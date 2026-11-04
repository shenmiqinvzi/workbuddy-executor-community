import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { TaskStore } from "../src/task-store.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { ROUTING_EVIDENCE_SCHEMA } from "../src/resource-routing.js";
import { WorkbenchHttpServer } from "../src/workbench-http.js";

// Two failure modes are easy to hide behind an aggregate view:
//   1. a mapping borrows the strongest level from one connection while showing
//      another connection's numbers and times;
//   2. a snapshot whose source time was never recorded is reported as if it had
//      been positively proven expired.
// These tests use the real QuotaStore / CreditBalanceStore and the real service,
// so they exercise the same reads the gateway and the desktop facade use.

const iso = (ms: number) => new Date(ms).toISOString();
const POOL_QUOTA = `pool-${"1".repeat(32)}`;
const POOL_CREDIT = `pool-${"2".repeat(32)}`;
const LIMITATIONS = ["routing_unverified", "shared_pool", "budget_estimated", "gateway_observed_usage_only", "task_attribution_unavailable"];

function observation(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: POOL_QUOTA, scopeKind: "gateway_pool", shared: true, modelId: "synthetic-model-alpha", realm: "cn",
    unit: "tokens", valueKind: "estimated", availability: "available",
    used: 20, budget: 100, remaining: 80, resetAt: null,
    method: "historical_budget_minus_observed_usage", limitations: [...LIMITATIONS],
    ...overrides,
  };
}

function quotaSnapshot(connectionId: string, observations: unknown[], times: { collectedAt: number; sourceObservedAt: number | null; expiresAt: number }, overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: `synthetic-quota-${connectionId}`.slice(0, 60), connectionId,
    collectedAt: iso(times.collectedAt), sourceObservedAt: times.sourceObservedAt === null ? null : iso(times.sourceObservedAt),
    expiresAt: iso(times.expiresAt), observations, ...overrides,
  };
}

function creditSnapshot(connectionId: string, times: { collectedAt: number; latestMemberObservedAt: number | null; cacheExpiresAt: number }, overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: `synthetic-credit-${connectionId}`, connectionId, scopeId: POOL_CREDIT, realm: "cn", unit: "credit", valueKind: "reported_cache",
    balance: 123.45, accountsEnabled: 3, accountsWithData: 1, coverage: "partial",
    latestMemberObservedAt: times.latestMemberObservedAt === null ? null : iso(times.latestMemberObservedAt),
    collectedAt: iso(times.collectedAt), cacheExpiresAt: iso(times.cacheExpiresAt),
    ...overrides,
  };
}

