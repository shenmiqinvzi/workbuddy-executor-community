import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyQuotaCollector } from "../src/quota-observation.js";
import { readQuotaResources } from "../src/quota-observation.js";
import { readCreditBalances } from "../src/credit-balance.js";
import { handleStatisticsRequest, statisticsSources } from "../src/statistics-http.js";

// A resource source can hang, answer with renamed fields or leave a corrupt
// cache behind. None of that may change what the task side can still prove:
// reading a task, its events, and its supervision/stop record keeps working,
// and a GET never writes.

const TASK_A = "6f1a0a3e-0000-4000-8000-0000000000bb";

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c06-fault-isolation-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  store.createOrGet({ taskId: TASK_A, messageId: "m-1", objective: "survive a resource fault", state: "running", createdAt: "2026-11-07T00:00:00.000Z" });
  store.appendTaskEvent({
    taskId: TASK_A, attemptId: null, type: "native_stop_confirmed", occurredAt: "2026-11-07T00:01:00.000Z",
    observedAt: "2026-11-07T00:01:00.000Z", actor: "program", payload: { reason: "fixture" }, sourceRef: "fixture:stop",
  });
  t.after(() => {
    try { store.close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { dir, store, db: path.join(dir, "tasks.sqlite") };
}

function digest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function source(t: test.TestContext, handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing socket");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => (error ? reject(error) : resolve()));
  }));
  return `http://127.0.0.1:${address.port}`;
}

const input = (baseUrl: string, overrides: Record<string, unknown> = {}) => ({
  id: "local-source", baseUrl, apiKey: "synthetic-private-key", intervalMs: 1000, maxAgeMs: 10_000, timeoutMs: 5000, ...overrides,
});

function assertTaskSideIntact(store: TaskStore) {
  const task = store.get(TASK_A);
  assert.equal(task?.taskId, TASK_A, "the task is still readable");
  const events = store.listTaskEvents(TASK_A, { limit: 50 }).events;
  assert.ok(events.some(event => event.type === "native_stop_confirmed"), "the stop record is still there");
  const response = handleStatisticsRequest(statisticsSources(store), "/workbench/v1/statistics", "");
  assert.ok(response);
  assert.equal(response.status, 200, "statistics still answers");
}

test("a hanging source times out and leaves task reads, supervision and statistics untouched", async t => {
  const f = fixture(t);
  const url = await source(t, () => { /* never answers */ });
  const collector = new WorkBuddyQuotaCollector(f.store.quotas, input(url, { timeoutMs: 120 }));
  const started = Date.now();
  await collector.collect();
  await collector.stop();
  assert.ok(Date.now() - started < 5000, "the collector gives up instead of blocking the reader");

  assertTaskSideIntact(f.store);
  const reader = new DatabaseSync(f.db, { readOnly: true });
  const view = readQuotaResources(reader);
  reader.close();
  assert.equal(view.connections[0]?.status, "unavailable");
  assert.match(String(view.connections[0]?.errorCode), /timeout/);
  // A source that never answered produced no reading at all: not a zero pool.
  assert.deepEqual(view.observations, []);
  assert.equal(view.actualTaskTokens, null);
});

test("a corrupt cache is unreadable, not an empty pool, and does not touch the task side", async t => {
  const f = fixture(t);
  const url = await source(t, (_request, response) => response.end(JSON.stringify({
    generated_at: Date.now() / 1000,
    rows: [{ uid: "private-account-id", realm: "cn", model: "example-model", used: 20, budget: 100, remaining: 80, reset_at: null, cooling: false }],
  })));
  const collector = new WorkBuddyQuotaCollector(f.store.quotas, input(url));
  await collector.collect();
  await collector.stop();

  const raw = new DatabaseSync(f.db);
  raw.prepare("UPDATE quota_connections SET snapshot_json = ?").run("{ not json");
  raw.close();

  const reader = new DatabaseSync(f.db, { readOnly: true });
  assert.throws(() => readQuotaResources(reader), /resource_corrupt/);
  // The credit ledger for this fixture was never configured: that is an empty
  // configured set, not a corrupt one, and it must not be invented into a row.
  const credit = readCreditBalances(reader);
  assert.deepEqual(credit.balances, []);
  assert.equal(credit.actualTaskCredits, null);
  reader.close();

  assertTaskSideIntact(f.store);
});

