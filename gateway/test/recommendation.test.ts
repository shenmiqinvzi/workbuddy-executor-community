import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PLAN_REFERENCE_SCHEMA, RECOMMENDATION_SCHEMA, RecommendationError, STATISTICS_SCHEMA, recommendTask,
} from "../src/recommendation.js";

/**
 * The evaluation table behind `docs/delivery/L05_RULES.md`. Each test names one
 * row of that table; together they prove the four claims the delivery makes:
 * deterministic output for one snapshot, no fabricated quality, no raising of
 * unknown into free/sufficient, and no authorization by recommendation.
 */
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const AT = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const selection = (over: Record<string, unknown> = {}) => ({
  executorId: "dsh" as const, connectionId: "host-1", providerId: "provider-1", modelId: "model-a", reasoningEffort: null as string | null, ...over,
});
const sourceOf = (execution: { executorId: string; connectionId: string; providerId: string }) => JSON.stringify([execution.executorId, execution.connectionId, execution.providerId]);

function model(over = {}) {
  return { execution: selection(), credits: "x0.00", pricingVerified: true, blockedReason: null as string | null, ...over };
}
function source(models: { execution: { executorId: "workbuddy" | "dsh"; connectionId: string; providerId: string } }[], over = {}) {
  const execution = models[0]!.execution;
  return { sourceId: sourceOf(execution), executorId: execution.executorId, connectionId: execution.connectionId, providerId: execution.providerId,
    label: `${execution.executorId} · ${execution.providerId} · ${execution.connectionId}`, state: "online", stateReason: null, dispatchable: true, stoppable: "unknown" as const, models, ...over };
}
const free = model();
const paid = model({ execution: selection({ modelId: "model-b", reasoningEffort: "high" }), credits: "x1.20" });
const mystery = model({ execution: selection({ connectionId: "host-2", providerId: "provider-2", modelId: "model-c" }), credits: null, pricingVerified: false });
const offlineModel = model({ execution: selection({ connectionId: "host-3", providerId: "provider-3", modelId: "model-d" }) });

function catalog(over: Record<string, unknown> = {}) {
  const models = [free, paid, mystery, offlineModel];
  return {
    catalogId: "catalog-1", observedAt: AT(-60_000), expiresAt: AT(240_000),
    models,
    sources: [source([free, paid]), source([mystery]), source([offlineModel], { state: "disabled", stateReason: "DSH 来源未启用", dispatchable: false })],
    policy: { version: "policy-1", maxAttempts: 2, maxTimeoutSeconds: 600, requireFree: false, selectionMode: "user_choice", allowed: [] },
    requiredFreeModel: null, dispatchEnabled: true, errors: [],
    ...over,
  };
}
const smallIntent = { objective: "修正文档中的一个拼写错误", allowedChanges: ["docs/guide.md"], checks: ["拼写错误消失"], maxAttempts: 1, timeoutSeconds: 120 };
const bigIntent = { objective: "重构统计页的聚合逻辑并补齐缺口用例", allowedChanges: ["src/statistics-service.ts", "src/statistics-http.ts", "test/statistics.test.ts", "workbench/statistics.mjs"], checks: ["现有统计端点保持兼容", "缺口样本被明确标注", "页面可读"], maxAttempts: 2, timeoutSeconds: 900 };

const stats = (over: Record<string, unknown> = {}) => ({
  ok: true, readOnly: true, snapshotOnly: true, schemaVersion: STATISTICS_SCHEMA,
  window: { from: "2026-10-01T00:00:00.000Z", to: null },
  coverage: { tasksRead: 20, tasksIncluded: 20, tasksExcludedOutsideWindow: 0, tasksWithoutEvents: 0, tasksIncomplete: 0, eventsRead: 140, tasksTruncated: 0, eventsTruncated: 0 },
  totals: {}, rows: [], limitations: [], limitationCounts: {}, claims: { savings: null, superiority: null }, ...over,
});
const reference = (execution: ReturnType<typeof selection>, over: Record<string, unknown> = {}) => ({
  schemaVersion: PLAN_REFERENCE_SCHEMA, readOnly: true, generatedAt: AT(-30_000), execution,
  attribution: "execution_link_declared", routingVerified: false,
  association: { status: "linked", reason: null },
  quota: { unit: "tokens", freshness: "fresh", remaining: 12_000, availability: "observed", limitations: [] },
  credit: { unit: "credit", balance: "x4.00", cacheFreshness: "fresh", limitations: [] },
  caveats: ["resource_reference_only", "not_task_usage", "not_a_spend_limit", "routing_unverified"],
  ...over,
});

