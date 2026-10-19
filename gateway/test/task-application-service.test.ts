import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import type { RunSnapshot } from "../src/run-journal.js";

class SnapshotClient extends WorkBuddyClient {
  snapshot?: RunSnapshot;
  sent = 0;
  override runSnapshot() { return this.snapshot; }
  override async sendMessage(...args: Parameters<WorkBuddyClient["sendMessage"]>) {
    this.sent++;
    const options = args[4]!;
    this.snapshot = { taskId: options.taskId!, attemptId: options.attemptId!, sessionId: args[3], status: "queued", updatedAt: new Date().toISOString() };
    return { messageId: options.attemptId!, raw: { code: 0, data: { message_id: options.attemptId! } } };
  }
}

test("two service instances reuse one task identity and dispatch only once", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-task-service-send-"));
  const config = { ...loadConfig(), backend: "desktop-acp" as const, dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs") };
  const firstStore = new TaskStore(config.dbFile);
  const secondStore = new TaskStore(config.dbFile);
  t.after(() => { secondStore.close(); firstStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = new SnapshotClient(config);
  const first = new TaskApplicationService(new TaskCoordinator(config, firstStore, client), 3);
  const second = new TaskApplicationService(new TaskCoordinator(config, secondStore, client), 3);
  const input = { taskId: "same-task", objective: "fix a file", workspace: dir, sessionId: "session-one" };
  const results = await Promise.all([first.send(input), second.send(input)]);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(client.sent, 1);
  await assert.rejects(() => second.send({ ...input, objective: "different work" }), /Task ID conflicts/);
  assert.equal(client.sent, 1);
});

test("separate entry point services agree and never offer review actions before matching stop proof", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-task-service-"));
  const config = { ...loadConfig(), backend: "desktop-queue" as const, dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs") };
  const firstStore = new TaskStore(config.dbFile);
  const secondStore = new TaskStore(config.dbFile);
  t.after(() => { secondStore.close(); firstStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = new SnapshotClient(config);
  const first = new TaskApplicationService(new TaskCoordinator(config, firstStore, client), 3);
  const second = new TaskApplicationService(new TaskCoordinator(config, secondStore, client), 3);
  firstStore.createOrGet({ taskId: "one", messageId: "pending", objective: "fix it", state: "queued", sessionId: "session-one" });
  const attemptId = "run-00000000-0000-4000-8000-000000000001";
  firstStore.beginAttempt("one", { attemptId, messageId: attemptId, sessionId: "session-one" });

  client.snapshot = { taskId: "one", attemptId, sessionId: "session-one", driver: "desktop-queue", status: "queued", updatedAt: new Date().toISOString() };
  assert.deepEqual(first.statusView(first.requireTask("one")), second.statusView(second.requireTask("one")));
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, ["cancel"]);

  firstStore.updateAttempt("one", attemptId, {
    state: "needs_review", runtimeSource: "desktop_queue",
    report: { rawText: "TASK_STATUS: completed", filesChanged: [], commandsRun: [] },
  });
  client.snapshot = { ...client.snapshot, status: "needs_review", reportDigest: "digest" };
  assert.equal(first.statusView(first.requireTask("one")).displayState, "waiting_stop");
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, []);

  client.snapshot = { ...client.snapshot, taskId: "other", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle" };
  assert.equal(first.statusView(first.requireTask("one")).remoteStopped, false);
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, []);

  client.snapshot = { ...client.snapshot, taskId: "one", sessionId: "other-session" };
  assert.equal(first.statusView(first.requireTask("one")).remoteStopped, false);
  client.snapshot = { ...client.snapshot, sessionId: "session-one", attemptId: "run-00000000-0000-4000-8000-000000000002" };
  assert.equal(first.statusView(first.requireTask("one")).remoteStopped, false);

  client.snapshot = { ...client.snapshot, attemptId };
  const withoutDigest = { ...client.snapshot };
  delete withoutDigest.reportDigest;
  client.snapshot = withoutDigest;
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, ["rework"]);
  client.snapshot = { ...client.snapshot, reportDigest: "digest" };
  const view = first.statusView(first.requireTask("one"));
  assert.equal(view.displayState, "needs_review");
  assert.deepEqual(view.allowedActions, ["rework", "accept"]);
  assert.deepEqual(view, second.statusView(second.requireTask("one")));

  firstStore.updateAttempt("one", attemptId, { state: "cancelled" });
  assert.equal(second.statusView(second.requireTask("one")).displayState, "cancelled");
  assert.deepEqual(second.statusView(second.requireTask("one")).allowedActions, []);
  client.snapshot = { ...client.snapshot, nativeStoppedAt: undefined, nativeStopSource: undefined };
  assert.equal(second.statusView(second.requireTask("one")).displayState, "waiting_stop");
  assert.deepEqual(second.statusView(second.requireTask("one")).allowedActions, []);
});
