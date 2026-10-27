import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { DesktopQueue, assertDesktopCaller, windowsWorkerCommand } from "../src/desktop-queue.js";
import { TaskStore } from "../src/task-store.js";
import { SelectedModelClient as WorkBuddyClient } from "./support/selected-model-client.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { RunJournal } from "../src/run-journal.js";
import { readWorkerResult } from "../src/worker-result.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-queue-unit-"));
  const config: Config = { ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), workbuddyConfigDir: dir, runsDir: path.join(dir, "runs") };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("unit-session", dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  // Unit fixture only. Production CLI always uses actual native process ancestry.
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (taskId = "unit-task") => coordinator.send({ model: "synthetic-user-choice", taskId, objective: "Unit transport fixture", workspace: dir, sessionId: "unit-session", constraints: ["Keep original constraint"], timeoutSeconds: 120 });
  return { dir, config, store, client, coordinator, queue, send };
}

test("queue dispatch does not claim provenance; native claim/report survive reconnect and same-session rework", async (t) => {
  const f = fixture(t);
  await f.send();
  const initial = f.store.get("unit-task")!;
  assert.equal(initial.runtimeSource, undefined);
  const claim = await f.queue.claim("unit-session", 0);
  assert.equal(claim.status, "task");
  if (claim.status !== "task") throw new Error("Expected claim");
  const firstAttempt = claim.attemptId;
  assert.equal((await f.coordinator.sync("unit-task")).state, "working");
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "", artifacts: [] }), /empty report/);
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: unit fixture report", artifacts: [] });
  const restarted = new TaskCoordinator(f.config, f.store, new WorkBuddyClient(f.config));
  const result = await restarted.sync("unit-task");
  assert.equal(result.state, "needs_review");
  assert.equal(result.runtimeSource, "desktop_queue");
  f.queue.observeNative(firstAttempt, { state: "idle", workspace: f.dir });
  await restarted.continue({ taskId: "unit-task", feedback: "Correct the third item" });
  const second = await f.queue.claim("unit-session", 0);
  if (second.status !== "task") throw new Error("Expected rework claim");
  assert.notEqual(second.attemptId, firstAttempt);
  assert.equal(second.sessionId, claim.sessionId);
  assert.match(second.prompt, /Keep original constraint/);
  assert.match(second.prompt, /Correct the third item/);
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "late old report", artifacts: [] }), /no longer active/);
  f.queue.report({ ...second, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: rework fixture report", artifacts: [] });
  f.queue.observeNative(second.attemptId, { state: "idle", workspace: f.dir });
  assert.equal((await restarted.accept("unit-task", "Unit state-machine verification", ["Verified unit transport report and same session identity"])).state, "accepted");
});

test("queue rejects wrong leases, sessions and overlapping claims", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  assert.throws(() => f.queue.progress({ ...claim, leaseToken: "wrong", text: "x" }), /execution lease/);
  assert.throws(() => f.queue.progress({ ...claim, sessionId: "other", text: "x" }), /execution lease/);
  await assert.rejects(f.send("second-task"), { code: "CAPACITY_OCCUPIED" });
  assert.equal(f.store.get("second-task"), undefined);
  assert.equal((await f.queue.claim("unit-session", 0)).status,"retry");
  const r = { attemptId: RunJournal.newId(), taskId: "unsupported", prompt: "x", timeoutSeconds: 10, sessionId: "unit-session" };
  assert.throws(()=>f.queue.start({ ...r, model: "different" }), { code: "CAPACITY_OCCUPIED" });
  f.queue.report({...claim,status:"completed",text:"fixture stopped",artifacts:[]});
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir});
  await f.coordinator.accept("unit-task", "verified", ["Verified stopped original report"]);
  f.queue.start({ ...r, model: "different" });
  assert.equal(new RunJournal(f.config.runsDir!, r.attemptId).request().model, "different");
  assert.throws(() => f.queue.start({ ...r, sessionMode: "new" }), { code: "OPERATION_CONFLICT" });
  assert.throws(() => f.queue.start({ ...r, workspace: path.join(f.dir, "other") }), { code: "OPERATION_CONFLICT" });
});

