import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import type { TaskCoordinator } from "../src/coordinator.js";
import { configuredDshCoordinator } from "../src/dsh-runtime.js";
import { DshTaskCoordinator } from "../src/dsh-coordinator.js";
import { discoverDshSessions, type DshTransport, type DshSelection } from "../src/dsh-client.js";
import { defaultModelPolicy, legacyFreeModelPolicy, AdmissionError } from "../src/collaboration.js";
import { RunJournal } from "../src/run-journal.js";
import { readTaskProjection } from "../src/task-view-reader.js";
import { workBuddyDshFreeRateVerifier, workBuddyDshRateObserver } from "../src/dsh-rate-verifier.js";
import { DeepSeekRpcError, type DeepSeekEvent } from "../src/deepseek-client.js";


function fixture(t: { after: (fn: () => void | Promise<void>) => void }, chosenModel = "deepseek-v4.1-flash") {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-adapter-")));
  const store = new TaskStore(path.join(dir, "tasks.sqlite")), runs = path.join(dir, "runs");
  const execution = { executorId: "dsh" as const, connectionId: "dsh-synthetic-host", providerId: "synthetic-provider", modelId: chosenModel, reasoningEffort: null };
  let selected: DshSelection | null = null, prompts = 0, selections = 0, busy = false, lost = false;
  let promptError: Error | undefined, selectionError: Error | undefined;
  const events: DeepSeekEvent[] = [];
  const checkKeys = (input: object, keys: string[]) => assert.deepEqual(Object.keys(input).sort(), keys.sort());
  const client: DshTransport = {
    resolveHostId(id) { assert.equal(id ?? execution.connectionId, execution.connectionId); return execution.connectionId; },
    async health() { return { capabilities: { automaticReview: false } }; },
    async sessions() { return { sessions: [{ sessionId: "original-session", workspace: dir, busy, attached: true }] }; },
    async create() { throw Error("Session creation is forbidden in this fixture"); },
    async session(input) { checkKeys(input, ["hostId", "sessionId"]); return { sessionId: input.sessionId, workspace: dir, busy, attached: true, selectedModel: selected }; },
    async models() { return { pricingVerified: false, models: [{ ...execution, credits: null, reasoningEfforts: [] }] }; },
    async selectModel(input) { checkKeys(input, ["hostId", "sessionId", "providerId", "modelId", "reasoningEffort"]); selections++; if (selectionError) throw selectionError; selected = { providerId: input.providerId, modelId: input.modelId, reasoningEffort: input.reasoningEffort }; return { sessionId: input.sessionId, workspace: dir, attached: true, selectedModel: selected }; },
    async prompt(input) { checkKeys(input, ["hostId", "sessionId", "requestId", "text", "expectedSelection"]); prompts++; if (promptError) throw promptError; return { requestId: input.requestId, accepted: true }; },
    async events(input) { checkKeys(input, ["hostId", "sessionId", "requestId", "afterSeq", "limit"]); if (lost) throw Error("private source error"); const page = events.filter(e => e.seq > input.afterSeq).slice(0, input.limit); return { events: page, cursor: page.at(-1)?.seq ?? input.afterSeq }; },
    async cancel(input) { checkKeys(input, ["hostId", "sessionId", "requestId"]); return { requested: true, stopped: true }; },
  };
  const free = async () => ({ credits: "x0.00", observedAt: new Date().toISOString() });
  const coordinator = new DshTaskCoordinator(store, client, runs, free);
  store.collaboration.registerWorkspace("project", dir, "Synthetic project");
  store.collaboration.setPolicy({ ...legacyFreeModelPolicy(), allowed: [...legacyFreeModelPolicy().allowed, execution] });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  function contract(taskId = "dsh-task") {
    const proposal = { schemaVersion: "workbuddy-executor/vnext-2", taskId, workspaceId: "project", title: "Synthetic DSH task", objective: "Verify the bounded synthetic adapter", execution, timeoutSeconds: 60, maxAttempts: 2, scope: { allowedChanges: ["src/example.ts"], permittedMetadata: [] }, requiredChecks: [], collaboration: { planId: "placeholder", expectedPlanRevision: "placeholder" } };
    const plan = store.collaboration.createPlan(proposal, coordinator.policy(), { mode: "manual", reason: "Explicit test action" });
    store.collaboration.authorizePlan(plan.planId, plan.revision, coordinator.policy(), "synthetic-user-action");
    return { ...proposal, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  }
  const send = (taskId?: string) => { const input = contract(taskId); return coordinator.send({ contract: input, objective: input.objective, sessionId: "original-session" }); };
  function event(type: DeepSeekEvent["type"], options: Partial<DeepSeekEvent> = {}) {
    const binding = store.dshBindings.forTask("dsh-task")!;
    const value: DeepSeekEvent = { seq: events.length, requestId: binding.requestId, type, timestamp: new Date().toISOString(), turnId: `${binding.sessionId}:turn:${store.get("dsh-task")!.attempt}`, rawType: type === "started" ? "turn/start" : ["completed", "failed", "cancelled"].includes(type) ? "turn/end" : "request/header", ...options };
    events.push(value); return value;
  }
  function finish(model = execution.modelId) {
    event("started"); event("progress", { data: { header: { config: { provider: execution.providerId, model } } } }); event("completed", { text: "TASK_STATUS: completed\nTEST_RESULT: synthetic verification passed" });
  }
  return { dir, store, runs, client, free, coordinator, contract, send, event, finish, events, execution,
    counts: () => ({ prompts, selections }), setBusy: (value: boolean) => { busy = value; }, setLost: (value: boolean) => { lost = value; }, setPromptError: (error?: Error) => { promptError = error; }, setSelectionError: (error?: Error) => { selectionError = error; }, setSelected: (value: DshSelection | null) => { selected = value; } };
}

test("DSH uses shared tasks, authenticated native report, revision and independent acceptance", async t => {
  const f = fixture(t), result = await f.send(); assert.equal(result.ok, true); f.finish();
  const done = await f.coordinator.sync("dsh-task"); assert.equal(done.state, "needs_review"); assert.equal(done.runtimeSource, "dsh");
  assert.equal(f.coordinator.executionStatus(done.taskId).remoteStopped, true);
  const before = fs.readFileSync(f.store.file), revision = done.revision;
  const projection = readTaskProjection({ store: f.store, runsDir: f.runs }, done.taskId);
  if (!projection.ok) throw Error(projection.code); assert.equal(projection.ok, true);
  assert.equal(projection.projection.facts?.report.state, "authenticated"); assert.equal(projection.projection.displayState, "needs_review");
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(f.store.get(done.taskId)!.revision, revision);
  assert.equal((await f.coordinator.accept(done.taskId, "Independent fixture verification", ["Inspected the native request model, report and stop identity"])).state, "accepted");
  assert.equal(f.store.listTaskEvents(done.taskId).events.filter(e => e.type === "task_closed").length, 1);
});

test("same task replay and coordinator reconstruction never dispatch again", async t => {
  const f = fixture(t), contract = f.contract(); const input = { contract, objective: contract.objective, sessionId: "original-session" };
  const results = await Promise.all([f.coordinator.send(input), f.coordinator.send(input)]);
  assert.equal(results.filter(r => r.created).length, 1); assert.equal(f.counts().prompts, 1);
  const restarted = new DshTaskCoordinator(f.store, f.client, f.runs, f.free);
  assert.equal((await restarted.send(input)).created, false); assert.equal(f.counts().selections, 1);
  await assert.rejects(restarted.send({ ...input, sessionId: "other" }), { code: "TASK_CONFLICT" });
});

test("explicit DSH rework retains the caller's revision when internal sync receives a new report", async t => {
  const f = fixture(t); await f.send();
  const original = f.store.get("dsh-task")!;
  f.finish();
  await assert.rejects(f.coordinator.continue({ taskId: original.taskId, feedback: "Feedback for the original view", operationId: "stale-rework",
    expectedRevision: original.revision, expectedAttemptId: original.attemptId }), { code: "STALE_REVISION" });
  assert.notEqual(f.store.get(original.taskId)!.revision, original.revision);
  assert.equal(f.store.get(original.taskId)!.attemptId, original.attemptId);
  assert.equal(f.store.operations.get("stale-rework")!.expectedRevision, original.revision);
  assert.deepEqual(f.counts(), { prompts: 1, selections: 1 });
});

test("lost dispatch response holds shared capacity and recovers by original events", async t => {
  const f = fixture(t); f.setPromptError(new Error("private credential must not leak")); const result = await f.send();
  assert.equal(result.ok, false); assert.equal(f.store.dshBindings.forTask("dsh-task")!.runOpen, true);
  await assert.rejects(f.send("other-task"), { code: "CAPACITY_OCCUPIED" });
  f.store.createOrGet({ taskId: "wb-task", objective: "Synthetic WorkBuddy peer", messageId: "pending", state: "blocked" });
  assert.throws(() => f.store.beginAttempt("wb-task", { attemptId: RunJournal.newId(), messageId: "next" }), { code: "CAPACITY_OCCUPIED" });
  f.finish(); assert.equal((await f.coordinator.sync("dsh-task")).state, "needs_review"); assert.equal(f.counts().prompts, 1);
  assert.equal(JSON.stringify(f.store.get("dsh-task")).includes("private credential"), false);
});

test("T4B: original DSH events reconcile an uncertain prompt and authorize a separate stopped closure", async t => {
  const f = fixture(t); f.setPromptError(new Error("Synthetic lost native receipt")); await f.send();
  const operation = f.store.operations.forTask("dsh-task").find(op => op.kind === "send")!;
  assert.equal(operation.state, "outcome_unknown");
  assert.deepEqual(f.store.recoveries.inspect(operation.operationId, f.runs).available, []);
  f.finish(); await f.coordinator.sync("dsh-task", 100, true);
  function decide(action: "close" | "reconcile") {
    const view = f.store.recoveries.inspect(operation.operationId, f.runs);
    const input = { action, operationId: `dsh-${action}`, targetOperationId: operation.operationId, expectedOperationToken: view.operationToken,
      expectedEvidenceToken: view.evidenceToken, expectedRevision: view.revision, expectedAttemptId: view.attemptId, reason: "Synthetic human verified original native events" };
    return f.store.recoveries.resolve(input, f.runs, f.store.recoveries.authorize(input, f.runs, "synthetic-human"));
  }
  assert.equal(decide("reconcile").proof, "dsh_receipt"); assert.equal(f.store.operations.occupant()!.taskId, "dsh-task");
  assert.equal(decide("close").proof, "native_stopped"); assert.equal(f.store.get("dsh-task")!.state, "cancelled");
  assert.equal(f.store.operations.occupant(), null); assert.deepEqual(f.counts(), { prompts: 1, selections: 1 });
});

test("T4B: explicit DSH recovery observation never sends a cancellation on model drift", async t => {
  const f = fixture(t); await f.send(); let cancels = 0;
  f.client.cancel = async () => { cancels++; return { requested: true, stopped: false }; };
  f.event("started"); f.event("progress", { data: { header: { config: { provider: f.execution.providerId, model: "different-model" } } } });
  await f.coordinator.sync("dsh-task", 100, true); assert.equal(cancels, 0); assert.equal(f.store.dshBindings.forTask("dsh-task")!.cancelRequested, false);
  assert.equal(f.store.operations.occupant()!.taskId, "dsh-task"); assert.deepEqual(f.counts(), { prompts: 1, selections: 1 });
});

test("cancel acknowledgements and idle never prove the original request stopped", async t => {
  const f = fixture(t); await f.send(); const result = await f.coordinator.cancel("dsh-task");
  assert.equal(result.remoteStopped, false); assert.equal(result.cancellationRequested, true);
  assert.equal(f.coordinator.executionStatus("dsh-task").state, "stop_unconfirmed");
  await assert.rejects(f.coordinator.continue({ taskId: "dsh-task", feedback: "retry" }), { code: "STOP_UNCONFIRMED" });
  f.event("started"); f.event("cancelled"); await f.coordinator.sync("dsh-task");
  assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, true); assert.equal(f.store.get("dsh-task")!.state, "cancelled");
});

