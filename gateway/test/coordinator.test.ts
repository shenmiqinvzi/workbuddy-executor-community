import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskStore, type StoredTask } from "../src/task-store.js";
import type { LocalMessage } from "../src/workbuddy-client.js";
import { SelectedModelClient as WorkBuddyClient } from "./support/selected-model-client.js";
import { RunJournal, type RunSnapshot } from "../src/run-journal.js";

class FakeClient extends WorkBuddyClient {
  readonly sent: Array<Parameters<WorkBuddyClient["sendMessage"]>> = [];
  readonly snapshots = new Map<string, RunSnapshot>();
  readonly receivedCursors: Array<string | undefined> = [];
  readonly cancelled: string[] = [];
  batches: LocalMessage[][] = [];
  sendError?: Error;
  private readPause?: { entered: () => void; result: Promise<LocalMessage[]> };
  override async sendMessage(...args: Parameters<WorkBuddyClient["sendMessage"]>) {
    this.sent.push(args);
    if (this.sendError) throw this.sendError;
    const [, , , sessionId, options] = args;
    const attemptId = options!.attemptId!;
    this.snapshots.set(attemptId, { attemptId, taskId: options!.taskId!, status: "queued", sessionId, updatedAt: new Date().toISOString() });
    return { messageId: attemptId, raw: { code: 0, data: { message_id: attemptId } } };
  }
  override async messages(options: { afterMessageId?: string; limit?: number } = {}) {
    this.receivedCursors.push(options.afterMessageId);
    const pause = this.readPause;
    if (pause) { this.readPause = undefined; pause.entered(); return pause.result; }
    return this.batches.shift() ?? [];
  }
  override runSnapshot(attemptId: string) { return this.snapshots.get(attemptId); }
  override cancel(messageId: string) { this.cancelled.push(messageId); return true; }
  pauseNextRead(): { entered: Promise<void>; resume: (messages: LocalMessage[]) => void } {
    let entered!: () => void;
    let resume!: (messages: LocalMessage[]) => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const result = new Promise<LocalMessage[]>((resolve) => { resume = resolve; });
    this.readPause = { entered, result };
    return { entered: enteredPromise, resume };
  }
}

function fixture(t: { after: (fn: () => void) => void }): { dir: string; config: Config; store: TaskStore; client: FakeClient; coordinator: TaskCoordinator } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-coordinator-"));
  const config: Config = { ...loadConfig(), backend: "desktop-acp", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"), tokenFile: path.join(dir, "unused-credentials.json"), workbuddyConfigDir: path.join(dir, "fake-workbuddy") };
  const store = new TaskStore(config.dbFile);
  const client = new FakeClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, client, coordinator };
}

function event(task: StoredTask, seq: number, text: string, metadata: Record<string, unknown> = {}): LocalMessage {
  return { message_id: `${task.attemptId}:${seq}`, role: metadata.type === "result" ? "assistant" : "system", content: [text], metadata: { attemptId: task.attemptId, eventSeq: seq, sessionId: "fixed-session", runtimeSource: "desktop_interactive", ...metadata } };
}
function finish(client: FakeClient, task: StoredTask, text = "TASK_STATUS: completed\nARTIFACTS:\n- output.mp4\nCOMMANDS_RUN:\n- render video\nTEST_RESULT: render succeeded") {
  client.snapshots.set(task.attemptId!, { attemptId: task.attemptId!, taskId: task.taskId, status: "needs_review", stopReason: "end_turn", sessionId: "fixed-session", updatedAt: new Date().toISOString() });
  client.batches.push([event(task, 2, text, { type: "result", status: "needs_review", artifacts: ["output.mp4"] })]);
}

async function send(coordinator: TaskCoordinator, workspace: string, taskId = "video", scope?: { allowedChanges: string[]; permittedMetadata: string[] }) {
  return coordinator.send({ model: "synthetic-user-choice", taskId, objective: "make a video", workspace, sessionId: "fixed-session", constraints: ["keep the approved script", "use WorkBuddy tools"], acceptanceCommands: ["inspect the exported media"], ...(scope ? { scope } : {}) });
}

test("idempotent parallel sends reserve one task and dispatch exactly one desktop prompt", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  const results = await Promise.all([send(coordinator, dir), send(coordinator, dir)]);
  assert.equal(client.sent.length, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(store.listAttempts("video").length, 1);
  assert.equal(store.get("video")?.state, "queued");
  const duplicate = await send(coordinator, dir);
  assert.equal(duplicate.created, false);
  assert.equal(client.sent.length, 1);
  assert.equal(store.get("video")?.objective, "make a video");
  await assert.rejects(() => coordinator.send({ model: "synthetic-user-choice", taskId: "video", objective: "different duplicate", workspace: dir }), /Task ID conflicts/);
  assert.equal(client.sent.length, 1);
});

