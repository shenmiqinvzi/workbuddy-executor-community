import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkbenchHttpServer } from "../src/workbench-http.js";
import {
  EXECUTION_LINKS_SCHEMA, PLAN_REFERENCE_SCHEMA, buildPlanResourceReference, readExecutionLinks,
} from "../src/plan-resource-reference.js";
import { describeReference, executionKey, referenceQuery } from "../workbench/plan-reference.mjs";

// A prepared plan and the gateway's statistics connections use different id
// namespaces. These tests pin the conservative rule: a link exists only when a
// deployment declares it, the numbers stay bound to the observation that owns
// them, and a missing snapshot never becomes zero or a "verified" route.

const iso = (ms: number) => new Date(ms).toISOString();
const POOL = `pool-${"1".repeat(32)}`;
const POOL_B = `pool-${"3".repeat(32)}`;
const LIMITATIONS = ["routing_unverified", "shared_pool", "budget_estimated", "gateway_observed_usage_only", "task_attribution_unavailable"];
const EXECUTION = { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-model-alpha", reasoningEffort: null };

function observation(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: POOL, scopeKind: "gateway_pool", shared: true, modelId: "synthetic-model-alpha", realm: "cn",
    unit: "tokens", valueKind: "estimated", availability: "available",
    used: 20, budget: 100, remaining: 80, resetAt: null,
    method: "historical_budget_minus_observed_usage", limitations: [...LIMITATIONS],
    ...overrides,
  };
}

function quotaSnapshot(connectionId: string, observations: unknown[], now = Date.now(), overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: `synthetic-quota-${connectionId}`, connectionId, collectedAt: iso(now), sourceObservedAt: iso(now - 60_000),
    expiresAt: iso(now + 90_000), observations, ...overrides,
  };
}

function creditSnapshot(connectionId: string, now = Date.now(), overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: `synthetic-credit-${connectionId}`, connectionId, scopeId: `pool-${"2".repeat(32)}`, realm: "cn", unit: "credit", valueKind: "reported_cache",
    balance: 12, accountsEnabled: 3, accountsWithData: 1, coverage: "partial",
    latestMemberObservedAt: iso(now - 60_000), collectedAt: iso(now), cacheExpiresAt: iso(now + 90_000),
    ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    executorId: "workbuddy", executionConnectionId: "local-workbuddy", providerId: "workbuddy-native",
    models: ["synthetic-model-alpha"], realm: "cn", quotaConnectionId: "stats-quota",
    creditConnectionId: "stats-credit", declaredAt: "2026-11-01T00:00:00.000Z", ...overrides,
  };
}

const declared = (...links: unknown[]) => ({ status: "declared" as const, code: null, links: links as never });

function seed(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reference-"));
  const file = path.join(dir, "tasks.sqlite");
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const store = new TaskStore(file);
  store.createOrGet({ taskId: "synthetic-task", messageId: "synthetic-message", objective: "synthetic objective", state: "queued" });
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, maxRetries: 3, retryDelay: 50, force: true });
  });
  return {
    dir, file, runsDir, store,
    service: () => new TaskApplicationService({ store } as never, 3, runsDir),
    publishQuota(connectionId: string, snapshot: unknown) {
      const epoch = store.quotas.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = store.quotas.beginPoll(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(store.quotas.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
    publishCredit(connectionId: string, snapshot: unknown) {
      const epoch = store.creditBalances.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = store.creditBalances.begin(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(store.creditBalances.publish(connectionId, epoch, generation, snapshot as never), true);
    },
    read(execution: Record<string, unknown> = EXECUTION, links = declared(link())) {
      return this.service().readPlanResourceReference(execution as never, links as never);
    },
  };
}

function sha(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("no declared link means no resource numbers at all", (t) => {
  const env = seed(t);
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()]));
  const document = env.read(EXECUTION, { status: "absent", code: null, links: [] });
  assert.equal(document.schemaVersion, PLAN_REFERENCE_SCHEMA);
  assert.equal(document.association.status, "unlinked");
  assert.equal(document.association.reason, "no_declared_link");
  assert.equal(document.quota, null);
  assert.equal(document.credit, null);
  assert.equal(document.routingVerified, false);
  assert.equal(document.attribution, "none");
  assert.ok(document.caveats.includes("resource_reference_only"));
});

test("a declared link reports the numbers, times and limits of one observation", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now));
  const document = env.read();
  assert.equal(document.association.status, "linked");
  assert.equal(document.attribution, "execution_link_declared");
  assert.equal(document.link.status, "declared");
  assert.equal(document.link.declaredAt, "2026-11-01T00:00:00.000Z");
  assert.equal(document.link.modelsCount, 1);
  assert.equal(document.quota?.remaining, 80);
  assert.equal(document.quota?.budget, 100);
  assert.equal(document.quota?.used, 20);
  assert.equal(document.quota?.unit, "tokens");
  assert.equal(document.quota?.connectionId, "stats-quota");
  assert.equal(document.quota?.snapshotId, "synthetic-quota-stats-quota");
  assert.equal(document.quota?.freshness, "fresh");
  assert.equal(document.quota?.expiresAt, iso(now + 90_000));
  assert.ok(document.quota?.limitations.includes("routing_unverified"));
  assert.equal(document.credit?.balance, 12);
  assert.equal(document.credit?.unit, "credit");
  assert.equal(document.credit?.coverage, "partial");
  assert.equal(document.credit?.accountsWithData, 1);
  assert.equal(document.creditState, "available");
  assert.equal(document.routingVerified, false);
});