const run = (parameters: Record<string, unknown>, snapshot: unknown = catalog()) => recommendTask(parameters, snapshot, NOW);
const codes = (list: { code: string }[]) => list.map(item => item.code);
const withoutGeneratedAt = (value: Record<string, unknown>) => { const copy = { ...value }; delete copy.generatedAt; return copy; };

test("a small read-only or exact-file change is direct and creates no attempt", () => {
  const result = run({ intent: { ...smallIntent, allowedChanges: [] } });
  assert.equal(result.decision, "direct");
  assert.equal(result.decisionReason.code, "direct_small_change");
  assert.ok(result.decisionReason.codes.includes("direct_read_only"));
  assert.equal(result.recommended, null);
  assert.equal(result.attempt, null);
  assert.equal(result.nativeAttempt, "none");
  assert.equal(result.authorization.state, "none");
  assert.deepEqual(result.authorization.requires, ["preview", "confirmation"]);
  assert.equal(result.schemaVersion, RECOMMENDATION_SCHEMA);
});

test("a wide scope is delegated instead of being called a small change", () => {
  const result = run({ intent: bigIntent });
  assert.equal(result.decision, "delegate");
  assert.notEqual(result.recommended, null);
  assert.ok(codes(result.missing).includes("direct_not_applicable") === false, "a wide scope is not reported as a refused direct task");
});

test("an explicit user choice wins over the ranking and over a direct suggestion", () => {
  const result = run({ intent: bigIntent, constraints: { selection: paid.execution } });
  assert.equal(result.decision, "delegate");
  assert.equal(result.userSelection?.status, "available");
  assert.deepEqual(result.recommended?.selection, paid.execution);
  assert.equal(result.decisionReason.code, "user_selection_wins");
  const directToo = run({ intent: smallIntent, constraints: { selection: paid.execution } });
  assert.equal(directToo.decision, "delegate", "the user asked for an executor, so direct is not suggested");
});

test("an unavailable user choice waits instead of substituting the cheapest candidate", () => {
  const result = run({ intent: bigIntent, constraints: { selection: offlineModel.execution } });
  assert.equal(result.decision, "wait");
  assert.equal(result.recommended, null);
  assert.equal(result.userSelection?.status, "unavailable");
  assert.ok(["source_not_online", "source_not_dispatchable"].includes(result.userSelection!.code));
  assert.ok(codes(result.missing).includes("user_selection_unavailable"));
  assert.ok(result.candidates.length > 0, "the other candidates are still listed for reading");
  assert.equal(result.recommended, null, "no candidate is silently promoted to the user's place");
});

test("several candidates are listed with a deterministic order and no quality score", () => {
  const first = run({ intent: bigIntent });
  const second = run({ intent: bigIntent });
  assert.ok(first.candidates.length >= 3);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(withoutGeneratedAt(first), withoutGeneratedAt(second));
  assert.deepEqual(first.candidates.map(item => item.selection.modelId), second.candidates.map(item => item.selection.modelId));
  assert.equal(first.recommended?.selection.modelId, "model-a", "the verified zero rate is the first policy tier, not a measured quality");
  assert.ok(first.candidates.every(item => item.rank.rule === "tier_then_lexicographic"));
  assert.ok(!JSON.stringify(first).includes('"score"'), "no fabricated quality score");
  assert.ok(first.notes.some(note => note.includes("不是质量排名")));
});

test("a paid rate is an observation and an unknown rate is neither free nor sufficient", () => {
  const result = run({ intent: bigIntent });
  const paidView = result.candidates.find(item => item.selection.modelId === "model-b")!;
  const mysteryView = result.candidates.find(item => item.selection.modelId === "model-c")!;
  assert.equal(paidView.cost.known, true);
  assert.equal(paidView.cost.zero, false);
  assert.match(paidView.cost.label, /观察费率 x1\.20/);
  assert.ok(paidView.reasons.some(reason => reason.code === "cost_observed"));
  assert.equal(mysteryView.cost.known, false);
  assert.equal(mysteryView.cost.zero, false);
  assert.equal(mysteryView.cost.credits, null);
  assert.match(mysteryView.cost.label, /费用未知/);
  assert.ok(mysteryView.reasons.some(reason => reason.code === "cost_unknown"));
  assert.ok(codes(result.missing).includes("pricing_unknown") === (result.recommended?.cost.known === false));
});

