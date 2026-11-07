import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import type { TaskCoordinator } from "../src/task-application-service.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkbenchHttpServer, workbenchHealth } from "../src/workbench-http.js";
import { runtimeVersion } from "../src/runtime-version.js";
import { openWorkbenchReadStore } from "../scripts/workbench-read-store.mjs";

// The desktop window opens the same database the gateway writes, through a
// genuinely read-only connection. These tests therefore build the schema with the
// real TaskStore, close it, and read it back through openWorkbenchReadStore.
// Nothing here fakes the facade: a missing query is a failing test, not a stub.

const iso = (ms: number) => new Date(ms).toISOString();
const POOL_QUOTA = `pool-${"1".repeat(32)}`;
const POOL_CREDIT = `pool-${"2".repeat(32)}`;
const QUOTA_SNAPSHOT_ID = "synthetic-quota-snapshot-0001";
const CREDIT_SNAPSHOT_ID = "synthetic-credit-snapshot-001";
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

function quotaSnapshot(connectionId: string, observations: unknown[], now = Date.now()) {
  return {
    snapshotId: QUOTA_SNAPSHOT_ID, connectionId, collectedAt: iso(now), sourceObservedAt: iso(now - 1000),
    expiresAt: iso(now + 90_000), observations,
  };
}

function creditSnapshot(connectionId: string, overrides: Record<string, unknown> = {}, now = Date.now()) {
  return {
    snapshotId: CREDIT_SNAPSHOT_ID, connectionId, scopeId: POOL_CREDIT, realm: "cn", unit: "credit", valueKind: "reported_cache",
    balance: 123.45, accountsEnabled: 3, accountsWithData: 1, coverage: "partial",
    latestMemberObservedAt: iso(now - 1000), collectedAt: iso(now), cacheExpiresAt: iso(now + 90_000),
    ...overrides,
  };
}

/** A real database, written by the real store, then closed so the reader sees
 * exactly what a stopped gateway left behind. */
function seed(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-readonly-resources-"));
  const file = path.join(dir, "tasks.sqlite");
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const writer = new TaskStore(file);
  writer.createOrGet({ taskId: "synthetic-task", messageId: "synthetic-message", objective: "synthetic objective", state: "queued" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return {
    dir, file, runsDir, writer,
    publishQuota(connectionId: string, snapshot: unknown) {
      const epoch = writer.quotas.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = writer.quotas.beginPoll(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(writer.quotas.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
    publishCredit(connectionId: string, snapshot: unknown) {
      const epoch = writer.creditBalances.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = writer.creditBalances.begin(connectionId, epoch);
      assert.ok(generation !== null);
      assert.equal(writer.creditBalances.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
    finish() { writer.close(); },
  };
}

/** Run one statement on a writable connection while the reader is closed. */
function writeOnce(file: string, sql: string, ...parameters: Array<string | number | null>) {
  const db = new DatabaseSync(file);
  try { db.prepare(sql).run(...parameters); } finally { db.close(); }
}

function readOnlyService(file: string, runsDir: string) {
  const store = openWorkbenchReadStore(file, { runsDir });
  // The desktop host composes the service with nothing but this frozen store.
  const service = new TaskApplicationService({ store } as unknown as TaskCoordinator, 3, runsDir);
  return { store, service };
}

function schemaNames(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
  } finally { db.close(); }
}

function digestOf(file: string) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

async function get(port: number, pathname: string) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { host: `127.0.0.1:${port}` } });
  return { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text() };
}

test("an empty resource schema reads as unconfigured, not as zero quota", async t => {
  const f = seed(t);
  f.finish();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    const quota = service.readQuotaResources();
    assert.deepEqual(quota.connections, []);
    assert.deepEqual(quota.observations, []);
    assert.equal(quota.truncated, false);
    assert.equal(quota.readOnly, true);
    assert.equal(quota.actualTaskTokens, null, "an empty read never becomes a zero balance");
    assert.equal(quota.attribution, "connection_only");
    const credit = service.readCreditBalances();
    assert.deepEqual(credit.connections, []);
    assert.deepEqual(credit.balances, []);
    assert.equal(credit.actualTaskCredits, null);
    const capacity = service.readCapacity();
    assert.equal(capacity.occupied, null);
    assert.equal(capacity.limit, 1);
    assert.equal(capacity.snapshotOnly, true);
  } finally { store.close(); }
});

test("a configured connection without a snapshot reads as not observed", async t => {
  const f = seed(t);
  f.writer.quotas.register("synthetic-quota", "synthetic-fingerprint-quota");
  f.writer.creditBalances.register("synthetic-credit", "synthetic-fingerprint-credit");
  f.finish();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    const quota = service.readQuotaResources();
    assert.equal(quota.connections.length, 1);
    assert.equal(quota.connections[0]!.status, "not_observed");
    assert.equal(quota.connections[0]!.snapshotId, null);
    assert.equal(quota.connections[0]!.freshness, "unavailable");
    assert.deepEqual(quota.observations, [], "a connection with no snapshot contributes no row");
    const credit = service.readCreditBalances();
    assert.equal(credit.connections[0]!.status, "not_observed");
    assert.equal(credit.connections[0]!.cacheFreshness, "unavailable");
    assert.deepEqual(credit.balances, []);
  } finally { store.close(); }
});

test("a saved quota snapshot is served with its estimates, nulls and exhaustion evidence", async t => {
  const f = seed(t);
  f.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [
    observation(),
    observation({ modelId: "synthetic-model-beta", valueKind: "unavailable", availability: "unknown", used: null, budget: null, remaining: null }),
    observation({ modelId: "synthetic-model-gamma", availability: "exhausted", used: 50, budget: 50, remaining: 0, method: "source_cooling_and_historical_budget", resetAt: iso(Date.now() + 3_600_000) }),
  ]));
  const expected = f.writer.quotas.read();
  f.finish();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    const view = service.readQuotaResources();
    assert.deepEqual(view, expected, "the desktop read is the gateway read, not a second implementation");
    const alpha = view.observations.find(item => item.modelId === "synthetic-model-alpha")!;
    assert.equal(alpha.remaining, 80);
    assert.equal(alpha.shared, true);
    assert.equal(alpha.scopeKind, "gateway_pool");
    assert.equal(alpha.unit, "tokens");
    assert.deepEqual(alpha.connectionIds, ["synthetic-quota"]);
    assert.ok(alpha.limitations.includes("routing_unverified"), "an unverified route stays unverified");
    const beta = view.observations.find(item => item.modelId === "synthetic-model-beta")!;
    assert.equal(beta.remaining, null, "null stays null instead of becoming zero");
    assert.equal(beta.availability, "unknown");
    const gamma = view.observations.find(item => item.modelId === "synthetic-model-gamma")!;
    assert.equal(gamma.remaining, 0, "a real zero is kept as a zero");
    assert.equal(gamma.availability, "exhausted");
    const connection = view.connections[0]!;
    assert.equal(connection.status, "observed");
    assert.equal(connection.freshness, "fresh");
    assert.equal(connection.snapshotId, QUOTA_SNAPSHOT_ID);
  } finally { store.close(); }
});

