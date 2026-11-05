import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkbenchHttpServer } from "../src/workbench-http.js";
import { EXECUTION_LINKS_SCHEMA, buildPlanResourceReference } from "../src/plan-resource-reference.js";
import { createReferenceLoader, describeReference } from "../workbench/plan-reference.mjs";

// Regression suite for the two D3-03 findings found by the independent review:
//   A. several declared links can match one execution selection, and the reader
//      must not pick the first one by array order;
//   B. a declared realm must also constrain the credit balance, not only quota.
// Fixtures are synthetic; the store and the service are the real ones.

const iso = (ms: number) => new Date(ms).toISOString();
const LIMITATIONS = ["routing_unverified", "shared_pool", "budget_estimated", "gateway_observed_usage_only", "task_attribution_unavailable"];
const EXECUTION = { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-model-alpha", reasoningEffort: null };
/** One stable, distinct pool id per named source. */
const pool = (name: string) => `pool-${crypto.createHash("sha256").update(`pool:${name}`).digest("hex").slice(0, 32)}`;
const POOL = pool("stats-quota");

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
    snapshotId: `synthetic-credit-${connectionId}`, connectionId, scopeId: pool(`credit:${connectionId}`), realm: "cn", unit: "credit", valueKind: "reported_cache",
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-conflict-"));
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
      return { epoch, generation };
    },
    registerCredit(connectionId: string) {
      return store.creditBalances.register(connectionId, `synthetic-fingerprint-${connectionId}`);
    },
    read(execution: Record<string, unknown> = EXECUTION, links = declared(link())) {
      return this.service().readPlanResourceReference(execution as never, links as never) as Record<string, unknown>;
    },
  };
}

function sha(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The parts a caller can act on, with the per-read timestamp removed. */
function conclusion(document: Record<string, unknown>) {
  return {
    association: document.association,
    quota: document.quota,
    otherQuotaSources: document.otherQuotaSources,
    credit: document.credit,
    creditState: document.creditState,
    attribution: document.attribution,
    routingVerified: document.routingVerified,
  };
}

// ---------------------------------------------------------------- A. ambiguity

test("[1] two statistics connections matching one selection never answer with either read", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("stats-a"), remaining: 80, used: 20 })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("stats-b"), remaining: 180, used: 20 })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now));
  const links = declared(link({ quotaConnectionId: "stats-a" }), link({ quotaConnectionId: "stats-b" }));
  const document = env.read(EXECUTION, links) as never;
  assert.equal(document.association.status, "linked_ambiguous");
  assert.equal(document.association.reason, "multiple_declared_links");
  assert.equal(document.association.candidates, 2);
  assert.equal(document.quota, null, "no arbitrarily picked token read");
  assert.equal(document.credit, null, "no arbitrarily picked credit read");
  assert.equal(document.creditState, "ambiguous");
  assert.deepEqual(document.otherQuotaSources, []);
  assert.equal(document.attribution, "none");
  assert.equal(document.routingVerified, false);
});

test("[2] swapping the declaration order keeps the same conclusion", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("stats-a"), remaining: 4242, used: 758, budget: 5000 })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("stats-b"), remaining: 8484, used: 1516, budget: 10000 })], now));
  const a = link({ quotaConnectionId: "stats-a" });
  const b = link({ quotaConnectionId: "stats-b" });
  const forward = env.read(EXECUTION, declared(a, b));
  const reverse = env.read(EXECUTION, declared(b, a));
  assert.equal(forward.association.status, "linked_ambiguous");
  assert.deepEqual(conclusion(forward), conclusion(reverse));
});

test("[3] partially overlapping model lists only affect the overlapping model", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [
    observation({ scopeId: pool("a:alpha"), modelId: "synthetic-model-alpha", remaining: 80 }),
    observation({ scopeId: pool("a:beta"), modelId: "synthetic-model-beta", remaining: 70 }),
  ], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [
    observation({ scopeId: pool("b:beta"), modelId: "synthetic-model-beta", remaining: 40 }),
    observation({ scopeId: pool("b:gamma"), modelId: "synthetic-model-gamma", remaining: 180 }),
  ], now));
  const links = declared(
    link({ models: ["synthetic-model-alpha", "synthetic-model-beta"], quotaConnectionId: "stats-a" }),
    link({ models: ["synthetic-model-beta", "synthetic-model-gamma"], quotaConnectionId: "stats-b" }),
  );
  const alpha = env.read({ ...EXECUTION, modelId: "synthetic-model-alpha" }, links);
  assert.equal(alpha.association.status, "linked");
  assert.equal((alpha.quota as { connectionId: string }).connectionId, "stats-a");
  assert.equal((alpha.quota as { remaining: number }).remaining, 80);
  const beta = env.read({ ...EXECUTION, modelId: "synthetic-model-beta" }, links);
  assert.equal(beta.association.status, "linked_ambiguous");
  assert.equal(beta.quota, null);
  const gamma = env.read({ ...EXECUTION, modelId: "synthetic-model-gamma" }, links);
  assert.equal(gamma.association.status, "linked");
  assert.equal((gamma.quota as { connectionId: string }).connectionId, "stats-b");
  assert.equal((gamma.quota as { remaining: number }).remaining, 180);
});

