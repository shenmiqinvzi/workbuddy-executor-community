import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkbenchHttpServer } from "../src/workbench-http.js";
import { RESOURCE_CONNECTIONS_ENV, RESOURCE_CONNECTIONS_SCHEMA } from "../src/resource-connections.js";
import { readResourceSnapshot, saveResourceSnapshot, snapshotDigest } from "../src/resource-snapshot-store.js";

// End-to-end shape of the trust surface: one read-only document that keeps
// configuration, execution declaration and actual routing apart, served while
// tasks keep their state and no upstream source is contacted.

const iso = (ms: number) => new Date(ms).toISOString();
const POOL_CN = `pool-${"1".repeat(32)}`;
const POOL_CREDIT = `pool-${"2".repeat(32)}`;

type Body = {
  schemaVersion: string;
  routingVerified: boolean;
  generatedAt: string;
  connections: { connectionId: string; level: string; reason: string }[];
  mappings: { scopeId: string; unit: string; level: string; evidenceReason: string }[];
  limitations: string[];
  layers: Record<string, { level: string; verified: boolean; status?: string; reason?: string }>;
  connectionRegistry: { status: string; source: string; connections: { connectionId: string; credentials: { envVar: string }[] }[]; fileDiagnostics: { code: string }[] };
  connectionDiagnostics: { connections: { connectionId: string; codes: string[] }[]; undeclaredObserved: { connectionId: string }[]; summary: { declared: number; observed: number } };
  requestAttribution: { status: string; fields: { requestId: null }; integrationTodo: string[] };
};

