import assert from "node:assert/strict";
import test from "node:test";
import { automationFixture } from "./support/automation-fixture.js";
import type { AutomationProbeResult } from "../src/automation.js";

/**
 * R2 — cost evidence is split into a rate, a balance and a hard cap. `known_cost` may only read a
 * balance that names its unit and whose source routes the number to this executor/connection/model.
 * R3 — the saved reasoning effort is resolved against the model identity's rows, never against
 * whichever row the catalog happened to list first.
 */
type Fixture = ReturnType<typeof automationFixture>;

function row(observedAt: string, overrides: Record<string, unknown> = {}): AutomationProbeResult["models"][number] {
  return {
    executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-user-choice",
    reasoningEfforts: [null], credits: "x0.11", remaining: null, unit: "credit", valueKind: "unavailable",
    freshness: "fresh", hardCap: "unsupported", catalogState: "available",
    observedAt, expiresAt: new Date(Date.parse(observedAt) + 3_600_000).toISOString(),
    ...overrides,
  } as AutomationProbeResult["models"][number];
}

function sample(observedAt: string, models: AutomationProbeResult["models"]): AutomationProbeResult {
  return {
    observedAt,
    executors: [{
      executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native",
      online: true, dispatchable: true, evidence: "synthetic-catalog", observedAt,
    }],
    models,
  };
}

const at = (fixture: Fixture) => new Date(fixture.clock.now).toISOString();

test("R2 a catalog multiplier is a rate, and known_cost refuses it as if it were a balance", async (t) => {
  const fixture = automationFixture(t);
  const probe = async () => sample(at(fixture), [row(at(fixture), {
    credits: "x0.11",
    rate: { kind: "reported", value: "x0.11" },
    balance: { kind: "unavailable", unit: "credit", remaining: null, routing: "unverified", source: null },
  })]);
  const automation = fixture.automation({ probe });
  fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "credit", ceiling: 10, requiresHardCap: false } });

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });

  assert.equal(evaluation.decision, "wait", JSON.stringify(evaluation.blocks));
  assert.ok(evaluation.blocks.some((block) => block.code === "QUOTA_UNAVAILABLE" && block.field === "cost"), JSON.stringify(evaluation.blocks));
  assert.equal(evaluation.cost.evidence, "unavailable");
  assert.equal(evaluation.cost.remaining, null, "a multiplier never becomes a remaining balance");
});

test("R2 an estimate from another connection is neither routed nor unit-compatible, so it is refused", async (t) => {
  const fixture = automationFixture(t);
  const probe = async () => sample(at(fixture), [row(at(fixture), {
    credits: null,
    // A shared gateway pool in tokens, reused for a credit-counted policy: the numbers are not comparable.
    balance: { kind: "estimated", unit: "tokens", remaining: 1000, routing: "unverified", source: "quota:other-connection" },
  })]);
  const automation = fixture.automation({ probe });
  fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "credit", ceiling: 10, requiresHardCap: false } });

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });

  assert.equal(evaluation.decision, "wait", JSON.stringify(evaluation.blocks));
  const fields = evaluation.blocks.map((block) => block.field);
  assert.ok(fields.includes("cost.routing"), JSON.stringify(evaluation.blocks));
  assert.ok(fields.includes("cost.unit"), JSON.stringify(evaluation.blocks));
  assert.ok(!evaluation.blocks.some((block) => block.field === "cost.remaining" && /cannot cover/.test(block.message)), "1000 was never compared with 10");
  assert.ok(evaluation.limits.includes("cost_routing_unverified"));
  assert.ok(evaluation.limits.includes("cost_unit_mismatch"));
});

test("R2 a verified per-model balance with the policy unit still satisfies known_cost", async (t) => {
  const fixture = automationFixture(t);
  const probe = async () => sample(at(fixture), [row(at(fixture), {
    credits: "x0.11",
    rate: { kind: "reported", value: "x0.11" },
    balance: { kind: "reported", unit: "tokens", remaining: 5000, routing: "verified", source: "quota:primary" },
  })]);
  const automation = fixture.automation({ probe });
  fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "tokens", ceiling: 10, requiresHardCap: false } });

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });

  assert.equal(evaluation.decision, "delegate", JSON.stringify(evaluation.blocks));
  assert.deepEqual(evaluation.blocks, []);
  assert.equal(evaluation.cost.evidence, "reported");
  assert.equal(evaluation.cost.remaining, 5000);
});

test("R2 two verified balances for one model are refused instead of quietly picking one", async (t) => {
  const fixture = automationFixture(t);
  const probe = async () => sample(at(fixture), [
    row(at(fixture), { balance: { kind: "reported", unit: "tokens", remaining: 5000, routing: "verified", source: "quota:a" } }),
    row(at(fixture), { balance: { kind: "reported", unit: "tokens", remaining: 900, routing: "verified", source: "quota:b" } }),
  ]);
  const automation = fixture.automation({ probe });
  fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "tokens", ceiling: 10, requiresHardCap: false } });

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });

  assert.equal(evaluation.decision, "wait");
  assert.ok(evaluation.blocks.some((block) => block.field === "cost.source"), JSON.stringify(evaluation.blocks));
  assert.ok(evaluation.limits.includes("cost_source_ambiguous"));
});

