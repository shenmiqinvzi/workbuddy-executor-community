import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { ROUTING_EVIDENCE_SCHEMA, buildRoutingEvidence } from "../src/resource-routing.js";
import { WorkbenchHttpServer } from "../src/workbench-http.js";

// Routing evidence answers a narrower question than the resource views:
// "which pool did a configured source report, and how strong is that claim?"
// These tests keep the answer honest — observed, expired, unavailable and
// unobserved must stay distinguishable, and nothing may ever be reported as a
// verified task-to-model route while the source carries no task identity.

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

function quotaSnapshot(connectionId: string, observations: unknown[], now = Date.now(), overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: "synthetic-quota-snapshot-0001", connectionId, collectedAt: iso(now), sourceObservedAt: iso(now - 1000),
    expiresAt: iso(now + 90_000), observations, ...overrides,
  };
}

function creditSnapshot(connectionId: string, now = Date.now(), overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: "synthetic-credit-snapshot-001", connectionId, scopeId: POOL_CREDIT, realm: "cn", unit: "credit", valueKind: "reported_cache",
    balance: 123.45, accountsEnabled: 3, accountsWithData: 1, coverage: "partial",
    latestMemberObservedAt: iso(now - 1000), collectedAt: iso(now), cacheExpiresAt: iso(now + 90_000),
    ...overrides,
  };
}

function seed(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resource-routing-"));
  const file = path.join(dir, "tasks.sqlite");
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const store = new TaskStore(file);
  store.createOrGet({ taskId: "synthetic-task", messageId: "synthetic-message", objective: "synthetic objective", state: "queued" });
  t.after(() => {
    // Some tests close the writer themselves to simulate a stopped gateway.
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return {
    dir, file, runsDir, store,
    service: () => new TaskApplicationService({ store } as never, 3, runsDir),
    registerQuota(connectionId: string) {
      return this.store.quotas.register(connectionId, `synthetic-fingerprint-${connectionId}`);
    },
    publishQuota(connectionId: string, snapshot: unknown) {
      const epoch = this.store.quotas.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = this.store.quotas.beginPoll(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(this.store.quotas.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
    publishCredit(connectionId: string, snapshot: unknown) {
      const epoch = this.store.creditBalances.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = this.store.creditBalances.begin(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(this.store.creditBalances.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
  };
}

function noWindow(value: { generatedAt: string }) {
  const { generatedAt, ...rest } = value;
  assert.equal(typeof generatedAt, "string");
  assert.equal(Number.isFinite(Date.parse(generatedAt)), true);
  return rest;
}

test("an empty database reports no mappings rather than a verified route", (t) => {
  const env = seed(t);
  const evidence = env.service().readRoutingEvidence();

  assert.equal(evidence.schemaVersion, ROUTING_EVIDENCE_SCHEMA);
  assert.equal(evidence.readOnly, true);
  assert.equal(evidence.snapshotOnly, true);
  assert.equal(evidence.routingVerified, false);
  assert.equal(evidence.basis, "gateway_observation_only");
  assert.deepEqual(evidence.connections, []);
  assert.deepEqual(evidence.mappings, []);
  // The unknowns are structural: they hold whatever the data says.
  assert.deepEqual(evidence.unresolved.map(item => item.code), ["task_to_model", "session_to_provider", "key_scope", "exclusive_reservation"]);
  assert.ok(evidence.limitations.includes("routing_unverified"));
});

test("a configured but unobserved connection stays unverified", (t) => {
  const env = seed(t);
  env.registerQuota("synthetic-quota");

  const evidence = env.service().readRoutingEvidence();
  assert.equal(evidence.connections.length, 1);
  const connection = evidence.connections[0]!;
  assert.equal(connection.resource, "quota");
  assert.equal(connection.status, "not_observed");
  assert.equal(connection.level, "unobserved");
  assert.equal(connection.snapshotId, null);
  assert.deepEqual(evidence.mappings, []);
});

test("an observed pool maps its models with a gateway-observation level only", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [
    observation(),
    observation({ modelId: "synthetic-model-beta", used: null, budget: null, remaining: null, availability: "unknown", valueKind: "unavailable" }),
  ], now));
  env.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit", now));

  const evidence = env.service().readRoutingEvidence();
  assert.equal(evidence.routingVerified, false);
  // Two token models plus one credit pool; the credit pool has no model dimension.
  assert.equal(evidence.mappings.length, 3);

  const alpha = evidence.mappings.find(item => item.modelId === "synthetic-model-alpha")!;
  assert.equal(alpha.scopeId, POOL_QUOTA);
  assert.equal(alpha.unit, "tokens");
  assert.equal(alpha.level, "observed");
  assert.equal(alpha.availability, "available");
  assert.deepEqual(alpha.connectionIds, ["synthetic-quota"]);
  assert.equal(typeof alpha.sourceObservedAt, "string");

  const credit = evidence.mappings.find(item => item.unit === "credit")!;
  assert.equal(credit.modelId, null);
  assert.equal(credit.scopeId, POOL_CREDIT);
  assert.equal(credit.scopeKind, "gateway_region_pool");
  assert.equal(credit.coverage, "partial");
  assert.equal(credit.level, "observed");

  // The projection is stable: the same store read twice gives the same document.
  assert.deepEqual(noWindow(evidence), noWindow(env.service().readRoutingEvidence()));
});

test("an expired snapshot downgrades the mapping instead of keeping it fresh", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], now, {
    collectedAt: iso(now - 600_000), sourceObservedAt: iso(now - 600_000), expiresAt: iso(now - 500_000),
  }));
  env.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit", now, {
    collectedAt: iso(now - 600_000), cacheExpiresAt: iso(now - 500_000), latestMemberObservedAt: iso(now - 600_000),
  }));

  const evidence = env.service().readRoutingEvidence();
  assert.equal(evidence.connections.every(item => item.status === "observed"), true);
  assert.equal(evidence.connections.every(item => item.level === "expired"), true);
  assert.equal(evidence.mappings.every(item => item.level === "expired"), true);
  assert.equal(evidence.routingVerified, false);
});

