import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AdmissionError } from "../src/collaboration.js";
import { AutomationService } from "../src/automation.js";
import { automationFixture } from "./support/automation-fixture.js";

const code = (error: unknown) => (error instanceof AdmissionError ? error.code : String(error));

async function rejects(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
  } catch (error) {
    assert.equal(code(error), expected, `expected ${expected}, got ${code(error)}: ${(error as Error).message}`);
    return;
  }
  assert.fail(`expected ${expected}, but the call succeeded`);
}

const operator = { actor: "synthetic-operator", source: "user:synthetic-operator" };

test("an authorized automatic decision dispatches through the same guarded service", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.armed();
  service.setEnabled(true, operator);
  const saved = fixture.savePolicy(service);

  const decision = await service.decide({ proposal: fixture.proposal("auto-1"), policyId: saved.policy.policyId }, "codex");
  assert.equal(decision.status, "pending");
  assert.equal(decision.evaluation.decision, "delegate");
  assert.equal(decision.evaluation.candidates[0]?.status, "candidate");
  assert.equal(decision.planId, null);
  assert.equal(decision.operationId, null);

  const operationId = randomUUID();
  const result = await service.execute(decision.decisionId, { operationId, actor: "synthetic-operator" }) as Record<string, unknown>;
  assert.equal(result.replay, false);
  assert.equal(result.status, "dispatched");
  assert.equal(result.taskId, "auto-1");

  const dispatched = service.getDecision(decision.decisionId);
  assert.equal(dispatched.status, "dispatched");
  assert.equal(dispatched.operationId, operationId);
  assert.ok(dispatched.planId);

  const plan = fixture.store.collaboration.getPlan(dispatched.planId!);
  assert.equal(plan.mode, "automatic");
  assert.equal(plan.automation?.decisionId, decision.decisionId);
  assert.equal(plan.automation?.policyId, saved.policy.policyId);
  assert.equal(plan.automation?.policyVersion, saved.policy.version);  assert.equal(plan.authorizationSource, `automation:${saved.policy.policyId}`);
  assert.equal(plan.consumedBy, "auto-1");
  assert.ok(plan.authorizedAt);

  const admission = fixture.store.collaboration.getTaskAdmission("auto-1");
  assert.equal(admission?.planId, dispatched.planId);
  assert.equal(admission?.planRevision, plan.revision);

  const task = fixture.store.get("auto-1");
  assert.ok(task);
  assert.ok(task!.attemptId);

  const operation = fixture.store.operations.get(operationId);
  assert.ok(operation);
  assert.equal(operation!.taskId, "auto-1");
  assert.equal(operation!.kind, "send");
  assert.ok(["succeeded", "effect_started"].includes(operation!.state));

  const actions = service.audit(20).map((entry) => entry.action);
  assert.ok(actions.includes("decision_pending"));
  assert.ok(actions.includes("decision_dispatch_intent"));
  assert.ok(actions.includes("decision_dispatched"));
  assert.equal(service.audit(20).find((entry) => entry.action === "decision_dispatched")?.source, `automation:${saved.policy.policyId}`);
  fixture.close();
});

test("one decision yields at most one effect, even when it is retried", async (t) => {
  const fixture = automationFixture(t);
  let sent = 0;
  const service = fixture.armed({ send: async (input) => { sent += 1; return fixture.service.send(input); } });
  service.setEnabled(true, operator);
  const saved = fixture.savePolicy(service);
  const decision = await service.decide({ proposal: fixture.proposal("auto-2"), policyId: saved.policy.policyId }, "codex");

  const operationId = randomUUID();
  await service.execute(decision.decisionId, { operationId });
  const replay = await service.execute(decision.decisionId, { operationId }) as Record<string, unknown>;
  assert.equal(replay.replay, true);
  assert.equal(replay.status, "dispatched");
  await rejects(service.execute(decision.decisionId, { operationId: randomUUID() }), "OPERATION_CONFLICT");

  assert.equal(sent, 1);
  assert.equal(fixture.store.listTasks().length, 1);
  fixture.close();
});

