import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdmissionError, defaultModelPolicy } from "../src/collaboration.js";
import { TaskStore } from "../src/task-store.js";
import { AutomationService, ensureAutomationSchema } from "../src/automation.js";
import { automationFixture } from "./support/automation-fixture.js";

const code = (error: unknown) => (error instanceof AdmissionError ? error.code : String(error));
const codes = (blocks: Array<{ code: string }>) => blocks.map((block) => block.code);
const operator = { actor: "synthetic-operator", source: "user:synthetic-operator" };

async function rejects(promise: Promise<unknown> | (() => unknown), expected: string) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    assert.equal(code(error), expected, `expected ${expected}, got ${code(error)}: ${(error as Error).message}`);
    return error as AdmissionError;
  }
  assert.fail(`expected ${expected}, but the call succeeded`);
}

test("a policy can only be saved from a user/local-operator/desktop source", (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  for (const source of ["agent:codex", "http://127.0.0.1", "automation:scheduler", "model:gpt", ""]) {
    assert.throws(() => service.createPolicy({
      workspaceId: "project", executor: fixture.execution, maxTasksPerWindow: 1, windowSeconds: 3600,
      maxTimeoutSeconds: 1800, maxAttempts: 3, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      cost: { mode: "free_only", unit: "credit", ceiling: null, requiresHardCap: false },
    }, { actor: "codex", source }), (error: unknown) => code(error) === "PLAN_CONFIRMATION_REQUIRED");
  }
  assert.equal(service.listPolicies().length, 0);
  assert.equal(service.audit().length, 0);
  fixture.close();
});

test("saved policy keeps an immutable revision and a readable audit trail", (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service);
  assert.equal(created.status, "active");
  assert.equal(created.policy.authorizationSource, "user:synthetic-operator");
  assert.equal(created.policy.supersedes, null);

  const revised = service.revisePolicy(created.policy.policyId, created.policy.revision, { maxTasksPerWindow: 2 }, operator);
  assert.equal(revised.policy.supersedes, created.policy.revision);
  assert.notEqual(revised.policy.revision, created.policy.revision);
  assert.equal(revised.policy.maxTasksPerWindow, 2);

  const revisions = service.listPolicyRevisions(created.policy.policyId);
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions.map((entry) => entry.status).sort(), ["active", "superseded"]);

  const audit = service.audit();
  assert.deepEqual(audit.slice(0, 2).map((entry) => entry.action), ["revised", "created"]);
  assert.equal((audit[0]?.detail as { fromRevision?: string }).fromRevision, created.policy.revision);
  fixture.close();
});

test("a revision cannot extend its own expiry or change the workspace", (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service);
  assert.throws(
    () => service.revisePolicy(created.policy.policyId, created.policy.revision, { expiresAt: new Date(Date.parse(created.policy.expiresAt) + 3_600_000).toISOString() }, operator),
    (error: unknown) => code(error) === "INVALID_AUTOMATION",
  );
  assert.throws(
    () => service.revisePolicy(created.policy.policyId, created.policy.revision, { workspaceId: "other" }, operator),
    (error: unknown) => code(error) === "SCOPE_VIOLATION",
  );
  assert.throws(
    () => service.revisePolicy(created.policy.policyId, "not-the-current-revision", { maxTasksPerWindow: 2 }, operator),
    (error: unknown) => code(error) === "POLICY_MISSING",
  );
  fixture.close();
});

test("revocation is audited and blocks evaluation", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service);
  const revoked = service.revokePolicy(created.policy.policyId, created.policy.revision, "Operator withdrew the standing approval", operator);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.policy.revocationReason, "Operator withdrew the standing approval");
  assert.equal(service.audit()[0]?.action, "revoked");
  assert.throws(
    () => service.revisePolicy(created.policy.policyId, created.policy.revision, { maxTasksPerWindow: 2 }, operator),
    (error: unknown) => code(error) === "POLICY_REVOKED",
  );
  const evaluation = await service.evaluate({ proposal: fixture.proposal("auto-a"), policyId: created.policy.policyId });
  assert.equal(evaluation.decision, "wait");
  assert.ok(codes(evaluation.blocks).includes("POLICY_REVOKED"));
  fixture.close();
});

