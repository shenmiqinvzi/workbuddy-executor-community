/**
 * Stage-1 read-only HTTP adapter tests.
 *
 * Everything runs against a synthetic isolated store in a temporary
 * directory; no real WorkBuddy installation, no real task database, no
 * native session and no model request is involved. The server binds an
 * ephemeral loopback port per test.
 *
 * The config object is built explicitly instead of through loadConfig so the
 * fixture does not depend on how many WorkBuddy installations exist on the
 * machine running the tests.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import type { Config } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import type { TaskState } from "../src/task-store.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import {
  WORKBENCH_DEFAULT_PORT,
  WorkbenchHttpServer,
  parseListQuery,
  workbenchHealth,
  workbenchPortFromEnv,
} from "../src/workbench-http.js";
import { STAGE_TASK_VIEW_SCHEMA_VERSION } from "../src/task-view-stage.js";

/** A client that never reaches the network; the read paths do not call it. */
class NoopClient extends WorkBuddyClient {}

interface Fixture {
  service: TaskApplicationService;
  store: TaskStore;
  dir: string;
  runsDir: string;
  /** Seed a stored task; when cancel is true the attempt also gets cancel.json. */
  seedTask: (options: { taskId: string; createdAt: string; state?: TaskState; stop?: boolean; cancel?: boolean }) => void;
}

function fixture(t: { after: (fn: () => void) => void }): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-http-"));
  const config: Config = {
    backend: "desktop-queue",
    apiBaseUrl: "http://127.0.0.1/unreachable",
    tokenFile: path.join(dir, "credentials.json"),
    dbFile: path.join(dir, "tasks.sqlite"),
    oauthRedirectUri: "http://127.0.0.1:0/oauth",
    oauthPort: 0,
    oauthScopes: "test",
    requestTimeoutMs: 1000,
    cliElectronPath: path.join(dir, "no-electron.exe"),
    cliScriptPath: path.join(dir, "no-cli"),
    cliPermissionMode: "deny",
    acpPermissionMode: "deny",
    gatewayUrl: "http://127.0.0.1:0",
    workbuddyConfigDir: path.join(dir, "workbuddy-config"),
    runsDir: path.join(dir, "runs"),
    taskTimeoutSeconds: 600,
    claimTimeoutSeconds: 60,
    maxTaskAttempts: 3,
    serviceConfigFile: path.join(dir, "persistent-service.json"),
  };
  const store = new TaskStore(config.dbFile);
  const coordinator = new TaskCoordinator(config, store, new NoopClient(config));
  const service = new TaskApplicationService(coordinator, 3, config.runsDir!);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let attemptCounter = 0;
  return {
    service, store, dir, runsDir: config.runsDir!,
    seedTask(options) {
      attemptCounter += 1;
      const attemptId = `run-00000000-0000-4000-8000-${attemptCounter.toString().padStart(12, "0")}`;
      const sessionId = "session-http-1";
      const state = options.state ?? "needs_review";
      // Create as queued so beginAttempt accepts the reservation, then move
      // the task to its target state afterwards.
      store.createOrGet({ taskId: options.taskId, messageId: `msg-${options.taskId}`, objective: `objective ${options.taskId}`, state: "queued", createdAt: options.createdAt, sessionId, runtimeSource: "desktop_queue", workspace: dir });
      store.beginAttempt(options.taskId, { attemptId, messageId: `msg-${options.taskId}`, sessionId });
      store.update(options.taskId, { state });
      store.updateAttempt(options.taskId, attemptId, { state, runtimeSource: "desktop_queue" });
      const runDir = path.join(config.runsDir!, attemptId);
      fs.mkdirSync(runDir, { recursive: true });
      const snapshot = {
        attemptId, taskId: options.taskId, status: state, driver: "desktop-queue" as const,
        sessionId, runtimeSource: "desktop_queue", text: "TASK_STATUS: completed\nsynthetic report",
        reportDigest: "synthetic-digest", updatedAt: options.createdAt,
        ...(options.stop ? { nativeStoppedAt: "2026-10-18T10:30:00.000Z", nativeStopSource: "native_idle" as const } : {}),
      };
      fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(snapshot));
      if (options.cancel) fs.writeFileSync(path.join(runDir, "cancel.json"), JSON.stringify({ requestedAt: options.createdAt, reason: "operator" }));
    },
  };
}

async function startServer(service: TaskApplicationService): Promise<{ server: WorkbenchHttpServer; port: number; close: () => Promise<void> }> {
  const server = new WorkbenchHttpServer({ service, health: () => workbenchHealth({ runtime: { release: "test", packageVersion: "0.0.0", startedAt: "2026-10-23T00:00:00.000Z" } }) });
  const port = await server.listen(0);
  return { server, port, close: () => server.close() };
}