test("queue cancellation is observed by native report; deadline blocks without resending", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  await f.coordinator.cancel("unit-task");
  assert.equal(f.queue.progress({ ...claim, text: "Checking cancellation" }).cancellationRequested, true);
  assert.equal(f.queue.report({ ...claim, status: "completed", text: "Stopped", artifacts: [] }).status, "cancelled");
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir});
  await f.coordinator.sync("unit-task"); // cancellation + observed stop persist the closure before another workflow
  await f.send("deadline-task");
  const task = f.store.get("deadline-task")!;
  const journal = new RunJournal(f.queue.root, task.attemptId!);
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  const blocked = await f.coordinator.sync("deadline-task");
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.blockingReason!, /no automatic resend/);
  assert.equal((await f.queue.claim("unit-session", 0)).status, "retry");
});

test("cancellation before claim is definitive and cannot be claimed later", async t => {
  const f = fixture(t); await f.send(); const task = f.store.get("unit-task")!;
  assert.equal(f.client.cancel(task.messageId), true);
  const journal = new RunJournal(f.queue.root, task.attemptId!);
  assert.equal(journal.snapshot()?.stopReason, "cancelled_before_claim");
  assert.equal((await f.queue.claim("unit-session", 0)).status, "retry");
  assert.equal((await f.coordinator.sync("unit-task")).state, "cancelled");
  assert.equal(fs.existsSync(path.join(journal.dir, "claim.json")), false);
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, true);
});

test("cancellation status distinguishes a requested stop from the worker's acknowledged stop", async t => {
  const f = fixture(t); await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const cancelled = await f.coordinator.cancel("unit-task");
  assert.equal(cancelled.remoteStopped, false);
  assert.equal(cancelled.execution.state, "stop_unconfirmed");
  assert.equal(f.coordinator.executionStatus("unit-task").cancellationRequested, true);
  f.queue.report({ ...claim, status: "cancelled", text: "Native worker stopped", artifacts: [] });
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, false);
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, true);
  assert.equal(f.coordinator.executionStatus("unit-task").state, "stopped");
});

test("production worker rejects Codex-side invocation", (t) => {
  const f = fixture(t);
  assert.throws(() => assertDesktopCaller({ ...f.config, cliElectronPath: path.join(f.dir, "nonexistent-native-desktop") }), /real WorkBuddy desktop/);
});

test("active queue listeners are visible only during native claim wait", async (t) => {
  const f = fixture(t);
  const waiting = f.queue.claim("unit-session", 0.3);
  assert.equal(f.queue.listeners().length, 1);
  assert.equal((await f.client.health("unit-session")).ready, true);
  assert.equal((await waiting).status, "retry");
  assert.equal(f.queue.listeners().length, 0);
});

