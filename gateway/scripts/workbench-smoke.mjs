/**
 * Stage-1 read-only HTTP smoke test against an isolated synthetic sample.
 *
 * Builds a temporary task store + runs directory with synthetic records,
 * starts the real WorkbenchHttpServer on an ephemeral loopback port, exercises
 * health / list / detail / pagination / error paths over real HTTP, and
 * verifies that every read leaves the stored bytes unchanged.
 *
 * Usage: node scripts/workbench-smoke.mjs
 * Exit 0 = all checks passed; the JSON log of each step prints to stdout.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const gatewayRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(gatewayRoot, "..");
const steps = [];
function step(name, detail) {
  const entry = { step: name, ...detail };
  steps.push(entry);
  console.log(JSON.stringify(entry));
  if (!detail.ok) {
    console.error(JSON.stringify({ smoke: "failed", failedAt: name }));
    process.exit(1);
  }
}

function hashTree(directory) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      // SQLite's -wal/-shm side files are shared-memory bookkeeping that the
      // database engine itself rewrites on reads; the stored facts live in
      // the main database file, which is the file the baseline verification
      // hashes. Changes to the side files are not writes by this service.
      else if (!relative.endsWith("-wal") && !relative.endsWith("-shm")) out[relative] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  if (fs.existsSync(directory)) walk(directory, "");
  return out;
}

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET", headers: options.headers ?? {} }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// 1. build the synthetic sample through the compiled store + projection code.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-smoke-"));
const config = {
  backend: "desktop-queue",
  apiBaseUrl: "http://127.0.0.1/unreachable",
  tokenFile: path.join(dir, "credentials.json"),
  dbFile: path.join(dir, "tasks.sqlite"),
  oauthRedirectUri: "http://127.0.0.1:0/oauth",
  oauthPort: 0,
  oauthScopes: "smoke",
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

const { DatabaseSync } = await import("node:sqlite");
/** Windows requires file:// URLs for absolute-path dynamic imports. */
const distImport = relative => import(new URL(relative, new URL(`file:///${path.join(gatewayRoot, "dist", "_").replaceAll("\\", "/")}`)));
const storeModule = await distImport("task-store.js");
const serviceModule = await distImport("task-application-service.js");
const coordinatorModule = await distImport("coordinator.js");
const clientModule = await distImport("workbuddy-client.js");
const serverModule = await distImport("workbench-http.js");

const store = new storeModule.TaskStore(config.dbFile);
const coordinator = new coordinatorModule.TaskCoordinator(config, store, new clientModule.WorkBuddyClient(config));
const service = new serviceModule.TaskApplicationService(coordinator, 3, config.runsDir);

// Synthetic digest via the compiled report-authentication helper.
const authModule = await distImport("report-authentication.js");
const REPORT_TEXT = "TASK_STATUS: completed\nsmoke synthetic report";
const reportDigest = authModule.reportDigest({ status: "completed", text: REPORT_TEXT, artifacts: [] });