test("a collection error downgrades both the connection and its pool", (t) => {
  const env = seed(t);
  const now = Date.now();
  const { epoch } = env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], now));
  // A refresh that failed keeps the previous snapshot but marks the connection.
  const generation = env.store.quotas.beginPoll("synthetic-quota", epoch);
  assert.ok(generation !== null);
  env.store.quotas.failed("synthetic-quota", epoch, generation, "source_timeout");

  const evidence = env.service().readRoutingEvidence();
  const connection = evidence.connections.find(item => item.connectionId === "synthetic-quota")!;
  assert.equal(connection.status, "unavailable");
  assert.equal(connection.errorCode, "source_timeout");
  assert.equal(connection.level, "unavailable");
  // The pool is still named, but at the weakest still-present level.
  assert.equal(evidence.mappings.length, 1);
  assert.equal(evidence.mappings[0]!.level, "unavailable");
});

test("the same pool reported by two connections is listed once with both sources", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota-a", quotaSnapshot("synthetic-quota-a", [observation()], now));
  env.publishQuota("synthetic-quota-b", quotaSnapshot("synthetic-quota-b", [observation({ used: 30, budget: 100, remaining: 70 })], now + 1000));

  const evidence = env.service().readRoutingEvidence();
  assert.equal(evidence.mappings.length, 1);
  const mapping = evidence.mappings[0]!;
  assert.deepEqual([...mapping.connectionIds].sort(), ["synthetic-quota-a", "synthetic-quota-b"]);
  assert.equal(mapping.level, "observed");
  // Both connections stay visible, so the shared scope is not hidden behind one id.
  assert.equal(evidence.connections.length, 2);
});

test("the desktop read-only facade derives the same evidence as the gateway", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], now));
  env.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit", now));
  const fromGateway = noWindow(env.service().readRoutingEvidence());
  env.store.close();

  const { openWorkbenchReadStore } = await import("../scripts/workbench-read-store.mjs");
  const readStore = openWorkbenchReadStore(env.file);
  try {
    const desktop = new TaskApplicationService({ store: readStore } as never, 3, env.runsDir);
    assert.deepEqual(noWindow(desktop.readRoutingEvidence()), fromGateway);
  } finally {
    readStore.close();
  }
});

test("the routing resource is served read-only and refuses query parameters", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], now));
  const server = new WorkbenchHttpServer({
    service: env.service(),
    health: () => ({ ok: true }),
    embed: { panel: null, origins: [] },
  });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  const get = (pathname: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, init);

  const ok = await get("/workbench/v1/resources/routing");
  assert.equal(ok.status, 200);
  const body = await ok.json() as { schemaVersion: string; routingVerified: boolean; mappings: unknown[] };
  assert.equal(body.schemaVersion, ROUTING_EVIDENCE_SCHEMA);
  assert.equal(body.routingVerified, false);
  assert.equal(body.mappings.length, 1);

  const withQuery = await get("/workbench/v1/resources/routing?connectionId=synthetic-quota");
  assert.equal(withQuery.status, 400);
  assert.equal((await withQuery.json() as { error: { code: string } }).error.code, "INVALID_RESOURCE_QUERY");

  const post = await get("/workbench/v1/resources/routing", { method: "POST" });
  assert.equal(post.status, 405);
});

test("a damaged quota store fails the routing read instead of reporting a mapping", async (t) => {
  const env = seed(t);
  const server = new WorkbenchHttpServer({
    service: env.service(),
    health: () => ({ ok: true }),
    embed: { panel: null, origins: [] },
  });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  // Drop one resource table from a second connection: the task tables stay
  // readable, so a resource failure is distinguishable from a dead database.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(env.file);
  db.exec("DROP TABLE quota_connections");
  db.close();

  const response = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "RESOURCE_STORE_UNAVAILABLE");

  // The task surface keeps working while the resource read fails.
  const tasks = await fetch(`http://127.0.0.1:${port}/workbench/v1/tasks?limit=5`);
  assert.equal(tasks.status, 200);
});

test("buildRoutingEvidence never upgrades a plan into an executed route", () => {
  const empty = buildRoutingEvidence(
    { schemaVersion: "workbuddy-executor/quota-1", readOnly: true, connections: [], observations: [], truncated: false, attribution: "connection_only", actualTaskCredits: null, actualTaskTokens: null } as never,
    { schemaVersion: "workbuddy-executor/credit-balance-1", readOnly: true, connections: [], balances: [], actualTaskCredits: null, attribution: "connection_only" } as never,
    new Date("2026-11-04T00:00:00.000Z"),
  );
  assert.equal(empty.generatedAt, "2026-11-04T00:00:00.000Z");
  assert.equal(empty.routingVerified, false);
  assert.ok(empty.invalidatesOn.includes("configuration_change"));
  assert.ok(empty.limitations.includes("model_scope_unverified"));
});