test("a saved credit balance keeps partial coverage and never becomes a currency total", async t => {
  const f = seed(t);
  f.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit"));
  const expected = f.writer.creditBalances.read();
  f.finish();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    const view = service.readCreditBalances();
    assert.deepEqual(view, expected);
    const balance = view.balances[0]!;
    assert.equal(balance.balance, 123.45);
    assert.equal(balance.unit, "credit");
    assert.equal(balance.coverage, "partial");
    assert.equal(balance.accountsEnabled, 3);
    assert.equal(balance.accountsWithData, 1);
    assert.equal(balance.shared, true);
    assert.ok(balance.limitations.includes("routing_unverified"));
    assert.equal(Object.hasOwn(balance, "total"), false, "no invented total across accounts");
    assert.equal(view.actualTaskCredits, null);
    assert.equal(view.connections[0]!.cacheFreshness, "fresh");
  } finally { store.close(); }
});

test("a stale snapshot and a recorded collection error stay visible instead of being dropped", async t => {
  const f = seed(t);
  const past = Date.now() - 600_000;
  const quota = f.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()], past));
  f.writer.quotas.failed("synthetic-quota", quota.epoch, quota.generation, "source_timeout");
  const credit = f.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit", {}, past));
  f.writer.creditBalances.failed("synthetic-credit", credit.epoch, credit.generation, "source_unavailable");
  f.finish();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    const quotas = service.readQuotaResources();
    assert.equal(quotas.connections[0]!.freshness, "stale");
    assert.equal(quotas.connections[0]!.errorCode, "source_timeout");
    assert.equal(quotas.connections[0]!.status, "unavailable");
    assert.equal(quotas.observations.length, 1, "a failed collection keeps the last saved observation");
    assert.equal(quotas.observations[0]!.remaining, 80);
    const credits = service.readCreditBalances();
    assert.equal(credits.connections[0]!.cacheFreshness, "stale");
    assert.equal(credits.balances.length, 1);
    assert.equal(credits.balances[0]!.balance, 123.45);
    assert.equal(credits.balances[0]!.errorCode, "source_unavailable");
  } finally { store.close(); }
});