test("initial submission identity survives reconnects and rejects changed routing, budget, model and requirements", async t => {
  const { dir, config, client, coordinator } = fixture(t);
  const original = { taskId: "stable", objective: "fix submission", workspace: dir, sessionId: "fixed-session", constraints: ["keep contract"], acceptanceCommands: ["check retry"], model: "approved", timeoutSeconds: 120 };
  await coordinator.send(original);
  const secondStore = new TaskStore(config.dbFile);
  try {
  const reconnected = new TaskCoordinator(config, secondStore, client);
  assert.equal((await reconnected.send({ ...original, workspace: path.join(dir, ".") })).created, false);
  for (const change of [{ objective: "other" }, { sessionId: "other" }, { model: "other" }, { timeoutSeconds: 121 }, { constraints: ["changed scope"] }, { acceptanceCommands: ["different check"] }, { workspace: path.dirname(dir) }]) {
    await assert.rejects(() => reconnected.send({ ...original, ...change }), /Task ID conflicts/);
  }
  assert.equal(client.sent.length, 1);
  assert.equal(secondStore.get("stable")?.objective, original.objective);
  } finally { secondStore.close(); }
});

test("parallel conflicting submissions reserve one contract and never dispatch the conflicting prompt", async t => {
  const { dir, client, coordinator, store } = fixture(t);
  const results = await Promise.allSettled([
    coordinator.send({ model: "synthetic-user-choice", taskId: "conflict", workspace: dir, sessionId: "fixed-session", objective: "first" }),
    coordinator.send({ model: "synthetic-user-choice", taskId: "conflict", workspace: dir, sessionId: "fixed-session", objective: "second" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal(client.sent.length, 1);
  assert.equal(store.get("conflict")?.objective, "first");
});

test("legacy submissions remain recoverable but reject observable objective conflicts", async t => {
  const { dir, client, coordinator, store } = fixture(t);
  store.createOrGet({ taskId: "legacy", messageId: "old", objective: "original", workspace: dir, state: "blocked" });
  assert.equal((await coordinator.send({ model: "synthetic-user-choice", taskId: "legacy", objective: "original", workspace: dir })).created, false);
  await assert.rejects(() => coordinator.send({ model: "synthetic-user-choice", taskId: "legacy", objective: "changed" }), /Task ID conflicts/);
  assert.equal(client.sent.length, 0);
});

test("refuses overlapping rework while WorkBuddy is running or waiting for permission", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  await assert.rejects(() => coordinator.continue({ taskId: "video", feedback: "change timing" }), /active worker/);
  const task = store.get("video")!;
  client.snapshots.set(task.attemptId!, { attemptId: task.attemptId!, taskId: task.taskId, status: "working", waitingInput: true, updatedAt: new Date().toISOString() });
  client.batches.push([event(task, 1, "Approve this render tool", { type: "input_request", status: "waiting_input" })]);
  await assert.rejects(() => coordinator.continue({ taskId: "video", feedback: "run again" }), /waiting for input/);
  assert.equal(client.sent.length, 1);
  assert.equal(store.get("video")?.state, "blocked");
  assert.match(store.get("video")?.blockingReason ?? "", /Approve this render tool/);
});

test("streams progress and final results separately and requires independent evidence for acceptance", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir, "video", { allowedChanges: ["output.mp4"], permittedMetadata: [] });
  const task = store.get("video")!;
  client.batches.push([event(task, 1, "WorkBuddy called the render tool", { type: "tool_call", status: "working" })]);
  assert.equal((await coordinator.sync("video")).state, "working");
  assert.equal(store.get("video")?.report, undefined);
  finish(client, task);
  const result = await coordinator.sync("video");
  assert.equal(result.state, "needs_review");
  assert.equal(result.sessionId, "fixed-session");
  assert.equal(result.runtimeSource, "desktop_interactive");
  assert.deepEqual(result.artifacts, ["output.mp4"]);
  assert.equal(store.listMessages("video").length, 2);
  await assert.rejects(() => coordinator.accept("video", "looks good", []), /concrete evidence/);
  await assert.rejects(() => coordinator.accept("video", "looks good", ["  "]), /concrete evidence/);
  assert.equal(store.get("video")?.state, "needs_review");
  const artifact = path.join(dir, "output.mp4");
  fs.writeFileSync(artifact, "fake test artifact, not a real video");
  const accepted = await coordinator.accept("video", "Media inspected by the reviewer", ["Independent check: file exists and has expected test bytes"], [artifact]);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.evidence?.length, 2);
  assert.ok(accepted.evidence?.some((value) => value.includes(artifact)));
  assert.equal(store.listAttempts("video")[0]?.state, "accepted");
});