test("[4] declarations for different, non-overlapping models keep working", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("a:alpha"), modelId: "synthetic-model-alpha" })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("b:gamma"), modelId: "synthetic-model-gamma", remaining: 180 })], now));
  const links = declared(
    link({ models: ["synthetic-model-alpha"], quotaConnectionId: "stats-a" }),
    link({ models: ["synthetic-model-gamma"], quotaConnectionId: "stats-b" }),
  );
  const alpha = env.read({ ...EXECUTION, modelId: "synthetic-model-alpha" }, links);
  assert.equal(alpha.association.status, "linked");
  assert.equal((alpha.quota as { remaining: number }).remaining, 80);
  const gamma = env.read({ ...EXECUTION, modelId: "synthetic-model-gamma" }, links);
  assert.equal(gamma.association.status, "linked");
  assert.equal((gamma.quota as { remaining: number }).remaining, 180);
});

test("[5] another execution connection or provider is never the same candidate", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("stats-a") })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("stats-b"), remaining: 180 })], now));
  env.publishQuota("stats-c", quotaSnapshot("stats-c", [observation({ scopeId: pool("stats-c"), remaining: 60 })], now));
  const links = declared(
    link({ executionConnectionId: "local-workbuddy", quotaConnectionId: "stats-a" }),
    link({ executionConnectionId: "local-other", quotaConnectionId: "stats-b" }),
    link({ providerId: "other-provider", quotaConnectionId: "stats-c" }),
  );
  const own = env.read(EXECUTION, links);
  assert.equal(own.association.status, "linked");
  assert.equal((own.quota as { connectionId: string }).connectionId, "stats-a");
  const other = env.read({ ...EXECUTION, connectionId: "local-other" }, links);
  assert.equal(other.association.status, "linked");
  assert.equal((other.quota as { connectionId: string }).connectionId, "stats-b");
  const otherProvider = env.read({ ...EXECUTION, providerId: "other-provider" }, links);
  assert.equal(otherProvider.association.status, "linked");
  assert.equal((otherProvider.quota as { connectionId: string }).connectionId, "stats-c");
});

test("[6] region-only candidates are never picked by a selection that gives no region", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [
    observation({ scopeId: pool("a:cn"), realm: "cn", remaining: 80 }),
    observation({ scopeId: pool("a:intl"), realm: "intl", remaining: 60 }),
  ], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("b:intl"), realm: "intl", remaining: 180 })], now));
  const links = declared(
    link({ realm: "cn", quotaConnectionId: "stats-a" }),
    link({ realm: "intl", quotaConnectionId: "stats-b" }),
  );
  const ambiguous = env.read(EXECUTION, links);
  assert.equal(ambiguous.association.status, "linked_ambiguous");
  assert.equal(ambiguous.quota, null);

  // The same rule inside one declared connection: two undistinguishable rows for
  // the same model in different regions are an ambiguity, not a first-row pick.
  const oneConnection = env.read(EXECUTION, declared(link({ realm: null, quotaConnectionId: "stats-a" })));
  assert.equal(oneConnection.association.status, "linked_ambiguous");
  assert.equal(oneConnection.association.reason, "ambiguous_quota_observation");
  assert.equal(oneConnection.quota, null);
});

test("[7] a unique match still reads normally", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now));
  const document = env.read();
  assert.equal(document.association.status, "linked");
  assert.equal((document.association as { reason: string }).reason, "declared_link");
  assert.equal((document.quota as { remaining: number }).remaining, 80);
  assert.equal((document.credit as { balance: number }).balance, 12);
  assert.equal(document.creditState, "available");
});

// -------------------------------------------------------------- B. credit realm

test("[8] a cn declaration with a cn credit source shows the balance", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation({ realm: "cn" })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "cn", balance: 42.5 }));
  const document = env.read(EXECUTION, declared(link({ realm: "cn" })));
  assert.equal(document.association.status, "linked");
  assert.equal(document.creditState, "available");
  assert.equal((document.credit as { balance: number }).balance, 42.5);
  assert.equal((document.credit as { realm: string }).realm, "cn");
});

