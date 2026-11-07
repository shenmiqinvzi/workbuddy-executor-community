import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openProductivityRuntime } from "../src/productivity-runtime.js";
import { workbenchHealth, WorkbenchHttpServer } from "../src/workbench-http.js";
import type { TaskApplicationService } from "../src/task-application-service.js";
import type { DeliveryExportStore } from "../src/delivery-export.js";
import type { NotificationStore, PendingNotification } from "../src/notification-center.js";
import type { NotificationSnapshotView } from "../src/productivity-service.js";
import type { StoredTask } from "../src/task-store.js";

const task: StoredTask = {
  taskId: "task-1",
  messageId: "message-1",
  objective: "objective text that must not be exported",
  state: "completed",
  createdAt: "2026-11-05T08:00:00.000Z",
  updatedAt: "2026-11-05T08:05:00.000Z",
  attemptId: "attempt-1",
  report: { status: "completed", filesChanged: [], commandsRun: [], rawText: "done" },
  evidence: [],
};

function fakeStore(): DeliveryExportStore & NotificationStore {
  return {
    get: (taskId: string) => (taskId === task.taskId ? task : undefined),
    listAttempts: () => [],
    listTaskEvents: () => ({ events: [], nextEventId: 0 }),
    getContract: () => ({ state: "absent" }),
    listTasksByCreatedCursor: () => ({ tasks: [task], anchorFound: true }),
    reviews: { list: () => [] },
    close: () => undefined,
  } as unknown as DeliveryExportStore & NotificationStore;
}