test("a free-only policy keeps only verified zero rates and never relaxes to paid", () => {
  const result = run({ intent: bigIntent, constraints: { freeOnly: true } });
  assert.ok(result.candidates.every(item => item.cost.zero));
  assert.deepEqual(result.candidates.map(item => item.selection.modelId), ["model-a"]);
  const excluded = result.excluded.filter(item => item.code === "free_only_not_verified");
  assert.equal(excluded.length, 2);
  const none = run({ intent: bigIntent, constraints: { freeOnly: true } }, catalog({ models: [paid, mystery], sources: [source([paid, mystery])] }));
  assert.equal(none.decision, "wait");
  assert.equal(none.recommended, null);
  assert.equal(none.decisionReason.code, "no_candidate");
});

test("a legacy allowlist keeps its exclusions visible and an empty allowlist waits", () => {
  const legacy = run({ intent: bigIntent }, catalog({
    models: [free, { ...paid, blockedReason: "当前部署的模型政策不允许此选择" }, { ...mystery, blockedReason: "当前部署的模型政策不允许此选择" }],
    sources: [source([free, paid, mystery])],
    policy: { version: "legacy", maxAttempts: 1, maxTimeoutSeconds: 600, requireFree: true, selectionMode: "allowlist", allowed: [free.execution] },
  }));
  assert.deepEqual(legacy.candidates.map(item => item.selection.modelId), ["model-a"]);
  assert.equal(legacy.excluded.filter(item => item.code === "policy_blocked").length, 2);
  const empty = run({ intent: bigIntent }, catalog({
    models: [{ ...free, blockedReason: "当前部署的模型政策不允许此选择" }],
    sources: [source([free])],
    policy: { version: "legacy", maxAttempts: 1, maxTimeoutSeconds: 600, requireFree: true, selectionMode: "allowlist", allowed: [] },
  }));
  assert.equal(empty.decision, "wait");
  assert.equal(empty.decisionReason.code, "no_candidate");
});

test("a required hard spending cap is refused rather than promised", () => {
  const result = run({ intent: bigIntent, constraints: { hardCostCap: { credits: "x2.00" } } });
  assert.equal(result.decision, "wait");
  assert.equal(result.recommended, null);
  assert.equal(result.constraints.hardCostCap.status, "unsupported");
  assert.equal(result.constraints.hardCostCap.requested, "x2.00");
  assert.ok(codes(result.missing).includes("hard_cost_cap_unsupported"));
  assert.ok(result.limitations.includes("hard_cost_cap_not_guaranteed"));
  assert.equal(result.decisionReason.code, "hard_cost_cap_unsupported");
});

test("a stale resource reference is named as stale and never read as a current balance", () => {
  const stale = reference(paid.execution, { quota: { unit: "tokens", freshness: "stale", remaining: null }, credit: { unit: "credit", balance: null, cacheFreshness: "stale" } });
  const result = run({ intent: bigIntent, constraints: { selection: paid.execution }, resources: [stale] });
  const chosen = result.recommended!;
  assert.equal(chosen.resources.status, "stale");
  assert.equal(chosen.resources.quotaFreshness, "stale");
  assert.equal(chosen.resources.quotaRemaining, null);
  assert.equal(chosen.resources.routingVerified, false);
  assert.ok(chosen.reasons.some(reason => reason.code === "resource_reference_stale"));
  assert.ok(chosen.resources.limitations.includes("routing_unverified"));
  const missingReference = run({ intent: bigIntent, constraints: { selection: paid.execution } });
  assert.equal(missingReference.recommended?.resources.status, "unavailable");
  assert.equal(missingReference.recommended?.resources.quotaRemaining, null);
});

test("a declared routing claim is reported and not trusted", () => {
  const claim = reference(free.execution, { routingVerified: true });
  const result = run({ intent: bigIntent, constraints: { selection: free.execution }, resources: [claim] });
  assert.equal(result.recommended?.resources.status, "unverified_claim");
  assert.equal(result.recommended?.resources.routingVerified, false);
  assert.ok(result.recommended?.resources.limitations.includes("routing_claim_rejected"));
  assert.equal(result.recommended?.resources.quotaRemaining, null);
});

test("a resource reference is only shown for the model it names", () => {
  const result = run({ intent: bigIntent, resources: [reference(paid.execution)] });
  const paidView = result.candidates.find(item => item.selection.modelId === "model-b")!;
  const freeView = result.candidates.find(item => item.selection.modelId === "model-a")!;
  assert.equal(paidView.resources.status, "fresh");
  assert.equal(paidView.resources.quotaRemaining, 12_000);
  assert.equal(freeView.resources.status, "unavailable");
  assert.equal(freeView.resources.quotaRemaining, null);
  assert.ok(freeView.resources.limitations.includes("resource_reference_other_model"));
});