test("the same model name on another execution connection is not a link", (t) => {
  const env = seed(t);
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()]));
  const document = env.read({ ...EXECUTION, connectionId: "local-other" });
  assert.equal(document.association.status, "unlinked");
  assert.equal(document.quota, null);
});

test("a declared link to an unconfigured connection says so instead of showing a balance", (t) => {
  const env = seed(t);
  const document = env.read();
  assert.equal(document.association.status, "linked_not_configured");
  assert.equal(document.association.reason, "quota_source_missing");
  assert.equal(document.quota, null);
  assert.equal(document.credit, null);
  assert.equal(document.creditState, "not_configured");
});

test("a configured connection without an observation for the model is not a zero read", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation({ modelId: "synthetic-model-beta" })], now));
  const document = env.read();
  assert.equal(document.association.status, "linked_not_observed");
  assert.equal(document.quota, null);
});

test("a failing collector keeps the last snapshot and marks it stale", (t) => {
  const env = seed(t);
  const now = Date.now();
  const handle = env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()], now));
  env.store.quotas.failed("stats-quota", handle.epoch, handle.generation, "source_timeout");
  const document = env.read();
  assert.equal(document.association.status, "linked");
  assert.equal(document.quota?.freshness, "stale");
  assert.equal(document.quota?.remaining, 80);
  assert.equal(document.quota?.sourceObservedAt, iso(now - 60_000));
});

test("an observation without a source time is unknown, not expired", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()], now, { sourceObservedAt: null }));
  const document = env.read();
  assert.equal(document.association.status, "linked");
  assert.equal(document.quota?.freshness, "unavailable");
  assert.equal(document.quota?.sourceObservedAt, null);
  assert.equal(document.quota?.remaining, 80);
});

test("null stays unknown while a real zero stays zero", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [
    observation({ modelId: "synthetic-model-null", valueKind: "unavailable", used: null, budget: null, remaining: null, availability: "unknown" }),
    observation({ modelId: "synthetic-model-zero", used: 50, budget: 50, remaining: 0, availability: "exhausted" }),
  ], now));
  const links = declared(link({ models: ["synthetic-model-null", "synthetic-model-zero"] }));
  const nullRead = env.read({ ...EXECUTION, modelId: "synthetic-model-null" }, links);
  assert.equal(nullRead.quota?.remaining, null);
  assert.equal(nullRead.quota?.valueKind, "unavailable");
  const zeroRead = env.read({ ...EXECUTION, modelId: "synthetic-model-zero" }, links);
  assert.equal(zeroRead.quota?.remaining, 0);
  assert.equal(zeroRead.quota?.availability, "exhausted");
});

test("a shared pool owned by another connection does not lend its numbers", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation({ modelId: "synthetic-model-alpha" })], now - 120_000));
  env.publishQuota("stats-quota-b", quotaSnapshot("stats-quota-b", [observation({ modelId: "synthetic-model-alpha", remaining: 5, used: 95 })], now));
  const own = env.read();
  assert.equal(own.association.status, "linked_rows_elsewhere");
  assert.equal(own.association.reason, "aggregate_owned_by_other_source");
  assert.equal(own.quota, null);
  assert.deepEqual(own.otherQuotaSources, [{ connectionId: "stats-quota-b" }]);
  const other = env.read(EXECUTION, declared(link({ quotaConnectionId: "stats-quota-b" })));
  assert.equal(other.association.status, "linked");
  assert.equal(other.quota?.remaining, 5);
  assert.deepEqual(other.otherQuotaSources, [{ connectionId: "stats-quota" }]);
});