test("[9] a cn declaration with an intl credit source shows no balance and says why", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation({ realm: "cn" })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "intl", balance: 42.5 }));
  const document = env.read(EXECUTION, declared(link({ realm: "cn" })));
  assert.equal(document.credit, null, "the mismatched balance is not displayed");
  assert.equal(document.creditState, "realm_mismatch");
  assert.equal((document.quota as { remaining: number }).remaining, 80, "the token evidence stays");
});

test("[10] an intl declaration with a cn credit source is refused the same way", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation({ realm: "intl", remaining: 60 })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "cn", balance: 42.5 }));
  const document = env.read(EXECUTION, declared(link({ realm: "intl" })));
  assert.equal(document.credit, null);
  assert.equal(document.creditState, "realm_mismatch");
  assert.equal((document.quota as { remaining: number }).remaining, 60);
  assert.equal((document.quota as { realm: string }).realm, "intl");
});

test("[11] a credit realm mismatch keeps the correctly linked token reference", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation({ realm: "cn" })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "intl", balance: 42.5 }));
  const document = env.read(EXECUTION, declared(link({ realm: "cn" })));
  const quota = document.quota as Record<string, unknown>;
  assert.equal(quota.connectionId, "stats-quota");
  assert.equal(quota.scopeId, POOL);
  assert.equal(quota.snapshotId, "synthetic-quota-stats-quota");
  assert.equal(quota.remaining, 80);
  assert.equal(quota.used, 20);
  assert.equal(quota.budget, 100);
  assert.deepEqual(document.otherQuotaSources, []);
  assert.equal(document.attribution, "execution_link_declared");
});

test("[12] a null realm means unconstrained, and never means cn", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation({ realm: "cn" })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "intl", balance: 7 }));
  const unconstrained = env.read(EXECUTION, declared(link({ realm: null })));
  assert.equal((unconstrained.link as { realm: unknown }).realm, null);
  assert.equal(unconstrained.association.status, "linked");
  assert.equal(unconstrained.creditState, "available", "no region filter is applied");
  assert.equal((unconstrained.credit as { realm: string }).realm, "intl", "and the declared realm is never rewritten");

  // A cn balance is equally acceptable: a null realm is not "cn by default".
  env.publishCredit("stats-credit-cn", creditSnapshot("stats-credit-cn", now, { realm: "cn", balance: 5 }));
  const other = env.read(EXECUTION, declared(link({ realm: null, creditConnectionId: "stats-credit-cn" })));
  assert.equal(other.creditState, "available");
  assert.equal((other.credit as { realm: string }).realm, "cn");
});

test("[13] region mismatch, unconfigured, no snapshot and a failed collector stay distinct", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-quota", quotaSnapshot("stats-quota", [observation()], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "intl" }));
  const mismatch = env.read(EXECUTION, declared(link({ realm: "cn" })));
  const unconfigured = env.read(EXECUTION, declared(link({ creditConnectionId: "stats-missing" })));
  assert.ok(env.registerCredit("stats-empty"));
  const missingSnapshot = env.read(EXECUTION, declared(link({ creditConnectionId: "stats-empty" })));

  const failedHandle = env.publishCredit("stats-failed", creditSnapshot("stats-failed", now, { realm: "cn", balance: 9 }));
  env.store.creditBalances.failed("stats-failed", failedHandle.epoch, failedHandle.generation, "source_unavailable");
  const failed = env.read(EXECUTION, declared(link({ creditConnectionId: "stats-failed" })));

  assert.equal(mismatch.creditState, "realm_mismatch");
  assert.equal(unconfigured.creditState, "not_configured");
  assert.equal(missingSnapshot.creditState, "no_snapshot");
  assert.equal(failed.creditState, "available", "a failed collector keeps the last saved balance");
  assert.equal((failed.credit as { cacheFreshness: string }).cacheFreshness, "stale");
  assert.equal((failed.credit as { balance: number }).balance, 9);
  assert.equal(new Set([mismatch.creditState, unconfigured.creditState, missingSnapshot.creditState, failed.creditState]).size, 4);
});

// ------------------------------------------------------------ C. HTTP and panel