test("same-session rework preserves selection and the immutable attempt budget", async t => {
  const f = fixture(t); await f.send(); f.finish(); await f.coordinator.sync("dsh-task"); const first = f.store.get("dsh-task")!;
  const result = await f.coordinator.continue({ taskId: first.taskId, feedback: "Inspect the edge case" }); assert.equal(result.ok, true);
  assert.notEqual(f.store.get(first.taskId)!.attemptId, first.attemptId); assert.equal(f.store.get(first.taskId)!.sessionId, first.sessionId); assert.equal(f.counts().selections, 1);
  f.events.length = 0; f.finish(); await f.coordinator.sync(first.taskId);
  await assert.rejects(f.coordinator.continue({ taskId: first.taskId, feedback: "third attempt" }), { code: "ATTEMPT_LIMIT" });
});

test("model drift and missing request evidence cannot authenticate a successful report", async t => {
  for (const variant of ["drift", "missing"]) {
    const f = fixture(t); await f.send();
    if (variant === "drift") f.finish("different-model"); else { f.event("started"); f.event("completed", { text: "A plausible success report" }); }
    assert.equal((await f.coordinator.sync("dsh-task")).state, "blocked"); assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, true);
    await assert.rejects(f.coordinator.accept("dsh-task", "review", ["evidence"]), { code: "REVIEW_REQUIRED" });
  }
});