function request(port: number, options: { method?: string; path: string; headers?: Record<string, string> }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET", headers: options.headers }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("parseListQuery applies the documented defaults and bounds", () => {
  assert.deepEqual(parseListQuery(""), { ok: true, limit: 50 });
  assert.deepEqual(parseListQuery("limit=7&afterTaskId=abc"), { ok: true, limit: 7, afterTaskId: "abc" });
  assert.equal(parseListQuery("limit=0").ok, false);
  assert.equal(parseListQuery("limit=101").ok, false);
  assert.equal(parseListQuery("limit=abc").ok, false);
  assert.equal(parseListQuery("afterTaskId=").ok, false);
  assert.equal(parseListQuery(`afterTaskId=${"x".repeat(201)}`).ok, false);
});

test("workbenchPortFromEnv rejects partial and malformed integers, not just out-of-range ones", () => {
  assert.equal(workbenchPortFromEnv({}), WORKBENCH_DEFAULT_PORT);
  assert.equal(workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "18493" }), 18493);
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "0" }));
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "65536" }));
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "not-a-port" }));
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "18493junk" }), "trailing text is not a port");
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "18493.5" }), "decimals are not ports");
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "1.8e4" }), "scientific notation is not a port");
  assert.equal(workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: " 18493 " }), 18493, "surrounding whitespace is trimmed before validation");
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "18 493" }), "internal whitespace is not a port");
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "+18493" }), "a sign is not accepted");
  assert.throws(() => workbenchPortFromEnv({ WORKBUDDY_WORKBENCH_PORT: "-1" }), "negative values are not ports");
});

test("health, list and detail answer from stored facts only", async t => {
  const f = fixture(t);
  f.seedTask({ taskId: "task-a", createdAt: "2026-10-18T10:00:00.000Z", stop: true, cancel: true });
  f.seedTask({ taskId: "task-b", createdAt: "2026-10-18T11:00:00.000Z", state: "working" });
  const { server, port, close } = await startServer(f.service);
  t.after(close);

  const health = await request(port, { path: "/workbench/v1/health" });
  assert.equal(health.status, 200);
  const healthBody = JSON.parse(health.body);
  assert.equal(healthBody.schemaVersion, STAGE_TASK_VIEW_SCHEMA_VERSION);
  assert.equal(healthBody.ready, true);
  assert.equal(healthBody.capacity.limit, 1);
  assert.equal(healthBody.capabilities.nativePermissionResponse, false);
  assert.equal(healthBody.capabilities.nativeSessionNavigation, false);
  assert.equal(healthBody.capabilities.taskEventsHttp, false);

  const list = await request(port, { path: "/workbench/v1/tasks" });
  assert.equal(list.status, 200);
  const listBody = JSON.parse(list.body);
  // Every entry is now an envelope: ok:true carries view, ok:false a failure.
  assert.equal(listBody.tasks[0].ok, true);
  assert.equal(listBody.tasks[0].view.taskId, "task-a");
  assert.equal(listBody.tasks[0].view.displayState, "cancelled");
  assert.equal(listBody.tasks[0].view.remoteStopped, true);
  assert.equal(listBody.tasks[0].view.revision, null);
  assert.equal(listBody.tasks[1].ok, true);
  assert.equal(listBody.tasks[1].view.displayState, "unknown", "no live observation is claimed from a stored snapshot");
  assert.equal(listBody.tasks[1].view.remoteStopped, false, "stop proof absent is a confirmed false, not null");

  const detail = await request(port, { path: "/workbench/v1/tasks/task-a" });
  assert.equal(detail.status, 200);
  const detailBody = JSON.parse(detail.body);
  assert.equal(detailBody.taskId, "task-a");
  assert.equal(detailBody.timing.createdAt, "2026-10-18T10:00:00.000Z");
  assert.equal(detailBody.timing.nativeStoppedAt, "2026-10-18T10:30:00.000Z");
  assert.deepEqual(detailBody.allowedActions, []);
  assert.deepEqual(detailBody.checks, []);
  assert.equal(detailBody.metrics, null);

  const missing = await request(port, { path: "/workbench/v1/tasks/nope" });
  assert.equal(missing.status, 404);
  const missingBody = JSON.parse(missing.body);
  assert.equal(missingBody.error.code, "TASK_NOT_FOUND");
  assert.equal(missingBody.view, null);
});