test("[14] the official HTTP surface returns the new states", async (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("stats-a"), remaining: 4242, used: 758, budget: 5000 })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("stats-b"), remaining: 8484, used: 1516, budget: 10000 })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "intl", balance: 42.5 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-conflict-http-"));
  const file = path.join(dir, "links.json");
  const saved = process.env.WORKBUDDY_RESOURCE_LINKS_FILE;
  process.env.WORKBUDDY_RESOURCE_LINKS_FILE = file;
  t.after(() => {
    if (saved === undefined) delete process.env.WORKBUDDY_RESOURCE_LINKS_FILE; else process.env.WORKBUDDY_RESOURCE_LINKS_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const server = new WorkbenchHttpServer({ service: env.service(), health: () => ({ ok: true }), embed: { panel: null, origins: [] } });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });
  const query = "?executorId=workbuddy&connectionId=local-workbuddy&providerId=workbuddy-native&modelId=synthetic-model-alpha";
  const before = sha(env.file);

  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: EXECUTION_LINKS_SCHEMA,
    links: [link({ quotaConnectionId: "stats-a" }), link({ quotaConnectionId: "stats-b" })],
  }));
  const ambiguousResponse = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/plan-reference${query}`);
  assert.equal(ambiguousResponse.status, 200);
  const ambiguousText = await ambiguousResponse.text();
  const ambiguous = JSON.parse(ambiguousText) as { association: { status: string; candidates: number }; quota: unknown; credit: unknown };
  assert.equal(ambiguous.association.status, "linked_ambiguous");
  assert.equal(ambiguous.association.candidates, 2);
  assert.equal(ambiguous.quota, null);
  assert.equal(ambiguous.credit, null);
  assert.ok(!ambiguousText.includes("4242") && !ambiguousText.includes("8484"), "no picked read leaks");

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: EXECUTION_LINKS_SCHEMA, links: [link({ realm: "cn", quotaConnectionId: "stats-a" })] }));
  const mismatchResponse = await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/plan-reference${query}`);
  assert.equal(mismatchResponse.status, 200);
  const mismatchText = await mismatchResponse.text();
  const mismatch = JSON.parse(mismatchText) as { creditState: string; credit: unknown; quota: { remaining: number } };
  assert.equal(mismatch.creditState, "realm_mismatch");
  assert.equal(mismatch.credit, null);
  assert.equal(mismatch.quota.remaining, 4242);
  assert.ok(!mismatchText.includes("42.5"), "the mismatched balance is not on the wire");

  assert.equal(sha(env.file), before, "resource reads never write");
});

test("[15] the panel wording expresses ambiguity and a credit region mismatch", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("stats-a") })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("stats-b"), remaining: 180, budget: 200 })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "intl" }));
  const ambiguous = describeReference(env.read(EXECUTION, declared(link({ quotaConnectionId: "stats-a" }), link({ quotaConnectionId: "stats-b" }))) as never);
  assert.equal(ambiguous.headline, "关联声明存在冲突，无法确定该方案对应的统计来源。");
  assert.equal(ambiguous.lines.length, 0, "no read lines at all");
  assert.ok(ambiguous.caveats.some(item => item.includes("不按声明顺序")), "says the order is not used");
  assert.ok(ambiguous.caveats.some(item => item.includes("不展示任何一条")), "says no read is shown");

  const mismatch = describeReference(env.read(EXECUTION, declared(link({ realm: "cn", quotaConnectionId: "stats-a" }))) as never);
  assert.ok(mismatch.lines.some(line => line.label === "剩余 token" && line.value === "80"));
  assert.ok(!mismatch.lines.some(line => line.label === "积分余额"), "no credit line");
  assert.ok(mismatch.caveats.some(item => item.includes("区域") && item.includes("积分")), "names the region rule");
  assert.ok(mismatch.caveats.some(item => item.includes("不表示余额为零")), "not described as zero");
});

test("[16] the ambiguous state leaks no read of any candidate", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("stats-a"), remaining: 4242, used: 758, budget: 5000 })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("stats-b"), remaining: 8484, used: 1516, budget: 10000 })], now));
  env.publishCredit("stats-a", creditSnapshot("stats-a", now, { realm: "cn", balance: 777.25 }));
  env.publishCredit("stats-b", creditSnapshot("stats-b", now, { realm: "cn", balance: 888.75 }));
  const links = declared(
    link({ quotaConnectionId: "stats-a", creditConnectionId: "stats-a" }),
    link({ quotaConnectionId: "stats-b", creditConnectionId: "stats-b" }),
  );
  const document = env.read(EXECUTION, links);
  const json = JSON.stringify(conclusion(document));
  const view = describeReference(document as never);
  const text = JSON.stringify(view.lines) + JSON.stringify(view.caveats) + view.headline;
  for (const secret of ["4242", "8484", "777.25", "888.75", "stats-a", "stats-b"]) {
    assert.ok(!json.includes(secret), `document must not mention ${secret}`);
    assert.ok(!text.includes(secret), `panel must not mention ${secret}`);
  }
});