test("a corrupt snapshot is refused instead of being reported as an empty resource", async t => {
  const f = seed(t);
  f.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()]));
  f.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit"));
  f.finish();
  writeOnce(f.file, "UPDATE quota_connections SET snapshot_json=? WHERE id=?", '{"broken":true}', "synthetic-quota");
  writeOnce(f.file, "UPDATE credit_balance_connections SET snapshot_json=? WHERE id=?", '{"broken":true}', "synthetic-credit");
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    assert.throws(() => service.readQuotaResources(), /resource_corrupt/);
    assert.throws(() => service.readCreditBalances(), /credit_resource_corrupt/);
    // A refused resource is not a task failure: the task read still answers.
    const page = service.listStageViews({ limit: 10 });
    assert.equal(page.ok, true);
    assert.equal(page.tasks.length, 1);
  } finally { store.close(); }
});

test("a database without resource tables is unreadable, never empty and never idle", async t => {
  const f = seed(t);
  f.finish();
  for (const table of ["quota_connections", "quota_metadata", "credit_balance_connections", "workflow_capacity"])
    writeOnce(f.file, `DROP TABLE ${table}`);
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    assert.throws(() => service.readQuotaResources(), /resource_storage_missing:quota_connections/);
    assert.throws(() => service.readCreditBalances(), /resource_storage_missing:credit_balance_connections/);
    assert.throws(() => service.readCapacity(), /resource_storage_missing:workflow_capacity/);
    const page = service.listStageViews({ limit: 10 });
    assert.equal(page.ok, true, "resource storage is absent, not the task query");
    assert.equal(page.tasks.length, 1);
  } finally { store.close(); }
});

test("capacity distinguishes a saved occupant from a saved free slot", async t => {
  const f = seed(t);
  f.finish();
  const free = readOnlyService(f.file, f.runsDir);
  try { assert.equal(free.service.readCapacity().occupied, null); } finally { free.store.close(); }
  writeOnce(f.file, "INSERT INTO workflow_capacity (slot,task_id,executor,operation_id) VALUES (1,?,?,?)",
    "synthetic-task", "workbuddy", "synthetic-operation-1");
  const busy = readOnlyService(f.file, f.runsDir);
  try {
    const capacity = busy.service.readCapacity();
    assert.deepEqual(capacity.occupied, { taskId: "synthetic-task", executor: "workbuddy", operationId: "synthetic-operation-1" });
    assert.equal(capacity.limit, 1);
    assert.ok(Number.isFinite(Date.parse(capacity.observedAt)));
  } finally { busy.store.close(); }
});

test("a damaged capacity table is refused instead of being reported as a free slot", async t => {
  const f = seed(t);
  f.finish();
  writeOnce(f.file, "DROP TABLE workflow_capacity");
  writeOnce(f.file, "CREATE TABLE workflow_capacity (task_id TEXT, executor TEXT)");
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    // Contract: a row this reader cannot query is not evidence that the slot is free,
    // so it must fail loudly rather than answer `occupied: null`.
    assert.throws(() => service.readCapacity(), /no such column: slot/);
    assert.equal(service.listStageViews({ limit: 10 }).ok, true, "damaged capacity is not a task failure");
  } finally { store.close(); }
});

test("opening and reading leaves the database unchanged and creates no storage", async t => {
  const f = seed(t);
  f.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()]));
  f.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit"));
  f.finish();
  const before = { hash: digestOf(f.file), tables: schemaNames(f.file) };
  const tasksBefore = (() => { const db = new DatabaseSync(f.file, { readOnly: true }); try { return db.prepare("SELECT task_id,revision,updated_at FROM tasks").all(); } finally { db.close(); } })();
  const eventsBefore = (() => { const db = new DatabaseSync(f.file, { readOnly: true }); try { return Number((db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as { n: number }).n); } finally { db.close(); } })();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    service.readQuotaResources();
    service.readCreditBalances();
    service.readCapacity();
    service.listStageViews({ limit: 10 });
    service.listTasksByCreatedCursor({ limit: 10 });
  } finally { store.close(); }
  assert.equal(digestOf(f.file), before.hash, "reading a window must not rewrite the database file");
  assert.deepEqual(schemaNames(f.file), before.tables, "no table may be created or dropped by a read");
  assert.deepEqual(tasksBefore, (() => { const db = new DatabaseSync(f.file, { readOnly: true }); try { return db.prepare("SELECT task_id,revision,updated_at FROM tasks").all(); } finally { db.close(); } })());
  assert.equal((() => { const db = new DatabaseSync(f.file, { readOnly: true }); try { return Number((db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as { n: number }).n); } finally { db.close(); } })(), eventsBefore);
});