test("foreign or unordered native events do not advance a cursor or change facts", async t => {
  const f = fixture(t); await f.send(); f.event("started", { requestId: "foreign" }); const before = f.store.get("dsh-task");
  await assert.rejects(f.coordinator.sync("dsh-task"), { code: "SOURCE_IDENTITY_MISMATCH" });
  assert.deepEqual(f.store.get("dsh-task"), before); assert.equal(f.store.dshBindings.forTask("dsh-task")!.cursor, -1);
  f.events.length = 0; f.event("started", { seq: -1 });
  assert.equal((await f.coordinator.sync("dsh-task")).state, "queued");
});

test("event pagination and replay preserve each request fact exactly once", async t => {
  const f = fixture(t); await f.send(); f.finish();
  await f.coordinator.sync("dsh-task", 1); assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, false);
  await f.coordinator.sync("dsh-task", 1); await f.coordinator.sync("dsh-task", 1);
  const count = f.store.listTaskEvents("dsh-task").events.length, revision = f.store.get("dsh-task")!.revision;
  await f.coordinator.sync("dsh-task", 1); assert.equal(f.store.listTaskEvents("dsh-task").events.length, count); assert.equal(f.store.get("dsh-task")!.revision, revision);
});

test("missing free-rate capability, busy session and unauthorized plan cause no preparation", async t => {
  const f = fixture(t), contract = f.contract(), input = { contract, objective: contract.objective, sessionId: "original-session" };
  await assert.rejects(new DshTaskCoordinator(f.store, f.client, f.runs).send(input), { code: "COST_VERIFICATION_UNAVAILABLE" });
  f.setBusy(true); await assert.rejects(f.coordinator.send({ ...input, operationId: "busy-check", expectedRevision: null, expectedAttemptId: null }), { code: "SESSION_BUSY" }); f.setBusy(false);
  await assert.rejects(f.coordinator.send({ ...input, contract: { ...contract, collaboration: { ...contract.collaboration, expectedPlanRevision: "old" } } }), { code: "PLAN_STALE" });
  assert.equal(f.store.listTasks().length, 0); assert.deepEqual(f.counts(), { prompts: 0, selections: 0 });
});