test("two processes racing one decision produce a single dispatch", async (t) => {
  const fixture = automationFixture(t);
  let sent = 0;
  const make = () => fixture.armed({ send: async (input) => { sent += 1; return fixture.service.send(input); } });
  const first = make(), second = make();
  first.setEnabled(true, operator);
  // A two-task window keeps the round limit out of the way, so the race loser has to be stopped by
  // the durable claim inside the write transaction rather than by an exhausted window.
  const saved = fixture.savePolicy(first, { maxTasksPerWindow: 2 });
  const decision = await first.decide({ proposal: fixture.proposal("auto-3"), policyId: saved.policy.policyId }, "codex");

  const results = await Promise.allSettled([
    first.execute(decision.decisionId, { operationId: randomUUID() }),
    second.execute(decision.decisionId, { operationId: randomUUID() }),
  ]);
  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  const rejected = results.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  // The loser is stopped either by the durable claim on the decision or by the capacity the winner
  // just took; both are refusals, and neither may produce a second effect.
  assert.ok(["OPERATION_CONFLICT", "EXECUTOR_BUSY", "OUTCOME_UNKNOWN"].includes(code(rejected[0]!.reason)), code(rejected[0]!.reason));
  assert.equal(sent, 1);
  assert.equal(fixture.store.listTasks().length, 1);
  const stored = first.getDecision(decision.decisionId);
  assert.equal(stored.status, "dispatched");
  assert.equal(stored.operationId, (fulfilled[0] as PromiseFulfilledResult<Record<string, unknown>>).value.operationId);
  assert.equal(fixture.service.listUnfinishedOperations().length <= 1, true);
  fixture.close();
});

test("a restart turns an unowned dispatch intent into an unknown outcome, never a retry", async (t) => {
  const fixture = automationFixture(t);
  const before = fixture.armed();
  before.setEnabled(true, operator);
  const saved = fixture.savePolicy(before);
  const decision = await before.decide({ proposal: fixture.proposal("auto-4"), policyId: saved.policy.policyId }, "codex");
  fixture.raw("UPDATE automation_decisions SET status='executing' WHERE decision_id=?", decision.decisionId);

  const after = fixture.armed();
  const recovered = after.recover();
  assert.deepEqual(recovered.recovered, [decision.decisionId]);
  assert.equal(after.getDecision(decision.decisionId).status, "outcome_unknown");
  assert.ok(after.audit(10).some((entry) => entry.action === "decision_recovered_unknown"));
  assert.equal(fixture.store.listTasks().length, 0);
  await rejects(after.execute(decision.decisionId, { operationId: randomUUID() }), "OUTCOME_UNKNOWN");
  assert.equal(fixture.store.listTasks().length, 0);
  fixture.close();
});

test("a live dispatch is never reclaimed by the restart receipt", async (t) => {
  const fixture = automationFixture(t);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = fixture.armed({ send: async (input) => { await gate; return fixture.service.send(input); } });
  service.setEnabled(true, operator);
  const saved = fixture.savePolicy(service);
  const decision = await service.decide({ proposal: fixture.proposal("auto-5"), policyId: saved.policy.policyId }, "codex");

  const running = service.execute(decision.decisionId, { operationId: randomUUID() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getDecision(decision.decisionId).status, "executing");
  assert.deepEqual(service.recover().recovered, []);

  release();
  await running;
  assert.equal(service.getDecision(decision.decisionId).status, "dispatched");
  fixture.close();
});

test("an unknown effect keeps the original task and refuses a replacement", async (t) => {
  const fixture = automationFixture(t, { failNativeSend: true });
  let sent = 0;
  const service = fixture.armed({ send: async (input) => { sent += 1; return fixture.service.send(input); } });
  service.setEnabled(true, operator);
  const saved = fixture.savePolicy(service);
  const decision = await service.decide({ proposal: fixture.proposal("auto-6"), policyId: saved.policy.policyId }, "codex");

  await rejects(service.execute(decision.decisionId, { operationId: randomUUID() }), "OUTCOME_UNKNOWN");
  const unknown = service.getDecision(decision.decisionId);
  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(unknown.blockedCode, "OUTCOME_UNKNOWN");
  assert.equal(service.listDecisions().length, 1);
  await rejects(service.execute(decision.decisionId, { operationId: randomUUID() }), "OUTCOME_UNKNOWN");

  const tasks = fixture.store.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.taskId, "auto-6");
  const second = await service.decide({ proposal: fixture.proposal("auto-6"), policyId: saved.policy.policyId }, "codex");
  assert.equal(second.status, "blocked");
  assert.ok(second.evaluation.blocks.some((block) => block.code === "TASK_CONFLICT"));
  assert.equal(sent, 1);
  fixture.close();
});