test("keeps the verified desktop session, objective, original constraints and acceptance checks across rework", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const first = store.get("video")!;
  finish(client, first);
  await coordinator.sync("video");
  await coordinator.continue({ taskId: "video", feedback: "Correct the subtitle timing only", acceptanceCommands: ["check subtitle timing"] });
  const second = store.get("video")!;
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(second.attempt, 2);
  assert.equal(second.sessionId, "fixed-session");
  assert.deepEqual(second.constraints, ["keep the approved script", "use WorkBuddy tools"]);
  assert.deepEqual(second.acceptanceCommands, ["inspect the exported media", "check subtitle timing"]);
  assert.equal(client.sent[1]?.[3], "fixed-session");
  assert.equal(client.sent[1]?.[4]?.sessionMode, "existing");
  const prompt = client.sent[1]?.[0] ?? "";
  for (const value of [first.objective, ...first.constraints!, ...second.acceptanceCommands!, "Correct the subtitle timing only"]) assert.ok(prompt.includes(value));
  assert.equal(second.report, undefined);
  assert.deepEqual(second.artifacts, []);
  client.batches.push([event(first, 99, "Stale first-round completion", { type: "result", status: "needs_review", artifacts: ["stale.mp4"] }), event(second, 1, "Second round tool call", { type: "tool_call", status: "working" })]);
  const synced = await coordinator.sync("video");
  assert.equal(synced.state, "working");
  assert.equal(synced.lastEventSeq, 1);
  assert.equal(synced.report, undefined);
  assert.deepEqual(synced.artifacts, []);
  assert.equal(store.listMessages("video").length, 1);
  assert.equal(store.listMessages("video", 100, first.attemptId).length, 2);
});

test("concurrent rework dispatches one prompt and cannot add rejected requirements to its running attempt", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  finish(client, store.get("video")!);
  await coordinator.sync("video");
  const results = await Promise.allSettled([
    coordinator.continue({ taskId: "video", feedback: "first rework", acceptanceCommands: ["first rework check"] }),
    coordinator.continue({ taskId: "video", feedback: "second overlapping rework", acceptanceCommands: ["rejected second check"] }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(client.sent.length, 2);
  assert.deepEqual(store.get("video")?.acceptanceCommands, ["inspect the exported media", "first rework check"]);
});

test("a cancellation during an in-flight poll cannot be overwritten by its late terminal result", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  const paused = client.pauseNextRead();
  const polling = coordinator.sync("video");
  await paused.entered;
  const cancellation = await coordinator.cancel("video", "Stop while the operator inspects desktop execution");
  assert.equal(cancellation.remoteStopped, false);
  assert.equal(cancellation.task.state, "cancelled");
  assert.deepEqual(client.cancelled, [task.messageId]);
  paused.resume([event(task, 1, "TASK_STATUS: completed\nLate result", { type: "result", status: "needs_review" })]);
  assert.equal((await polling).state, "cancelled");
  assert.equal(store.get("video")?.state, "cancelled");
  await assert.rejects(() => coordinator.continue({ taskId: "video", feedback: "restart" }), /Cancelled tasks/);
});

test("a stale result cannot turn an accepted task back into review or replace its evidence", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  finish(client, task);
  await coordinator.sync("video");
  const paused = client.pauseNextRead();
  const polling = coordinator.sync("video");
  await paused.entered;
  await coordinator.accept("video", "checked", ["Independent artifact inspection passed"]);
  paused.resume([event(task, 3, "TASK_STATUS: completed\nRepeated old result", { type: "result", status: "needs_review" })]);
  assert.equal((await polling).state, "accepted");
  assert.deepEqual(store.get("video")?.evidence, ["Independent artifact inspection passed"]);
});

test("blocks a failed dispatch and rejects acceptance from unverified hidden backends", async (t) => {
  const { dir, config, store, client, coordinator } = fixture(t);
  client.sendError = new Error("No visible desktop session available");
  const result = await send(coordinator, dir);
  assert.equal(result.ok, false);
  assert.equal(result.task?.state, "blocked");
  assert.match(result.task?.blockingReason ?? "", /No visible desktop session/);
  assert.equal(store.listAttempts("video").length, 1);
  await assert.rejects(() => coordinator.accept("video", "accept failed task", ["some evidence"]), /finish the turn/);
  const hidden = new TaskCoordinator({ ...config, backend: "gateway" }, store, client);
  await assert.rejects(() => hidden.send({ objective: "test" }), /requires WORKBUDDY_BACKEND=desktop-queue or desktop-acp/);
});

