/**
 * L08 acceptance line — admission, dispatch and native-boundary anomalies.
 *
 * Every case drives the real application service, the real durable store and a
 * synthetic native executor, then asserts persisted state, journal files and
 * the number of native calls. Matching an error message alone is never treated
 * as proof: the same expectation is re-read from SQLite or from the run
 * directory after the failure.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OperationOutcomeError } from "../src/operation-admission.js";
import { acceptanceFixture } from "./support/finish-acceptance-fixture.js";
import { SelectedModelClient } from "./support/selected-model-client.js";

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

test("L08 no explicit model: nothing is prepared, dispatched or reserved", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { dispatch: false });
  // Layer 1: a vnext-2 proposal or contract that omits an exact model cannot even
  // become an authorized plan, so the refusal happens before any admission.
  await assert.rejects(f.sendRaw({ model: "  " }), (error: unknown) => {
    assert.ok(["PLAN_STALE", "INVALID_CONTRACT", "MODEL_SELECTION_REQUIRED"].includes(String(codeOf(error))), `unexpected model gate ${String(error)}`);
    return true;
  });
  // Layer 2: the legacy (contract-free) admission keeps its own explicit gate.
  await assert.rejects(
    f.coordinator.send({ taskId: "l08-legacy-model", objective: "synthetic legacy task", model: "  ", workspace: f.workspace }),
    { code: "MODEL_SELECTION_REQUIRED" },
  );
  assert.equal(f.counters.preparations, 0, "a model-less send must not reach preparation");
  assert.equal(f.counters.prompts, 0);
  assert.equal(f.store().operations.occupant(), null, "no workflow capacity may be consumed");
  assert.equal(f.store().get(f.taskId) ?? null, null, "no task row may be created without an authorized model");
  assert.equal(f.store().get("l08-legacy-model") ?? null, null);
});

test("L08 preparation failure is an unknown outcome, keeps the slot and never re-prepares", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { dispatch: false, prepareFails: true });
  const operationId = "l08-op-preparation";
  await assert.rejects(f.sendRaw({ operationId }));
  assert.equal(f.counters.preparations, 1, "the native preparation was attempted exactly once");
  // The preparation crosses nativeBoundary() before it runs, because a native session
  // may already exist. A crash is therefore an unresolved outcome, never a clean reject.
  assert.equal(f.store().operations.get(operationId)?.state, "outcome_unknown");
  const task = f.store().get(f.taskId);
  assert.equal(task?.attemptId ?? null, null, "no attempt row may exist after a failed preparation");
  assert.equal(task?.state, "blocked");
  assert.equal(f.store().operations.occupant()?.taskId, f.taskId, "the immutable contract still owns the single slot");
  assert.equal(fs.existsSync(f.runsDir) && fs.readdirSync(f.runsDir).length > 0, false, "no run directory is created without an attempt");
  await assert.rejects(f.sendRaw({ operationId }), (error: unknown) => {
    assert.ok(error instanceof OperationOutcomeError, `a replay must surface the unresolved outcome, got ${String(error)}`);
    assert.equal((error as { operationState?: string }).operationState, "outcome_unknown");
    return true;
  });
  assert.equal(f.counters.preparations, 1, "a replay must never call the native preparation twice");
  await assert.rejects(f.sendRaw({ taskId: "l08-other-task" }), { code: "CAPACITY_OCCUPIED" });
});

test("L08 an uncertain dispatch keeps the slot, records outcome_unknown and never auto-retries", async t => {
  const original = SelectedModelClient.prototype.sendMessage;
  t.after(() => { SelectedModelClient.prototype.sendMessage = original; });
  Object.assign(SelectedModelClient.prototype, {
    sendMessage: async () => { throw new Error("synthetic transport loss after the native boundary"); },
  });
  const f = await acceptanceFixture(t, "workbuddy", { dispatch: false });
  const operationId = "l08-op-uncertain-dispatch";
  // The transport dies after nativeBoundary(), so the service reports an unresolved
  // receipt instead of pretending the dispatch either succeeded or was refused.
  const receipt = await f.sendRaw({ operationId }) as { code?: string; operationState?: string };
  assert.equal(receipt.code, "OUTCOME_UNKNOWN");
  assert.equal(receipt.operationState, "outcome_unknown");
  assert.equal(f.store().operations.get(operationId)?.state, "outcome_unknown");
  const task = f.store().get(f.taskId)!;
  assert.ok(task.attemptId, "the attempt row exists because the native boundary was crossed");
  assert.equal(task.state, "blocked");
  assert.equal(f.store().operations.occupant()?.taskId, f.taskId, "an unknown dispatch keeps the single capacity slot");
  const request = path.join(f.runsDir, task.attemptId!, "request.json");
  assert.equal(fs.existsSync(request), false, "the synthetic transport failed before any queue request was written");

  await assert.rejects(f.sendRaw({}), (error: unknown) => {
    assert.ok(error instanceof OperationOutcomeError, `a second send must surface the unresolved outcome, got ${String(error)}`);
    assert.equal((error as { operationState?: string }).operationState, "outcome_unknown");
    return true;
  });
  assert.equal(f.store().operations.occupant()?.taskId, f.taskId);
  assert.equal(f.store().operations.forTask(f.taskId).filter(operation => operation.kind === "send").length, 1, "the unresolved send is the only send operation for this task");
});

test("L08 one operation key replays its receipt; a different payload under that key is a conflict", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { dispatch: false });
  let actions = 0;
  const binding = { sessionId: null, model: "synthetic-user-choice", workspace: f.workspace, workerKey: null, title: null };
  const options = { operationId: "l08-op-key", expectedRevision: null, expectedAttemptId: null };
  const first = await f.store().operations.run("send", f.taskId, "workbuddy", { objective: "first" }, options, binding, async () => {
    actions++;
    return { ok: true as const, created: true as const };
  });
  assert.equal(actions, 1);
  const replay = await f.store().operations.run("send", f.taskId, "workbuddy", { objective: "first" }, options, binding, async () => {
    actions++;
    return { ok: true as const, created: true as const };
  });
  assert.equal(actions, 1, "the same key with the same payload replays the stored receipt");
  assert.equal(replay.operationId, first.operationId);
  await assert.rejects(
    async () =>
      f.store().operations.run("send", f.taskId, "workbuddy", { objective: "second" }, options, binding, async () => {
        actions++;
        return { ok: true as const, created: true as const };
      }),
    { code: "OPERATION_CONFLICT" },
  );
  assert.equal(actions, 1, "a conflicting payload must not execute at all");

  const dispatched = await acceptanceFixture(t, "workbuddy", { timeoutSeconds: 600 });
  await assert.rejects(
    dispatched.service.send({
      taskId: dispatched.taskId,
      objective: dispatched.contract.objective,
      contract: { ...dispatched.contract, execution: { ...dispatched.execution, executorId: "dsh" } },
      sessionId: "l08-session",
      operationId: dispatched.store().operations.forTask(dispatched.taskId)[0]!.operationId,
    }),
    { code: "OPERATION_CONFLICT" },
  );
  assert.equal(dispatched.counters.prompts, 0, "no DSH prompt may be sent for a WorkBuddy operation key");
});

test("L08 capacity one is enforced across tasks and executors without side effects", async t => {
  const f = await acceptanceFixture(t, "workbuddy");
  assert.equal(f.store().operations.occupant()?.taskId, f.taskId);
  const before = { ...f.counters };
  await assert.rejects(f.sendRaw({ taskId: "l08-second-task" }), { code: "CAPACITY_OCCUPIED" });
  assert.equal(f.store().get("l08-second-task") ?? null, null, "a refused dispatch creates no task row");
  assert.equal(f.counters.prompts, before.prompts);
  assert.equal(f.store().operations.occupant()?.taskId, f.taskId);
  await assert.rejects(async () => f.store().operations.claim(f.taskId, "dsh", "l08-op-switch"), { code: "EXECUTOR_UNAVAILABLE" });
  assert.equal(f.store().operations.get("l08-op-switch"), null, "a refused executor switch stores no operation");
});

test("L08 a claimed attempt cancelled by the user refuses the native boundary and rework", async t => {
  const f = await acceptanceFixture(t, "workbuddy");
  const claim = await f.queue.claim("l08-session", 0);
  assert.equal(claim.status, "task");
  if (claim.status !== "task") return;
  await f.service.cancel(f.taskId, "Synthetic user cancellation after claim");
  const cancelFile = JSON.parse(fs.readFileSync(path.join(f.runsDir, claim.attemptId, "cancel.json"), "utf8")) as { reason: string };
  assert.ok(cancelFile.reason.trim().length > 0, "the cancellation reason is persisted, not empty");
  assert.throws(() => f.store().operations.nativeBoundary(f.taskId, claim.attemptId), { code: "CANCELLED_TERMINAL" });
  assert.equal(f.store().get(f.taskId)?.state, "cancelled");
  assert.equal(f.store().operations.isClosed(f.store().get(f.taskId)!), false, "a cancellation without native stop evidence is not a closure");
  assert.equal(f.store().operations.occupant()?.taskId, f.taskId, "the slot stays occupied until the native stop is proven");
  const journal = f.journal();
  assert.equal(journal.cancellationRequested(), true);
  assert.equal(journal.snapshot()?.reportAuthentication, undefined, "cancellation never manufactures an authenticated report");
});

test("L08 a report attributed to the wrong session is refused and leaves no authentication", async t => {
  const f = await acceptanceFixture(t, "workbuddy");
  const claim = await f.queue.claim("l08-session", 0);
  assert.equal(claim.status, "task");
  if (claim.status !== "task") return;
  await f.service.sync(f.taskId);
  assert.throws(() => f.queue.report({ ...claim, sessionId: "l08-other-session", status: "completed", text: "TASK_STATUS: completed", artifacts: [] }), /session|lease|match/i);
  const snapshot = f.journal().snapshot()!;
  assert.equal(snapshot.reportAuthentication, undefined);
  assert.equal(snapshot.status, "working");
  assert.equal(f.store().get(f.taskId)?.state, "working", "a rejected report does not advance the task");
});

test("L08 a late report after the deadline is preserved for inspection and never becomes success", async t => {
  const f = await acceptanceFixture(t, "workbuddy");
  const claim = await f.queue.claim("l08-session", 0);
  assert.equal(claim.status, "task");
  if (claim.status !== "task") return;
  await f.service.sync(f.taskId);
  const journal = f.journal();
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 60_000).toISOString() });
  const result = f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nLATE: synthetic", artifacts: [] });
  assert.deepEqual(result, { ok: true, status: "blocked" });
  const snapshot = f.journal().snapshot()!;
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.reportAuthentication, undefined, "a late report is never authenticated as success");
  assert.match(snapshot.text ?? "", /TASK_STATUS: blocked/);
  const late = path.join(f.runsDir, claim.attemptId, "late-report.json");
  assert.equal(fs.existsSync(late), true, "the real late report is preserved as evidence");
  const preserved = JSON.parse(fs.readFileSync(late, "utf8")) as { status: string; text: string };
  assert.equal(preserved.status, "completed");
  assert.match(preserved.text, /LATE: synthetic/);
  await f.service.sync(f.taskId);
  assert.equal(f.store().get(f.taskId)?.state, "blocked");
});

test("L08 a restart keeps the task identity and re-dispatches nothing", async t => {
  const f = await acceptanceFixture(t, "workbuddy");
  const before = f.store().get(f.taskId)!;
  const request = JSON.parse(fs.readFileSync(path.join(f.runsDir, before.attemptId!, "request.json"), "utf8")) as { attemptId: string; taskId: string };
  const events = f.store().listTaskEvents(f.taskId);
  const reopened = f.restart();
  const after = reopened.get(f.taskId)!;
  assert.equal(after.attemptId, before.attemptId);
  assert.equal(after.revision, before.revision ?? null);
  assert.equal(reopened.operations.occupant()?.taskId, f.taskId, "the durable slot survives a process restart");
  assert.equal(request.attemptId, before.attemptId);
  assert.equal(request.taskId, f.taskId);
  const later = reopened.listTaskEvents(f.taskId);
  assert.equal(later.nextEventId, events.nextEventId, "reopening the store appends no synthetic event");
  assert.equal(reopened.operations.forTask(f.taskId).filter(operation => operation.kind === "send").length, 1, "exactly one send operation exists for one dispatch");
});

test("L08 an exhausted budget refuses another dispatch and keeps the last attempt", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { maxAttempts: 1 });
  await f.finish();
  const first = f.store().get(f.taskId)!;
  assert.equal(first.attempt, 1);
  assert.equal(f.counters.preparations, 1, "one dispatch prepares exactly one native route");
  assert.equal(f.counters.inspections, 1, "the bound model is observed once");

  // R8 hung on an uncoded error: the operator saw "attempt limit" but no code
  // to key recovery on. The refusal must stay a stable admission code.
  await assert.rejects(f.service.continue({ taskId: f.taskId, feedback: "synthetic rework request after the budget is spent" }),
    (error: { name?: string; code?: string; message?: string }) => error.name === "AdmissionError" && error.code === "ATTEMPT_LIMIT" && /attempt limit/i.test(error.message ?? ""));

  const after = f.store().get(f.taskId)!;
  assert.equal(after.attempt, 1, "no extra attempt is created once the immutable budget is spent");
  assert.equal(after.attemptId, first.attemptId);
  assert.equal(after.state, first.state, "a refused rework does not change the task state");
  assert.equal(f.counters.preparations, 1, "no second preparation reached the executor");
  const runDirs = fs.readdirSync(f.runsDir).filter(name => name.startsWith("run-"));
  assert.deepEqual(runDirs, [first.attemptId], "no second run directory was opened");
  const rework = f.store().operations.forTask(f.taskId).filter(operation => operation.kind === "rework");
  assert.equal(rework.length, 1);
  assert.ok(["rejected", "failed"].includes(rework[0].state), `unexpected rework state ${rework[0].state}`);
});