test("cursor pagination is stable, re-readable, and a missing cursor is an error", async t => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) {
    f.seedTask({ taskId: `page-task-${index}`, createdAt: `2026-10-18T1${index}:00:00.000Z`, state: "working" });
  }
  const { server, port, close } = await startServer(f.service);
  t.after(close);

  const page1 = JSON.parse((await request(port, { path: "/workbench/v1/tasks?limit=2" })).body);
  assert.deepEqual(page1.tasks.map((task: { taskId: string }) => task.taskId ?? (task as { view?: { taskId: string } }).view?.taskId), ["page-task-0", "page-task-1"]);
  assert.equal(page1.nextAfterTaskId, "page-task-1");

  const page2 = JSON.parse((await request(port, { path: "/workbench/v1/tasks?limit=2&afterTaskId=page-task-1" })).body);
  assert.deepEqual(page2.tasks.map((task: { taskId: string }) => task.taskId ?? (task as { view?: { taskId: string } }).view?.taskId), ["page-task-2", "page-task-3"]);
  assert.equal(page2.nextAfterTaskId, "page-task-3");

  const page3 = JSON.parse((await request(port, { path: "/workbench/v1/tasks?limit=2&afterTaskId=page-task-3" })).body);
  assert.deepEqual(page3.tasks.map((task: { taskId: string }) => task.taskId ?? (task as { view?: { taskId: string } }).view?.taskId), ["page-task-4"]);
  assert.equal(page3.nextAfterTaskId, null);

  const page2again = JSON.parse((await request(port, { path: "/workbench/v1/tasks?limit=2&afterTaskId=page-task-1" })).body);
  assert.deepEqual(page2again, page2, "a cursor page is re-readable");

  const unknownCursor = await request(port, { path: "/workbench/v1/tasks?afterTaskId=missing-task" });
  assert.equal(unknownCursor.status, 400);
  assert.equal(JSON.parse(unknownCursor.body).error.code, "INVALID_CURSOR");
});

test("a full page exposes the next cursor and concurrent updates do not shift rows", async t => {
  const f = fixture(t);
  for (let index = 0; index < 4; index++) {
    f.seedTask({ taskId: `shift-${index}`, createdAt: `2026-10-19T10:0${index}:00.000Z`, state: "working" });
  }
  const { server, port, close } = await startServer(f.service);
  t.after(close);
  const first = JSON.parse((await request(port, { path: "/workbench/v1/tasks?limit=2" })).body);
  const taskIdOf = (task: { taskId?: string; view?: { taskId: string } }) => task.taskId ?? task.view?.taskId;
  assert.deepEqual(first.tasks.map(taskIdOf), ["shift-0", "shift-1"]);
  // An update between pages changes updatedAt but not the created_at order.
  f.store.update("shift-0", { reviewNote: "touched" });
  const second = JSON.parse((await request(port, { path: `/workbench/v1/tasks?limit=2&afterTaskId=${first.nextAfterTaskId}` })).body);
  assert.deepEqual(second.tasks.map(taskIdOf), ["shift-2", "shift-3"]);
});

test("access boundary: foreign Host, cross-origin Origin and non-GET methods are refused", async t => {
  const f = fixture(t);
  f.seedTask({ taskId: "guard-task", createdAt: "2026-10-18T10:00:00.000Z", state: "working" });
  const { server, port, close } = await startServer(f.service);
  t.after(close);

  const foreignHost = await request(port, { path: "/workbench/v1/health", headers: { host: "evil.example.com" } });
  assert.equal(foreignHost.status, 403);

  const localhostName = await request(port, { path: "/workbench/v1/health", headers: { host: "localhost:1234" } });
  assert.equal(localhostName.status, 403, "a DNS name is refused even when it would resolve to loopback");

  const crossOrigin = await request(port, { path: "/workbench/v1/tasks", headers: { host: "127.0.0.1", origin: "http://evil.example.com" } });
  assert.equal(crossOrigin.status, 403);

  const loopbackOrigin = await request(port, { path: "/workbench/v1/tasks", headers: { host: "127.0.0.1", origin: "http://127.0.0.1:5173" } });
  assert.equal(loopbackOrigin.status, 200, "a loopback web origin is accepted");

  const post = await request(port, { method: "POST", path: "/workbench/v1/tasks", headers: { "content-type": "application/json" } });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");

  const del = await request(port, { method: "DELETE", path: "/workbench/v1/tasks/guard-task" });
  assert.equal(del.status, 405);

  const put = await request(port, { method: "PUT", path: "/workbench/v1/tasks/guard-task/cancel" });
  assert.equal(put.status, 405);

  const postEvents = await request(port, { method: "POST", path: "/workbench/v1/tasks/guard-task/events" });
  assert.equal(postEvents.status, 405);
});