test("an expired policy blocks with POLICY_EXPIRED without throwing", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service, { expiresAt: new Date(fixture.clock.now + 60_000).toISOString() });
  fixture.clock.now += 120_000;
  const evaluation = await service.evaluate({ proposal: fixture.proposal("auto-b"), policyId: created.policy.policyId });
  assert.equal(evaluation.decision, "wait");
  assert.ok(codes(evaluation.blocks).includes("POLICY_EXPIRED"));
  fixture.close();
});

test("a policy with no active cover, or two covers, refuses to guess", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  await rejects(() => service.evaluate({ proposal: fixture.proposal("auto-c") }), "POLICY_MISSING");
  const first = fixture.savePolicy(service);
  assert.equal(first.status, "active");
  assert.equal((await service.evaluate({ proposal: fixture.proposal("auto-c") })).policyId, first.policy.policyId);
  fixture.savePolicy(service);
  await rejects(() => service.evaluate({ proposal: fixture.proposal("auto-c") }), "POLICY_AMBIGUOUS");
  fixture.close();
});

test("workspace and scope drift are blocked before any decision", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service);
  const otherProject = await service.evaluate({ proposal: fixture.proposal("auto-d", { workspaceId: "other" }), policyId: created.policy.policyId });
  assert.ok(codes(otherProject.blocks).includes("SCOPE_VIOLATION"));
  const wider = await service.evaluate({ proposal: fixture.proposal("auto-e", { scope: { allowedChanges: ["src/**", "package.json"], permittedMetadata: [] } }), policyId: created.policy.policyId });
  assert.ok(codes(wider.blocks).includes("SCOPE_VIOLATION"));
  assert.equal(wider.candidates[0]?.status, "excluded");
  const metadata = await service.evaluate({ proposal: fixture.proposal("auto-f", { scope: { allowedChanges: ["src/**"], permittedMetadata: ["commit-message"] } }), policyId: created.policy.policyId });
  assert.ok(codes(metadata.blocks).includes("SCOPE_VIOLATION"));
  fixture.close();
});

test("a different model, reasoning effort or executor is outside the saved policy", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service);
  const model = await service.evaluate({ proposal: fixture.proposal("auto-g", { execution: { ...fixture.execution, modelId: "another-model" } }), policyId: created.policy.policyId });
  assert.ok(codes(model.blocks).includes("MODEL_POLICY_BLOCKED"));
  const reasoning = await service.evaluate({ proposal: fixture.proposal("auto-h", { execution: { ...fixture.execution, reasoningEffort: "high" } }), policyId: created.policy.policyId });
  assert.ok(codes(reasoning.blocks).includes("MODEL_POLICY_BLOCKED"));
  const executor = await service.evaluate({ proposal: fixture.proposal("auto-i", { execution: { ...fixture.execution, executorId: "dsh" } }), policyId: created.policy.policyId });
  assert.ok(codes(executor.blocks).includes("MODEL_POLICY_BLOCKED"));
  fixture.close();
});

test("installed historical restrictions still apply to automatic dispatch", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service);
  fixture.store.collaboration.setPolicy({ ...defaultModelPolicy(3), requireFree: true, selectionMode: "allowlist", allowed: [{ ...fixture.execution, modelId: "historical-only" }] });
  const evaluation = await service.evaluate({ proposal: fixture.proposal("auto-j"), policyId: created.policy.policyId });
  assert.equal(evaluation.history.source, "live_policy");
  assert.equal(evaluation.history.blocked, true);
  assert.ok(codes(evaluation.blocks).includes("MODEL_POLICY_BLOCKED"));
  fixture.close();
});