test("R3 the saved reasoning effort wins even when the catalog lists another effort first", async (t) => {
  for (const order of [["low", "high"], ["high", "low"]] as const) {
    const fixture = automationFixture(t);
    const probe = async () => sample(at(fixture), order.map((effort) => row(at(fixture), { reasoningEfforts: [effort] })));
    const automation = fixture.automation({ probe });
    const executor = { ...fixture.execution, reasoningEffort: "high" };
    fixture.savePolicy(automation, { executor, cost: { mode: "unknown_allowed", unit: "credit", ceiling: null, requiresHardCap: false } });

    const evaluation = await automation.evaluate({ proposal: fixture.proposal("reasoning-order-task", { execution: executor }) });

    assert.equal(evaluation.decision, "delegate", `${order.join(">")}: ${JSON.stringify(evaluation.blocks)}`);
    assert.equal(evaluation.candidates[0]?.execution.reasoningEffort, "high", "the selected effort is never silently replaced");
  }
});

test("R3 a missing effort is named with the reported efforts and is not substituted", async (t) => {
  const fixture = automationFixture(t);
  const probe = async () => sample(at(fixture), [row(at(fixture), { reasoningEfforts: ["low"] }), row(at(fixture), { reasoningEfforts: ["high"] })]);
  const automation = fixture.automation({ probe });
  const executor = { ...fixture.execution, reasoningEffort: "medium" };
  fixture.savePolicy(automation, { executor, cost: { mode: "unknown_allowed", unit: "credit", ceiling: null, requiresHardCap: false } });

  const evaluation = await automation.evaluate({ proposal: fixture.proposal("reasoning-missing-task", { execution: executor }) });

  assert.equal(evaluation.decision, "wait");
  const block = evaluation.blocks.find((entry) => entry.field === "executor.reasoningEffort");
  assert.ok(block, JSON.stringify(evaluation.blocks));
  assert.match(block!.message, /medium/);
  assert.match(block!.message, /low/);
  assert.match(block!.message, /high/);
  assert.equal(evaluation.candidates[0]?.execution.reasoningEffort, "medium");
});

test("P1 a snapshot saved before balances carried routing stays readable but cannot satisfy known_cost", async (t) => {
  const fixture = automationFixture(t);
  // Exactly the shape final5 wrote when a catalog multiplier and a shared token pool met on one
  // model: a reported valueKind, a remaining number from an unrelated connection, and no routing
  // proof at all. It may be displayed; it may not stand behind a cost threshold.
  const probe = async () => sample(at(fixture), [row(at(fixture), {
    credits: "x0.11",
    remaining: 1000,
    unit: "tokens",
    valueKind: "reported",
  })]);
  const automation = fixture.automation({ probe });
  fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "tokens", ceiling: 10, requiresHardCap: false } });

  const evaluation = await automation.evaluate({ proposal: fixture.proposal("legacy-snapshot-task") });

  assert.equal(evaluation.decision, "wait", JSON.stringify(evaluation.blocks));
  assert.ok(evaluation.blocks.some((entry) => entry.code === "COST_CONTROL_UNAVAILABLE" && entry.field === "cost.routing"), JSON.stringify(evaluation.blocks));
  assert.ok(evaluation.limits.includes("cost_routing_unverified"));
  assert.ok(!evaluation.blocks.some((entry) => entry.field === "cost.remaining" && /cannot cover/.test(entry.message)), "an unrouted number is never compared with the ceiling");
  assert.equal(evaluation.cost.remaining, 1000, "the saved number is still shown");
  assert.equal(evaluation.cost.evidence, "reported", "the saved evidence level is still shown");
});

test("P1 known_cost refuses an estimate explicitly instead of only excluding unavailable", async (t) => {
  const fixture = automationFixture(t);
  const probe = async () => sample(at(fixture), [row(at(fixture), {
    credits: null,
    balance: { kind: "estimated", unit: "credit", remaining: 4200, routing: "verified", source: "quota:this-model" },
  })]);
  const automation = fixture.automation({ probe });
  fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "credit", ceiling: 10, requiresHardCap: false } });

  const evaluation = await automation.evaluate({ proposal: fixture.proposal("estimated-balance-task") });

  assert.equal(evaluation.decision, "wait", JSON.stringify(evaluation.blocks));
  const block = evaluation.blocks.find((entry) => entry.field === "cost");
  assert.ok(block, JSON.stringify(evaluation.blocks));
  assert.match(block!.message, /only estimated/);
  assert.equal(evaluation.cost.evidence, "estimated", "an estimate stays labelled as one");
});