test("an invalid links file is refused and never turns into a link", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-links-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = process.env.WORKBUDDY_RESOURCE_LINKS_FILE;
  t.after(() => { if (saved === undefined) delete process.env.WORKBUDDY_RESOURCE_LINKS_FILE; else process.env.WORKBUDDY_RESOURCE_LINKS_FILE = saved; });
  const file = path.join(dir, "links.json");
  process.env.WORKBUDDY_RESOURCE_LINKS_FILE = file;

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: "workbuddy-executor/execution-links-2", links: [] }));
  assert.equal(readExecutionLinks().code, "links_schema_mismatch");
  fs.writeFileSync(file, "{not-json");
  assert.equal(readExecutionLinks().code, "links_file_invalid_json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: EXECUTION_LINKS_SCHEMA, links: [link({ models: [] })] }));
  assert.equal(readExecutionLinks().code, "links_entry_invalid:models");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: EXECUTION_LINKS_SCHEMA, links: [link({ extra: true })] }));
  assert.equal(readExecutionLinks().code, "links_entry_invalid:unknown_key");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: EXECUTION_LINKS_SCHEMA, links: [link()] }));
  const valid = readExecutionLinks();
  assert.equal(valid.status, "declared");
  assert.equal(valid.links.length, 1);
  delete process.env.WORKBUDDY_RESOURCE_LINKS_FILE;
  const missing = readExecutionLinks();
  assert.equal(missing.status, "absent");
  process.env.WORKBUDDY_RESOURCE_LINKS_FILE = path.join(dir, "nope.json");
  assert.equal(readExecutionLinks().code, "links_file_missing");
});

test("the HTTP resource answers only for a complete execution selection", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now));
  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });
  const get = (query: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}/workbench/v1/resources/plan-reference${query}`, init);
  const base = "executorId=workbuddy&connectionId=local-workbuddy&providerId=workbuddy-native&modelId=synthetic-model-alpha";
  const unlinked = await get(`?${base}`);
  assert.equal(unlinked.status, 200);
  assert.equal((await unlinked.json() as { association: { status: string } }).association.status, "unlinked");
  assert.equal((await get(`?${base}&limit=5`)).status, 400);
  assert.equal((await get("?executorId=workbuddy&connectionId=local-workbuddy&providerId=workbuddy-native")).status, 400);
  assert.equal((await get("?executorId=other&connectionId=x&providerId=y&modelId=z")).status, 400);
  const post = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/plan-reference?${base}`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("a declared link reaches the HTTP surface without writing anything", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-links-http-"));
  const file = path.join(dir, "links.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: EXECUTION_LINKS_SCHEMA, links: [link()] }));
  const saved = process.env.WORKBUDDY_RESOURCE_LINKS_FILE;
  process.env.WORKBUDDY_RESOURCE_LINKS_FILE = file;
  t.after(() => {
    if (saved === undefined) delete process.env.WORKBUDDY_RESOURCE_LINKS_FILE; else process.env.WORKBUDDY_RESOURCE_LINKS_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const before = sha(env.file);
  const linksBefore = fs.readFileSync(file, "utf8");
  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });
  const query = "?executorId=workbuddy&connectionId=local-workbuddy&providerId=workbuddy-native&modelId=synthetic-model-alpha";
  const response = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/plan-reference${query}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { schemaVersion: string; association: { status: string }; quota: { remaining: number }; routingVerified: boolean };
  assert.equal(body.schemaVersion, PLAN_REFERENCE_SCHEMA);
  assert.equal(body.association.status, "linked");
  assert.equal(body.quota.remaining, 80);
  assert.equal(body.routingVerified, false);
  assert.equal(sha(env.file), before, "a resource read must not change the database file");
  assert.equal(fs.readFileSync(file, "utf8"), linksBefore);
});

test("a damaged quota store answers 503 while the task surface keeps working", async (t) => {
  const env = seed(t);
  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(env.file);
  db.exec("DROP TABLE quota_connections");
  db.close();
  const query = "?executorId=workbuddy&connectionId=local-workbuddy&providerId=workbuddy-native&modelId=synthetic-model-alpha";
  const response = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/plan-reference${query}`);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "RESOURCE_STORE_UNAVAILABLE");
  assert.equal((await fetch(`http://127.0.0.1:${port}/workbench/v1/tasks?limit=5`)).status, 200);
});