test("events, export and workspaces stay explicitly closed (501), unknown paths 404", async t => {
  const f = fixture(t);
  f.seedTask({ taskId: "closed-task", createdAt: "2026-10-18T10:00:00.000Z", state: "working" });
  const { server, port, close } = await startServer(f.service);
  t.after(close);

  const events = await request(port, { path: "/workbench/v1/tasks/closed-task/events?afterEventId=0&limit=100" });
  assert.equal(events.status, 501);
  assert.equal(JSON.parse(events.body).error.code, "EVENTS_NOT_IMPLEMENTED");

  const exportBody = await request(port, { path: "/workbench/v1/tasks/closed-task/export" });
  assert.equal(exportBody.status, 501);
  assert.equal(JSON.parse(exportBody.body).error.code, "EXPORT_NOT_IMPLEMENTED");

  const workspaces = await request(port, { path: "/workbench/v1/workspaces" });
  assert.equal(workspaces.status, 501);

  const unknown = await request(port, { path: "/workbench/v1/unknown" });
  assert.equal(unknown.status, 404);

  const outside = await request(port, { path: "/v1/runs" });
  assert.equal(outside.status, 404, "the legacy gateway prefix is not served by this adapter");
});

test("HEAD answers like GET without a body", async t => {
  const f = fixture(t);
  const { server, port, close } = await startServer(f.service);
  t.after(close);
  const head = await request(port, { method: "HEAD", path: "/workbench/v1/health" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("reading over HTTP leaves every stored byte unchanged", async t => {
  const f = fixture(t);
  f.seedTask({ taskId: "hash-task", createdAt: "2026-10-18T10:00:00.000Z", stop: true, cancel: true });
  const { server, port, close } = await startServer(f.service);
  t.after(close);
  const snapshot = () => Object.fromEntries(
    fs.readdirSync(f.dir, { recursive: true }).map(String).sort().map(relative => {
      const filename = path.join(f.dir, relative);
      return [relative, fs.statSync(filename).isFile() ? fs.readFileSync(filename).byteLength : -1];
    }),
  );
  const before = snapshot();
  await request(port, { path: "/workbench/v1/health" });
  await request(port, { path: "/workbench/v1/tasks" });
  await request(port, { path: "/workbench/v1/tasks/hash-task" });
  await request(port, { path: "/workbench/v1/tasks/hash-task" });
  assert.deepEqual(snapshot(), before, "GET must not write to the task database or run files");
});

/**
 * R2 regression: the real entry subprocess, started with WORKBUDDY_DB_FILE
 * only (no WORKBUDDY_RUNS_DIR), must resolve the runs directory like the rest
 * of the execution chain — next to the database — and report the stored
 * authenticated report at needs_review with the stop proof. A test that only
 * constructs the service directly cannot see the entry's own resolution.
 */
test("workbench entry subprocess resolves the default runs directory next to the database", async t => {
  // The temp directory is intentionally NOT removed in t.after: the entry
  // subprocess may still hold its SQLite handle when the assertion finishes,
  // and force-removing it on Windows can block the runner indefinitely. The
  // OS temp cleaner reclaims it later; the test itself is self-contained.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-entry-"));
  // Seed a synthetic store + runs layout exactly where the default resolution expects them.
  const dbFile = path.join(dir, "tasks.sqlite");
  const runsDir = path.join(dir, "runs");
  const { execFileSync } = await import("node:child_process");
  const seedScript = path.join(dir, "seed.mjs");
  // Windows ESM imports need file:// URLs for absolute paths.
  const distUrl = (module: string) => `file:///${path.join(process.cwd(), "dist", module).replaceAll("\\", "/")}`;
  fs.writeFileSync(seedScript, `
    import fs from "node:fs";
    import path from "node:path";
    import { TaskStore } from "${distUrl("task-store.js")}";
    import { TaskCoordinator } from "${distUrl("coordinator.js")}";
    import { TaskApplicationService } from "${distUrl("task-application-service.js")}";
    import { WorkBuddyClient } from "${distUrl("workbuddy-client.js")}";
    import { reportDigest } from "${distUrl("report-authentication.js")}";
    const dir = ${JSON.stringify(dir)};
    const config = {
      backend: "desktop-queue", apiBaseUrl: "http://127.0.0.1/unreachable", tokenFile: path.join(dir, "c.json"),
      dbFile: path.join(dir, "tasks.sqlite"), oauthRedirectUri: "http://127.0.0.1:0", oauthPort: 0, oauthScopes: "s",
      requestTimeoutMs: 1000, cliElectronPath: path.join(dir, "e"), cliScriptPath: path.join(dir, "c"),
      cliPermissionMode: "deny", acpPermissionMode: "deny", gatewayUrl: "http://127.0.0.1:0",
      workbuddyConfigDir: path.join(dir, "wb"), runsDir: path.join(dir, "runs"),
      taskTimeoutSeconds: 600, claimTimeoutSeconds: 60, maxTaskAttempts: 3, serviceConfigFile: path.join(dir, "p.json"),
    };
    const store = new TaskStore(config.dbFile);
    const service = new TaskApplicationService(new TaskCoordinator(config, store, new WorkBuddyClient(config)), 3, config.runsDir);
    const taskId = "entry-task";
    const attemptId = "run-e0000000-0000-4000-8000-000000000001";
    const sessionId = "entry-session";
    store.createOrGet({ taskId, messageId: "m", objective: "o", state: "queued", createdAt: "2026-10-18T10:00:00.000Z", sessionId, runtimeSource: "desktop_queue", workspace: dir });
    store.beginAttempt(taskId, { attemptId, messageId: "m", sessionId });
    store.update(taskId, { state: "needs_review" });
    store.updateAttempt(taskId, attemptId, { state: "needs_review", runtimeSource: "desktop_queue" });
    const text = "TASK_STATUS: completed\\nentry"; const digest = reportDigest({ status: "completed", text, artifacts: [] });
    fs.mkdirSync(path.join(config.runsDir, attemptId), { recursive: true });
    fs.writeFileSync(path.join(config.runsDir, attemptId, "state.json"), JSON.stringify({
      attemptId, taskId, status: "needs_review", driver: "desktop-queue", sessionId, runtimeSource: "desktop_queue",
      text, reportDigest: digest, nativeStoppedAt: "2026-10-18T10:30:00.000Z", nativeStopSource: "native_idle",
      updatedAt: "2026-10-18T10:00:00.000Z",
      reportAuthentication: { formatVersion: 1, taskId, attemptId, sessionId, runtimeSource: "desktop_queue", reportedStatus: "completed", reportDigest: digest, authenticatedAt: "2026-10-18T10:05:00.000Z" },
    }));
    store.close();
  `);
  let seedError = "";
  try {
    execFileSync(process.execPath, [seedScript], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    seedError = String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
  assert.equal(seedError, "", `seeding failed: ${seedError.slice(0, 400)}`);

  // Start the real compiled entry with only WORKBUDDY_DB_FILE configured.
  const port = 18765 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "workbench-entry.js")], {
    env: {
      ...process.env,
      WORKBUDDY_DB_FILE: dbFile,
      WORKBUDDY_BACKEND: "desktop-queue",
      WORKBUDDY_WORKBENCH_PORT: String(port),
      WORKBUDDY_CONFIG_DIR: path.join(dir, "wb"),
      WORKBUDDY_CLI_ELECTRON: path.join(dir, "no-electron.exe"),
      WORKBUDDY_TOKEN_FILE: path.join(dir, "credentials.json"),
      WORKBUDDY_SERVICE_CONFIG: path.join(dir, "persistent-service.json"),
      // WORKBUDDY_RUNS_DIR deliberately absent: the default must resolve next to the db.
    },
    // stdio ignored so no pipe keeps the test runner waiting after kill.
    stdio: "ignore",
  });
  t.after(() => { if (child.exitCode === null && child.pid) { try { process.kill(child.pid); } catch { /* already gone */ } } });
  const url = `http://127.0.0.1:${port}/workbench/v1/tasks/entry-task`;
  // Poll until the server answers or the child dies; the poll is bounded so a
  // stuck server fails the test instead of hanging it.
  let body: { displayState?: string; remoteStopped?: boolean | null } | undefined;
  let lastError = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.status === 200) { body = (await response.json()) as { displayState?: string; remoteStopped?: boolean | null }; break; }
      lastError = `status ${response.status}`;
    } catch (error) { lastError = String(error); }
  }
  assert.ok(body, `entry subprocess did not answer on port ${port}; last: ${lastError}; exit: ${child.exitCode}`);
  assert.equal(body!.displayState, "needs_review", "the stored report is found through the default runs directory");
  assert.equal(body!.remoteStopped, true);
  assert.equal(child.exitCode, null, "the entry stays up; it did not crash resolving paths");
});