function fixture(t: { after: (fn: () => void) => void }) {
  const configDir = mkdtempSync(path.join(tmpdir(), "workbuddy-productivity-http-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const store = fakeStore();
  const runtime = openProductivityRuntime({ configDir, store });
  return { runtime, store };
}

async function start(t: { after: (fn: () => void) => void }, withProductivity: boolean, runtime?: ReturnType<typeof openProductivityRuntime>) {
  const server = new WorkbenchHttpServer({
    service: {} as unknown as TaskApplicationService,
    health: () => workbenchHealth({ runtime: { release: "test", packageVersion: "0.0.0", startedAt: "2026-11-05T00:00:00.000Z" } }),
    ...(withProductivity && runtime ? { productivity: runtime.sources } : {}),
  });
  const port = await server.listen(0);
  t.after(async () => {
    await server.close();
  });
  return port;
}

function request(port: number, options: { method?: string; path: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: { host: `127.0.0.1:${port}` } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("productivity http: the catalog is readable and says activation is unsupported", async (t) => {
  const { runtime } = fixture(t);
  const port = await start(t, true, runtime);
  const response = await request(port, { path: "/workbench/v1/templates" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = JSON.parse(response.body) as { schemaVersion: string; readOnly: boolean; count: number; activation: { supported: boolean } };
  assert.equal(body.schemaVersion, "workbuddy-executor/productivity-1");
  assert.equal(body.readOnly, true);
  assert.equal(body.count, 0);
  assert.equal(body.activation.supported, false);
});

test("productivity http: unknown and malformed identifiers answer 404 and 400 without reading files", async (t) => {
  const { runtime } = fixture(t);
  const port = await start(t, true, runtime);
  const missing = await request(port, { path: "/workbench/v1/templates/tmpl-00000000" });
  assert.equal(missing.status, 404);
  assert.equal((JSON.parse(missing.body) as { error: { code: string } }).error.code, "TEMPLATE_NOT_FOUND");
  const malformed = await request(port, { path: "/workbench/v1/templates/..%2F..%2Fetc" });
  assert.equal(malformed.status, 400);
  assert.equal((JSON.parse(malformed.body) as { error: { code: string } }).error.code, "INVALID_TEMPLATE_ID");
  const badQuery = await request(port, { path: "/workbench/v1/templates?includeArchived=yes" });
  assert.equal(badQuery.status, 400);
  assert.equal((JSON.parse(badQuery.body) as { error: { code: string } }).error.code, "INVALID_QUERY");
  const badTask = await request(port, { path: "/workbench/v1/export-preview/bad%20task" });
  assert.equal(badTask.status, 400);
  assert.equal((JSON.parse(badTask.body) as { error: { code: string } }).error.code, "INVALID_TASK_ID");
});

test("productivity http: the preview is read-only and never carries the objective text", async (t) => {
  const { runtime } = fixture(t);
  const port = await start(t, true, runtime);
  const response = await request(port, { path: "/workbench/v1/export-preview/task-1" });
  assert.equal(response.status, 200);
  assert.equal(response.body.includes("objective text that must not be exported"), false);
  const body = JSON.parse(response.body) as { digest: string; bytes: number; target: string; whitelist: string[] };
  assert.match(body.digest, /^[a-f0-9]{64}$/);
  assert.ok(body.bytes > 0);
  assert.equal(body.target, "user_chosen_directory");
  assert.ok(body.whitelist.includes("task"));
});

test("productivity http: writes are refused with 405 and the notification snapshot does not consume episodes", async (t) => {
  const { runtime } = fixture(t);
  const port = await start(t, true, runtime);
  for (const route of ["/workbench/v1/templates", "/workbench/v1/notifications", "/workbench/v1/export-preview/task-1"]) {
    const response = await request(port, { method: "POST", path: route });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
  const first = await request(port, { path: "/workbench/v1/notifications" });
  const second = await request(port, { path: "/workbench/v1/notifications" });
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
});

test("productivity http: without sources the routes do not exist", async (t) => {
  const port = await start(t, false);
  const response = await request(port, { path: "/workbench/v1/templates" });
  assert.equal(response.status, 404);
});

test("productivity http: a saved delivery failure is reported with its reason, and a never-attempted episode is not counted", async (t) => {
  const { runtime } = fixture(t);
  const pending = [
    {
      episodeKey: "task-1|input_requested|event:3",
      reason: "input_requested",
      taskId: "task-1",
      taskTitle: "示例任务",
      state: "waiting_input",
      anchor: { kind: "event", eventId: 3 },
      occurredAt: "2026-11-05T08:00:00.000Z",
      readyAt: null,
      lastFailure: { message: "native presenter is not available", at: "2026-11-05T08:01:00.000Z", attempts: 2 },
    },
    {
      episodeKey: "task-1|needs_review|event:4",
      reason: "needs_review",
      taskId: "task-1",
      taskTitle: "示例任务",
      state: "needs_review",
      anchor: { kind: "event", eventId: 4 },
      occurredAt: "2026-11-05T08:02:00.000Z",
      readyAt: null,
    },
  ] as unknown as PendingNotification[];
  const notifications = {
    pending: () => pending,
    config: () => runtime.sources.notifications.config(),
    issues: () => [] as string[],
  } as unknown as typeof runtime.sources.notifications;
  const server = new WorkbenchHttpServer({
    service: {} as unknown as TaskApplicationService,
    health: () => workbenchHealth({ runtime: { release: "test", packageVersion: "0.0.0", startedAt: "2026-11-05T00:00:00.000Z" } }),
    productivity: { ...runtime.sources, notifications },
  });
  const port = await server.listen(0);
  t.after(async () => {
    await server.close();
  });
  const response = await request(port, { path: "/workbench/v1/notifications" });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as NotificationSnapshotView;
  assert.equal(body.pending.length, 2);
  assert.equal(body.limits.pendingReturned, 2);
  // Only the episode whose own ledger entry records a thrown attempt counts.
  assert.equal(body.deliveryFailures, 1);
  assert.equal(body.failures.length, 1);
  assert.equal(body.failures[0]!.episodeKey, "task-1|input_requested|event:3");
  assert.equal(body.failures[0]!.reason, "input_requested");
  assert.equal(body.failures[0]!.message, "native presenter is not available");
  assert.equal(body.failures[0]!.attempts, 2);
  assert.equal(body.failures[0]!.at, "2026-11-05T08:01:00.000Z");
  // A preview, not a delivery: reading it twice cannot swallow an episode.
  const again = await request(port, { path: "/workbench/v1/notifications" });
  assert.deepEqual(JSON.parse(again.body), JSON.parse(response.body));
});