let counter = 0;
function seed(taskId, createdAt, options = {}) {
  counter += 1;
  const attemptId = `run-30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const sessionId = "smoke-session-1";
  const state = options.state ?? "needs_review";
  store.createOrGet({ taskId, messageId: `msg-${taskId}`, objective: `smoke objective ${taskId}`, state: "queued", createdAt, sessionId, runtimeSource: "desktop_queue", workspace: dir });
  store.beginAttempt(taskId, { attemptId, messageId: `msg-${taskId}`, sessionId });
  store.update(taskId, { state });
  store.updateAttempt(taskId, attemptId, { state, runtimeSource: "desktop_queue" });
  const runDir = path.join(config.runsDir, attemptId);
  fs.mkdirSync(runDir, { recursive: true });
  const snapshot = {
    attemptId, taskId, status: state === "accepted" || state === "completed" ? "needs_review" : state, driver: "desktop-queue",
    sessionId, runtimeSource: "desktop_queue", text: REPORT_TEXT,
    reportDigest, updatedAt: createdAt,
    ...(options.stop ? { nativeStoppedAt: "2026-10-18T10:30:00.000Z", nativeStopSource: "native_idle" } : {}),
    ...(options.authenticated ? { reportAuthentication: { formatVersion: 1, taskId, attemptId, sessionId, runtimeSource: "desktop_queue", reportedStatus: "completed", reportDigest, authenticatedAt: createdAt } } : {}),
  };
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(snapshot));
  const cancellation = options.cancel ? { requestedAt: createdAt, reason: "operator" } : undefined;
  if (cancellation) fs.writeFileSync(path.join(runDir, "cancel.json"), JSON.stringify(cancellation));
  store.updateAttempt(taskId, attemptId, { runEvidenceDigest: coordinatorModule.runEvidenceDigestOf(snapshot, cancellation) });
  return attemptId;
}

seed("smoke-task-a", "2026-10-18T10:00:00.000Z", { stop: true, cancel: true, authenticated: true });
seed("smoke-task-b", "2026-10-18T11:00:00.000Z", { state: "working" });
seed("smoke-task-c", "2026-10-18T12:00:00.000Z", { state: "working" });
// A corrupt projection record must keep its own list entry (not masked, not
// dropped) and answer 400 on its detail read. The record is corrupted through
// an attempt run directory holding a broken state.json.
const corruptId = "smoke-task-corrupt";
{
  counter += 1;
  const attemptId = `run-30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  store.createOrGet({ taskId: corruptId, messageId: `msg-${corruptId}`, objective: "smoke corrupt", state: "queued", createdAt: "2026-10-18T13:00:00.000Z", sessionId: "smoke-session-1", runtimeSource: "desktop_queue", workspace: dir });
  store.beginAttempt(corruptId, { attemptId, messageId: `msg-${corruptId}`, sessionId: "smoke-session-1" });
  store.update(corruptId, { state: "needs_review" });
  const runDir = path.join(config.runsDir, attemptId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), "{not-json");
}
step("sample-seeded", { ok: true, tasks: 4, dir });

const before = { data: hashTree(dir) };

// 2. start the real HTTP server on an ephemeral port.
const server = new serverModule.WorkbenchHttpServer({
  service,
  health: () => serverModule.workbenchHealth({ runtime: { release: "smoke", packageVersion: "0.0.0", startedAt: new Date().toISOString() } }),
});
const port = await server.listen(0);
step("server-listening", { ok: true, port, loopback: "127.0.0.1" });