test("the panel description keeps null, zero and currency apart", () => {
  const document = buildPlanResourceReference({
    execution: EXECUTION,
    links: declared(link()),
    quota: {
      schemaVersion: "workbuddy-executor/quota-1", readOnly: true, truncated: false, attribution: "connection_only", actualTaskCredits: null, actualTaskTokens: null,
      connections: [{ connectionId: "stats-quota", status: "observed", errorCode: null, snapshotId: "s1", collectedAt: iso(Date.now()), sourceObservedAt: iso(Date.now() - 60_000), expiresAt: iso(Date.now() + 60_000), freshness: "fresh" }],
      observations: [{ ...observation({ remaining: 0, used: 50, budget: 50, availability: "exhausted" }), connectionId: "stats-quota", snapshotId: "s1", sourceObservedAt: iso(Date.now() - 60_000), collectedAt: iso(Date.now()), connectionIds: ["stats-quota", "stats-extra"] }],
    } as never,
    credit: {
      schemaVersion: "workbuddy-executor/credit-balance-1", readOnly: true, attribution: "connection_only", actualTaskCredits: null,
      connections: [{ connectionId: "stats-credit", status: "observed", errorCode: null, snapshotId: "c1", collectedAt: iso(Date.now()), cacheFreshness: "fresh" }],
      balances: [{ connectionId: "stats-credit", scopeId: POOL, realm: "cn", unit: "credit", valueKind: "reported_cache", balance: 12, accountsEnabled: 4, accountsWithData: 2, coverage: "partial", latestMemberObservedAt: iso(Date.now() - 60_000), collectedAt: iso(Date.now()), cacheExpiresAt: iso(Date.now() + 60_000), balanceFreshness: "stale", limitations: ["shared_region_pool"], errorCode: null, snapshotId: "c1", connectionIds: ["stats-credit"] }],
    } as never,
    now: new Date().toISOString(),
  });
  const view = describeReference(document);
  const byLabel = (label: string) => view.lines.find(line => line.label === label)?.value;
  assert.equal(byLabel("剩余 token"), "0");
  assert.equal(byLabel("已用 token"), "50");
  assert.equal(byLabel("积分余额"), "12");
  assert.ok(view.caveats.some(item => item.includes("积分不是货币")));
  assert.ok(view.caveats.some(item => item.includes("另有 1 个来源")));
  assert.ok(!view.lines.some(line => /[¥$€]/.test(String(line.value))), "credit is not currency");
  assert.ok(view.caveats.some(item => item.includes("不证明本任务实际可用")));
});

test("the panel description shows 未提供 instead of zero and names the unlinked state", () => {
  const unlinked = buildPlanResourceReference({
    execution: EXECUTION,
    links: { status: "absent", code: null, links: [] },
    quota: { schemaVersion: "workbuddy-executor/quota-1", readOnly: true, connections: [], observations: [], truncated: false, attribution: "connection_only", actualTaskCredits: null, actualTaskTokens: null } as never,
    credit: { schemaVersion: "workbuddy-executor/credit-balance-1", readOnly: true, connections: [], balances: [], actualTaskCredits: null, attribution: "connection_only" } as never,
    now: new Date().toISOString(),
  });
  const view = describeReference(unlinked);
  assert.equal(view.headline, "尚未建立该执行来源与统计连接的关联。");
  assert.equal(view.lines.length, 0);
  assert.ok(view.caveats.some(item => item.includes("没有可核验的执行来源与统计连接关联")));

  const unknown = buildPlanResourceReference({
    execution: EXECUTION,
    links: declared(link()),
    quota: {
      schemaVersion: "workbuddy-executor/quota-1", readOnly: true, truncated: false, attribution: "connection_only", actualTaskCredits: null, actualTaskTokens: null,
      connections: [{ connectionId: "stats-quota", status: "observed", errorCode: null, snapshotId: "s1", collectedAt: iso(Date.now()), sourceObservedAt: null, expiresAt: null, freshness: "unavailable" }],
      observations: [{ ...observation({ remaining: null, used: null, budget: null, valueKind: "unavailable", availability: "unknown" }), connectionId: "stats-quota", snapshotId: "s1", sourceObservedAt: null, collectedAt: iso(Date.now()), connectionIds: ["stats-quota"] }],
    } as never,
    credit: { schemaVersion: "workbuddy-executor/credit-balance-1", readOnly: true, connections: [], balances: [], actualTaskCredits: null, attribution: "connection_only" } as never,
    now: new Date().toISOString(),
  });
  const unknownView = describeReference(unknown);
  const byLabel = (label: string) => unknownView.lines.find(line => line.label === label)?.value;
  assert.equal(byLabel("剩余 token"), "未提供");
  assert.equal(byLabel("来源时间"), "未提供");
  assert.ok(unknownView.caveats.some(item => item.includes("不是新鲜的")));
  assert.equal(unknown.quota?.freshness, "unavailable");
});

test("the query is built from the exact execution selection", () => {
  const query = referenceQuery({ ...EXECUTION, reasoningEffort: "high" });
  assert.equal(query, "/workbench/v1/resources/plan-reference?executorId=workbuddy&connectionId=local-workbuddy&providerId=workbuddy-native&modelId=synthetic-model-alpha&reasoningEffort=high");
  const plain = referenceQuery({ ...EXECUTION, modelId: "模型 名称" });
  assert.ok(plain.includes("modelId=%E6%A8%A1%E5%9E%8B+%E5%90%8D%E7%A7%B0"));
  assert.notEqual(executionKey({ ...EXECUTION, modelId: "a" }), executionKey({ ...EXECUTION, modelId: "b" }));
});
