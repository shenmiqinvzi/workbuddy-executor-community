import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createReadOnlyProbe, type AutomationProbeReport } from "../src/automation.js";
import { QuotaStore } from "../src/quota-observation.js";
import { CreditBalanceStore } from "../src/credit-balance.js";
import { RESOURCE_CONNECTIONS_ENV, RESOURCE_CONNECTIONS_SCHEMA } from "../src/resource-connections.js";
import type { DesktopCatalogSource } from "../src/desktop-dispatch.js";
import { automationFixture } from "./support/automation-fixture.js";

/**
 * D02: the read-only observation probe.
 *
 * These tests exercise the probe against the surfaces a real composition root has — the declared
 * resource registry, the saved quota/credit tables and a catalog reader — and then through the
 * assessment, because a probe that reports something is only worth the decision it produces.
 */
const iso = (ms: number) => new Date(ms).toISOString();
const POOL = `pool-${"a".repeat(32)}`;

function model(overrides: Record<string, unknown> = {}) {
  return {
    scopeId: POOL, scopeKind: "gateway_pool", shared: true, modelId: "synthetic-user-choice", realm: "cn",
    unit: "tokens", valueKind: "estimated", availability: "available",
    used: 10, budget: 1010, remaining: 1000, resetAt: null,
    method: "historical_budget_minus_observed_usage",
    limitations: ["routing_unverified", "shared_pool", "budget_estimated", "gateway_observed_usage_only", "task_attribution_unavailable"],
    ...overrides,
  };
}

/** A saved token pool, written through the same store the collector publishes with. */
function savePool(db: DatabaseSync, options: { expiresAt: number; observations: Array<Record<string, unknown>>; collectedAt: number }) {
  const store = new QuotaStore(db);
  const connectionId = "workbuddy2api-local";
  const epoch = store.register(connectionId, "synthetic-fingerprint");
  const generation = store.beginPoll(connectionId, epoch);
  assert.notEqual(generation, null, "the synthetic quota connection must be pollable");
  const published = store.publish(connectionId, epoch, generation!, {
    snapshotId: `snap-${"b".repeat(24)}`, connectionId,
    collectedAt: iso(options.collectedAt), sourceObservedAt: iso(options.collectedAt), expiresAt: iso(options.expiresAt),
    observations: options.observations as never,
  });
  assert.equal(published, true, "the synthetic quota snapshot must be accepted by the store");
}

test("a probe with no catalog reader never calls an executor dispatchable", async (t) => {
  const fixture = automationFixture(t);
  const probe = createReadOnlyProbe({ db: fixture.store.database, env: {}, now: () => new Date(fixture.clock.now) });
  const policy = fixture.policy();

  const report = await probe(policy.policy);
  assert.equal(report.readOnly, true);
  assert.equal(report.probeVersion, "workbuddy-executor/automation-probe-1");
  assert.deepEqual(report.executors, []);
  assert.deepEqual(report.models, []);
  assert.equal(report.coverage.executors, "unavailable");
  assert.equal(report.coverage.catalog, "missing");
  assert.ok(report.limitations.includes("no_catalog_reader"));
  const catalog = report.sources.find((source) => source.source === "catalog");
  assert.equal(catalog?.status, "unwired");
  assert.match(catalog?.detail ?? "", /nothing here may claim the executor is dispatchable/);

  // The assessment must refuse on the observation, not fall back to the saved policy.
  const automation = fixture.automation({ probe });
  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });
  assert.equal(evaluation.decision, "wait");
  assert.ok(evaluation.blocks.some((block) => block.code === "OBSERVATION_UNAVAILABLE" && block.field === "probe.catalog"), JSON.stringify(evaluation.blocks));
  assert.equal(evaluation.probe.coverage?.catalog, "missing");
});

test("an unreadable resource table is reported as unreadable, not as an empty balance", async (t) => {
  const fixture = automationFixture(t);
  const automation = fixture.automation();
  const saved = fixture.savePolicy(automation);

  // A database where the collector never ran has no resource table at all: that is unreadable.
  const bare = new DatabaseSync(path.join(fixture.root, "bare.sqlite"));
  const unwired = createReadOnlyProbe({ db: bare, env: {}, now: () => new Date(fixture.clock.now) });
  const bareReport = await unwired(saved.policy);
  bare.close();
  for (const name of ["quota", "credit"] as const) {
    const source = bareReport.sources.find((item) => item.source === name);
    assert.equal(source?.status, "unreadable", `${name} must not be read as empty`);
    assert.match(source?.detail ?? "", /resource_storage_missing/);
  }
  assert.equal(bareReport.coverage.costEvidence, "unavailable");
  assert.equal(bareReport.coverage.tokenEstimates, "unavailable");
  assert.equal(bareReport.coverage.creditCache, "unavailable");

  // A store that exists and holds no connection is "not declared", which is also not a zero balance.
  const probe = createReadOnlyProbe({ db: fixture.store.database, env: {}, now: () => new Date(fixture.clock.now) });
  const report = await probe(saved.policy);
  const quota = report.sources.find((item) => item.source === "quota");
  assert.equal(quota?.status, "not_declared");
  assert.equal(quota?.entries, 0);
  assert.match(quota?.detail ?? "", /not a zero balance/);
  assert.equal(report.coverage.costEvidence, "unavailable");
});