function seed(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resource-trust-"));
  const file = path.join(dir, "tasks.sqlite");
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const store = new TaskStore(file);
  store.createOrGet({ taskId: "synthetic-task", messageId: "synthetic-message", objective: "synthetic objective", state: "queued" });
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return {
    dir, file, store,
    service: () => new TaskApplicationService({ store } as never, 3, runsDir),
    publishQuota(connectionId: string, observations: unknown[], now = Date.now()) {
      const epoch = store.quotas.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = store.quotas.beginPoll(connectionId, epoch);
      assert.ok(generation !== null);
      const snapshot = {
        snapshotId: "synthetic-quota-snapshot-0001", connectionId, collectedAt: iso(now), sourceObservedAt: iso(now - 1000),
        expiresAt: iso(now + 90_000), observations,
      };
      assert.equal(store.quotas.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
    publishCredit(connectionId: string, now = Date.now()) {
      const epoch = store.creditBalances.register(connectionId, `synthetic-fingerprint-${connectionId}`);
      const generation = store.creditBalances.begin(connectionId, epoch);
      assert.ok(generation !== null);
      const snapshot = {
        snapshotId: "synthetic-credit-snapshot-001", connectionId, scopeId: POOL_CREDIT, realm: "cn", unit: "credit",
        valueKind: "reported_cache", balance: 123.45, accountsEnabled: 3, accountsWithData: 1, coverage: "partial",
        latestMemberObservedAt: iso(now - 1000), collectedAt: iso(now), cacheExpiresAt: iso(now + 90_000),
      };
      assert.equal(store.creditBalances.publish(connectionId, epoch, generation, snapshot as never), true);
      return { epoch, generation };
    },
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: POOL_CN, scopeKind: "gateway_pool", shared: true, modelId: "synthetic-model-alpha", realm: "cn",
    unit: "tokens", valueKind: "estimated", availability: "available",
    used: 20, budget: 100, remaining: 80, resetAt: null,
    method: "historical_budget_minus_observed_usage", limitations: ["routing_unverified"],
    ...overrides,
  };
}

const declaration = () => ({
  schemaVersion: RESOURCE_CONNECTIONS_SCHEMA,
  connections: [
    {
      connectionId: "synthetic-quota", resource: "quota", sourceUrl: "http://127.0.0.1:8788/", realm: "cn",
      pools: [POOL_CN], models: ["synthetic-model-alpha"], shared: true, declaredAt: "2026-11-04T00:00:00.000Z",
      credentialEnv: { apiKey: "WORKBUDDY_QUOTA_API_KEY", panelToken: "WORKBUDDY_QUOTA_PANEL_TOKEN" },
    },
    {
      connectionId: "synthetic-credit", resource: "credit", sourceUrl: "http://127.0.0.1:8788/", realm: "cn",
      pools: [POOL_CREDIT], shared: true, declaredAt: "2026-11-04T00:00:00.000Z",
      credentialEnv: { apiKey: "WORKBUDDY_CREDIT_API_KEY" },
    },
  ],
});

/** Writes a declaration file and points the read path at it for one test. */
function declare(t: test.TestContext, text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resource-declaration-"));
  const file = path.join(dir, "connections.json");
  fs.writeFileSync(file, text, "utf8");
  const previous = process.env[RESOURCE_CONNECTIONS_ENV];
  process.env[RESOURCE_CONNECTIONS_ENV] = file;
  process.env.WORKBUDDY_QUOTA_API_KEY = "synthetic-quota-key";
  t.after(() => {
    if (previous === undefined) delete process.env[RESOURCE_CONNECTIONS_ENV];
    else process.env[RESOURCE_CONNECTIONS_ENV] = previous;
    delete process.env.WORKBUDDY_QUOTA_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return file;
}

function taskSnapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = ["tasks", "messages", "task_attempts", "task_contracts", "task_events"];
    const counts = Object.fromEntries(tables.map(name => [name, (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n]));
    const state = db.prepare("SELECT task_id, state, updated_at FROM tasks ORDER BY task_id").all();
    return { counts, state };
  } finally { db.close(); }
}

test("one routing read carries three separate layers and writes no task row", async (t) => {
  const env = seed(t);
  env.publishQuota("synthetic-quota", [observation()]);
  env.publishCredit("synthetic-credit");
  declare(t, JSON.stringify(declaration()));
  const before = taskSnapshot(env.file);

  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const response = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`);
  assert.equal(response.status, 200);
  const body = await response.json() as Body;

  // Layer 1: configuration, observed only through the declaration.
  assert.equal(body.layers.configuration.status, "declared");
  assert.equal(body.layers.configuration.verified, false);
  assert.equal(body.layers.configuration.level, "gateway_observation_only");
  // Layer 2: an execution's declaration is not evidence about an upstream call.
  assert.equal(body.layers.executionSelection.verified, false);
  assert.equal(body.layers.executionSelection.level, "declaration_only");
  // Layer 3: actual routing is a stated gap, not a guess.
  assert.equal(body.layers.requestRouting.verified, false);
  assert.equal(body.layers.requestRouting.level, "unavailable");
  assert.equal(body.layers.requestRouting.reason, "upstream_payload_lacks_request_identity");

  assert.equal(body.routingVerified, false);
  assert.equal(body.connectionRegistry.status, "declared");
  assert.equal(body.connectionRegistry.source, "file");
  assert.deepEqual(body.connectionRegistry.connections.map(item => item.connectionId), ["synthetic-quota", "synthetic-credit"]);
  // Credential references appear as variable names only.
  assert.equal(JSON.stringify(body).includes("synthetic-quota-key"), false);
  assert.deepEqual(body.connectionRegistry.connections[0]!.credentials.map(item => item.envVar), ["WORKBUDDY_QUOTA_API_KEY", "WORKBUDDY_QUOTA_PANEL_TOKEN"]);

  assert.deepEqual(body.connectionDiagnostics.connections.map(item => item.connectionId), ["synthetic-quota", "synthetic-credit"]);
  assert.ok(body.connectionDiagnostics.connections[0]!.codes.includes("declared_and_observed"));
  assert.equal(body.connectionDiagnostics.summary.declared, 2);
  assert.equal(body.connectionDiagnostics.summary.observed, 2);

  // A declaration never upgrades an observation into a verified route.
  assert.deepEqual(body.mappings.map(item => item.level), ["observed", "observed"]);
  assert.equal(JSON.stringify(body.mappings).includes("declared"), false);
  assert.ok(body.limitations.includes("routing_unverified"));

  assert.equal(body.requestAttribution.status, "unavailable");
  assert.equal(body.requestAttribution.fields.requestId, null);
  assert.equal(body.requestAttribution.integrationTodo.length, 10);

  // The read is loopback-only and contacts no source.
  assert.equal(seen.length, 1);
  assert.equal(seen[0], `http://127.0.0.1:${port}/workbench/v1/resources/routing`);

  // Zero task writes: no row count and no task state changed.
  assert.deepEqual(taskSnapshot(env.file), before);
});

test("a resource source failure keeps the routing document readable and the task intact", async (t) => {
  const env = seed(t);
  const published = env.publishQuota("synthetic-quota", [observation()]);
  declare(t, JSON.stringify(declaration()));
  const before = taskSnapshot(env.file);

  env.store.quotas.failed("synthetic-quota", published.epoch, published.generation, "source_unauthorized");

  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  const response = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`);
  assert.equal(response.status, 200);
  const body = await response.json() as Body;

  const quota = body.connections.find(item => item.connectionId === "synthetic-quota")!;
  assert.equal(quota.level, "unavailable");
  assert.equal(quota.reason, "source_error");
  // The saved snapshot stays readable as expired evidence rather than vanishing.
  assert.equal(body.mappings.some(item => item.scopeId === POOL_CN), true);
  assert.ok(body.connectionDiagnostics.connections.find(item => item.connectionId === "synthetic-quota")!.codes.includes("observed_source_error:source_unauthorized"));

  const tasks = await fetch(`http://127.0.0.1:${port}/workbench/v1/tasks?limit=5`);
  assert.equal(tasks.status, 200);
  assert.deepEqual(taskSnapshot(env.file), before);
});

test("an observed connection with no declaration is listed as undeclared", async (t) => {
  const env = seed(t);
  env.publishQuota("synthetic-quota", [observation()]);

  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  const body = await (await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`)).json() as Body;

  assert.equal(body.connectionRegistry.status, "not_declared");
  assert.deepEqual(body.connectionRegistry.connections, []);
  assert.deepEqual(body.connectionDiagnostics.undeclaredObserved.map(item => item.connectionId), ["synthetic-quota"]);
  assert.equal(body.connectionDiagnostics.summary.declared, 0);
  // The observation is still reported on its own terms.
  assert.equal(body.mappings.length, 1);
  assert.equal(body.mappings[0]!.level, "observed");
});

test("a broken declaration file is reported without failing the read", async (t) => {
  const env = seed(t);
  env.publishQuota("synthetic-quota", [observation()]);
  declare(t, "{ not json");

  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  const response = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`);
  assert.equal(response.status, 200);
  const body = await response.json() as Body;

  assert.equal(body.connectionRegistry.status, "invalid_file");
  assert.deepEqual(body.connectionRegistry.fileDiagnostics.map(item => item.code), ["file_not_json"]);
  assert.equal(body.mappings[0]!.level, "observed");
  assert.equal(body.mappings[0]!.evidenceReason, "snapshot_fresh");
});

test("the served document can be archived and re-read end to end", async (t) => {
  const env = seed(t);
  env.publishQuota("synthetic-quota", [observation()]);
  declare(t, JSON.stringify(declaration()));

  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });

  const body = await (await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/routing`)).json() as Body;
  const directory = path.join(env.dir, "snapshots");
  const saved = saveResourceSnapshot({ directory, kind: "routing", document: body });

  assert.equal(saved.status, "saved");
  assert.equal(saved.digest, snapshotDigest(body));
  const read = readResourceSnapshot(saved.file!);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  // What a later reader compares is the digest of exactly what the gateway served.
  assert.equal(read.digest, saved.digest);
  assert.equal((read.document as Body).connectionRegistry.status, "declared");
  assert.equal((read.document as Body).layers.requestRouting.verified, false);
  assert.equal(JSON.stringify(read.document).includes("synthetic-quota-key"), false);
});
