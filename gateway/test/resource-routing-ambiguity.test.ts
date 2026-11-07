import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { buildRoutingEvidence } from "../src/resource-routing.js";

// Two records can describe the same scope without agreeing. The evidence may
// never resolve that by taking the first array element: it states the
// disagreement and keeps the reading unresolved.

const iso = (ms: number) => new Date(ms).toISOString();
const POOL = `pool-${"a".repeat(32)}`;
const LIMITATIONS = ["routing_unverified", "shared_pool", "budget_estimated", "gateway_observed_usage_only", "task_attribution_unavailable"];

function observation(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: POOL, scopeKind: "gateway_pool", shared: true, modelId: "model-alpha", realm: "cn",
    unit: "tokens", valueKind: "estimated", availability: "available",
    used: 20, budget: 100, remaining: 80, resetAt: null,
    method: "historical_budget_minus_observed_usage", limitations: [...LIMITATIONS],
    ...overrides,
  };
}

function snapshot(connectionId: string, observations: unknown[], overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    snapshotId: `snapshot-${connectionId}-000000000000`, connectionId, collectedAt: iso(now), sourceObservedAt: iso(now - 1000),
    expiresAt: iso(now + 90_000), observations, ...overrides,
  };
}

function seed(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-ambiguity-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  store.createOrGet({ taskId: "task-ambiguity", messageId: "message-ambiguity", objective: "objective", state: "queued" });
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return {
    store,
    service: () => new TaskApplicationService({ store } as never, 3, runsDir),
    publishQuota(connectionId: string, published: unknown) {
      const epoch = store.quotas.register(connectionId, `fingerprint-${connectionId}`);
      const generation = store.quotas.beginPoll(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(store.quotas.publish(connectionId, epoch, generation, published as never), true);
    },
    publishCredit(connectionId: string, published: unknown) {
      const epoch = store.creditBalances.register(connectionId, `fingerprint-${connectionId}`);
      const generation = store.creditBalances.begin(epoch === null ? connectionId : connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(store.creditBalances.publish(connectionId, epoch, generation, published as never), true);
    },
  };
}

test("one scope reported twice keeps its conflict visible instead of picking the first record", (t) => {
  const env = seed(t);
  env.publishQuota("quota-a", snapshot("quota-a", [observation()]));
  env.publishQuota("quota-b", snapshot("quota-b", [observation()]));

  const evidence = env.service().readRoutingEvidence();
  assert.equal(evidence.mappings.length, 1, "the merged row is still one row");
  const mapping = evidence.mappings[0]!;
  assert.deepEqual([...mapping.connectionIds].sort(), ["quota-a", "quota-b"]);
  assert.ok(mapping.conflict?.unresolved, "the merged row is flagged as unresolved");
  assert.ok(mapping.conflict?.codes.includes("multiple_connections"));
  assert.ok(evidence.ambiguities.some(item => item.code === "multiple_connections" && item.scopeId === POOL));
  assert.ok(evidence.limitations.includes("routing_ambiguous"));
  assert.equal(mapping.level, "observed", "the merge itself is not an error: it is a pool reading");
});

test("two sources disagreeing on exhaustion keep both readings and say so", (t) => {
  const env = seed(t);
  env.publishQuota("quota-a", snapshot("quota-a", [observation()]));
  env.publishQuota("quota-b", snapshot("quota-b", [observation({ availability: "exhausted", remaining: 0 })]));

  const mapping = env.service().readRoutingEvidence().mappings[0]!;
  // The merged figure is one named source's reading, never a blend, and the
  // disagreement travels with it instead of being flattened away.
  assert.ok(["available", "exhausted"].includes(mapping.availability!));
  assert.deepEqual([...mapping.connectionIds].sort(), ["quota-a", "quota-b"]);
  assert.ok(mapping.conflict?.codes.includes("availability_disagreement"));
});

test("a realm disagreement is stated, not averaged away", (t) => {
  const env = seed(t);
  env.publishQuota("quota-a", snapshot("quota-a", [observation({ realm: "cn" })]));
  env.publishQuota("quota-b", snapshot("quota-b", [observation({ realm: "intl" })]));

  const evidence = env.service().readRoutingEvidence();
  const mapping = evidence.mappings[0]!;
  assert.ok(["cn", "intl"].includes(mapping.realm), "the row keeps one observed realm, it does not invent a merged one");
  assert.ok(mapping.conflict?.codes.includes("realm_conflict"));
  assert.equal(evidence.ambiguities.find(item => item.code === "realm_conflict")?.connectionIds.length, 2);
});

test("the same scope id in two units is a conflict: units are never added together", (t) => {
  const env = seed(t);
  env.publishQuota("quota-a", snapshot("quota-a", [observation()]));
  const now = Date.now();
  env.publishCredit("credit-a", {
    snapshotId: "credit-snapshot-0000000001", connectionId: "credit-a", scopeId: POOL, realm: "cn", unit: "credit",
    valueKind: "reported_cache", balance: 10.5, accountsEnabled: 2, accountsWithData: 2, coverage: "complete",
    latestMemberObservedAt: iso(now - 1000), collectedAt: iso(now), cacheExpiresAt: iso(now + 90_000),
  });

  const evidence = env.service().readRoutingEvidence();
  assert.equal(evidence.mappings.length, 2, "tokens and credit stay two rows");
  const unitConflict = evidence.ambiguities.find(item => item.code === "unit_conflict");
  assert.ok(unitConflict, "the shared scope id is flagged");
  assert.equal(unitConflict?.scopeId, POOL);
  assert.ok(evidence.mappings.every(item => item.conflict?.codes.includes("unit_conflict")));
});

test("one source with one reading reports no ambiguity at all", (t) => {
  const env = seed(t);
  env.publishQuota("quota-a", snapshot("quota-a", [observation()]));

  const evidence = env.service().readRoutingEvidence();
  assert.deepEqual(evidence.ambiguities, []);
  assert.equal(evidence.mappings[0]!.conflict, undefined);
  assert.ok(!evidence.limitations.includes("routing_ambiguous"));
});

test("building the document twice yields the same ambiguity list", (t) => {
  const env = seed(t);
  env.publishQuota("quota-a", snapshot("quota-a", [observation()]));
  env.publishQuota("quota-b", snapshot("quota-b", [observation()]));
  const first = env.service().readRoutingEvidence();
  const second = env.service().readRoutingEvidence();
  assert.deepEqual(first.ambiguities, second.ambiguities);
  assert.deepEqual(buildRoutingEvidence({ connections: [], observations: [], truncated: false } as never,
    { connections: [], balances: [], truncated: false } as never).ambiguities, []);
});