test("failed model preparation retains its identity and cannot be replayed or bypassed", async t => {
  const f = fixture(t); f.setSelectionError(new Error("native selection unavailable")); const input = f.contract();
  assert.equal((await f.coordinator.send({ contract: input, objective: input.objective, sessionId: "original-session" })).ok, false);
  assert.equal((await f.coordinator.send({ contract: input, objective: input.objective, sessionId: "original-session" })).created, false);
  assert.equal(f.counts().selections, 1); assert.equal(f.counts().prompts, 0);
  await assert.rejects(f.send("another-task"), { code: "CAPACITY_OCCUPIED" });
});

test("post-report file tampering is refused by independent acceptance", async t => {
  const f = fixture(t); await f.send(); f.finish(); await f.coordinator.sync("dsh-task");
  const journal = new RunJournal(f.runs, f.store.get("dsh-task")!.attemptId!); journal.save({ ...journal.snapshot()!, text: "tampered success" });
  await assert.rejects(f.coordinator.accept("dsh-task", "review", ["evidence"]), { code: "CONTRACT_INTEGRITY" });
  assert.equal(f.store.get("dsh-task")!.state, "needs_review");
});

test("source loss preserves original ownership and never retries a model prompt", async t => {
  const f = fixture(t); await f.send(); f.setLost(true); await f.coordinator.sync("dsh-task");
  assert.equal(f.store.dshBindings.forTask("dsh-task")!.runOpen, true); assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, false); assert.equal(f.counts().prompts, 1);
});