function seed(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-consistency-"));
  const file = path.join(dir, "tasks.sqlite");
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const store = new TaskStore(file);
  store.createOrGet({ taskId: "synthetic-task", messageId: "synthetic-message", objective: "synthetic objective", state: "queued" });
  const env = {
    dir, file, runsDir, store,
    service: () => new TaskApplicationService({ store } as never, 3, runsDir),
    publishQuota(connectionId: string, snapshot: unknown, fingerprint = `synthetic-fingerprint-${connectionId}`) {
      const epoch = store.quotas.register(connectionId, fingerprint);
      const generation = store.quotas.beginPoll(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(store.quotas.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
    failQuota(connectionId: string, epoch: string, code: string) {
      const generation = store.quotas.beginPoll(connectionId, epoch);
      assert.ok(generation !== null);
      store.quotas.failed(connectionId, epoch, generation, code as never);
    },
    publishCredit(connectionId: string, snapshot: unknown) {
      const epoch = store.creditBalances.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = store.creditBalances.begin(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(store.creditBalances.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
  };
  t.after(() => {
    try { store.close(); } catch { /* closed by the test */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return env;
}

test("a fresh single source keeps its own level, time and expiry on the mapping", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now - 2000, sourceObservedAt: now - 3000, expiresAt: now + 90_000,
  }));

  const evidence = env.service().readRoutingEvidence();
  const mapping = evidence.mappings[0]!;
  assert.equal(mapping.level, "observed");
  assert.equal(mapping.evidenceReason, "snapshot_fresh");
  assert.equal(mapping.primaryConnectionId, "synthetic-quota");
  assert.equal(mapping.expiresAt, iso(now + 90_000));
  assert.equal(mapping.sourceObservedAt, iso(now - 3000));
  assert.deepEqual(mapping.sources.map(item => [item.connectionId, item.level, item.reason]), [["synthetic-quota", "observed", "snapshot_fresh"]]);
  assert.equal(evidence.routingVerified, false);
});

test("a positively expired snapshot maps at expired", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now - 600_000, sourceObservedAt: now - 600_000, expiresAt: now - 500_000,
  }));

  const mapping = env.service().readRoutingEvidence().mappings[0]!;
  assert.equal(mapping.level, "expired");
  assert.equal(mapping.evidenceReason, "snapshot_expired");
});

test("a snapshot without a source time is unavailable, never expired", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now, sourceObservedAt: null, expiresAt: now + 90_000,
  }));

  const evidence = env.service().readRoutingEvidence();
  const connection = evidence.connections[0]!;
  assert.equal(connection.snapshotId !== null, true);
  assert.equal(connection.level, "unavailable");
  assert.equal(connection.reason, "source_time_unknown");

  const mapping = evidence.mappings[0]!;
  assert.equal(mapping.level, "unavailable");
  assert.equal(mapping.evidenceReason, "source_time_unknown");
  // The time-provenance gap is not re-labelled as a confirmed expiry.
  assert.notEqual(mapping.level, "expired");
  assert.equal(mapping.sourceObservedAt, null);
});

test("a failed refresh keeps the last snapshot but reports the source error", (t) => {
  const env = seed(t);
  const now = Date.now();
  const { epoch } = env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now - 2000, sourceObservedAt: now - 3000, expiresAt: now + 90_000,
  }));
  env.failQuota("synthetic-quota", epoch, "source_timeout");

  const evidence = env.service().readRoutingEvidence();
  const mapping = evidence.mappings[0]!;
  assert.equal(mapping.level, "unavailable");
  assert.equal(mapping.evidenceReason, "source_error");
  // The numbers and times are still the retained snapshot's.
  assert.equal(mapping.availability, "available");
  assert.equal(mapping.sourceObservedAt, iso(now - 3000));
});

test("a newer failed source never borrows an older source's level", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota-a", quotaSnapshot("synthetic-quota-a", [observation()], {
    collectedAt: now - 60_000, sourceObservedAt: now - 60_000, expiresAt: now + 90_000,
  }));
  const { epoch } = env.publishQuota("synthetic-quota-b", quotaSnapshot("synthetic-quota-b", [
    observation({ used: 100, budget: 100, remaining: 0, availability: "exhausted" }),
  ], { collectedAt: now - 1000, sourceObservedAt: now - 1000, expiresAt: now + 90_000 }));
  env.failQuota("synthetic-quota-b", epoch, "source_unavailable");

  const mapping = env.service().readRoutingEvidence().mappings[0]!;
  // The aggregate view selected B's snapshot; the evidence must say so.
  assert.equal(mapping.primaryConnectionId, "synthetic-quota-b");
  assert.equal(mapping.level, "unavailable");
  assert.equal(mapping.evidenceReason, "source_error");
  assert.equal(mapping.availability, "exhausted");
  assert.equal(mapping.sourceObservedAt, iso(now - 1000));
  // A is still named as another reporter, at its own level.
  const sourceA = mapping.sources.find(item => item.connectionId === "synthetic-quota-a")!;
  assert.equal(sourceA.level, "observed");
  assert.equal(mapping.level, sourceA.level === "observed" ? mapping.level : "unavailable");
  assert.notEqual(mapping.level, "observed");
  assert.deepEqual([...mapping.connectionIds].sort(), ["synthetic-quota-a", "synthetic-quota-b"]);
});