test("free-only needs a fresh proof of x0.00, not an assumption", async (t) => {
  const fixture = automationFixture(t);
  const created = fixture.savePolicy(fixture.automation());

  const unavailable = new AutomationService(fixture.store, { now: () => new Date(fixture.clock.now), probe: () => fixture.probe({ model: { credits: null, valueKind: "unavailable", remaining: null } }) });
  const first = await unavailable.evaluate({ proposal: fixture.proposal("auto-k"), policyId: created.policy.policyId });
  assert.ok(codes(first.blocks).includes("QUOTA_UNAVAILABLE"));
  assert.equal(first.cost.evidence, "unavailable");

  const paid = new AutomationService(fixture.store, { now: () => new Date(fixture.clock.now), probe: () => fixture.probe({ model: { credits: "x1.50", remaining: 100 } }) });
  const second = await paid.evaluate({ proposal: fixture.proposal("auto-l"), policyId: created.policy.policyId });
  assert.ok(codes(second.blocks).includes("MODEL_UNVERIFIED"));

  const stale = new AutomationService(fixture.store, { now: () => new Date(fixture.clock.now), probe: () => fixture.probe({ model: { freshness: "stale" } }) });
  const third = await stale.evaluate({ proposal: fixture.proposal("auto-m"), policyId: created.policy.policyId });
  assert.ok(codes(third.blocks).includes("QUOTA_UNAVAILABLE"));
  fixture.close();
});

test("a hard spending cap is refused when the source cannot enforce one", async (t) => {
  const fixture = automationFixture(t);
  const created = fixture.savePolicy(fixture.automation(), { cost: { mode: "known_cost", unit: "credit", ceiling: 25, requiresHardCap: true } });
  const unsupported = new AutomationService(fixture.store, { now: () => new Date(fixture.clock.now), probe: () => fixture.probe({ model: { credits: "x120.00", remaining: 900, hardCap: "unsupported" } }) });
  const evaluation = await unsupported.evaluate({ proposal: fixture.proposal("auto-n"), policyId: created.policy.policyId });
  assert.ok(codes(evaluation.blocks).includes("COST_CONTROL_UNAVAILABLE"));
  assert.equal(evaluation.cost.hardCapSupported, false);

  const exhausted = new AutomationService(fixture.store, { now: () => new Date(fixture.clock.now), probe: () => fixture.probe({ model: { credits: "x5.00", remaining: 10 } }) });
  const second = await exhausted.evaluate({ proposal: fixture.proposal("auto-o"), policyId: created.policy.policyId });
  assert.ok(codes(second.blocks).includes("QUOTA_EXHAUSTED"));

  const supported = new AutomationService(fixture.store, { now: () => new Date(fixture.clock.now), probe: () => fixture.probe({ model: { credits: "x80.00", remaining: 500, hardCap: "reported" } }) });
  const third = await supported.evaluate({ proposal: fixture.proposal("auto-p"), policyId: created.policy.policyId });
  assert.equal(third.decision, "delegate");
  fixture.close();
});

test("unknown price may be chosen explicitly, and is never reported as a hard limit", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service, { cost: { mode: "unknown_allowed", unit: "credit", ceiling: null, requiresHardCap: false } });
  const unknown = new AutomationService(fixture.store, { now: () => new Date(fixture.clock.now), probe: () => fixture.probe({ model: { credits: null, valueKind: "unavailable", remaining: null, freshness: "fresh" } }) });
  const evaluation = await unknown.evaluate({ proposal: fixture.proposal("auto-q"), policyId: created.policy.policyId });
  assert.equal(evaluation.decision, "delegate");
  assert.ok(evaluation.limits.includes("cost_unknown_not_a_hard_cap"));
  assert.match(evaluation.cost.note, /not a hard spending limit/i);

  const capped = fixture.savePolicy(service, { policyId: "policy-capped", cost: { mode: "unknown_allowed", unit: "credit", ceiling: null, requiresHardCap: true } });
  const refused = await unknown.evaluate({ proposal: fixture.proposal("auto-r"), policyId: capped.policy.policyId });
  assert.ok(codes(refused.blocks).includes("COST_CONTROL_UNAVAILABLE"));
  fixture.close();
});

