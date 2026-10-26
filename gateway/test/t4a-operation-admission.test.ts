import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator, runEvidenceDigestOf } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { DshTaskCoordinator } from "../src/dsh-coordinator.js";
import type { DshTransport, DshSelection } from "../src/dsh-client.js";
import type { Config } from "../src/config.js";
import type { WorkBuddyClient } from "../src/workbuddy-client.js";
import { RunJournal, type RunSnapshot } from "../src/run-journal.js";
import { OperationOutcomeError, operationDigest } from "../src/operation-admission.js";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t4a-admission-")));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  const other = new TaskStore(store.file);
  const runs = path.join(dir, "runs");
  const config = { backend: "desktop-queue", dbFile: store.file, runsDir: runs, serviceConfigFile: path.join(dir, "none.json"), workbuddyConfigDir: dir, maxTaskAttempts: 3, taskTimeoutSeconds: 60 } as Config;
  let preparations = 0, prompts = 0;
  const snapshots = new Map<string, RunSnapshot>();
  const wb = (db: TaskStore) => new TaskCoordinator(config, db, {
    async sendMessage(_text: string, _workspace: string, _timeout: number, sessionId: string, options: { taskId: string; attemptId: string }) {
      prompts++;
      snapshots.set(options.attemptId, { taskId: options.taskId, attemptId: options.attemptId, sessionId, driver: "desktop-queue", runtimeSource: "desktop_queue", status: "queued", updatedAt: new Date().toISOString() });
      return { messageId: options.attemptId, raw: {} };
    }, runSnapshot(id: string) { return snapshots.get(id); }, async messages() { return []; }, cancel() { return true; },
  } as unknown as WorkBuddyClient,
  async (_config, input) => { preparations++; await Promise.resolve(); return { workspace: dir, sessionId: input.sessionId ?? "wb-session" }; },
  async (_config, sessionId, model) => ({ sessionId, modelId: model, selectedModel: model, credits: null, level: "selected", observedAt: new Date().toISOString() }));
  let selected: DshSelection | null = null;
  const transport: DshTransport = {
    resolveHostId: id => id ?? "synthetic-host", async health() { return {}; }, async sessions() { return { sessions: [] }; }, async create() { throw Error("No native session creation"); },
    async session(input) { return { sessionId: input.sessionId, workspace: dir, attached: true, busy: false, selectedModel: selected }; },
    async models() { return { pricingVerified: false, models: [{ providerId: "synthetic-provider", modelId: "user-paid-or-unknown", reasoningEfforts: [], credits: null }] }; },
    async selectModel(input) { preparations++; selected = { providerId: input.providerId, modelId: input.modelId, reasoningEffort: input.reasoningEffort }; return { sessionId: input.sessionId, workspace: dir, attached: true, selectedModel: selected }; },
    async prompt(input) { prompts++; return { accepted: true, requestId: input.requestId }; }, async events(input) { return { cursor: input.afterSeq, events: [] }; }, async cancel() { return { requested: true }; },
  };
  const workbuddy = wb(store), dsh = new DshTaskCoordinator(other, transport, runs);
  const service = new TaskApplicationService(workbuddy, 3, runs);
  store.collaboration.registerWorkspace("project", dir, "Synthetic T4A project");
  const contract = (taskId: string, executorId: "workbuddy" | "dsh" = "workbuddy") => {
    const proposal = { schemaVersion: "workbuddy-executor/vnext-2", taskId, workspaceId: "project", title: "T4A synthetic task", objective: "Verify durable admission", execution: { executorId, connectionId: executorId === "dsh" ? "synthetic-host" : "local-workbuddy", providerId: executorId === "dsh" ? "synthetic-provider" : "workbuddy-native", modelId: "user-paid-or-unknown", reasoningEffort: null }, timeoutSeconds: 60, maxAttempts: 3, scope: { allowedChanges: ["src/example.ts"], permittedMetadata: [] }, requiredChecks: [], collaboration: { planId: "placeholder", expectedPlanRevision: "placeholder" } };
    const plan = service.createCollaborationPlan(proposal, { mode: "manual", reason: "Actual synthetic user selection", operationId: `plan:${taskId}` });
    service.authorizeCollaborationPlan(plan.planId, plan.revision, "synthetic-user-action", { operationId: `authorize:${taskId}` });
    return { ...proposal, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  };
  const send = (taskId = "task", operationId = `send:${taskId}`) => {
    const c = contract(taskId);
    return { contract: c, taskId, objective: c.objective, sessionId: "wb-session", operationId, expectedRevision: null, expectedAttemptId: null };
  };
  t.after(() => { other.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4 }); });
  return { dir, store, other, runs, config, wb, workbuddy, dsh, service, contract, send, snapshots, counts: () => ({ preparations, prompts }) };
}