test("renamed source fields are rejected and the previous snapshot stays stale, not zero", async t => {
  const f = fixture(t);
  let payload = JSON.stringify({
    generated_at: Date.now() / 1000,
    rows: [{ uid: "private-account-id", realm: "cn", model: "example-model", used: 20, budget: 100, remaining: 80, reset_at: null, cooling: false }],
  });
  const url = await source(t, (_request, response) => response.end(payload));
  const first = new WorkBuddyQuotaCollector(f.store.quotas, input(url));
  await first.collect();
  await first.stop();
  const before = f.store.quotas.read();
  assert.equal(before.observations[0]?.remaining, 80);

  // The upstream renames `remaining`; the old reading must not become 0.
  payload = JSON.stringify({ generated_at: Date.now() / 1000, rows: [{ uid: "private-account-id", realm: "cn", model: "example-model", used: 20, budget: 100, remaining_tokens: 0, cooling: false }] });
  const second = new WorkBuddyQuotaCollector(f.store.quotas, input(url));
  await second.collect();
  await second.stop();
  const after = f.store.quotas.read();
  assert.notEqual(after.observations[0]?.remaining, 0, "a renamed field never turns into a zero balance");
  assert.ok(after.connections[0]?.errorCode === null || after.connections[0]?.errorCode === "source_invalid",
    `the connection either keeps the old reading or reports the schema it could not read, not a silent success (${after.connections[0]?.errorCode})`);
  assertTaskSideIntact(f.store);
});

test("a statistics GET never writes: same bytes before and after", t => {
  const f = fixture(t);
  const before = digest(f.db);
  const sources = statisticsSources(f.store);
  const overview = handleStatisticsRequest(sources, "/workbench/v1/statistics", "?limit=5");
  const task = handleStatisticsRequest(sources, `/workbench/v1/statistics/tasks/${TASK_A}`, "");
  const rejected = handleStatisticsRequest(sources, "/workbench/v1/statistics", "?limit=0");
  assert.equal(overview?.status, 200);
  assert.equal(task?.status, 200);
  assert.equal(rejected?.status, 400);
  assert.equal(digest(f.db), before, "reading the statistics never mutates the store");
});

test("resource faults do not stop a second, healthy source from being read", async t => {
  const f = fixture(t);
  const healthy = await source(t, (_request, response) => response.end(JSON.stringify({
    generated_at: Date.now() / 1000,
    rows: [{ uid: "private-account-id", realm: "cn", model: "example-model", used: 20, budget: 100, remaining: 80, reset_at: null, cooling: false }],
  })));
  const broken = await source(t, () => { /* hangs */ });

  const ok = new WorkBuddyQuotaCollector(f.store.quotas, input(healthy, { id: "healthy-source" }));
  await ok.collect();
  await ok.stop();
  const bad = new WorkBuddyQuotaCollector(f.store.quotas, input(broken, { id: "broken-source", timeoutMs: 120 }));
  await bad.collect();
  await bad.stop();

  const reader = new DatabaseSync(f.db, { readOnly: true });
  const view = readQuotaResources(reader);
  reader.close();
  assert.equal(view.connections.find(item => item.connectionId === "healthy-source")?.status, "observed");
  assert.match(String(view.connections.find(item => item.connectionId === "broken-source")?.errorCode), /timeout/);
  assert.equal(view.observations[0]?.remaining, 80);
  assertTaskSideIntact(f.store);
});