test("no statistics leaves the sample unknown instead of zero or complete", () => {
  const result = run({ intent: bigIntent });
  assert.equal(result.history.status, "unavailable");
  assert.equal(result.history.code, "statistics_not_read");
  assert.equal(result.history.sampleSize, null);
  assert.equal(result.history.window, null);
  assert.deepEqual(result.history.claims, { savings: null, superiority: null });
  assert.ok(codes(result.missing).includes("no_statistics_sample"));
  assert.equal(result.decision, "delegate", "missing history does not remove a usable candidate");
});

test("partial statistics keep the window and sample size visible", () => {
  const result = run({ intent: bigIntent, statistics: stats({ coverage: { tasksRead: 20, tasksIncluded: 12, tasksExcludedOutsideWindow: 8, tasksWithoutEvents: 1, tasksIncomplete: 1, eventsRead: 60, tasksTruncated: 0, eventsTruncated: 0 } }) });
  assert.equal(result.history.status, "partial");
  assert.equal(result.history.code, "statistics_partial_coverage");
  assert.equal(result.history.sampleSize, 12);
  assert.deepEqual(result.history.window, { from: "2026-10-01T00:00:00.000Z", to: null });
  assert.equal(result.history.coverage?.tasksIncluded, 12);
  assert.ok(codes(result.missing).includes("statistics_partial_coverage"));
  const clean = run({ intent: bigIntent, statistics: stats() });
  assert.equal(clean.history.status, "available");
  assert.equal(clean.history.sampleSize, 20);
});

test("a changed snapshot is reported as drift before dispatch", () => {
  const before = run({ intent: bigIntent });
  const changed = run({ intent: bigIntent, previous: { digest: before.digest, catalogId: "catalog-1", policyVersion: "policy-1", selection: before.recommended!.selection } }, catalog({ catalogId: "catalog-2", policy: { version: "policy-2", maxAttempts: 2, maxTimeoutSeconds: 600, requireFree: false, selectionMode: "user_choice", allowed: [] } }));
  assert.equal(changed.drift?.blockedForDispatch, true);
  assert.ok(changed.drift!.codes.includes("catalog_changed"));
  assert.ok(changed.drift!.codes.includes("policy_changed"));
  const same = run({ intent: bigIntent, previous: { digest: before.digest, catalogId: "catalog-1", policyVersion: "policy-1", selection: before.recommended!.selection } });
  assert.deepEqual(same.drift, { codes: [], message: "与上次评估一致。", blockedForDispatch: false });
});

test("an expired snapshot, a disabled dispatch and an unreadable request are refused with reasons", () => {
  const expired = run({ intent: bigIntent }, catalog({ expiresAt: AT(-1_000) }));
  assert.equal(expired.decision, "wait");
  assert.equal(expired.recommended, null);
  assert.ok(codes(expired.missing).includes("catalog_expired"));
  assert.ok(codes(expired.excluded).includes("catalog_expired"));
  const disabled = run({ intent: bigIntent }, catalog({ dispatchEnabled: false }));
  assert.equal(disabled.decision, "wait");
  assert.ok(codes(disabled.excluded).includes("dispatch_not_enabled"));
  assert.equal(disabled.policy.dispatchEnabled, false);
  assert.throws(() => run({ intent: bigIntent, unexpected: true }), (error: unknown) => error instanceof RecommendationError && error.code === "INVALID_REQUEST");
  assert.throws(() => run({ intent: bigIntent, constraints: { selection: { ...paid.execution, executorId: "other" } } }), /executorId/);
  assert.throws(() => run({ intent: { ...bigIntent, allowedChanges: "src/a.ts" } }), /allowedChanges/);
});

test("one malformed catalog row is counted, not silently dropped and not fatal", () => {
  const broken = { execution: { executorId: "dsh" }, credits: "x0.00", pricingVerified: true, blockedReason: null };
  const result = run({ intent: bigIntent }, catalog({ models: [free, broken], sources: [source([free])] }));
  assert.ok(codes(result.missing).includes("catalog_entry_unreadable"));
  assert.deepEqual(result.candidates.map(item => item.selection.modelId), ["model-a"]);
});

test("the evaluator reads no filesystem, network or clock beyond its arguments", () => {
  const text = fs.readFileSync(new URL("../src/recommendation.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:fs", "node:net", "node:http", "node:child_process", "fetch(", "Date.now("]) {
    assert.equal(text.includes(forbidden), false, `recommendation.ts must not use ${forbidden}`);
  }
  assert.ok(text.includes("attempt: null"), "a recommendation never creates an attempt");
  const result = run({ intent: bigIntent });
  assert.equal(result.authorization.state, "none");
  assert.equal(JSON.stringify(result).includes('"authorized":true'), false);
});