test("same operation and parallel submissions save one result and one native side effect", async t => {
  const f = fixture(t), input = f.send();
  const [a, b] = await Promise.all([f.service.send(input), f.service.send(input)]);
  assert.deepEqual(a, b); assert.deepEqual(f.counts(), { preparations: 1, prompts: 1 });
  f.store.update("task", { state: "needs_review", reviewNote: "Later revision" });
  assert.deepEqual(await f.service.send(input), a, "completed replay precedes stale revision checks");
  assert.equal(f.store.operations.get(input.operationId)?.state, "succeeded");
  assert.equal(f.store.operations.get(input.operationId)?.attemptId, a.task.attemptId);
});

test("one operationId conflicts on every behavior field and canonical key order is stable", async t => {
  const f = fixture(t), input = f.send(); await f.service.send(input);
  for (const patch of [{ model: "different" }, { timeoutSeconds: 61 }, { objective: "different" }, { sessionId: "other" }, { taskId: "other" }, { expectedRevision: "old" }, { contract: { ...input.contract, collaboration: { ...input.contract.collaboration, planId: "other" } } }]) {
    await assert.rejects(f.service.send({ ...input, ...patch }), { code: "OPERATION_CONFLICT" });
  }
  assert.equal(operationDigest({ b: [1, 2], a: "x" }), operationDigest({ a: "x", b: [1, 2] }));
  assert.notEqual(operationDigest({ feedback: "one" }), operationDigest({ feedback: "two" }));
  await assert.rejects(f.service.send({ ...input, contract: { ...input.contract, execution: { ...input.contract.execution, executorId: "dsh" } } }), { code: "OPERATION_CONFLICT" });
  assert.deepEqual(f.counts(), { preparations: 1, prompts: 1 });
});

test("stale revision, stale attempt and fabricated initial attempt reject transactionally without effects", async t => {
  const f = fixture(t), input = f.send(); await f.service.send(input);
  const task = f.store.get("task")!;
  for (const [patch, code] of [[{ expectedRevision: "old", expectedAttemptId: task.attemptId }, "STALE_REVISION"], [{ expectedRevision: task.revision, expectedAttemptId: "old" }, "STALE_ATTEMPT"]] as const) {
    await assert.rejects(f.service.continue({ taskId: task.taskId, feedback: "Bound feedback", operationId: code, ...patch }), { code });
    assert.equal(f.store.operations.get(code), null);
  }
  const fresh = f.send("fresh");
  await assert.rejects(f.service.send({ ...fresh, expectedAttemptId: "fabricated" }), { code: "STALE_ATTEMPT" });
  await assert.rejects(f.service.continue({ taskId: task.taskId, feedback: "missing versions", operationId: "missing" }), { code: "OPERATION_PRECONDITION_REQUIRED" });
  assert.deepEqual(f.counts(), { preparations: 1, prompts: 1 });
});