test("rounds, deadline, capacity and task identity are all re-checked", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const created = fixture.savePolicy(service, { maxTasksPerWindow: 1, maxTimeoutSeconds: 1800 });
  fixture.raw(
    "INSERT INTO automation_decisions (decision_id,policy_id,policy_revision,status,task_id,plan_id,effect_operation,created_at,updated_at,digest,body_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "decision-old", created.policy.policyId, created.policy.revision, "dispatched", "old-task", null, "op-old",
    new Date(fixture.clock.now).toISOString(), new Date(fixture.clock.now).toISOString(), "0".repeat(64), "{}",
  );
  const rounds = await service.evaluate({ proposal: fixture.proposal("auto-s"), policyId: created.policy.policyId });
  assert.ok(codes(rounds.blocks).includes("ATTEMPT_LIMIT"));
  assert.equal(rounds.rounds.used, 1);
  assert.equal(rounds.rounds.limit, 1);

  const wide = fixture.savePolicy(service, { policyId: "policy-wide", maxTasksPerWindow: 5, maxTimeoutSeconds: 60 });
  const deadline = await service.evaluate({ proposal: fixture.proposal("auto-t", { timeoutSeconds: 600 }), policyId: wide.policy.policyId });
  assert.ok(codes(deadline.blocks).includes("DEADLINE_EXCEEDED"));

  const attempts = await service.evaluate({ proposal: fixture.proposal("auto-u", { maxAttempts: 9 }), policyId: wide.policy.policyId });
  assert.ok(codes(attempts.blocks).includes("ATTEMPT_LIMIT"));

  fixture.raw("INSERT INTO workflow_capacity (slot,task_id,executor,operation_id) VALUES (1,?,?,?)", "busy-task", "workbuddy", "op-busy");
  const capacity = await service.evaluate({ proposal: fixture.proposal("auto-v"), policyId: wide.policy.policyId });
  assert.ok(codes(capacity.blocks).includes("EXECUTOR_BUSY"));
  fixture.close();
});

test("a policy that expires before the task could finish is refused", async (t) => {
  const fixture = automationFixture(t);
  const created = fixture.savePolicy(fixture.automation(), { expiresAt: new Date(fixture.clock.now + 300_000).toISOString(), maxTimeoutSeconds: 1800 });
  const evaluation = await fixture.automation().evaluate({ proposal: fixture.proposal("auto-w", { timeoutSeconds: 600 }), policyId: created.policy.policyId });
  assert.ok(codes(evaluation.blocks).includes("DEADLINE_EXCEEDED"));
  fixture.close();
});

test("a stale or future catalog observation is not treated as evidence", async (t) => {
  const fixture = automationFixture(t);
  const created = fixture.savePolicy(fixture.automation());
  const stale = new AutomationService(fixture.store, {
    now: () => new Date(fixture.clock.now),
    probe: () => fixture.probe({ observedAt: new Date(fixture.clock.now - 120_000).toISOString() }),
  });
  const evaluation = await stale.evaluate({ proposal: fixture.proposal("auto-x"), policyId: created.policy.policyId });
  assert.ok(codes(evaluation.blocks).includes("MODEL_UNVERIFIED"));

  const offline = new AutomationService(fixture.store, {
    now: () => new Date(fixture.clock.now),
    probe: () => fixture.probe({ executor: { online: false, dispatchable: false, evidence: "synthetic-offline" } }),
  });
  const second = await offline.evaluate({ proposal: fixture.proposal("auto-y"), policyId: created.policy.policyId });
  assert.ok(codes(second.blocks).includes("EXECUTOR_UNAVAILABLE"));
  fixture.close();
});

test("a saved policy narrows dispatch and never widens it", (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  fixture.savePolicy(service);
  const described = service.describe();
  assert.equal(described.httpWrites, false);
  assert.equal(described.writeEntry, "local_cli_only");
  assert.equal(described.armed, false);
  assert.match(String(described.limits), /never grants commit, push, deploy or native-approval/i);
  fixture.close();
});