test("a catalog row without a verified price is observed, but it is not free", async (t) => {
  const fixture = automationFixture(t);
  const livePolicy = fixture.store.collaboration.currentPolicy(undefined as never);
  const catalog: DesktopCatalogSource = {
    models: [{ execution: fixture.execution, credits: null, pricingVerified: false }],
    sessions: [],
    policy: fixture.store.collaboration.currentPolicy(livePolicy),
    requiredFreeModel: null,
    dispatchEnabled: true,
    errors: [],
  };
  const probe = createReadOnlyProbe({ db: fixture.store.database, env: {}, now: () => new Date(fixture.clock.now), catalog: () => catalog });

  const automation = fixture.automation({ probe });
  const saved = fixture.savePolicy(automation, { cost: { mode: "free_only", unit: "credit", ceiling: null, requiresHardCap: false } });

  const report = await probe(saved.policy);
  assert.equal(report.executors.length, 1);
  assert.equal(report.executors[0]?.dispatchable, true);
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0]?.valueKind, "unavailable");
  assert.equal(report.models[0]?.credits, null);
  assert.equal(report.coverage.catalog, "observed");
  assert.equal(report.coverage.costEvidence, "unavailable");

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });
  assert.equal(evaluation.decision, "wait");
  assert.equal(evaluation.cost.mode, "free_only");
  assert.ok(evaluation.blocks.some((block) => block.code === "QUOTA_UNAVAILABLE"), JSON.stringify(evaluation.blocks));
});

test("a saved token pool reaches only its exact model, and can carry a known-cost decision", async (t) => {
  const fixture = automationFixture(t);
  savePool(fixture.store.database, {
    collectedAt: fixture.clock.now,
    expiresAt: fixture.clock.now + 600_000,
    observations: [model(), model({ scopeId: `pool-${"c".repeat(32)}`, modelId: "another-model", used: 500, budget: 507, remaining: 7 })],
  });
  const livePolicy = fixture.store.collaboration.currentPolicy(undefined as never);
  const catalog: DesktopCatalogSource = {
    models: [{ execution: fixture.execution, credits: null, pricingVerified: false }],
    sessions: [], policy: fixture.store.collaboration.currentPolicy(livePolicy), requiredFreeModel: null, dispatchEnabled: true, errors: [],
  };
  const probe = createReadOnlyProbe({ db: fixture.store.database, env: {}, now: () => new Date(fixture.clock.now), catalog: () => catalog });
  const automation = fixture.automation({ probe });
  const saved = fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "tokens", ceiling: 10, requiresHardCap: false } });
  const report = await probe(saved.policy);

  // The number comes from the pool row whose modelId matched exactly, never from a neighbour.
  assert.equal(report.models[0]?.remaining, 1000);
  assert.equal(report.models[0]?.unit, "tokens");
  assert.equal(report.models[0]?.valueKind, "estimated");
  assert.equal(report.coverage.costEvidence, "gateway_pool");
  assert.ok(report.limitations.includes("cost_evidence_is_a_shared_pool_not_task_attribution"));

  // R2: a saved gateway pool is a shared estimate without verified routing, so it reaches the report
  // but cannot stand behind a known-cost decision. The number is shown, never spent.
  const balance = report.models[0]?.balance;
  assert.equal(balance?.kind, "estimated");
  assert.equal(balance?.unit, "tokens");
  assert.equal(balance?.remaining, 1000);
  assert.equal(balance?.routing, "unverified");
  assert.match(balance?.source ?? "", /^quota:/);
  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });
  assert.equal(evaluation.decision, "wait", JSON.stringify(evaluation.blocks));
  assert.ok(evaluation.blocks.some((block) => block.code === "COST_CONTROL_UNAVAILABLE" && block.field === "cost.routing"), JSON.stringify(evaluation.blocks));
  assert.equal(evaluation.cost.remaining, 1000, "the observed number is still reported");
});

test("a stale saved pool is not presented as a live reading", async (t) => {
  const fixture = automationFixture(t);
  savePool(fixture.store.database, {
    collectedAt: fixture.clock.now - 900_000,
    expiresAt: fixture.clock.now - 600_000,
    observations: [model()],
  });
  const livePolicy = fixture.store.collaboration.currentPolicy(undefined as never);
  const catalog: DesktopCatalogSource = {
    models: [{ execution: fixture.execution, credits: null, pricingVerified: false }],
    sessions: [], policy: fixture.store.collaboration.currentPolicy(livePolicy), requiredFreeModel: null, dispatchEnabled: true, errors: [],
  };
  const probe = createReadOnlyProbe({ db: fixture.store.database, env: {}, now: () => new Date(fixture.clock.now), catalog: () => catalog });
  const automation = fixture.automation({ probe });
  const saved = fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "tokens", ceiling: 10, requiresHardCap: false } });
  const report = await probe(saved.policy);

  assert.equal(report.coverage.tokenEstimates, "observed");
  assert.ok(report.limitations.includes("token_estimates_stale"));
  assert.equal(report.models[0]?.remaining, null, "an expired snapshot may not supply a balance");
  assert.equal(report.sources.find((source) => source.source === "quota")?.status, "stale");

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });
  assert.equal(evaluation.decision, "wait");
  assert.ok(evaluation.blocks.some((block) => block.code === "QUOTA_UNAVAILABLE"), JSON.stringify(evaluation.blocks));
});