test("bootstrap instructions do not pretend to start a worker and preserve quoted installation paths", (t) => {
  const f = fixture(t);
  const prepared = f.queue.prepare("unit-session");
  assert.equal(prepared.started, false);
  assert.equal(prepared.workspace, f.dir);
  assert.match(prepared.prompt, /claim --session-id 'unit-session'/);
  assert.match(prepared.prompt, /```bash/);
  assert.match(prepared.prompt, /不要沿用历史命令/);
  if (process.platform === "win32") assert.match(prepared.prompt, /cd '[^\n]+' && '[^\n]+' '[^\n]+' claim/);
  assert.match(prepared.prompt, /成功回报后也结束/);
  assert.doesNotMatch(prepared.prompt, /连续重试 4 次/);
  assert.throws(() => f.queue.prepare("missing-session"), /not registered/);
});

test("Windows worker command anchors the workspace and shortens the helper path", () => {
  const command = windowsWorkerCommand(
    "C:/Program Files/nodejs/node.exe",
    "C:/Users/中文/project/workbuddy-executor-community/gateway/dist/desktop-worker-cli.js",
    "C:/Users/中文/project/work/sample",
  );
  assert.equal(command, "cd 'C:/Users/中文/project/work/sample' && 'C:/Program Files/nodejs/node.exe' '../../workbuddy-executor-community/gateway/dist/desktop-worker-cli.js'");
  assert.doesNotMatch(command, /work\/workbuddy-executor-community/);
});

test("Windows worker command quotes shell characters and preserves a different drive", () => {
  const command = windowsWorkerCommand("C:/Program Files/nodejs/node.exe", "D:/gateway ' $()/dist/desktop-worker-cli.js", "C:/sample ' $()/work");
  assert.equal(command, "cd 'C:/sample '\\'' $()/work' && 'C:/Program Files/nodejs/node.exe' 'D:/gateway '\\'' $()/dist/desktop-worker-cli.js'");
  assert.throws(() => windowsWorkerCommand("node", "C:/gateway/worker.js", "C:/sample"), /absolute Windows paths/);
  assert.throws(() => windowsWorkerCommand("C:/node.exe", "worker.js", "C:/sample"), /absolute Windows paths/);
  assert.throws(() => windowsWorkerCommand("C:/node.exe", "C:/gateway/worker.js", "sample"), /absolute Windows paths/);
});

test("file-based reporting preserves quoted paths, multiline text and shell metacharacters without shell interpolation", async t => {
  const f = fixture(t); await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const resultFile = claim.reporting.resultFile;
  const claimFile = path.join(path.dirname(resultFile), "worker-context.json");
  const artifact = path.join(f.dir, "中文 ' $() report.css");
  fs.writeFileSync(artifact, "actual output");
  const text = "Actual result\nQuotes: ' \" and literal $() `payload`";
  fs.writeFileSync(resultFile, JSON.stringify({ status: "completed", text, artifacts: [artifact] }));
  const input = readWorkerResult(f.config, claimFile, resultFile);
  assert.equal(input.text, text);
  assert.deepEqual(input.artifacts, [artifact]);
  assert.match(claim.reporting.command, /finish --claim-file/);
  assert.equal(claim.reporting.command.includes(claim.leaseToken), false);
  assert.equal(claim.reporting.command.includes(text), false);
  assert.equal(f.queue.report(input).status, "needs_review");
  const journal = new RunJournal(f.queue.root, claim.attemptId);
  const events = journal.events(0, Infinity).length;
  assert.equal(f.queue.report(input).status, "needs_review");
  assert.equal(journal.events(0, Infinity).length, events, "an identical retry must only acknowledge the existing report");
  assert.throws(() => f.queue.report({ ...input, text: "conflicting result" }), /conflicting/);
  assert.throws(() => f.queue.report({ ...input, leaseToken: "wrong" }), /execution lease/);
});

test("file reporting rejects malformed, oversized, relative-artifact and cross-attempt results", async t => {
  const f = fixture(t); await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const file = claim.reporting.resultFile;
  const context = path.join(path.dirname(file), "worker-context.json");
  for (const result of [{ status: "completed", text: "", artifacts: [] }, { status: "bogus", text: "x", artifacts: [] }, { status: "completed", text: "x", artifacts: ["relative.css"] }]) {
    fs.writeFileSync(file, JSON.stringify(result));
    assert.throws(() => readWorkerResult(f.config, context, file));
  }
  fs.writeFileSync(file, " ".repeat(65537));
  assert.throws(() => readWorkerResult(f.config, context, file), /size limit/);
  assert.throws(() => readWorkerResult(f.config, context, path.join(f.dir, "other-result.json")), /this execution attempt/);
  assert.equal(new RunJournal(f.queue.root, claim.attemptId).snapshot()?.status, "working");
});

test("task attempts stop at the configured budget while preserving prior output", async t => {
  const f = fixture(t); f.config.maxTaskAttempts = 2;
  await f.send();
  for (let index = 0; index < 2; index++) {
    const claim = await f.queue.claim("unit-session", 0);
    if (claim.status !== "task") throw new Error("Expected claim");
    f.queue.report({ ...claim, status: "completed", text: "actual fixture output", artifacts: [] });
    f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
    await f.coordinator.sync("unit-task");
    if (!index) await f.coordinator.continue({ taskId: "unit-task", feedback: "one correction" });
  }
  await assert.rejects(() => f.coordinator.continue({ taskId: "unit-task", feedback: "third round" }), /attempt limit/);
  assert.equal(f.store.listAttempts("unit-task").length, 2);
  assert.equal(f.store.get("unit-task")?.state, "needs_review");
});

test("a worker report cannot confirm native stop, allow rework or acceptance, or release a later claim", async t => {
  const f = fixture(t); await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const text = "TASK_STATUS: completed\nTEST_RESULT: fixture output";
  f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  await f.coordinator.sync("unit-task");
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, false);
  assert.equal(f.coordinator.executionStatus("unit-task").state, "report_received");
  await assert.rejects(() => f.coordinator.continue({ taskId: "unit-task", feedback: "too early" }), /not been confirmed stopped/);
  await assert.rejects(() => f.coordinator.accept("unit-task", "too early", ["Inspected fixture"]), /not been confirmed stopped/);
  const journal = new RunJournal(f.queue.root, claim.attemptId);
  const reported = journal.snapshot()!;
  journal.save({ ...reported, driver: undefined });
  await assert.rejects(() => f.coordinator.accept("unit-task", "missing driver", ["Inspected fixture"]), /not been confirmed stopped/);
  await assert.rejects(() => f.coordinator.continue({ taskId: "unit-task", feedback: "missing driver" }), /not been confirmed stopped/);
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, false);
  journal.save(reported);
  await assert.rejects(f.send("next-task"), { code: "CAPACITY_OCCUPIED" });
  assert.equal((await f.queue.claim("unit-session",0)).status,"retry");
  for (const state of ["busy", "waiting_input"] as const) {
    f.queue.observeNative(claim.attemptId, { state, workspace: f.dir });
    assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, false);
  }
  assert.throws(() => f.queue.observeNative(claim.attemptId, { state: "offline", workspace: f.dir }), /does not match/);
  assert.throws(() => f.queue.observeNative(claim.attemptId, { state: "idle", workspace: path.join(f.dir, "other") }), /does not match/);
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, true);
  assert.equal(new RunJournal(f.queue.root, claim.attemptId).snapshot()?.text, text);
  assert.equal((await f.coordinator.accept("unit-task", "verified", ["Inspected fixture"])).state, "accepted");
  await f.send("next-task");
  assert.equal((await f.queue.claim("unit-session", 0)).status, "task");
});

test("legacy report stop reasons remain unconfirmed until a native observation", async t => {
  const f = fixture(t); await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const journal = new RunJournal(f.queue.root, claim.attemptId);
  journal.save({ ...journal.snapshot()!, status: "needs_review", text: "Legacy report", stopReason: "end_turn" });
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, false);
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  assert.equal(f.coordinator.executionStatus("unit-task").remoteStopped, true);
  assert.equal(journal.snapshot()?.text, "Legacy report");
});

test("a rejected queue dispatch remains inspectable and can be corrected without losing its task", async (t) => {
  const f = fixture(t);
  const rejected = await f.coordinator.send({ model: "synthetic-user-choice", taskId: "rejected-mode", objective: "Fixture task", workspace: f.dir, sessionId: "unit-session", sessionMode: "new" });
  assert.equal(rejected.ok, false);
  assert.equal((await f.coordinator.sync("rejected-mode")).state, "blocked");
  await f.coordinator.continue({ taskId: "rejected-mode", feedback: "Use the native desktop model already selected" });
  assert.equal((await f.queue.claim("unit-session", 0)).status, "task");
});