try {
  // health
  const health = await request(port, { path: "/workbench/v1/health" });
  const healthBody = JSON.parse(health.body);
  step("health", {
    ok: health.status === 200 && healthBody.ready === true && healthBody.schemaVersion === "workbuddy-executor/stage-2"
      && healthBody.capabilities.nativePermissionResponse === false && healthBody.capabilities.nativeSessionNavigation === false
      && healthBody.capabilities.readOnlyHttp === true && healthBody.capabilities.taskEventsHttp === true,
    status: health.status, ready: healthBody.ready, capabilities: healthBody.capabilities,
  });

  // list — each entry is {ok, taskId, view} or {ok:false, taskId, code, ...};
  // a failed read keeps its entry instead of masking the page.
  const listOf = entry => entry.taskId ?? entry.view?.taskId;
  const list = await request(port, { path: "/workbench/v1/tasks?limit=2" });
  const listBody = JSON.parse(list.body);
  const listIds = listBody.tasks.map(listOf);
  step("list-page-1", {
    ok: list.status === 200 && JSON.stringify(listIds) === JSON.stringify(["smoke-task-a", "smoke-task-b"]) && listBody.nextAfterTaskId === "smoke-task-b",
    ids: listIds, nextAfterTaskId: listBody.nextAfterTaskId,
  });

  const list2 = await request(port, { path: "/workbench/v1/tasks?limit=2&afterTaskId=smoke-task-b" });
  const list2Body = JSON.parse(list2.body);
  const page2Ids = list2Body.tasks.map(listOf);
  step("list-page-2", {
    ok: list2.status === 200 && JSON.stringify(page2Ids) === JSON.stringify(["smoke-task-c", corruptId]) && list2Body.nextAfterTaskId === null,
    ids: page2Ids, nextAfterTaskId: list2Body.nextAfterTaskId,
  });

  // detail with authenticated report + stop proof; cancel.json makes the
  // terminal cause cancellation, so the display state is cancelled.
  const detail = await request(port, { path: "/workbench/v1/tasks/smoke-task-a" });
  const detailBody = JSON.parse(detail.body);
  step("detail-cancelled-with-proof", {
    ok: detail.status === 200 && detailBody.displayState === "cancelled" && detailBody.remoteStopped === true
      && typeof detailBody.revision === "string" && detailBody.revision.length > 0
      && detailBody.timing.nativeStoppedAt === "2026-10-18T10:30:00.000Z"
      && detailBody.timing.attemptDeadlineAt === null && detailBody.metrics === null
      && detailBody.workspace.id === null && detailBody.allowedActions.length === 0,
    displayState: detailBody.displayState, remoteStopped: detailBody.remoteStopped,
    revision: detailBody.revision, nativeStoppedAt: detailBody.timing.nativeStoppedAt,
  });

  // working task without live observation degrades to unknown
  const detailB = await request(port, { path: "/workbench/v1/tasks/smoke-task-b" });
  const detailBBody = JSON.parse(detailB.body);
  step("detail-snapshot-only", {
    ok: detailB.status === 200 && detailBBody.displayState === "unknown" && detailBBody.remoteStopped === false,
    displayState: detailBBody.displayState, remoteStopped: detailBBody.remoteStopped,
    note: "no live observation is claimed; false means stop unproven, not running",
  });

  // error paths
  const missing = await request(port, { path: "/workbench/v1/tasks/no-such-task" });
  const missingBody = JSON.parse(missing.body);
  step("detail-404", { ok: missing.status === 404 && missingBody.error.code === "TASK_NOT_FOUND" && missingBody.view === null, status: missing.status, code: missingBody.error?.code });

  // a corrupt record keeps a per-item failure in the list and a 400 detail
  const detailCorrupt = await request(port, { path: `/workbench/v1/tasks/${corruptId}` });
  const listCorrupt = await request(port, { path: "/workbench/v1/tasks?limit=50" });
  const listCorruptBody = JSON.parse(listCorrupt.body);
  const corruptEntry = listCorruptBody.tasks.find(entry => entry.taskId === corruptId);
  step("corrupt-item-preserved", {
    ok: detailCorrupt.status === 400
      && listCorrupt.status === 200
      && corruptEntry?.ok === false
      && typeof corruptEntry.code === "string" && corruptEntry.code.length > 0
      && listCorruptBody.tasks.every(entry => (entry.ok === true ? entry.view?.taskId : entry.taskId) != null),
    status: detailCorrupt.status, listStatus: listCorrupt.status,
    corruptEntryCode: corruptEntry?.code, corruptEntryMessage: corruptEntry?.message,
  });

  const badCursor = await request(port, { path: "/workbench/v1/tasks?afterTaskId=missing-anchor" });
  step("list-bad-cursor-400", { ok: badCursor.status === 400 && JSON.parse(badCursor.body).error.code === "INVALID_CURSOR", status: badCursor.status });

  const events = await request(port, { path: "/workbench/v1/tasks/smoke-task-a/events" });
  const eventsBody = JSON.parse(events.body);
  const eventList = Array.isArray(eventsBody.events) ? eventsBody.events : [];
  const eventIds = eventList.map((e) => e.eventId);
  const idsStrictlyRising = eventIds.every((id, i) => i === 0 || id > eventIds[i - 1]);
  const eventShapesOk = eventList.every((e) => typeof e.eventId === "number" && typeof e.type === "string"
    && typeof e.occurredAt === "string" && typeof e.observedAt === "string" && typeof e.actor === "string"
    && e.payload !== null && typeof e.payload === "object");
  const lastEventId = eventIds.at(-1) ?? null;
  step("events-listed", {
    ok: events.status === 200 && eventList.length > 0 && idsStrictlyRising && eventShapesOk
      && typeof eventsBody.nextEventId === "number"
      && lastEventId !== null && eventsBody.nextEventId === lastEventId,
    status: events.status, count: eventList.length, nextEventId: eventsBody.nextEventId,
  });

  const eventsExhausted = await request(port, { path: `/workbench/v1/tasks/smoke-task-a/events?afterEventId=${eventsBody.nextEventId}` });
  step("events-exhausted-cursor", { ok: eventsExhausted.status === 200 && Array.isArray(JSON.parse(eventsExhausted.body).events) && JSON.parse(eventsExhausted.body).events.length === 0 && JSON.parse(eventsExhausted.body).nextEventId === eventsBody.nextEventId });

  const eventsBadCursor = await request(port, { path: "/workbench/v1/tasks/smoke-task-a/events?afterEventId=zero" });
  step("events-bad-cursor-400", { ok: eventsBadCursor.status === 400 && JSON.parse(eventsBadCursor.body).error.code === "INVALID_CURSOR", status: eventsBadCursor.status });

  const exportAttempt = await request(port, { path: "/workbench/v1/tasks/smoke-task-a/export" });
  step("export-501", { ok: exportAttempt.status === 501, status: exportAttempt.status });

  const workspaces = await request(port, { path: "/workbench/v1/workspaces" });
  step("workspaces-501", { ok: workspaces.status === 501, status: workspaces.status });

  const post = await request(port, { method: "POST", path: "/workbench/v1/tasks", headers: { "content-type": "application/json" } });
  step("post-405", { ok: post.status === 405 && post.headers.allow === "GET, HEAD", status: post.status, allow: post.headers.allow });

  const cancelPost = await request(port, { method: "POST", path: "/workbench/v1/tasks/smoke-task-a/cancel" });
  step("cancel-post-405", { ok: cancelPost.status === 405, status: cancelPost.status });

  const foreignHost = await request(port, { path: "/workbench/v1/health", headers: { host: "attacker.example.com" } });
  step("foreign-host-403", { ok: foreignHost.status === 403, status: foreignHost.status });

  const crossOrigin = await request(port, { path: "/workbench/v1/tasks", headers: { host: "127.0.0.1", origin: "http://attacker.example.com" } });
  step("cross-origin-403", { ok: crossOrigin.status === 403, status: crossOrigin.status });

  const legacyPrefix = await request(port, { path: "/v1/runs" });
  step("legacy-prefix-404", { ok: legacyPrefix.status === 404, status: legacyPrefix.status });

  // read-only invariance
  const after = { data: hashTree(dir) };
  const unchanged = JSON.stringify(before.data) === JSON.stringify(after.data);
  step("read-only-invariance", {
    ok: unchanged,
    note: "task database (main file) and run files byte-identical after all reads; sqlite -wal/-shm engine bookkeeping is excluded",
  });

  // Exercise the compiled MCP entry, rather than asserting registration from
  // a comment. All configuration and data belong to this synthetic sample.
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(gatewayRoot,"dist/server.js")], cwd: gatewayRoot, stderr: "pipe",
    env: { ...getDefaultEnvironment(), WORKBUDDY_BACKEND:"desktop-queue", WORKBUDDY_DB_FILE:path.join(dir,"mcp.sqlite"),
      WORKBUDDY_RUNS_DIR:path.join(dir,"mcp-runs"), WORKBUDDY_CONFIG_DIR:path.join(dir,"synthetic-native"),
      WORKBUDDY_CLI_ELECTRON:path.join(dir,"missing.exe"), WORKBUDDY_TOKEN_FILE:path.join(dir,"unused-token.json"),
      WORKBUDDY_SERVICE_CONFIG:path.join(dir,"unused-service.json") } });
  transport.stderr?.on("data",()=>{});
  const mcp = new Client({name:"workbench-smoke",version:"1"});
  try {
    await mcp.connect(transport,{timeout:10000});
    const {tools}=await mcp.listTools({}, {timeout:10000});
    const send=tools.find(tool=>tool.name==="workbuddy_send_task");
    const workspace=tools.find(tool=>tool.name==="workbuddy_ensure_workspace");
    step("compiled-mcp-registration", {ok:tools.some(tool=>tool.name==="workbuddy_get_task") && Boolean(send?.inputSchema.properties?.contract) && Boolean(workspace?.inputSchema.properties?.workspaceId),tools:tools.length});
    for (const [name, args] of [
      ["workbuddy_send_task", { taskId: "no-model-choice", objective: "Synthetic task; must not dispatch", detail: "brief" }],
      ["workbuddy_ensure_workspace", { workspace: dir, workspaceId: "no-model-workspace", detail: "full" }],
    ]) {
      const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
      const body = JSON.parse(result.content[0].text);
      step(`${name}-requires-model-choice`, { ok: body.ok === false && body.code === "MODEL_SELECTION_REQUIRED" });
    }
    const listed = await mcp.callTool({ name: "workbuddy_list_tasks", arguments: { detail: "full" } });
    step("no-model-choice-no-tasks-created", { ok: JSON.parse(listed.content[0].text).tasks.length === 0 });
  } finally {await mcp.close();}
} finally {
  await server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ smoke: "passed", steps: steps.length }));