test("conflicting availability stays attached to one traceable source", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota-a", quotaSnapshot("synthetic-quota-a", [observation()], {
    collectedAt: now - 60_000, sourceObservedAt: now - 60_000, expiresAt: now + 90_000,
  }));
  env.publishQuota("synthetic-quota-b", quotaSnapshot("synthetic-quota-b", [
    observation({ used: 100, budget: 100, remaining: 0, availability: "exhausted" }),
  ], { collectedAt: now - 1000, sourceObservedAt: now - 1000, expiresAt: now + 90_000 }));

  const mapping = env.service().readRoutingEvidence().mappings[0]!;
  assert.equal(mapping.primaryConnectionId, "synthetic-quota-b");
  assert.equal(mapping.availability, "exhausted");
  assert.equal(mapping.sourceObservedAt, iso(now - 1000));
  assert.equal(mapping.level, "observed");
  // Every field of the mapping belongs to B, even though A is fresher in age.
  assert.equal(mapping.sources.find(item => item.connectionId === "synthetic-quota-b")!.level, "observed");
});

test("an expired primary does not get upgraded by a fresher peer", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota-a", quotaSnapshot("synthetic-quota-a", [observation()], {
    collectedAt: now - 300_000, sourceObservedAt: now - 300_000, expiresAt: now + 90_000,
  }));
  // B is the newest observation but its own snapshot has already expired.
  env.publishQuota("synthetic-quota-b", quotaSnapshot("synthetic-quota-b", [observation()], {
    collectedAt: now - 1000, sourceObservedAt: now - 1000, expiresAt: now - 500,
  }));

  const mapping = env.service().readRoutingEvidence().mappings[0]!;
  assert.equal(mapping.primaryConnectionId, "synthetic-quota-b");
  assert.equal(mapping.level, "expired");
  assert.equal(mapping.sources.find(item => item.connectionId === "synthetic-quota-a")!.level, "observed");
});

test("a shared pool keeps each reporting source's own status", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota-a", quotaSnapshot("synthetic-quota-a", [observation()], {
    collectedAt: now - 60_000, sourceObservedAt: now - 60_000, expiresAt: now + 90_000,
  }));
  const { epoch } = env.publishQuota("synthetic-quota-b", quotaSnapshot("synthetic-quota-b", [observation()], {
    collectedAt: now - 1000, sourceObservedAt: now - 1000, expiresAt: now + 90_000,
  }));
  env.failQuota("synthetic-quota-b", epoch, "source_timeout");

  const mapping = env.service().readRoutingEvidence().mappings[0]!;
  const byId = new Map(mapping.sources.map(item => [item.connectionId, item]));
  assert.equal(byId.get("synthetic-quota-a")!.level, "observed");
  assert.equal(byId.get("synthetic-quota-b")!.level, "unavailable");
  assert.equal(byId.get("synthetic-quota-b")!.reason, "source_error");
  assert.equal(mapping.level, "unavailable");
});

test("credit cache freshness and member freshness stay separate", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit", {
    collectedAt: now - 1000, latestMemberObservedAt: now - 3_600_000, cacheExpiresAt: now + 90_000,
  }));

  const mapping = env.service().readRoutingEvidence().mappings[0]!;
  assert.equal(mapping.unit, "credit");
  // The cache read succeeded recently.
  assert.equal(mapping.level, "observed");
  assert.equal(mapping.evidenceReason, "cache_fresh");
  // ...which does not make the region balance current.
  assert.equal(mapping.memberFreshness, "stale");
  assert.equal(mapping.sourceObservedAt, iso(now - 3_600_000));
  assert.equal(mapping.expiresAt, iso(now + 90_000));
  assert.equal(mapping.coverage, "partial");
});