test("reading an old database does not add quota metadata, salt or connections", async t => {
  const f = seed(t);
  f.finish();
  for (const table of ["quota_connections", "quota_metadata", "credit_balance_connections"])
    writeOnce(f.file, `DROP TABLE ${table}`);
  const tables = schemaNames(f.file);
  const { store, service } = readOnlyService(f.file, f.runsDir);
  try {
    assert.throws(() => service.readQuotaResources(), /resource_storage_missing/);
    service.listStageViews({ limit: 10 });
  } finally { store.close(); }
  assert.deepEqual(schemaNames(f.file), tables, "a read-only open never migrates or seeds a scope salt");
  assert.equal(schemaNames(f.file).includes("quota_metadata"), false);
});

test("the desktop host serves the resource page and the saved resources over HTTP", async t => {
  const f = seed(t);
  f.publishQuota("synthetic-quota", quotaSnapshot("synthetic-quota", [observation()]));
  f.publishCredit("synthetic-credit", creditSnapshot("synthetic-credit"));
  f.finish();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  const server = new WorkbenchHttpServer({ service, health: () => workbenchHealth({ runtime: runtimeVersion }) });
  const port = await server.listen(0);
  try {
    for (const [pathname, type] of [
      ["/workbench/resources.mjs", "text/javascript; charset=utf-8"],
      ["/workbench/resources-model.mjs", "text/javascript; charset=utf-8"],
      ["/workbench/resources-source.mjs", "text/javascript; charset=utf-8"],
      ["/workbench/resources.css", "text/css; charset=utf-8"],
    ] as const) {
      const asset = await get(port, pathname);
      assert.equal(asset.status, 200, pathname);
      assert.equal(asset.type, type, pathname);
    }
    const quotas = await get(port, "/workbench/v1/resources/quotas");
    assert.equal(quotas.status, 200);
    const quotaDocument = JSON.parse(quotas.body);
    assert.equal(quotaDocument.schemaVersion, "workbuddy-executor/quota-2");
    // Each merged row carries the reading of the source it came from.
    assert.deepEqual(quotaDocument.observations[0].readings.map((item: { connectionId: string }) => item.connectionId), ["synthetic-quota"]);
    const credits = await get(port, "/workbench/v1/resources/credit-balances");
    assert.equal(credits.status, 200);
    assert.equal(JSON.parse(credits.body).schemaVersion, "workbuddy-executor/credit-balance-1");
    const capacity = await get(port, "/workbench/v1/resources/capacity");
    assert.equal(capacity.status, 200);
    assert.equal(JSON.parse(capacity.body).occupied, null);
    const tasks = await get(port, "/workbench/v1/tasks?limit=10");
    assert.equal(tasks.status, 200);
  } finally { await server.close(); store.close(); }
});

test("a missing resource table answers 503 instead of an empty resource or a free slot", async t => {
  const f = seed(t);
  f.finish();
  for (const table of ["quota_connections", "credit_balance_connections", "workflow_capacity"])
    writeOnce(f.file, `DROP TABLE ${table}`);
  const { store, service } = readOnlyService(f.file, f.runsDir);
  const server = new WorkbenchHttpServer({ service, health: () => workbenchHealth({ runtime: runtimeVersion }) });
  const port = await server.listen(0);
  try {
    for (const pathname of ["/workbench/v1/resources/quotas", "/workbench/v1/resources/credit-balances", "/workbench/v1/resources/capacity"]) {
      const response = await get(port, pathname);
      assert.equal(response.status, 503, pathname);
      assert.equal(JSON.parse(response.body).error.code, "RESOURCE_STORE_UNAVAILABLE");
    }
    const tasks = await get(port, "/workbench/v1/tasks?limit=10");
    assert.equal(tasks.status, 200, "resource storage is absent; the task view is not");
    const page = await get(port, "/workbench/");
    assert.equal(page.status, 200, "the window still loads");
  } finally { await server.close(); store.close(); }
});

test("closing the read store and the server leaves nothing running", async t => {
  const f = seed(t);
  f.finish();
  const { store, service } = readOnlyService(f.file, f.runsDir);
  const server = new WorkbenchHttpServer({ service, health: () => workbenchHealth({ runtime: runtimeVersion }) });
  const port = await server.listen(0);
  await server.close();
  await assert.rejects(get(port, "/workbench/"));
  store.close();
  assert.throws(() => service.readQuotaResources());
});