test("nested shared-store mutations roll back bindings and task creation together", t => {
  const f = fixture(t);
  assert.throws(() => f.store.atomic(() => { f.store.createOrGet({ taskId: "rolled-back", objective: "rollback", messageId: "pending", state: "queued" }); throw Error("fault"); }), /fault/);
  assert.equal(f.store.get("rolled-back"), undefined); assert.equal(f.store.listTaskEvents("rolled-back").events.length, 0);
  f.store.atomic(() => { try { f.store.atomic(() => { f.store.createOrGet({ taskId: "nested", objective: "rollback", messageId: "pending", state: "queued" }); throw Error("nested"); }); } catch { /* outer operation deliberately continues */ } f.store.createOrGet({ taskId: "outer", objective: "commit", messageId: "pending", state: "queued" }); });
  assert.equal(f.store.get("nested"), undefined); assert.equal(f.store.get("outer")?.taskId, "outer");
});

test("live registry discovery distinguishes missing, corrupt, ambiguous and selected without writes", t => {
  const f = fixture(t), filename = path.join(f.dir, "coord.sqlite");
  assert.equal(discoverDshSessions(f.dir, undefined, filename).reason, "registry_missing"); fs.writeFileSync(filename, "corrupt");
  assert.equal(discoverDshSessions(f.dir, undefined, filename).reason, "registry_unreadable"); fs.unlinkSync(filename);
  const db = new DatabaseSync(filename); db.exec("CREATE TABLE live_sessions(session_id TEXT,cwd TEXT,lease_until INTEGER)");
  for (const id of ["one", "two", "expired"]) db.prepare("INSERT INTO live_sessions VALUES (?,?,?)").run(id, f.dir, Date.now() + (id === "expired" ? -1000 : 60000)); db.close();
  const before = fs.readFileSync(filename); assert.equal(discoverDshSessions(f.dir, undefined, filename).reason, "ambiguous"); assert.equal(discoverDshSessions(f.dir, "one", filename).selected?.sessionId, "one"); assert.equal(discoverDshSessions(f.dir, "foreign", filename).reason, "session_not_matched"); assert.deepEqual(fs.readFileSync(filename), before);
});