test("WorkBuddy and DSH on independent connections compete before preparing either native model", async t => {
  const f = fixture(t), a = f.send("wb"), c = f.contract("dsh", "dsh");
  const b = { contract: c, objective: c.objective, sessionId: "dsh-session", operationId: "send:dsh", expectedRevision: null, expectedAttemptId: null };
  const results = await Promise.allSettled([f.workbuddy.send(a), f.dsh.send(b)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected" && r.reason.code === "CAPACITY_OCCUPIED").length, 1);
  assert.deepEqual(f.counts(), { preparations: 1, prompts: 1 });
  assert.equal(f.store.get("dsh"), undefined);
  assert.equal(f.store.operations.get("send:dsh"), null);
});

test("concurrent same operation on separate connections only grants one execution right", async t => {
  const f = fixture(t);
  let release!: () => void, effects = 0;
  const barrier = new Promise<void>(resolve => release = resolve);
  const options = { operationId: "same", expectedRevision: null, expectedAttemptId: null };
  const first = f.store.operations.run("send", "same-task", "workbuddy", { model: "chosen" }, options, {}, async () => {
    await barrier; f.store.operations.nativeBoundary("same-task"); effects++; return { ok: true };
  });
  assert.throws(() => f.other.operations.run("send", "same-task", "workbuddy", { model: "chosen" }, options, {}, async () => { effects++; return { ok: true }; }), { code: "OUTCOME_UNKNOWN", operationId: "same" });
  release(); const result = await first;
  assert.deepEqual(await f.other.operations.run("send", "same-task", "workbuddy", { model: "chosen" }, options, {}, async () => assert.fail("no second effect")), result);
  assert.equal(effects, 1);
});

test("DSH wins first and blocks WorkBuddy, legacy queue and a changed executor", async t => {
  const f = fixture(t), c = f.contract("dsh", "dsh");
  const input = { contract: c, objective: c.objective, sessionId: "dsh-session", operationId: "dsh-first", expectedRevision: null, expectedAttemptId: null };
  const result = await f.dsh.send(input);
  assert.deepEqual(await f.service.send(input), result, "completed DSH receipt remains replayable without a live DSH adapter");
  await assert.rejects(f.service.send({ ...input, model: "replacement" }), { code: "OPERATION_CONFLICT" });
  await assert.rejects(f.workbuddy.send(f.send("wb")), { code: "CAPACITY_OCCUPIED" });
  assert.throws(() => f.store.operations.enqueue("other", RunJournal.newId(), { model: "another" }, () => assert.fail("must not enqueue")), { code: "CAPACITY_OCCUPIED" });
  await assert.rejects(f.workbuddy.send({ taskId: "dsh", objective: c.objective, sessionId: "wb-session", model: "another" }), { code: "EXECUTOR_UNAVAILABLE" });
  assert.deepEqual(f.counts(), { preparations: 1, prompts: 1 });
});

test("same-task stopped rework retains workflow slot, binding and immutable budget", async t => {
  const f = fixture(t), input = f.send(); await f.service.send(input);
  const first = f.store.get("task")!;
  const stopped: RunSnapshot = { ...f.snapshots.get(first.attemptId!)!, status: "needs_review", nativeStopSource: "native_idle", nativeStoppedAt: new Date().toISOString() };
  f.snapshots.set(first.attemptId!, stopped);
  f.store.update("task", { state: "needs_review", runtimeSource: "desktop_queue", runEvidenceDigest: runEvidenceDigestOf(stopped) });
  const current = f.store.get("task")!, owner = f.store.operations.occupant();
  await assert.rejects(f.workbuddy.send(f.send("other")), { code: "CAPACITY_OCCUPIED" });
  const terms = f.store.getContract("task"); assert.equal(terms.state, "found");
  const rework = { taskId: "task", feedback: "Fix only the approved issue", operationId: "rework", expectedRevision: current.revision, expectedAttemptId: current.attemptId };
  const result = await f.service.continue(rework);
  assert.equal(result.task.sessionId, first.sessionId); assert.notEqual(result.task.attemptId, first.attemptId);
  assert.equal(result.task.attempt, 2); assert.deepEqual(f.store.getContract("task"), terms);
  assert.deepEqual(f.store.operations.occupant(), owner); assert.equal(f.counts().preparations, 1);
  assert.equal(f.counts().prompts, 2);
  assert.deepEqual(await f.service.continue(rework), result);
  await assert.rejects(f.service.continue({ ...rework, feedback: "Different behavior" }), { code: "OPERATION_CONFLICT" });
  assert.equal(f.counts().prompts, 2);
});

test("cancel requests, idle, timeout and TTL never release an uncertain operation", async t => {
  const f = fixture(t);
  await assert.rejects(f.store.operations.run("send", "unknown", "workbuddy", { model: "selected" }, { operationId: "unknown", expectedRevision: null, expectedAttemptId: null }, { sessionId: "original" }, async () => {
    f.store.createOrGet({ taskId: "unknown", messageId: "pending", objective: "Uncertain execution", state: "queued" });
    f.store.operations.nativeBoundary("unknown"); throw Error("Receipt lost");
  }), /Receipt lost/);
  const now = Date.now; Date.now = () => now() + 365 * 86400000;
  try {
    f.store.update("unknown", { state: "cancelled", cancelNote: "Requested only", runEvidenceDigest: JSON.stringify({ stopped: false, state: "idle", timedOut: true }) });
    await assert.rejects(f.workbuddy.send(f.send("next")), { code: "CAPACITY_OCCUPIED" });
  } finally { Date.now = now; }
  assert.equal(f.other.operations.get("unknown")?.state, "outcome_unknown");
  assert.equal(f.other.operations.occupant()?.taskId, "unknown");
});

test("unknown legacy tasks including no-attempt preparations cannot be ignored on migration", async t => {
  const f = fixture(t);
  f.store.createOrGet({ taskId: "legacy", objective: "Historical preparation", messageId: "pending", state: "blocked" });
  const before = f.store.get("legacy");
  const reopened = new TaskStore(f.store.file);
  try {
    await assert.rejects(f.wb(reopened).send(f.send("next")), { code: "CAPACITY_OCCUPIED" });
    assert.deepEqual(reopened.get("legacy"), before);
    assert.equal(reopened.listTaskEvents("legacy").events.some(e => e.type === "native_stop_confirmed"), false);
  } finally { reopened.close(); }
  assert.deepEqual(f.counts(), { preparations: 0, prompts: 0 });
});

test("only matching stop facts and a real closed workflow allow the next admission", async t => {
  const f = fixture(t), input = f.send(); await f.workbuddy.send(input);
  const task = f.store.get("task")!;
  f.store.update("task", { state: "accepted", runEvidenceDigest: JSON.stringify({ attemptId: "wrong", stopped: true }) });
  await assert.rejects(f.workbuddy.send(f.send("next")), { code: "CAPACITY_OCCUPIED" });
  f.store.update("task", { runEvidenceDigest: JSON.stringify({ attemptId: task.attemptId, stopped: true }) });
  await assert.rejects(f.workbuddy.send(f.send("next")), { code: "CAPACITY_OCCUPIED" });
  f.store.appendTaskEvent({ taskId: "task", attemptId: task.attemptId!, type: "task_closed", occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), actor: "synthetic-trusted-review", payload: {}, sourceRef: null });
  assert.equal((await f.workbuddy.send(f.send("next"))).ok, true);
  assert.equal(f.store.operations.occupant()?.taskId, "next");
});

test("admission fault rolls back both operation and slot; receipt fault preserves possible effects", async t => {
  const f = fixture(t), db = new DatabaseSync(f.store.file);
  try {
    db.exec("CREATE TRIGGER fail_admit BEFORE INSERT ON task_operations WHEN NEW.kind='send' BEGIN SELECT RAISE(ABORT,'synthetic admission fault'); END");
    await assert.rejects(f.workbuddy.send(f.send()), /synthetic admission fault/);
    assert.equal(f.store.operations.get("send:task"), null); assert.equal(f.store.operations.occupant(), null);
    assert.equal(f.store.get("task"), undefined); assert.deepEqual(f.counts(), { preparations: 0, prompts: 0 });
    db.exec("DROP TRIGGER fail_admit; CREATE TRIGGER fail_receipt BEFORE UPDATE ON task_operations WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic receipt fault'); END");
    await assert.rejects(f.workbuddy.send(f.send()), /synthetic receipt fault/);
    assert.equal(f.other.operations.get("send:task")?.state, "outcome_unknown");
    assert.equal(f.other.operations.occupant()?.taskId, "task"); assert.equal(f.counts().prompts, 1);
    await assert.rejects(f.wb(f.other).send(f.send()), { code: "OUTCOME_UNKNOWN", operationId: "send:task" });
    assert.equal(f.counts().prompts, 1);
  } finally { db.close(); }
});

test("a failure saving both receipt and error still identifies the durable uncertain operation", async t => {
  const f = fixture(t), input = f.send(), db = new DatabaseSync(f.store.file);
  try {
    db.exec("CREATE TRIGGER fail_all_receipts BEFORE UPDATE ON task_operations WHEN NEW.state IN ('succeeded','outcome_unknown') BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
    await assert.rejects(f.workbuddy.send(input), { operationId: "send:task", outcomeCode: "OUTCOME_UNKNOWN" });
    assert.equal(f.other.operations.get("send:task")?.state, "effect_started");
    assert.equal(f.other.operations.occupant()?.taskId, "task");
    await assert.rejects(f.wb(f.other).send(input), { code: "OUTCOME_UNKNOWN", operationId: "send:task" });
    assert.equal(f.counts().prompts, 1);
  } finally { db.close(); }
});

test("client approval and free labels cannot authorize an unconfirmed collaboration plan", async t => {
  const f = fixture(t), authorized = f.contract("task");
  const plan = f.service.createCollaborationPlan(authorized, { mode: "manual", reason: "Await the actual user", operationId: "unconfirmed-plan" });
  const contract = { ...authorized, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  const input = { contract, objective: contract.objective, sessionId: "wb-session", operationId: "unapproved-send", expectedRevision: null, expectedAttemptId: null, approved: true, verified: true, free: true };
  await assert.rejects(f.workbuddy.send(input), { code: "PLAN_CONFIRMATION_REQUIRED" });
  assert.deepEqual(f.counts(), { preparations: 0, prompts: 0 });
  assert.equal(f.store.get("task"), undefined); assert.equal(f.store.operations.occupant(), null);
});

test("trusted plan creation and confirmation are atomic replayable operations with plan revisions", t => {
  const f = fixture(t), input = f.send();
  const p = f.service.getCollaborationPlan(input.contract.collaboration.planId);
  assert.equal(p.authorizedAt !== null, true);
  const before = f.store.operations.get("authorize:task");
  const repeated = f.service.authorizeCollaborationPlan(p.planId, p.revision, "synthetic-user-action", { operationId: "authorize:task" });
  assert.equal(repeated.authorizedAt, p.authorizedAt); assert.deepEqual(f.store.operations.get("authorize:task"), before);
  assert.throws(() => f.service.authorizeCollaborationPlan(p.planId, "old", "synthetic-user-action", { operationId: "stale-plan" }), { code: "PLAN_STALE" });
  assert.equal(f.store.operations.get("stale-plan"), null);
  assert.deepEqual(f.counts(), { preparations: 0, prompts: 0 });
});

/** A real child runs the compiled storage implementation and exits without a receipt. */
function child(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    processChild.stdout.on("data", chunk => stdout += chunk); processChild.stderr.on("data", chunk => stderr += chunk);
    processChild.on("error", reject); processChild.on("exit", code => resolve({ code, stdout, stderr }));
  });
}
const storageURL = pathToFileURL(path.resolve(import.meta.dirname, "../dist/task-store.js")).href;
const childScript = `import fs from 'node:fs'; const {TaskStore}=await import(${JSON.stringify(storageURL)});
 const [file,id,executor,mode,ready,go]=process.argv.slice(1); const store=new TaskStore(file);
 if(ready){fs.writeFileSync(ready,'ready');while(!fs.existsSync(go))await new Promise(r=>setTimeout(r,5));}
 try {await store.operations.run('send',id,executor,{id,model:'synthetic'},{operationId:mode==='same'?'same-operation':id,expectedRevision:null,expectedAttemptId:null},{sessionId:'original'},async()=>{
   if(mode==='before')process.exit(71);
   store.operations.nativeBoundary(id); fs.appendFileSync(file+'.effects',id+'\\n');
   if(mode==='after')process.exit(72);
   await new Promise(r=>setTimeout(r,50)); return {ok:true};
 });console.log('admitted');}catch(e){console.log(e.code??e.message);}finally{store.close();}`;

test("two real processes using different executors have one shared SQLite preparation slot", async t => {
  const f = fixture(t), go = path.join(f.dir, "go"), ready = [path.join(f.dir, "one"), path.join(f.dir, "two")];
  const jobs = ready.map((r, i) => child(childScript, [f.store.file, `child-${i}`, i ? "dsh" : "workbuddy", "compete", r, go]));
  const deadline = Date.now() + 15000;
  while (!ready.every(r => fs.existsSync(r))) { assert.ok(Date.now() < deadline, "children must reach barrier"); await new Promise(r => setTimeout(r, 10)); }
  fs.writeFileSync(go, "go");
  const results = await Promise.all(jobs);
  assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
  assert.equal(results.filter(r => r.stdout.includes("admitted")).length, 1);
  assert.equal(results.filter(r => r.stdout.includes("CAPACITY_OCCUPIED")).length, 1);
  assert.equal(fs.readFileSync(f.store.file + ".effects", "utf8").trim().split("\n").length, 1);
});

for (const mode of ["before", "after"] as const) test(`crash ${mode} native boundary retains the original operation across process restart`, async t => {
  const f = fixture(t), result = await child(childScript, [f.store.file, "crash-task", "workbuddy", mode, "", ""]);
  assert.equal(result.code, mode === "before" ? 71 : 72, result.stderr);
  assert.equal(f.other.operations.get("crash-task")?.state, mode === "before" ? "reserved" : "effect_started");
  assert.equal(f.other.operations.occupant()?.taskId, "crash-task");
  assert.throws(() => f.other.operations.run("send", "crash-task", "workbuddy", { id: "crash-task", model: "synthetic" }, { operationId: "crash-task", expectedRevision: null, expectedAttemptId: null }, {}, async () => assert.fail("never retry")), (error: unknown) => error instanceof OperationOutcomeError && error.operationId === "crash-task");
  await assert.rejects(f.workbuddy.send(f.send("replacement")), { code: "CAPACITY_OCCUPIED" });
  assert.equal(f.other.operations.listUnfinished().length, 1);
  assert.equal(fs.existsSync(f.store.file + ".effects"), mode === "after");
});


test("legacy rework retains its original model, duration and saved attempt budget", async t => {
  const f = fixture(t);
  await f.workbuddy.send({ taskId: "legacy-budget", objective: "Synthetic legacy admission", sessionId: "wb-session", model: "original-choice" });
  const task = f.store.get("legacy-budget")!;
  const stopped: RunSnapshot = { ...f.snapshots.get(task.attemptId!)!, status: "needs_review", nativeStopSource: "native_idle", nativeStoppedAt: new Date().toISOString() };
  f.snapshots.set(task.attemptId!, stopped);
  f.store.update(task.taskId, { state: "needs_review", runEvidenceDigest: runEvidenceDigestOf(stopped) });
  await assert.rejects(f.workbuddy.continue({ taskId: task.taskId, feedback: "Different model", model: "substitute" }), { code: "MODEL_BINDING_CHANGED" });
  await assert.rejects(f.workbuddy.continue({ taskId: task.taskId, feedback: "Longer duration", timeoutSeconds: 61 }), { code: "TASK_CONFLICT" });
  f.store.update(task.taskId, { sessionId: "replacement-session" });
  await assert.rejects(f.workbuddy.continue({ taskId: task.taskId, feedback: "Cannot switch sessions" }), { code: "MODEL_BINDING_CHANGED" });
  f.store.update(task.taskId, { sessionId: task.sessionId });
  f.config.backend = "desktop-acp";
  await assert.rejects(f.workbuddy.continue({ taskId: task.taskId, feedback: "Cannot switch adapters" }), { code: "EXECUTOR_UNAVAILABLE" });
  f.config.backend = "desktop-queue";
  f.config.maxTaskAttempts = 99;
  f.store.update(task.taskId, { attempt: 3 });
  await assert.rejects(f.workbuddy.continue({ taskId: task.taskId, feedback: "Cannot extend saved budget" }), /attempt limit/);
  assert.equal(f.counts().prompts, 1);
});