test("a declared resource connection is a declaration, never an executor row", async (t) => {
  const fixture = automationFixture(t);
  const file = path.join(fixture.root, "resource-connections.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: RESOURCE_CONNECTIONS_SCHEMA,
    connections: [{
      connectionId: "workbuddy2api-local", resource: "quota", sourceUrl: "http://127.0.0.1:18999", realm: "cn", shared: true,
      models: ["synthetic-user-choice"], credentialEnv: { apiKey: "WORKBUDDY_STATISTICS_API_KEY" },
    }],
  }));
  const probe = createReadOnlyProbe({
    db: fixture.store.database, now: () => new Date(fixture.clock.now),
    env: { [RESOURCE_CONNECTIONS_ENV]: file } as NodeJS.ProcessEnv,
  });
  const automation = fixture.automation({ probe });
  const saved = fixture.savePolicy(automation, { cost: { mode: "unknown_allowed", unit: "credit", ceiling: null, requiresHardCap: false } });
  const report = await probe(saved.policy);

  const connections = report.sources.find((source) => source.source === "connections");
  assert.equal(connections?.status, "ok");
  assert.equal(connections?.entries, 1);
  assert.deepEqual(report.executors, [], "a declaration does not prove an executor exists");
  assert.equal(report.coverage.catalog, "declared_only");

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });
  assert.equal(evaluation.decision, "wait");
  assert.ok(evaluation.blocks.some((block) => block.code === "OBSERVATION_UNAVAILABLE"), JSON.stringify(evaluation.blocks));
});

test("a saved region credit cache stays a region pool, never one model's balance", async (t) => {
  const fixture = automationFixture(t);
  const db = fixture.store.database;
  const quota = new QuotaStore(db);
  const credit = new CreditBalanceStore(db, quota);
  const connectionId = "workbuddy2api-credit";
  const epoch = credit.register(connectionId, "synthetic-credit-fingerprint");
  const generation = credit.begin(connectionId, epoch);
  assert.notEqual(generation, null);
  // The saved payload carries exactly the keys the store publishes; the region dimension only.
  const published = credit.publish(connectionId, epoch, generation!, {
    snapshotId: `snap-${"d".repeat(24)}`, connectionId, scopeId: credit.scope("http://127.0.0.1:18999", "cn"),
    realm: "cn", unit: "credit", valueKind: "reported_cache", balance: 250,
    accountsEnabled: 2, accountsWithData: 2, coverage: "complete",
    latestMemberObservedAt: iso(fixture.clock.now), collectedAt: iso(fixture.clock.now),
    cacheExpiresAt: iso(fixture.clock.now + 600_000),
  } as never);
  assert.equal(published, true);

  const file = path.join(fixture.root, "resource-connections.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: RESOURCE_CONNECTIONS_SCHEMA,
    connections: [{
      connectionId, resource: "credit", sourceUrl: "http://127.0.0.1:18999", realm: "cn", shared: true,
      credentialEnv: { apiKey: "WORKBUDDY_STATISTICS_API_KEY" },
    }],
  }));
  const livePolicy = fixture.store.collaboration.currentPolicy(undefined as never);
  const catalog: DesktopCatalogSource = {
    models: [{ execution: fixture.execution, credits: null, pricingVerified: false }],
    sessions: [], policy: fixture.store.collaboration.currentPolicy(livePolicy), requiredFreeModel: null, dispatchEnabled: true, errors: [],
  };
  const probe = createReadOnlyProbe({
    db, now: () => new Date(fixture.clock.now), catalog: () => catalog,
    env: { [RESOURCE_CONNECTIONS_ENV]: file } as NodeJS.ProcessEnv,
  });
  const automation = fixture.automation({ probe });
  const saved = fixture.savePolicy(automation, { cost: { mode: "known_cost", unit: "credit", ceiling: 10, requiresHardCap: false } });
  const report: AutomationProbeReport = await probe(saved.policy);
  assert.equal(report.coverage.creditCache, "observed");
  assert.equal(report.sources.find((source) => source.source === "credit")?.status, "ok");
  assert.ok(report.limitations.includes("credit_balance_is_a_region_pool_not_a_model_balance"));
  // A region pool is not a per-model balance, so it may not fill this model row.
  assert.equal(report.models[0]?.remaining, null);
  assert.equal(report.models[0]?.credits, null);

  const evaluation = await automation.evaluate({ proposal: fixture.proposal() });
  assert.equal(evaluation.decision, "wait");
  assert.ok(evaluation.blocks.some((block) => block.code === "QUOTA_UNAVAILABLE"), JSON.stringify(evaluation.blocks));
});