test("capacity stays one, so a second automatic task waits", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.armed();
  service.setEnabled(true, operator);
  const wide = fixture.savePolicy(service, { policyId: "policy-wide", maxTasksPerWindow: 2 });
  const first = await service.decide({ proposal: fixture.proposal("auto-7"), policyId: wide.policy.policyId }, "codex");
  await service.execute(first.decisionId, { operationId: randomUUID() });

  const second = await service.decide({ proposal: fixture.proposal("auto-8"), policyId: wide.policy.policyId }, "codex");
  assert.equal(second.status, "blocked");
  const busy = second.evaluation.blocks.find((block) => block.code === "EXECUTOR_BUSY");
  assert.equal(busy?.field, "capacity");
  await rejects(service.execute(second.decisionId, { operationId: randomUUID() }), "EXECUTOR_BUSY");
  assert.equal(fixture.store.listTasks().length, 1);
  fixture.close();
});

test("revocation after the dispatch intent is audited without cancelling the effect", async (t) => {
  const fixture = automationFixture(t);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = fixture.armed({ send: async (input) => { await gate; return fixture.service.send(input); } });
  service.setEnabled(true, operator);
  const saved = fixture.savePolicy(service);
  const decision = await service.decide({ proposal: fixture.proposal("auto-9"), policyId: saved.policy.policyId }, "codex");

  const running = service.execute(decision.decisionId, { operationId: randomUUID() });
  await new Promise((resolve) => setImmediate(resolve));

  const other = fixture.armed();
  other.revokePolicy(saved.policy.policyId, saved.policy.revision, "Operator stopped the standing approval", operator);
  assert.ok(other.audit(10).some((entry) => entry.action === "revoke_after_dispatch_intent"));
  assert.equal(service.getDecision(decision.decisionId).status, "executing");

  release();
  await running;
  assert.equal(service.getDecision(decision.decisionId).status, "dispatched");

  const blocked = await service.decide({ proposal: fixture.proposal("auto-10"), policyId: saved.policy.policyId }, "codex");
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.evaluation.blocks.some((block) => block.code === "POLICY_REVOKED"));
  fixture.close();
});

test("the dispatcher refuses while it is unarmed, disabled or unwired", async (t) => {
  const fixture = automationFixture(t);
  const saved = fixture.savePolicy(fixture.automation());
  const decision = await fixture.automation().decide({ proposal: fixture.proposal("auto-11"), policyId: saved.policy.policyId }, "codex");

  await rejects(fixture.armed().execute(decision.decisionId, { operationId: randomUUID() }), "AUTOMATION_NOT_ENABLED");
  const enabled = fixture.armed();
  enabled.setEnabled(true, operator);
  assert.equal(enabled.describe().enabled, true);

  const unwired = new AutomationService(fixture.store, { armed: true, now: () => new Date(fixture.clock.now) });
  unwired.setEnabled(true, operator);
  await rejects(unwired.execute(decision.decisionId, { operationId: randomUUID() }), "AUTOMATION_NOT_ARMED");

  await rejects(enabled.execute(decision.decisionId, { operationId: "" }), "INVALID_AUTOMATION");
  await rejects(enabled.execute(decision.decisionId, { operationId: "not a stable id" }), "INVALID_AUTOMATION");
  assert.equal(fixture.service.listUnfinishedOperations().length, 0);
  fixture.close();
});

test("a blocked decision reports its original reason and never dispatches", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.armed();
  service.setEnabled(true, operator);
  const saved = fixture.savePolicy(service);
  const decision = await service.decide({ proposal: fixture.proposal("auto-12", { scope: { allowedChanges: ["lib/**"], permittedMetadata: [] } }), policyId: saved.policy.policyId }, "codex");
  assert.equal(decision.status, "blocked");
  assert.equal(decision.blockedCode, "SCOPE_VIOLATION");
  await rejects(service.execute(decision.decisionId, { operationId: randomUUID() }), "SCOPE_VIOLATION");

  await rejects(service.decide({ proposal: fixture.proposal("auto-13"), policyId: "policy-unknown" }, "codex"), "POLICY_MISSING");
  assert.equal(fixture.store.listTasks().length, 0);
  fixture.close();
});