test("an old database gains empty automation tables and never an implicit authorization", async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t7-automation-legacy-")));
  const store = new TaskStore(path.join(root, "state", "tasks.sqlite"));
  try {
    const service = new AutomationService(store);
    assert.deepEqual(service.listPolicies(), []);
    assert.deepEqual(service.listDecisions(), []);
    assert.equal(service.describe().schemaVersion, 1);
    assert.equal(service.describe().enabled, false);
    await assert.rejects(() => service.evaluate({ proposal: { schemaVersion: "workbuddy-executor/vnext-2" } }), (error: unknown) => code(error) === "PLAN_STALE");
    store.database.prepare("UPDATE automation_meta SET schema_version=99 WHERE id=1").run();
    // The schema is created on first use, so the refusal appears there rather
    // than in the constructor.
    const broken = new AutomationService(store);
    assert.throws(() => broken.describe(), (error: unknown) => code(error) === "AUTOMATION_SCHEMA_UNSUPPORTED");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("a manual plan stays manual and cannot be turned into an automatic one", (t) => {
  const fixture = automationFixture(t);
  const policy = fixture.store.collaboration.currentPolicy(defaultModelPolicy(3));
  const manual = fixture.store.collaboration.createPlan(fixture.proposal("manual-task"), policy, { mode: "manual", reason: "Synthetic manual plan" });
  assert.equal(manual.mode, "manual");
  assert.equal(manual.automation, null);

  assert.throws(
    () => fixture.store.collaboration.createPlan(fixture.proposal("manual-task"), policy, { mode: "automatic", reason: "No binding" }),
    (error: unknown) => code(error) === "PLAN_CONFIRMATION_REQUIRED",
  );
  assert.throws(
    () => fixture.store.collaboration.createPlan(fixture.proposal("manual-task"), policy, { mode: "manual", reason: "Manual with binding", automation: { policyId: "p", policyRevision: "r", policyVersion: "v", decisionId: "d" } }),
    (error: unknown) => code(error) === "PLAN_CONFIRMATION_REQUIRED",
  );

  const automatic = fixture.store.collaboration.createPlan(fixture.proposal("manual-task"), policy, {
    mode: "automatic", reason: "Synthetic automatic plan",
    automation: { policyId: "policy-synthetic", policyRevision: "rev", policyVersion: policy.version, decisionId: "decision-synthetic" },
  });
  fixture.store.collaboration.authorizePlan(automatic.planId, automatic.revision, policy, "user:synthetic-operator");
  assert.throws(
    () => fixture.store.collaboration.prepare({ ...fixture.proposal("manual-task"), collaboration: { planId: automatic.planId, expectedPlanRevision: automatic.revision } } as never, "hash", policy),
    (error: unknown) => code(error) === "PLAN_CONFIRMATION_REQUIRED",
  );
  fixture.close();
});

test("the manual service seam refuses to mint an automatic plan", (t) => {
  const fixture = automationFixture(t);
  assert.throws(
    () => fixture.service.createCollaborationPlan(fixture.proposal("manual-service"), { mode: "automatic" as never, reason: "Should be refused" }),
    (error: unknown) => code(error) === "PLAN_CONFIRMATION_REQUIRED",
  );
  fixture.close();
});

test("the automation module never appears in the MCP tool surface", () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const file of ["server.ts", "deepseek-server.ts"]) {
    const source = fs.readFileSync(path.join(here, "..", "src", file), "utf8");
    assert.equal(/automation/i.test(source), false, `${file} must not expose an automation write tool`);
  }
});

test("ensureAutomationSchema is idempotent on the same connection", (t) => {
  const fixture = automationFixture(t);
  ensureAutomationSchema(fixture.store.database);
  ensureAutomationSchema(fixture.store.database);
  assert.equal(Number(fixture.row<{ schema_version: number }>("SELECT schema_version FROM automation_meta WHERE id=1")?.schema_version), 1);
  fixture.close();
});