test("[17] native confirmation, plan terms and dispatch requests do not change", (t) => {
  const env = seed(t);
  const now = Date.now();
  env.publishQuota("stats-a", quotaSnapshot("stats-a", [observation({ scopeId: pool("stats-a") })], now));
  env.publishQuota("stats-b", quotaSnapshot("stats-b", [observation({ scopeId: pool("stats-b"), remaining: 180, budget: 200 })], now));
  env.publishCredit("stats-credit", creditSnapshot("stats-credit", now, { realm: "intl" }));
  const before = sha(env.file);
  const tasksBefore = JSON.stringify(env.service().listTasks(50));
  const ambiguous = env.read(EXECUTION, declared(link({ quotaConnectionId: "stats-a" }), link({ quotaConnectionId: "stats-b" })));
  const mismatch = env.read(EXECUTION, declared(link({ realm: "cn" })));
  assert.equal(sha(env.file), before, "a resource read never touches the task store");
  assert.equal(JSON.stringify(env.service().listTasks(50)), tasksBefore, "tasks and their terms are untouched");
  // The document carries evidence only: no field can admit, approve, dispatch or
  // rewrite a plan, so a new state cannot change those flows.
  const keys = Object.keys(ambiguous).sort();
  assert.deepEqual(keys, [
    "association", "attribution", "caveats", "credit", "creditState", "execution", "generatedAt",
    "link", "otherQuotaSources", "quota", "readOnly", "routingVerified", "schemaVersion",
  ]);
  assert.deepEqual(Object.keys(mismatch).sort(), keys);
  assert.equal(ambiguous.routingVerified, false);
  assert.equal(mismatch.routingVerified, false);
});

test("[18] the new states reach the loader and old responses are still dropped", async () => {
  const now = new Date().toISOString();
  const document = (connectionId: string, status: string) => ({
    schemaVersion: "workbuddy-executor/plan-resource-reference-1",
    readOnly: true,
    generatedAt: now,
    execution: { executorId: "workbuddy", connectionId, providerId: "workbuddy-native", modelId: "synthetic-model-alpha", reasoningEffort: null },
    link: { status: "declared", source: "WORKBUDDY_RESOURCE_LINKS_FILE", code: null, declaredAt: null, realm: null, modelsCount: 0 },
    association: status === "linked_ambiguous"
      ? { status, reason: "multiple_declared_links", candidates: 2 }
      : { status, reason: "declared_link" },
    quota: null,
    otherQuotaSources: [],
    credit: null,
    creditState: status === "linked_ambiguous" ? "ambiguous" : "available",
    caveats: [],
    routingVerified: false,
    attribution: "none",
  });
  const A = { ...EXECUTION, connectionId: "local-a" };
  const B = { ...EXECUTION, connectionId: "local-b" };
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = async (url: string) => {
    if (url.includes("local-b")) await gate;
    const body = url.includes("local-b") ? document("local-b", "linked") : document("local-a", "linked_ambiguous");
    return { ok: true, json: async () => body } as never;
  };
  const loader = createReferenceLoader({ fetchImpl: fetchImpl as never });
  loader.bind(A as never, "draft-1:synthetic-digest");
  await loader.load();
  assert.equal(loader.state.error, null);
  assert.equal(loader.state.document.association.status, "linked_ambiguous");
  assert.equal(describeReference(loader.state.document as never).headline, "关联声明存在冲突，无法确定该方案对应的统计来源。");

  loader.bind(B as never, "draft-2:synthetic-digest");
  const pending = loader.load();
  loader.bind(A as never, "draft-1:synthetic-digest");
  await loader.load();
  release?.();
  await pending;
  assert.equal(loader.state.error, null, "the late answer is dropped, not an identity mismatch");
  assert.equal(loader.state.document.execution.connectionId, "local-a");
  assert.equal(loader.state.document.association.status, "linked_ambiguous");
  loader.destroy();
});

test("[19] the gateway total entry is not gated by the new states", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../workbench/plan-reference.mjs"), "utf8");
  const start = source.indexOf("function actionBar()");
  const end = source.indexOf("return actions;", start);
  assert.ok(start > 0 && end > start);
  const bar = source.slice(start, end);
  assert.ok(bar.includes("查看网关资源汇总"), "the entry stays in the action bar");
  assert.ok(!/association|creditState|state\.document/.test(bar), "the action bar never reads the new state");
});