test("source rate verifier uses exact bound provider, key and model; unknown or paid is refused", async t => {
  let credits: unknown = "x0.00", calls = 0;
  const server = http.createServer((req, res) => { calls++; assert.equal(req.url, "/v1/models"); assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, "Bearer synthetic-rate-key"); res.end(JSON.stringify({ data: [{ id: "deepseek-v4.1-flash", credits }] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("socket");
  const verifier = workBuddyDshFreeRateVerifier({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic-rate-key", providerId: "provider", connectionId: "host" });
  const execution = { executorId: "dsh" as const, providerId: "provider", connectionId: "host", modelId: "deepseek-v4.1-flash", reasoningEffort: null };
  assert.equal((await verifier(execution)).credits, "x0.00");
  for (credits of [null, "x1.00", "unknown"]) await assert.rejects(verifier(execution), { code: "MODEL_UNVERIFIED" });
  await assert.rejects(verifier({ ...execution, providerId: "foreign" }), { code: "MODEL_BINDING_CHANGED" }); assert.equal(calls, 4);
});


test("explicit native pre-admission rejection preserves the workflow without inventing a turn", async t => {
  const f = fixture(t); f.setPromptError(new DeepSeekRpcError("bridge/session-busy", "rejected", true));
  const result = await f.send(); assert.equal(result.ok, false);
  assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, true);
  assert.equal(f.store.dshBindings.forTask("dsh-task")!.runOpen, false);
  assert.equal(f.store.listTaskEvents("dsh-task").events.some(e => e.type === "dsh_completed"), false);
  f.setPromptError(undefined);
  await assert.rejects(f.send("second-task"), { code: "CAPACITY_OCCUPIED" });
  assert.equal(f.store.get("second-task"), undefined);
});

test("one wrong request model cannot be erased by a later correct request", async t => {
  const f = fixture(t); await f.send(); f.event("started");
  f.event("progress", { data: { header: { config: { provider: f.execution.providerId, model: "wrong-model" } } } });
  f.event("progress", { data: { header: { config: { provider: f.execution.providerId, model: f.execution.modelId } } } });
  f.event("completed", { text: "plausible report after a model change" });
  assert.equal((await f.coordinator.sync("dsh-task")).state, "blocked");
  await assert.rejects(f.coordinator.accept("dsh-task", "review", ["evidence"]), { code: "REVIEW_REQUIRED" });
});

test("elapsed fixed deadline requests stop and retains ownership until the original terminal event", async t => {
  const f = fixture(t); await f.send(); const journal = new RunJournal(f.runs, f.store.get("dsh-task")!.attemptId!);
  const now = Date.now; Date.now = () => Date.parse(journal.snapshot()!.deadline!) + 1000;
  try { assert.equal((await f.coordinator.sync("dsh-task")).state, "blocked"); } finally { Date.now = now; }
  assert.equal(f.coordinator.executionStatus("dsh-task").cancellationRequested, true);
  assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, false);
  f.event("started"); f.event("cancelled"); await f.coordinator.sync("dsh-task");
  assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, true); assert.equal(f.store.get("dsh-task")!.state, "blocked");
});

test("a report completed after the reserved deadline remains blocked", async t => {
  const f = fixture(t); await f.send(); f.finish();
  const journal = new RunJournal(f.runs, f.store.get("dsh-task")!.attemptId!);
  const ended = Date.parse(journal.snapshot()!.deadline!) + 1000; f.events.at(-1)!.timestamp = new Date(ended).toISOString();
  const now = Date.now; Date.now = () => ended;
  try { assert.equal((await f.coordinator.sync("dsh-task")).state, "blocked"); } finally { Date.now = now; }
  assert.equal(f.coordinator.executionStatus("dsh-task").remoteStopped, true);
  await assert.rejects(f.coordinator.accept("dsh-task", "review", ["evidence"]), { code: "REVIEW_REQUIRED" });
});

test("two SQLite connections cannot prepare different DSH tasks concurrently", async t => {
  const f = fixture(t), second = new TaskStore(f.store.file);
  try {
    const other = new DshTaskCoordinator(second, f.client, f.runs, f.free);
    const a = f.contract(), b = f.contract("second-task");
    const results = await Promise.allSettled([f.coordinator.send({ contract: a, objective: a.objective, sessionId: "original-session" }), other.send({ contract: b, objective: b.objective, sessionId: "original-session" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected" && r.reason.code === "CAPACITY_OCCUPIED").length, 1); assert.equal(f.counts().selections, 1); assert.equal(f.counts().prompts, 1);
  } finally { second.close(); }
});


test("the shared application service routes DSH explicitly and never falls back to WorkBuddy", async t => {
  const f = fixture(t), contract = f.contract();
  const legacy = { store: f.store } as unknown as TaskCoordinator;
  const input = { contract, objective: contract.objective, sessionId: "original-session", sessionMode: "existing" as const };
  await assert.rejects(new TaskApplicationService(legacy, 3, f.runs).send(input), { code: "EXECUTOR_UNAVAILABLE" });
  const service = new TaskApplicationService(legacy, 3, f.runs, f.coordinator);
  assert.equal((await service.send(input)).ok, true); f.finish(); await service.sync("dsh-task");
  assert.ok(service.statusView(f.store.get("dsh-task")!).allowedActions.includes("accept"));
  assert.throws(() => service.respond("dsh-task", "allow_once"), { code: "EXECUTOR_CAPABILITY_MISSING" });
  await assert.rejects(service.send({ ...input, taskId: "different" }), { code: "CAPACITY_OCCUPIED" });
  assert.equal((await service.accept("dsh-task", "Independent source and stop review", ["Verified original native request and current report"])).state, "accepted");
});

test("optional configuration does not widen policy, dispatch or collect rates", t => {
  const f = fixture(t), policy = f.coordinator.policy();
  assert.equal(configuredDshCoordinator(f.store, f.runs, {}), undefined);
  assert.ok(configuredDshCoordinator(f.store, f.runs, { WORKBUDDY_DSH_ENABLED: "1" }));
  assert.deepEqual(f.coordinator.policy(), policy); assert.equal(f.counts().prompts, 0);
});


test("native discovery excludes cold history and never selects among multiple attached sessions", async t => {
  const f = fixture(t);
  f.client.sessions = async () => ({ sessions: [{ sessionId: "one", workspace: f.dir, attached: true }, { sessionId: "two", workspace: f.dir, attached: true }, { sessionId: "cold", workspace: f.dir, attached: false }] });
  const found = await f.coordinator.discover(f.dir); assert.equal(found.reason, "ambiguous"); assert.equal(found.selected, undefined); assert.equal(found.candidates.length, 2);
  assert.equal((await f.coordinator.discover(f.dir, undefined, "one")).selected?.sessionId, "one");
  assert.equal((await f.coordinator.discover(f.dir, undefined, "cold")).reason, "session_not_matched");
  assert.deepEqual(f.counts(), { prompts: 0, selections: 0 });
});


test("default user choice admits the exact paid or unpriced model without substitution", async t => {
  for (const [id, credits] of [["vendor/paid-model", "x2.50"], ["another-unpriced-model", null]] as const) {
    const f = fixture(t, id);
    f.store.collaboration.setPolicy(defaultModelPolicy());
    const observer = credits === null ? undefined : async () => ({ credits, observedAt: new Date().toISOString() });
    const coordinator = new DshTaskCoordinator(f.store, f.client, f.runs, observer);
    const contract = f.contract();
    const result = await coordinator.send({ contract, objective: contract.objective, sessionId: "original-session" });
    assert.equal(result.ok, true);
    const task = f.store.get(contract.taskId)!;
    const attempt = f.store.collaboration.getAttempt(task.attemptId!)!;
    assert.equal(attempt.model.modelId, id); assert.equal(attempt.model.credits, credits);
    assert.equal(f.store.collaboration.getTaskAdmission(task.taskId)!.execution.modelId, id);
    assert.deepEqual(f.counts(), { prompts: 1, selections: 1 });
    f.finish(); assert.equal((await coordinator.sync(task.taskId)).state, "needs_review");
  }
});

test("missing price source remains unknown under user choice; free-only stays strict", async t => {
  const f = fixture(t, "chosen-paid-model"); f.store.collaboration.setPolicy(defaultModelPolicy());
  const unavailable = async () => { throw new AdmissionError("COST_VERIFICATION_UNAVAILABLE", "Unavailable"); };
  const coordinator = new DshTaskCoordinator(f.store, f.client, f.runs, unavailable), contract = f.contract();
  assert.equal((await coordinator.send({ contract, objective: contract.objective, sessionId: "original-session" })).ok, true);
  assert.equal(f.store.collaboration.getAttempt(f.store.get(contract.taskId)!.attemptId!)!.model.credits, null);
  const g = fixture(t); g.store.collaboration.setPolicy({ ...defaultModelPolicy(), requireFree: true });
  const strict = new DshTaskCoordinator(g.store, g.client, g.runs), denied = g.contract();
  await assert.rejects(strict.send({ contract: denied, objective: denied.objective, sessionId: "original-session" }), { code: "COST_VERIFICATION_UNAVAILABLE" });
  assert.deepEqual(g.counts(), { prompts: 0, selections: 0 });
});

test("user choice still needs real plan authorization and exact native readback", async t => {
  const f = fixture(t, "user-selected-model"); f.store.collaboration.setPolicy(defaultModelPolicy());
  const authorized = f.contract(), saved = f.store.collaboration.getPlan(authorized.collaboration.planId);
  const plan = f.store.collaboration.createPlan(saved.proposal, f.coordinator.policy(), { mode: "manual", reason: "Await actual user choice" });
  const input = { ...authorized, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  const coordinator = new DshTaskCoordinator(f.store, f.client, f.runs);
  await assert.rejects(coordinator.send({ contract: input, objective: input.objective, sessionId: "original-session" }), { code: "PLAN_CONFIRMATION_REQUIRED" });
  assert.deepEqual(f.counts(), { prompts: 0, selections: 0 });
  f.client.selectModel = async request => ({ sessionId: request.sessionId, workspace: f.dir, attached: true, selectedModel: { providerId: request.providerId, modelId: "unapproved-fallback", reasoningEffort: null } });
  const result = await coordinator.send({ contract: authorized, objective: authorized.objective, sessionId: "original-session" });
  assert.equal(result.ok, false); assert.equal("code" in result && result.code, "MODEL_BINDING_CHANGED"); assert.equal(f.counts().prompts, 0);
});

test("a legacy free-only task cannot be relaxed by switching the global default", async t => {
  const f = fixture(t); await f.send(); f.finish(); await f.coordinator.sync("dsh-task");
  f.store.collaboration.setPolicy(defaultModelPolicy());
  const paid = new DshTaskCoordinator(f.store, f.client, f.runs, async () => ({ credits: "x1.00", observedAt: new Date().toISOString() }));
  const result = await paid.continue({ taskId: "dsh-task", feedback: "Bounded rework" });
  assert.equal(result.ok, false); assert.equal("code" in result && result.code, "MODEL_UNVERIFIED"); assert.equal(f.counts().prompts, 1);
});

test("bound source observer reports paid and unknown prices without claiming free", async t => {
  let credits: unknown = "x2.50";
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ data: [{ id: "chosen-model", credits }] })));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("socket");
  const observe = workBuddyDshRateObserver({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic-key", providerId: "provider", connectionId: "host" });
  const selection = { executorId: "dsh" as const, providerId: "provider", connectionId: "host", modelId: "chosen-model", reasoningEffort: null };
  assert.equal((await observe(selection)).credits, "x2.50"); credits = null; assert.equal((await observe(selection)).credits, null);
  await assert.rejects(observe({ ...selection, providerId: "other" }), { code: "MODEL_BINDING_CHANGED" });
});
