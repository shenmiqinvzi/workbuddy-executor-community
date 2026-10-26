import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator, runEvidenceDigestOf } from "../src/coordinator.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal, writePrivateJson } from "../src/run-journal.js";
import { NativeDesktopRpcTrigger } from "../src/native-desktop-trigger.js";
import { ensureWorkspace } from "../src/workspace-manager.js";

function fixture(t: TestContext) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t4a-boundary-")));
  const workspace = path.join(dir, "project"); fs.mkdirSync(workspace);
  const config = { backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"),
    tokenFile: path.join(dir, "unused.json"), workbuddyConfigDir: path.join(dir, "native"), serviceConfigFile: path.join(dir, "service.json"),
    cliElectronPath: path.join(dir, "unused.exe"), taskTimeoutSeconds: 60, claimTimeoutSeconds: 30, maxTaskAttempts: 3 } as Config;
  fs.mkdirSync(config.workbuddyConfigDir);
  const native = new DatabaseSync(path.join(config.workbuddyConfigDir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?,?,1,NULL)").run("original", workspace); native.close();
  const store = new TaskStore(config.dbFile), other = new TaskStore(config.dbFile);
  let sends = 0, prepareHook: (() => Promise<void>) | undefined;
  const client = {
    async sendMessage(_text: string, _space: string, _duration: number, sessionId: string, options: { taskId: string; attemptId: string }) {
      sends++;
      new RunJournal(config.runsDir!, options.attemptId).save({ taskId: options.taskId, attemptId: options.attemptId, sessionId, driver: "desktop-queue", status: "queued", updatedAt: new Date().toISOString() });
      return { messageId: options.attemptId, raw: {} };
    },
    async messages(): Promise<import("../src/workbuddy-client.js").LocalMessage[]> { return []; },
    runSnapshot(id: string) { return new RunJournal(config.runsDir!, id).snapshot(); },
  } as unknown as WorkBuddyClient;
  const coordinator = new TaskCoordinator(config, store, client,
    async (_cfg, input) => { if (prepareHook) await prepareHook(); return { workspace: input.workspace, sessionId: input.sessionId ?? "original" }; },
    async (_cfg, sessionId, model) => ({ sessionId, modelId: model, selectedModel: model, credits: null, level: "selected", observedAt: new Date().toISOString() }));
  store.collaboration.registerWorkspace("project", workspace, "Synthetic project");
  function contract() {
    const proposal = { schemaVersion: "workbuddy-executor/vnext-2", taskId: "task", workspaceId: "project", title: "Boundary test", objective: "Verify original admission",
      execution: { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "user-choice", reasoningEffort: null },
      scope: { allowedChanges: ["src/example.ts"], permittedMetadata: [] }, requiredChecks: [], timeoutSeconds: 60, maxAttempts: 3,
      collaboration: { planId: "placeholder", expectedPlanRevision: "placeholder" } };
    const plan = store.collaboration.createPlan(proposal, coordinator.modelPolicy(), { mode: "manual", reason: "Explicit synthetic user action" });
    store.collaboration.authorizePlan(plan.planId, plan.revision, coordinator.modelPolicy(), "synthetic-user");
    return { ...proposal, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  }
  function input() { const c = contract(); return { contract: c, taskId: c.taskId, objective: c.objective, sessionId: "original", operationId: "send-op", expectedRevision: null, expectedAttemptId: null }; }
  function stop() {
    const task = store.get("task")!, journal = new RunJournal(config.runsDir!, task.attemptId!);
    const snapshot = { ...journal.snapshot()!, status: "needs_review" as const, nativeStopSource: "native_idle" as const, nativeStoppedAt: new Date().toISOString() };
    journal.save(snapshot); store.update("task", { state: "needs_review", runEvidenceDigest: runEvidenceDigestOf(snapshot) });
    return store.get("task")!;
  }
  t.after(() => { other.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return { dir, workspace, config, store, other, coordinator, client, input, stop, count: () => sends, pausePreparation: (hook: () => Promise<void>) => { prepareHook = hook; } };
}

test("F01: two historical queues on one database cannot execute without original durable admission", async t => {
  const f = fixture(t), queues: Array<{ queue: DesktopQueue; sessionId: string; attemptId: string }> = [];
  for (let n = 0; n < 2; n++) {
    const sessionId = `old-${n}`, workspace = path.join(f.dir, `old-project-${n}`); fs.mkdirSync(workspace);
    const native = new DatabaseSync(path.join(f.config.workbuddyConfigDir, "workbuddy.db")); native.prepare("INSERT INTO sessions VALUES (?,?,1,NULL)").run(sessionId, workspace); native.close();
    const config = { ...f.config, runsDir: path.join(f.dir, `old-runs-${n}`) }, attemptId = RunJournal.newId(), taskId = `old-task-${n}`;
    f.store.createOrGet({ taskId, attemptId, attempt: 1, messageId: attemptId, objective: "Historical queued task", workspace, sessionId, state: "queued" });
    const journal = new RunJournal(config.runsDir, attemptId);
    writePrivateJson(path.join(journal.dir, "request.json"), { taskId, attemptId, workspace, sessionId, model: "chosen-old-model", prompt: "Original task", timeoutSeconds: 60 });
    journal.save({ taskId, attemptId, sessionId, driver: "desktop-queue", status: "queued", deadline: new Date(Date.now() + 60000).toISOString(), updatedAt: new Date().toISOString() });
    writePrivateJson(path.join(journal.dir, "model-ready.json"), { attemptId, sessionId, model: "chosen-old-model" });
    queues.push({ queue: new DesktopQueue(config, () => ({ desktopPid: process.pid })), sessionId, attemptId });
  }
  for (const item of queues) {
    assert.equal((await item.queue.claim(item.sessionId, 0)).status, "retry");
    assert.equal(fs.existsSync(path.join(item.queue.root, item.attemptId, "claim.json")), false);
  }
  assert.equal(f.store.operations.occupant(), null);
  assert.deepEqual(f.store.operations.listUnfinished(), []);
  assert.equal(f.store.listTasks().length, 2);
});

test("F01/F04: an explicitly selected new task can be claimed through the production queue", async t => {
  const f = fixture(t), coordinator = new TaskCoordinator(f.config, f.store, new WorkBuddyClient(f.config));
  const sent = await coordinator.send({ taskId: "selected", objective: "Authorized selected task", workspace: f.workspace, sessionId: "original", model: "user-choice" });
  const attemptId = sent.task.attemptId!, journal = new RunJournal(f.config.runsDir!, attemptId);
  writePrivateJson(path.join(journal.dir, "model-ready.json"), { attemptId, sessionId: "original", model: "user-choice" });
  const claim = await new DesktopQueue(f.config, () => ({ desktopPid: process.pid })).claim("original", 0);
  assert.equal(claim.status, "task");
  assert.equal(f.store.operations.get(`queue:${attemptId}`)?.state, "succeeded");
  assert.equal(f.store.operations.occupant()?.taskId, "selected");
});

test("F02: missing stop evidence with a saved submitted wake never permits rework", async t => {
  const f = fixture(t); await f.coordinator.send(f.input());
  const original = f.store.get("task")!, journal = new RunJournal(f.config.runsDir!, original.attemptId!);
  writePrivateJson(path.join(journal.dir, "wake.json"), { state: "submitted", sessionId: "original", attemptId: original.attemptId, wakeId: `wake-${original.attemptId}` });
  fs.rmSync(path.join(journal.dir, "state.json")); f.store.update("task", { state: "blocked", blockingReason: "Original evidence is missing" });
  const task = f.store.get("task")!;
  await assert.rejects(f.coordinator.continue({ taskId: "task", feedback: "No overlapping recovery", operationId: "rework", expectedRevision: task.revision, expectedAttemptId: task.attemptId }), { code: "STOP_UNCONFIRMED" });
  assert.equal(f.count(), 1); assert.equal(f.store.get("task")!.attemptId, original.attemptId);
  assert.equal(f.store.operations.occupant()?.taskId, "task");
});

test("F03: only the exact persisted preparation route may enter once", async t => {
  const f = fixture(t), selected = f.input();
  writePrivateJson(f.config.serviceConfigFile!, { version: 1, sessionId: "original", workspace: f.workspace, projectDir: f.dir, nodeBin: process.execPath, cdpPort: 18491,
    dbFile: f.config.dbFile, runsDir: f.config.runsDir, workbuddyConfigDir: f.config.workbuddyConfigDir, cliElectronPath: f.config.cliElectronPath });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  f.pausePreparation(async () => { entered(); await barrier; });
  const sending = f.coordinator.send(selected); await started;
  const saved = NativeDesktopRpcTrigger.prototype.setModel, calls: string[] = [];
  NativeDesktopRpcTrigger.prototype.setModel = async (sessionId, model) => { calls.push(`${sessionId}:${model}`); return { sessionId, model }; };
  const request = { workspace: f.workspace, sessionId: "original", model: "user-choice", title: selected.contract.title, admissionTaskId: "task", admissionOperationId: selected.operationId };
  try {
    await assert.rejects(ensureWorkspace(f.config, { ...request, admissionOperationId: undefined }), { code: "OPERATION_REQUIRED" });
    for (const patch of [{ model: "unapproved" }, { sessionId: "replacement" }, { workerKey: "other-task" }, { title: "Changed title" }]) await assert.rejects(ensureWorkspace(f.config, { ...request, ...patch }), { code: "MODEL_BINDING_CHANGED" });
    assert.equal(calls.length, 0);
    assert.equal((await ensureWorkspace(f.config, request)).sessionId, "original");
    await assert.rejects(ensureWorkspace(f.config, request), { code: "OUTCOME_UNKNOWN", operationId: selected.operationId });
    assert.deepEqual(calls, ["original:user-choice"]);
  } finally { NativeDesktopRpcTrigger.prototype.setModel = saved; release(); await sending; }
});

test("F04: production SDK rejects an unselected new task but preserves historical query replay", async t => {
  const f = fixture(t), coordinator = new TaskCoordinator(f.config, f.store, new WorkBuddyClient(f.config));
  await assert.rejects(coordinator.send({ taskId: "unselected", objective: "No model choice", workspace: f.workspace, sessionId: "original" }), { code: "MODEL_SELECTION_REQUIRED" });
  assert.equal(f.store.get("unselected"), undefined); assert.equal(f.store.operations.occupant(), null);
  assert.equal((await new DesktopQueue(f.config, () => ({ desktopPid: process.pid })).claim("original", 0)).status, "retry");
  f.store.createOrGet({ taskId: "historical", objective: "Existing original task", messageId: "pending", state: "blocked" });
  assert.equal((await coordinator.send({ taskId: "historical", objective: "Existing original task" })).created, false);
  assert.equal(f.store.operations.occupant(), null);
});

test("F03: the production preparation route creates and configures one original session", async t => {
  const f = fixture(t), selected = { ...f.input(), sessionId: undefined };
  writePrivateJson(f.config.serviceConfigFile!, { version: 1, sessionId: "original", workspace: f.workspace, projectDir: f.dir, nodeBin: process.execPath, cdpPort: 18491,
    dbFile: f.config.dbFile, runsDir: f.config.runsDir, workbuddyConfigDir: f.config.workbuddyConfigDir, cliElectronPath: f.config.cliElectronPath });
  const savedCreate = NativeDesktopRpcTrigger.prototype.createWorker, savedModel = NativeDesktopRpcTrigger.prototype.setModel;
  const created: string[] = [], configured: string[] = [];
  NativeDesktopRpcTrigger.prototype.createWorker = async (workspace, sessionId) => {
    created.push(sessionId);
    const db = new DatabaseSync(path.join(f.config.workbuddyConfigDir, "workbuddy.db"));
    try { db.prepare("INSERT INTO sessions VALUES (?,?,1,NULL)").run(sessionId, workspace); } finally { db.close(); }
    return { sessionId, workspace };
  };
  NativeDesktopRpcTrigger.prototype.setModel = async (sessionId, model) => { configured.push(sessionId); return { sessionId, model }; };
  const coordinator = new TaskCoordinator(f.config, f.store, f.client, undefined,
    async (_cfg, sessionId, model) => ({ sessionId, modelId: model, selectedModel: model, credits: null, level: "selected", observedAt: new Date().toISOString() }));
  try {
    const sent = await coordinator.send(selected);
    assert.equal(sent.ok, true); assert.equal(created.length, 1); assert.deepEqual(configured, created);
    assert.equal(sent.task.sessionId, created[0]);
    assert.equal(f.store.operations.get(selected.operationId)!.preparationSessionId, created[0]);
    assert.deepEqual(await coordinator.send(selected), sent);
    assert.equal(created.length, 1); assert.equal(f.count(), 1);
  } finally { NativeDesktopRpcTrigger.prototype.createWorker = savedCreate; NativeDesktopRpcTrigger.prototype.setModel = savedModel; }
});

test("F05: a newly synchronized report cannot replace an operation's original expected revision", async t => {
  const f = fixture(t); await f.coordinator.send(f.input()); f.stop();
  f.store.update("task", { report: { rawText: "Previously reviewed report", filesChanged: [], commandsRun: [] } });
  const task = f.store.get("task")!;
  let read = false;
  f.client.messages = async () => {
    if (read) return []; read = true;
    return [{ message_id: `${task.attemptId}:new`, role: "assistant", content: ["TASK_STATUS: completed\nA new report"], metadata: { attemptId: task.attemptId, sessionId: task.sessionId, runtimeSource: "desktop_queue", type: "result", status: "needs_review", eventSeq: 1 } }];
  };
  const request = { taskId: "task", feedback: "Feedback for the old report", operationId: "rework", expectedRevision: task.revision, expectedAttemptId: task.attemptId };
  await assert.rejects(f.coordinator.continue(request), { code: "STALE_REVISION" });
  assert.notEqual(f.store.get("task")!.revision, task.revision);
  assert.equal(f.store.operations.get("rework")!.expectedRevision, task.revision);
  assert.equal(f.store.get("task")!.attemptId, task.attemptId); assert.equal(f.count(), 1);
});

test("F06: saved explicit and compatibility operations replay after current timeout defaults change", async t => {
  const f = fixture(t), input = f.input(), original = await f.coordinator.send(input);
  f.config.taskTimeoutSeconds = 120;
  assert.deepEqual(await f.coordinator.send(input), original); assert.equal(f.count(), 1);
  const g = fixture(t), initial = { taskId: "legacy", objective: "Selected legacy task", workspace: g.workspace, sessionId: "original", model: "user-choice" };
  await g.coordinator.send(initial); g.config.taskTimeoutSeconds = 120;
  assert.equal((await g.coordinator.send(initial)).created, false); assert.equal(g.count(), 1);
});