test("an acceptance decision cannot overwrite a rework reserved by another MCP process", async (t) => {
  const { dir, config, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const originalAttempt = store.get("video")!;
  finish(client, originalAttempt);
  await coordinator.sync("video");
  const otherProcessStore = new TaskStore(config.dbFile);
  try {
  const reservedId = RunJournal.newId();
  const acceptAttempt = store.acceptAttempt.bind(store);
  store.acceptAttempt = (taskId, attemptId, patch, closedEvent, options) => {
    if (patch.state === "accepted") otherProcessStore.beginAttempt(taskId, { attemptId: reservedId, messageId: reservedId });
    return acceptAttempt(taskId, attemptId, patch, closedEvent, options);
  };
  await assert.rejects(() => coordinator.accept("video", "accept the old output", ["Old attempt was inspected"]), /changed|active|attempt|acceptance/i);
  const current = store.get("video")!;
  assert.equal(current.attemptId, reservedId);
  assert.equal(current.state, "queued");
  assert.deepEqual(current.evidence, []);
  assert.equal(store.listAttempts("video")[0]?.state, "needs_review");
  } finally { otherProcessStore.close(); }
});

// --- T2 reacceptance regressions (R1/R2/R3 residue) ---

test("terminal sync persists the consumption cursor and closes the task exactly once (T2-R3)", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  const attemptId = task.attemptId!;
  // Cancel: the business terminal state locks rework/acceptance, but evidence
  // collection and cursor advancement must continue.
  await coordinator.cancel("video", "operator requested");
  // After the cancellation the worker posts progress, the cancellation report
  // and the native idle confirmation 鈥?more journal events than fit one page.
  client.batches.push([
    event(task, 3, "progress 1", { type: "status" }),
    event(task, 4, "progress 2", { type: "status" }),
    event(task, 5, "TASK_STATUS: cancelled\nWork stopped by operator request", { type: "result", status: "cancelled" }),
  ]);
  client.snapshots.set(attemptId, { attemptId, taskId: "video", status: "cancelled", sessionId: "fixed-session", driver: "desktop-queue", stopReason: "native_idle_verified", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle", updatedAt: new Date().toISOString() });
  const smallPage = await coordinator.sync("video", 2);
  assert.ok(smallPage);
  const afterPageOne = store.get("video")!;
  assert.equal(afterPageOne.state, "cancelled", "the business terminal state survives cursor advancement");
  assert.notEqual(afterPageOne.lastMessageId, task.lastMessageId, "the consumption cursor advanced past the cancellation");
  const drained = await coordinator.sync("video", 2);
  assert.ok(drained);
  const drainedTask = store.get("video")!;
  assert.equal(drainedTask.state, "cancelled");
  const closed = store.listTaskEvents("video", { limit: 200 }).events.filter((item) => item.type === "task_closed");
  assert.equal(closed.length, 1, "task_closed is recorded exactly once despite repeated terminal syncs");
  await coordinator.sync("video", 2);
  assert.equal(store.listTaskEvents("video", { limit: 200 }).events.filter((item) => item.type === "task_closed").length, 1, "an extra terminal sync stays idempotent");
});

test("one sync covering waiting input, resume and the report keeps per-fact events and per-message texts (T2-R2)", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  client.batches.push([
    event(task, 2, "Approve the render export", { type: "status", status: "waiting_input" }),
    event(task, 3, "Native execution resumed.", { type: "status", status: "working" }),
    event(task, 4, "TASK_STATUS: completed\nUnique report text", { type: "result", status: "needs_review", artifacts: ["output.mp4"] }),
  ]);
  client.snapshots.set(task.attemptId!, { attemptId: task.attemptId!, taskId: "video", status: "needs_review", stopReason: "end_turn", sessionId: "fixed-session", updatedAt: new Date().toISOString() });
  const updated = await coordinator.sync("video");
  assert.equal(updated?.state, "needs_review");
  const events = store.listTaskEvents("video", { limit: 200 }).events;
  const requested = events.filter((item) => item.type === "input_requested");
  const resolved = events.filter((item) => item.type === "input_resolved");
  assert.equal(requested.length, 1, "the batch records the input request");
  assert.equal(resolved.length, 1, "the batch records the input resolution");
  const permissionMirror = events.find((item) => item.type === "status" && item.payload.status === "waiting_input");
  assert.ok(permissionMirror, "the permission request is mirrored");
  assert.equal(permissionMirror.payload.text, "Approve the render export", "the request keeps its own message text");
  const reportMirror = events.find((item) => item.type === "result");
  assert.ok(reportMirror, "the worker result is mirrored");
  assert.match(String(reportMirror.payload.text ?? ""), /Unique report text/, "the report mirror keeps the report text, not the first batch text");
  const report = updated?.report ?? null;
  assert.ok(report && report.status === "completed");
  // The final state must not be a leftover intermediate state: needs_review,
  // no stale blocking reason.
  assert.equal(updated?.blockingReason ?? null, null);
});

test("tampered report authentication folds into the revision on the next sync (T2-R1)", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const task = store.get("video")!;
  const attemptId = task.attemptId!;
  finish(client, task);
  await coordinator.sync("video");
  client.snapshots.set(attemptId, { attemptId, taskId: "video", status: "needs_review", sessionId: "fixed-session", driver: "desktop-queue", stopReason: "native_idle_verified", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle", reportDigest: "digest-before-tamper", reportAuthentication: { formatVersion: 1, taskId: "video", attemptId, sessionId: "fixed-session", runtimeSource: "desktop_queue", reportedStatus: "needs_review", reportDigest: "digest-before-tamper", authenticatedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() });
  await coordinator.sync("video");
  const before = store.get("video")!;
  assert.ok(before.runEvidenceDigest);
  // Tampering with the authentication content (a legal field shape) must be
  // visible: the digest carries the full authentication object, so the next
  // sync rewrites the revision.
  client.snapshots.set(attemptId, { ...client.snapshots.get(attemptId)!, reportAuthentication: { ...client.snapshots.get(attemptId)!.reportAuthentication!, reportDigest: "tampered-authentication-digest" } });
  await coordinator.sync("video");
  const after = store.get("video")!;
  assert.notEqual(after.revision, before.revision, "an authentication change produces a new revision");
  assert.notEqual(after.runEvidenceDigest, before.runEvidenceDigest);
  // Repeating an unchanged sync stays stable.
  await coordinator.sync("video");
  assert.equal(store.get("video")!.revision, after.revision, "an unchanged sync does not rewrite the revision");
});

test("a new attempt's stop evidence is recorded even without intermediate polling (T2-R2)", async (t) => {
  const { dir, store, client, coordinator } = fixture(t);
  await send(coordinator, dir);
  const first = store.get("video")!;
  finish(client, first);
  client.snapshots.set(first.attemptId!, { attemptId: first.attemptId!, taskId: "video", status: "needs_review", sessionId: "fixed-session", driver: "desktop-queue", stopReason: "native_idle_verified", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle", updatedAt: new Date().toISOString() });
  await coordinator.sync("video");
  const firstAttemptStop = store.listTaskEvents("video", { limit: 200 }).events.filter((item) => item.type === "native_stop_confirmed" && item.attemptId === first.attemptId);
  assert.equal(firstAttemptStop.length, 1);
  await coordinator.continue({ taskId: "video", feedback: "rework the transition" });
  const second = store.get("video")!;
  assert.notEqual(second.attemptId, first.attemptId);
  // beginAttempt clears the previous attempt's evidence; dispatch folds the
  // NEW attempt's dispatch-stage snapshot in its place (T2-R1 round 3). The
  // folded digest must carry NO stop proof, so it cannot suppress this
  // round's native_stop_confirmed.
  const folded = JSON.parse(second.runEvidenceDigest ?? "{}") as { attemptId?: string; stopped?: boolean; reportDigest?: string | null };
  assert.equal(folded.attemptId, second.attemptId, "the folded digest belongs to the new attempt");
  assert.equal(folded.stopped, false, "the folded digest records no stop proof");
  assert.equal(folded.reportDigest ?? null, null, "the folded digest records no report");
  // The next sync happens only after the new round's report and stop 鈥?the
  // old digest must not suppress the new round's native_stop_confirmed.
  client.batches.push([event(second, 2, "TASK_STATUS: completed\nSecond report", { type: "result", status: "needs_review", artifacts: ["output-2.mp4"] })]);
  client.snapshots.set(second.attemptId!, { attemptId: second.attemptId!, taskId: "video", status: "needs_review", sessionId: "fixed-session", driver: "desktop-queue", stopReason: "native_idle_verified", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle", updatedAt: new Date().toISOString() });
  await coordinator.sync("video");
  const secondAttemptStop = store.listTaskEvents("video", { limit: 200 }).events.filter((item) => item.type === "native_stop_confirmed" && item.attemptId === second.attemptId);
  assert.equal(secondAttemptStop.length, 1, "the second attempt records its own stop confirmation");
});