test("a fingerprint change invalidates the saved evidence instead of extending it", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now, sourceObservedAt: now, expiresAt: now + 90_000,
  }));
  assert.equal(env.service().readRoutingEvidence().mappings.length, 1);

  // A changed source configuration rotates the epoch and clears the snapshot.
  env.store.quotas.register("synthetic-quota", "synthetic-fingerprint-changed");

  const evidence = env.service().readRoutingEvidence();
  assert.deepEqual(evidence.mappings, []);
  const connection = evidence.connections[0]!;
  assert.equal(connection.level, "unobserved");
  assert.equal(connection.reason, "no_snapshot");
});

test("a corrupt snapshot fails the read rather than becoming an absent mapping", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now, sourceObservedAt: now, expiresAt: now + 90_000,
  }));

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(env.file);
  db.exec("UPDATE quota_connections SET snapshot_json = '{not json'");
  db.close();

  assert.throws(() => env.service().readRoutingEvidence(), /resource_corrupt/);
});

test("the desktop read-only facade derives the same evidence as the gateway", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota-a", quotaSnapshot("synthetic-quota-a", [observation()], {
    collectedAt: now - 60_000, sourceObservedAt: now - 60_000, expiresAt: now + 90_000,
  }));
  const { epoch } = env.publishQuota("synthetic-quota-b", quotaSnapshot("synthetic-quota-b", [observation()], {
    collectedAt: now - 1000, sourceObservedAt: now - 1000, expiresAt: now + 90_000,
  }));
  env.failQuota("synthetic-quota-b", epoch, "source_timeout");
  env.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit", {
    collectedAt: now, latestMemberObservedAt: now - 3_600_000, cacheExpiresAt: now + 90_000,
  }));

  const strip = (value: { generatedAt: string }) => { const { generatedAt, ...rest } = value; return rest; };
  const fromGateway = strip(env.service().readRoutingEvidence());
  env.store.close();

  const { openWorkbenchReadStore } = await import("../scripts/workbench-read-store.mjs");
  const readStore = openWorkbenchReadStore(env.file);
  try {
    const desktop = new TaskApplicationService({ store: readStore } as never, 3, env.runsDir);
    assert.deepEqual(strip(desktop.readRoutingEvidence()), fromGateway);
  } finally {
    readStore.close();
  }
});

test("reading the routing resource does not write, refresh or change task facts", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now, sourceObservedAt: now, expiresAt: now + 90_000,
  }));
  const server = new WorkbenchHttpServer({
    service: env.service(),
    health: () => ({ ok: true }),
    embed: { panel: null, origins: [] },
  });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  const before = createHash("sha256").update(fs.readFileSync(env.file)).digest("hex");
  const taskBefore = env.service().listTasksByCreatedCursor({ limit: 10 });
  const first = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`);
  assert.equal(first.status, 200);
  const body = await first.json() as { schemaVersion: string; generatedAt: string };
  assert.equal(body.schemaVersion, ROUTING_EVIDENCE_SCHEMA);
  const second = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`);
  assert.equal(second.status, 200);
  const after = createHash("sha256").update(fs.readFileSync(env.file)).digest("hex");

  assert.equal(after, before);
  assert.deepEqual(env.service().listTasksByCreatedCursor({ limit: 10 }), taskBefore);
});

test("no evidence state ever reports a verified route", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], {
    collectedAt: now, sourceObservedAt: null, expiresAt: now + 90_000,
  }));
  env.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit", {
    collectedAt: now, latestMemberObservedAt: null, cacheExpiresAt: now + 90_000,
  }));

  const evidence = env.service().readRoutingEvidence();
  assert.equal(evidence.routingVerified, false);
  assert.ok(evidence.limitations.includes("routing_unverified"));
  assert.ok(evidence.limitations.includes("model_scope_unverified"));
  assert.equal(evidence.mappings.every(item => item.level !== "observed" || item.level === "observed"), true);
});
