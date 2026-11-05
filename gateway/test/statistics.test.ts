/**
 * L03 acceptance tests: request attribution and recomputable statistics.
 *
 * These tests are the synthetic evidence for the L03 line (D6-01/02/05). They
 * cover, in order:
 *   - upstream usage envelope validation (shape, units, currency, retry links);
 *   - the append-only ledger (replay dedup, value/occurrence conflicts, missing
 *     table probing, credential/path-shaped scopes);
 *   - attribution levels and the rule that another client's rows in a shared
 *     pool are never counted, and units are never summed together;
 *   - MetricSummary timing/calls/acceptance/rework/recovery/interventions/usage
 *     from stored facts only, including out-of-order events and late observations;
 *   - the read-only statistics query surface (window parsing, paging cap,
 *     overview totals, contract integrity, no writes);
 *   - the HTTP route mapping, including task ids that could look like paths.
 *
 * Every fixture is synthetic. No test calls a model, opens a socket to an
 * upstream source, reads a run directory or writes a task state.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { TaskStore, type StoredAttempt, type StoredTask, type StoredTaskEvent } from "../src/task-store.js";
import type { ReviewRecord } from "../src/task-reviews.js";
import { persistedTaskContract, validateSupportedTaskContract } from "../src/task-contract.js";
import {
  UPSTREAM_USAGE_SCHEMA,
  USAGE_ATTRIBUTION_SCHEMA,
  UsageLedger,
  attributeTaskUsage,
  attributeTaskUsageFromLedger,
  parseUpstreamUsageEnvelope,
  readUsageRecords,
  readUsageRecordsFromFile,
  usageSourceScopeProblem,
  type StoredUsageRecord,
  type UpstreamUsageRecord,
} from "../src/usage-attribution.js";
import { TASK_METRICS_SCHEMA, buildTaskMetricSummary } from "../src/task-metrics.js";
import {
  STATISTICS_SCHEMA,
  parseStatisticsQuery,
  readStatisticsOverview,
  readTaskStatistics,
  type StatisticsSources,
  type StatisticsStore,
} from "../src/statistics-service.js";
import { handleStatisticsRequest, statisticsSources } from "../src/statistics-http.js";

const ATTEMPT_A = "run-11111111-1111-1111-1111-111111111111";
const ATTEMPT_B = "run-22222222-2222-2222-2222-222222222222";

function tempStore(t: { after(callback: () => void): void }): { dir: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l03-statistics-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { dir, store };
}

function taskFixture(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    taskId: "task-1",
    messageId: "msg-1",
    objective: "synthetic objective",
    state: "working",
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    ...overrides,
  };
}

function attemptFixture(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  return {
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    attempt: 1,
    messageId: "msg-1",
    state: "needs_review",
    lastEventSeq: 0,
    artifacts: [],
    evidence: [],
    createdAt: "2026-11-05T10:00:30.000Z",
    updatedAt: "2026-11-05T10:05:00.000Z",
    ...overrides,
  };
}

function eventFixture(
  eventId: number,
  type: string,
  occurredAt: string,
  extra: { observedAt?: string; attemptId?: string | null; payload?: Record<string, unknown>; actor?: string } = {},
): StoredTaskEvent {
  return {
    taskId: "task-1",
    eventId,
    attemptId: extra.attemptId === undefined ? ATTEMPT_A : extra.attemptId,
    type,
    occurredAt,
    observedAt: extra.observedAt ?? occurredAt,
    actor: extra.actor ?? "gateway",
    payload: extra.payload ?? {},
    sourceRef: null,
  };
}

function reviewFixture(checks: Array<{ checkId: string; status: string }>, attemptId = ATTEMPT_A): ReviewRecord {
  return {
    reviewId: "review-1",
    taskId: "task-1",
    attemptId,
    basisRevision: "rev-1",
    committedRevision: "rev-2",
    bindingDigest: "digest",
    agreement: { hash: "hash", version: "agreement-1" },
    runtimeSource: "desktop_queue",
    sessionId: "session-1",
    machineCheckIds: [],
    checks: checks.map(check => ({ checkId: check.checkId, status: check.status })) as ReviewRecord["checks"],
    note: "synthetic review",
    createdAt: "2026-11-05T10:09:00.000Z",
    reviewer: { actor: "independent_reviewer", channel: "trusted_local_coordinator" },
    supersedesReviewId: null,
    correction: null,
  } as unknown as ReviewRecord;
}

function contractFixture(taskId = "task-1", checks: Array<{ id: string; kind: "command" | "semantic" }> = [{ id: "unit", kind: "command" }, { id: "sem", kind: "semantic" }]) {
  const validated = validateSupportedTaskContract({
    schemaVersion: "workbuddy-executor/vnext-1",
    taskId,
    workspaceId: "ws-1",
    title: "synthetic task",
    objective: "synthetic objective",
    model: "synthetic-model",
    timeoutSeconds: 1800,
    maxAttempts: 3,
    scope: { allowedChanges: ["src/a.ts"], permittedMetadata: [] },
    requiredChecks: checks.map(check => ({
      id: check.id,
      kind: check.kind,
      definition: check.kind === "command" ? '{"command":["node","-v"]}' : "behaviour is unchanged",
    })),
  });
  assert.equal(validated.ok, true, "the synthetic contract must validate");
  return persistedTaskContract(validated.contract, validated.contractHash, "2026-11-05T10:00:00.000Z", { maxAttempts: 3 });
}

function usageRecord(overrides: Partial<UpstreamUsageRecord> = {}): UpstreamUsageRecord {
  return {
    requestId: "req-1",
    retryOf: null,
    retryIndex: 0,
    occurredAt: "2026-11-05T09:00:00.000Z",
    observedAt: "2026-11-05T09:00:05.000Z",
    executorId: "dsh",
    runtimeSource: "dsh",
    connectionId: "connection-1",
    providerId: "provider-1",
    modelId: "model-1",
    reasoningEffort: null,
    sessionId: "session-1",
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    role: "worker",
    unit: "tokens",
    currency: null,
    scopeKind: "routed_pool",
    scopeId: "pool-abc",
    value: 100,
    valueKind: "reported",
    method: "provider_reported",
    limitations: [],
    ...overrides,
  };
}

function storedUsage(overrides: Partial<StoredUsageRecord> = {}): StoredUsageRecord {
  const base = usageRecord();
  return { ...base, sourceScope: "connection-1", sourceKey: `connection-1\u0000${base.requestId}\u0000${base.unit}`, recordedAt: "2026-11-05T09:00:06.000Z", ...overrides };
}

// ---------------------------------------------------------------- upstream --

test("upstream envelope: a complete synthetic record parses", () => {
  const parsed = parseUpstreamUsageEnvelope({
    schemaVersion: UPSTREAM_USAGE_SCHEMA,
    generatedAt: "2026-11-05T09:10:00.000Z",
    records: [usageRecord(), usageRecord({ requestId: "req-2", unit: "credits", value: 2, currency: null })],
    limitations: [],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.envelope.records.length, 2);
});

test("upstream envelope: wrong schema version is refused explicitly", () => {
  const parsed = parseUpstreamUsageEnvelope({ schemaVersion: "workbuddy-upstream-usage-2", generatedAt: "2026-11-05T09:10:00.000Z", records: [], limitations: [] });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "unsupported_schema");
    assert.equal(parsed.field, "schemaVersion");
  }
});

test("upstream envelope: unknown fields, unknown limitation codes and duplicate lines are refused", () => {
  const base = { schemaVersion: UPSTREAM_USAGE_SCHEMA, generatedAt: "2026-11-05T09:10:00.000Z", limitations: [] as string[] };

  const unknownField = parseUpstreamUsageEnvelope({ ...base, records: [{ ...usageRecord(), totalCost: 5 }] });
  assert.equal(unknownField.ok, false);
  if (!unknownField.ok) assert.match(unknownField.field, /^records\[0\]\.totalCost$/);

  const unknownLimitation = parseUpstreamUsageEnvelope({ ...base, records: [usageRecord({ limitations: ["cost_guessed" as never] })] });
  assert.equal(unknownLimitation.ok, false);
  if (!unknownLimitation.ok) assert.match(unknownLimitation.field, /^records\[0\]\.limitations\[0\]$/);

  const duplicate = parseUpstreamUsageEnvelope({ ...base, records: [usageRecord(), usageRecord()] });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.field, "records[1].requestId");
});

test("upstream envelope: unmeasured values, mixed units and broken retry links are refused", () => {
  const base = { schemaVersion: UPSTREAM_USAGE_SCHEMA, generatedAt: "2026-11-05T09:10:00.000Z", limitations: [] as string[] };

  const valueWithUnavailable = parseUpstreamUsageEnvelope({ ...base, records: [usageRecord({ valueKind: "unavailable", value: 10 })] });
  assert.equal(valueWithUnavailable.ok, false);
  if (!valueWithUnavailable.ok) assert.equal(valueWithUnavailable.field, "records[0].value");

  const currencyOnTokens = parseUpstreamUsageEnvelope({ ...base, records: [usageRecord({ currency: "CNY" })] });
  assert.equal(currencyOnTokens.ok, false);
  if (!currencyOnTokens.ok) assert.equal(currencyOnTokens.field, "records[0].currency");

  const currencyWithoutCode = parseUpstreamUsageEnvelope({ ...base, records: [usageRecord({ unit: "currency", currency: null, value: 1 })] });
  assert.equal(currencyWithoutCode.ok, false);
  if (!currencyWithoutCode.ok) assert.equal(currencyWithoutCode.field, "records[0].currency");

  const fractionalTokens = parseUpstreamUsageEnvelope({ ...base, records: [usageRecord({ value: 1.5 })] });
  assert.equal(fractionalTokens.ok, false);
  if (!fractionalTokens.ok) assert.equal(fractionalTokens.field, "records[0].value");

  const selfRetry = parseUpstreamUsageEnvelope({ ...base, records: [usageRecord({ retryOf: "req-1", retryIndex: 1 })] });
  assert.equal(selfRetry.ok, false);
  if (!selfRetry.ok) assert.equal(selfRetry.field, "records[0].retryOf");
});

// ------------------------------------------------------------------ ledger --

test("ledger: a replayed line is a duplicate and keeps the original observation", () => {
  const db = new DatabaseSync(":memory:");
  const times = ["2026-11-05T09:00:06.000Z", "2026-11-05T23:00:00.000Z"];
  let index = 0;
  const ledger = new UsageLedger(db, () => times[Math.min(index++, times.length - 1)]!);

  const first = ledger.record(usageRecord(), "connection-1");
  assert.equal(first.status, "inserted");
  assert.equal(first.record.observedAt, "2026-11-05T09:00:05.000Z");

  const replay = ledger.record(usageRecord({ observedAt: "2026-11-05T22:00:00.000Z" }), "connection-1");
  assert.equal(replay.status, "duplicate");
  // A late observation never rewrites when the request actually happened.
  assert.equal(replay.record.occurredAt, "2026-11-05T09:00:00.000Z");
  assert.equal(replay.record.observedAt, "2026-11-05T09:00:05.000Z");
  assert.equal(replay.record.recordedAt, "2026-11-05T09:00:06.000Z");
  assert.equal(ledger.count(), 1);
});

test("ledger: a different value or occurrence is a conflict that keeps the stored row", () => {
  const ledger = new UsageLedger(new DatabaseSync(":memory:"), () => "2026-11-05T09:00:06.000Z");
  ledger.record(usageRecord(), "connection-1");

  const valueConflict = ledger.record(usageRecord({ value: 140 }), "connection-1");
  assert.equal(valueConflict.status, "conflict");
  if (valueConflict.status === "conflict") assert.equal(valueConflict.reason, "value_conflict");
  assert.equal(valueConflict.record.value, 100);

  const occurrenceConflict = ledger.record(usageRecord({ occurredAt: "2026-11-05T09:00:01.000Z" }), "connection-1");
  assert.equal(occurrenceConflict.status, "conflict");
  if (occurrenceConflict.status === "conflict") assert.equal(occurrenceConflict.reason, "occurred_at_conflict");
  assert.equal(occurrenceConflict.record.occurredAt, "2026-11-05T09:00:00.000Z");
});

test("ledger: the same request from a second scope is a separate line, not a replay", () => {
  const ledger = new UsageLedger(new DatabaseSync(":memory:"));
  assert.equal(ledger.record(usageRecord(), "connection-1").status, "inserted");
  assert.equal(ledger.record(usageRecord(), "connection-2").status, "inserted");
  assert.equal(ledger.count(), 2);
});

test("ledger read: a missing table is reported absent and is not created", () => {
  const db = new DatabaseSync(":memory:");
  const read = readUsageRecords(db, { taskId: "task-1" });
  assert.deepEqual(read, { present: false, records: [] });
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_records'").get();
  assert.equal(table, undefined);
});

test("ledger read: the statistics file reader never creates or migrates the ledger", (t) => {
  const { dir, store } = tempStore(t);
  const file = store.file;
  // A task store that has never recorded usage: the reader reports absence and
  // leaves sqlite_master untouched instead of running the ledger DDL.
  assert.deepEqual(readUsageRecordsFromFile(file, { taskId: "task-1" }), { present: false, records: [] });
  const probe = new DatabaseSync(file, { readOnly: true });
  const table = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_records'").get();
  probe.close();
  assert.equal(table, undefined, "a read must not add the usage_records table");

  // A database that does not exist yet is "not measured", not an error.
  assert.deepEqual(readUsageRecordsFromFile(path.join(dir, "absent.sqlite")), { present: false, records: [] });

  // Once a writer records a line, the same read-only path attributes it.
  const writerDb = new DatabaseSync(file);
  const writer = new UsageLedger(writerDb);
  assert.equal(writer.record(usageRecord(), "connection-1").status, "inserted");
  writerDb.close();
  const read = readUsageRecordsFromFile(file, { taskId: "task-1" });
  assert.equal(read.present, true);
  assert.equal(read.records.length, 1);
  const attribution = attributeTaskUsageFromLedger({ file, taskId: "task-1", attemptIds: [ATTEMPT_A] });
  assert.equal(attribution.attribution, "exact");
  assert.equal(attribution.coverage.records, 1);
});

test("ledger read: filters are half-open and ordered by occurrence", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new UsageLedger(db);
  ledger.record(usageRecord({ requestId: "req-a", occurredAt: "2026-11-05T09:00:00.000Z" }), "connection-1");
  ledger.record(usageRecord({ requestId: "req-b", occurredAt: "2026-11-05T10:00:00.000Z" }), "connection-1");
  const read = readUsageRecords(db, { from: "2026-11-05T09:00:00.000Z", to: "2026-11-05T10:00:00.000Z" });
  assert.equal(read.present, true);
  if (read.present) {
    assert.deepEqual(read.records.map(record => record.requestId), ["req-a"]);
  }
});

test("ledger: credential-shaped and path-shaped source scopes are refused by shape", () => {
  for (const scope of ["", "Bearer abc123", "sk-live-123", "C:\\secrets\\key.txt", "\\\\server\\share", "/etc/passwd", "tenant/secret"]) {
    assert.notEqual(usageSourceScopeProblem(scope), null, `scope ${JSON.stringify(scope)} must be refused`);
  }
  assert.equal(usageSourceScopeProblem("connection-1"), null);
  assert.equal(usageSourceScopeProblem("pool-3f2a1c"), null);
  const ledger = new UsageLedger(new DatabaseSync(":memory:"));
  assert.throws(() => ledger.record(usageRecord(), "Bearer abc123"));
});

// ------------------------------------------------------------ attribution --

test("attribution: fully bound reported rows are exact, and another client's rows stay out", () => {
  const own = storedUsage();
  const otherClient = storedUsage({ sourceKey: "connection-1\u0000req-9\u0000tokens", requestId: "req-9", taskId: "task-2", attemptId: ATTEMPT_B, value: 999 });
  const result = attributeTaskUsage({ taskId: "task-1", records: [own, otherClient], attemptIds: [ATTEMPT_A] });

  assert.equal(result.schemaVersion, USAGE_ATTRIBUTION_SCHEMA);
  assert.equal(result.attribution, "exact");
  assert.deepEqual(result.coverage, { records: 1, measuredRecords: 1, attemptBoundRecords: 1, ratio: 1 });
  assert.deepEqual(result.limitations, []);
  assert.equal(result.totals.length, 1);
  assert.equal(result.totals[0]?.amount, 100);
  assert.deepEqual(result.requestRefs.map(reference => reference.requestId), ["req-1"]);
  assert.equal(result.byRole.length, 4);
  assert.deepEqual(result.byRole.map(split => split.role), ["worker", "planner", "reviewer", "checker"]);
  assert.equal(result.byRole[0]?.records, 1);
  assert.equal(result.byRole[1]?.records, 0);
});

test("attribution: an unbound attempt or a missing retry parent downgrades to connection_only", () => {
  const unbound = attributeTaskUsage({
    taskId: "task-1",
    records: [storedUsage({ attemptId: null })],
    attemptIds: [ATTEMPT_A],
  });
  assert.equal(unbound.attribution, "connection_only");
  assert.deepEqual(unbound.limitations, ["attempt_binding_incomplete"]);

  const retried = attributeTaskUsage({
    taskId: "task-1",
    records: [storedUsage({ requestId: "req-2", retryOf: "req-missing", retryIndex: 1 })],
    attemptIds: [ATTEMPT_A],
  });
  assert.equal(retried.attribution, "connection_only");
  assert.deepEqual(retried.limitations, ["retry_parent_missing"]);

  const parentPresent = attributeTaskUsage({
    taskId: "task-1",
    records: [
      storedUsage({ requestId: "req-1" }),
      storedUsage({ requestId: "req-2", retryOf: "req-1", retryIndex: 1, sourceKey: "connection-1\u0000req-2\u0000tokens" }),
    ],
    attemptIds: [ATTEMPT_A],
  });
  // Both the failed request and its retry are measured lines; they are summed
  // as recorded and the retry count is visible per role, never double-counted
  // by re-walking the retry chain.
  assert.equal(parentPresent.attribution, "exact");
  assert.equal(parentPresent.totals[0]?.amount, 200);
  assert.equal(parentPresent.byRole[0]?.retryRecords, 1);
});

test("attribution: no measured row means unavailable, never zero cost", () => {
  const result = attributeTaskUsage({
    taskId: "task-1",
    records: [storedUsage({ valueKind: "unavailable", value: null })],
    attemptIds: [ATTEMPT_A],
  });
  assert.equal(result.attribution, "unavailable");
  assert.deepEqual(result.limitations, ["no_measured_amount"]);
  assert.equal(result.totals[0]?.amount, null);
  assert.equal(result.totals[0]?.unavailableRecords, 1);
  assert.equal(result.coverage.ratio, 0);
});

test("attribution: estimated and shared-pool rows are named in limitations", () => {
  const result = attributeTaskUsage({
    taskId: "task-1",
    records: [storedUsage({ valueKind: "estimated", scopeKind: "gateway_pool", limitations: ["shared_pool"] })],
    attemptIds: [ATTEMPT_A],
  });
  assert.equal(result.attribution, "connection_only");
  assert.deepEqual(result.limitations, ["shared_pool_scope", "usage_estimated"]);
});

test("attribution: tokens, credits and currency stay in separate groups", () => {
  const result = attributeTaskUsage({
    taskId: "task-1",
    records: [
      storedUsage(),
      storedUsage({ requestId: "req-c", unit: "credits", value: 2, sourceKey: "connection-1\u0000req-c\u0000credits" }),
      storedUsage({ requestId: "req-m", unit: "currency", currency: "CNY", value: 1.2345678, sourceKey: "connection-1\u0000req-m\u0000currency" }),
    ],
    attemptIds: [ATTEMPT_A],
  });
  assert.deepEqual(result.totals.map(group => [group.unit, group.currency, group.amount]), [
    ["tokens", null, 100],
    ["credits", null, 2],
    ["currency", "CNY", 1.234568],
  ]);
});

test("attribution: request references are bounded and the cut is named", () => {
  const records = Array.from({ length: 3 }, (_value, index) => storedUsage({
    requestId: `req-${index}`,
    sourceKey: `connection-1\u0000req-${index}\u0000tokens`,
  }));
  const result = attributeTaskUsage({ taskId: "task-1", records, attemptIds: [ATTEMPT_A], maxRefs: 2 });
  assert.equal(result.requestRefs.length, 2);
  assert.ok(result.limitations.includes("request_references_truncated"));
  assert.equal(result.coverage.records, 3);
});

// --------------------------------------------------------------- metrics --

test("metrics: timing, calls, acceptance, rework, recovery, interventions and usage", () => {
  const task = taskFixture({ state: "accepted", attemptId: ATTEMPT_A, attempt: 2, reviewedAt: "2026-11-05T10:10:00.000Z" });
  const events = [
    eventFixture(1, "attempt_queued", "2026-11-05T10:00:30.000Z"),
    eventFixture(2, "input_requested", "2026-11-05T10:01:00.000Z", { payload: { episodeId: "ep-1" } }),
    eventFixture(3, "input_resolved", "2026-11-05T10:02:00.000Z", { payload: { episodeId: "ep-1" } }),
    eventFixture(4, "rework_requested", "2026-11-05T10:02:30.000Z", { payload: { reason: "worker_content" } }),
    eventFixture(5, "tool_call_finished", "2026-11-05T10:03:00.000Z", { payload: { channel: "mcp", outcome: "succeeded", bytes: { stdout: 10, wire: 20 } } }),
    eventFixture(6, "tool_call_finished", "2026-11-05T10:03:10.000Z", { payload: { channel: "mcp", outcome: "succeeded", stdoutBytes: 5 } }),
    eventFixture(7, "tool_call_finished", "2026-11-05T10:03:20.000Z", { payload: { channel: "native", outcome: "failed", bytes: { combined: 100 } } }),
    eventFixture(8, "report_received", "2026-11-05T10:05:00.000Z"),
    eventFixture(9, "native_stop_confirmed", "2026-11-05T10:06:00.000Z"),
    eventFixture(10, "recovery_recorded", "2026-11-05T10:06:30.000Z", { payload: { taskId: "task-1" } }),
    eventFixture(11, "review_recorded", "2026-11-05T10:09:00.000Z"),
  ];
  const usage = attributeTaskUsage({
    taskId: "task-1",
    records: [storedUsage()],
    attemptIds: [ATTEMPT_A],
  });

  const summary = buildTaskMetricSummary({
    task,
    attempts: [attemptFixture()],
    events,
    reviews: [reviewFixture([{ checkId: "unit", status: "passed" }, { checkId: "sem", status: "passed" }])],
    contract: contractFixture(),
    usage,
  });

  assert.equal(summary.schemaVersion, TASK_METRICS_SCHEMA);
  assert.equal(summary.taskId, "task-1");
  assert.deepEqual(summary.timing, {
    wallElapsedSeconds: 600,
    queueSeconds: 30,
    inputWaitSeconds: 60,
    reportToStopSeconds: 60,
    stopToAcceptanceSeconds: 240,
    observationLagSeconds: 0,
  });
  assert.deepEqual(summary.calls.map(call => [call.channel, call.outcome, call.count, call.stdoutBytes, call.combinedBytes, call.wireBytes]), [
    ["mcp", "succeeded", 2, 15, null, 20],
    ["native", "failed", 1, null, 100, null],
  ]);
  assert.deepEqual(summary.acceptance, {
    reviewCount: 1,
    acceptedAt: "2026-11-05T10:10:00.000Z",
    requiredCheckTotal: 2,
    requiredCheckPassed: 2,
    requiredCheckUnknown: 0,
    requiredCheckCheckerError: 0,
  });
  assert.equal(summary.rework.rounds, 1);
  assert.deepEqual(summary.rework.reasons, ["worker_content"]);
  assert.deepEqual(summary.recovery, { events: 1, recoveredTasks: 1 });
  assert.deepEqual(summary.interventions, { episodes: 1, requested: 1, resolved: 1, rejected: 0, expired: 0 });
  assert.equal(summary.usage.tokens, 100);
  assert.equal(summary.usage.actualCredits, null);
  assert.equal(summary.usage.catalogRateLabel, null);
  assert.equal(summary.usage.activeReasoningSeconds, null);
  // This build records no catalogue rate label and no reasoning-time duration,
  // so the summary is deliberately not "complete" even when every other family
  // measured. A partial account must never read as a finished one.
  assert.equal(summary.complete, false);
  assert.ok(summary.limitations.includes("catalog_rate_label_unavailable"));
  assert.ok(summary.limitations.includes("active_reasoning_time_unavailable"));
});

test("metrics: out-of-order events and a late observation do not move occurrence times", () => {
  const task = taskFixture({ state: "failed", attemptId: ATTEMPT_A });
  const events = [
    eventFixture(1, "task_closed", "2026-11-05T10:20:00.000Z", { observedAt: "2026-11-05T11:00:00.000Z" }),
    eventFixture(2, "report_received", "2026-11-05T10:05:00.000Z"),
    eventFixture(3, "native_stop_confirmed", "2026-11-05T10:06:00.000Z", { observedAt: "2026-11-05T10:06:00.000Z" }),
    eventFixture(4, "task_state_changed", "2026-11-05T10:20:00.000Z", { observedAt: "2026-11-05T10:19:00.000Z" }),
  ];
  const summary = buildTaskMetricSummary({
    task,
    attempts: [],
    events,
    reviews: [],
    contract: null,
    usage: null,
  });

  assert.equal(summary.timing.wallElapsedSeconds, 1200);
  assert.equal(summary.timing.queueSeconds, null);
  assert.equal(summary.timing.reportToStopSeconds, 60);
  // The late write is observation lag; the skewing event is named, not used.
  assert.equal(summary.timing.observationLagSeconds, 2400);
  assert.ok(summary.limitations.includes("observation_time_skew"));
  assert.ok(summary.limitations.includes("event_time_invalid") === false);
  assert.equal(summary.usage.tokens, null);
  assert.ok(summary.limitations.includes("usage_ledger_absent"));
  assert.ok(summary.limitations.includes("required_checks_unavailable"));
});

test("metrics: a legacy task without an event stream reports null, not zero", () => {
  const summary = buildTaskMetricSummary({
    task: taskFixture({ state: "completed" }),
    attempts: [],
    events: [],
    reviews: [],
    contract: null,
    usage: null,
  });
  assert.equal(summary.timing.wallElapsedSeconds, null);
  assert.equal(summary.timing.inputWaitSeconds, null);
  assert.deepEqual(summary.calls, []);
  assert.deepEqual(summary.rework, { rounds: null, reasons: [], workerSelfCorrectionRounds: null });
  assert.deepEqual(summary.recovery, { events: null, recoveredTasks: null });
  assert.deepEqual(summary.interventions, { episodes: null, requested: null, resolved: null, rejected: null, expired: null });
  assert.equal(summary.complete, false);
  assert.ok(summary.limitations.includes("event_stream_absent"));
});

test("metrics: checker_error, failed and unrecorded required checks stay separate counters", () => {
  const task = taskFixture({ state: "needs_review", attemptId: ATTEMPT_A });
  const contract = contractFixture("task-1", [
    { id: "alpha", kind: "command" },
    { id: "beta", kind: "command" },
    { id: "gamma", kind: "semantic" },
  ]);
  const summary = buildTaskMetricSummary({
    task,
    attempts: [attemptFixture()],
    events: [eventFixture(1, "report_received", "2026-11-05T10:05:00.000Z")],
    reviews: [reviewFixture([{ checkId: "alpha", status: "passed" }, { checkId: "beta", status: "checker_error" }])],
    contract,
    usage: null,
  });

  assert.equal(summary.acceptance.requiredCheckTotal, 3);
  assert.equal(summary.acceptance.requiredCheckPassed, 1);
  assert.equal(summary.acceptance.requiredCheckCheckerError, 1);
  assert.equal(summary.acceptance.requiredCheckUnknown, 1);
  assert.ok(summary.limitations.includes("required_checks_partially_recorded"));
  assert.ok(!summary.limitations.includes("required_checks_failed"));
});

test("metrics: rework counts sent rounds by attempt, not event repeats", () => {
  const task = taskFixture({ state: "working", attemptId: ATTEMPT_B, attempt: 2 });
  const summary = buildTaskMetricSummary({
    task,
    attempts: [attemptFixture({ attempt: 1, attemptId: ATTEMPT_A }), attemptFixture({ attempt: 2, attemptId: ATTEMPT_B })],
    events: [
      eventFixture(1, "rework_requested", "2026-11-05T10:02:00.000Z", { attemptId: ATTEMPT_A, payload: { reason: "worker_scope" } }),
      eventFixture(2, "rework_requested", "2026-11-05T10:02:01.000Z", { attemptId: ATTEMPT_A, payload: { reason: "worker_scope" } }),
      eventFixture(3, "rework_requested", "2026-11-05T10:04:00.000Z", { attemptId: ATTEMPT_B, payload: { reason: "something_else" } }),
    ],
    reviews: [],
    contract: null,
    usage: null,
  });
  assert.equal(summary.rework.rounds, 2);
  assert.deepEqual(summary.rework.reasons, ["unknown", "worker_scope"]);
  assert.equal(summary.rework.workerSelfCorrectionRounds, null);
});

test("metrics: one intervention episode is not two events, and an unanswered one is named", () => {
  const task = taskFixture({ state: "blocked", attemptId: ATTEMPT_A });
  const answered = buildTaskMetricSummary({
    task,
    attempts: [attemptFixture()],
    events: [
      eventFixture(1, "input_requested", "2026-11-05T10:01:00.000Z", { payload: { episodeId: "ep-1" } }),
      eventFixture(2, "input_resolved", "2026-11-05T10:02:00.000Z", { payload: { episodeId: "ep-1", decision: "rejected" } }),
    ],
    reviews: [],
    contract: null,
    usage: null,
  });
  assert.deepEqual(answered.interventions, { episodes: 1, requested: 1, resolved: 1, rejected: 1, expired: 0 });

  const pending = buildTaskMetricSummary({
    task,
    attempts: [attemptFixture()],
    events: [eventFixture(1, "input_requested", "2026-11-05T10:01:00.000Z", { payload: { episodeId: "ep-2" } })],
    reviews: [],
    contract: null,
    usage: null,
  });
  assert.deepEqual(pending.interventions, { episodes: 1, requested: 1, resolved: 0, rejected: 0, expired: 0 });
  assert.ok(pending.limitations.includes("intervention_unresolved"));
});

// ------------------------------------------------------- statistics service --

test("statistics query: only from/to/limit are accepted, with UTC bounds", () => {
  const ok = parseStatisticsQuery("?from=2026-11-01T00:00:00.000Z&to=2026-11-30T00:00:00.000Z&limit=10");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.query.limit, 10);
    assert.equal(ok.query.window.from, "2026-11-01T00:00:00.000Z");
  }

  const reversed = parseStatisticsQuery("?from=2026-11-30T00:00:00.000Z&to=2026-11-01T00:00:00.000Z");
  assert.equal(reversed.ok, false);
  if (!reversed.ok) assert.equal(reversed.code, "invalid_window");

  const localTime = parseStatisticsQuery("?from=2026-11-01T00:00:00%2B08:00");
  assert.equal(localTime.ok, false);
  if (!localTime.ok) assert.equal(localTime.code, "invalid_window");

  const badLimit = parseStatisticsQuery("?limit=0");
  assert.equal(badLimit.ok, false);
  if (!badLimit.ok) assert.equal(badLimit.code, "invalid_limit");

  const unknown = parseStatisticsQuery("?window=all");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "invalid_query");
});

test("statistics read: one task summary is served from stored facts and writes nothing", (t) => {
  const { store } = tempStore(t);
  const task = store.createOrGet({
    taskId: "task-read",
    messageId: "msg-1",
    objective: "synthetic read-only task",
    state: "working",
    createdAt: "2026-11-05T10:00:00.000Z",
  }).task;
  store.appendTaskEvent({
    taskId: task.taskId, attemptId: null, type: "report_received",
    occurredAt: "2026-11-05T10:05:00.000Z", observedAt: "2026-11-05T10:05:00.000Z", actor: "workbuddy", payload: {}, sourceRef: "report-1",
  });
  const beforeRevision = store.get(task.taskId)!.revision;
  const beforeEvents = store.listTaskEvents(task.taskId, { limit: 200 }).events.length;

  const result = readTaskStatistics(statisticsSources(store), task.taskId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.metrics.schemaVersion, TASK_METRICS_SCHEMA);
  assert.equal(result.metrics.taskId, task.taskId);
  assert.equal(result.sources.events, beforeEvents);
  assert.equal(result.sources.eventsTruncated, false);
  assert.equal(result.attribution, null);
  assert.ok(result.metrics.limitations.includes("usage_ledger_absent"));

  assert.equal(store.get(task.taskId)!.revision, beforeRevision);
  assert.equal(store.listTaskEvents(task.taskId, { limit: 200 }).events.length, beforeEvents);
});

test("statistics read: unknown, malformed and contract-broken tasks stay distinct failures", (t) => {
  const { store } = tempStore(t);
  const missing = readTaskStatistics(statisticsSources(store), "no-such-task");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "task_not_found");

  const malformed = readTaskStatistics(statisticsSources(store), "task/../../etc/passwd");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.code, "invalid_task_id");

  const broken: StatisticsStore = {
    get: () => taskFixture({ taskId: "task-broken" }),
    listAttempts: () => [],
    listTaskEvents: () => ({ events: [], nextEventId: 0 }),
    getContract: () => ({ state: "integrity_failure", integrity: { problem: "shape", detail: "synthetic" } }),
    listTasksByCreatedCursor: () => ({ tasks: [], anchorFound: true }),
    reviews: { list: () => [] },
  };
  const intact = readTaskStatistics(statisticsSources(broken), "task-broken");
  assert.equal(intact.ok, false);
  if (!intact.ok) assert.equal(intact.code, "contract_integrity");
});

test("statistics read: a capped event page reports truncation instead of guessing", (t) => {
  const { store } = tempStore(t);
  const task = store.createOrGet({ taskId: "task-many", messageId: "msg-1", objective: "many events", state: "working", createdAt: "2026-11-05T10:00:00.000Z" }).task;
  for (let index = 0; index < 5; index += 1) {
    store.appendTaskEvent({
      taskId: task.taskId, attemptId: null, type: "task_updated",
      occurredAt: `2026-11-05T10:0${index}:00.000Z`, observedAt: `2026-11-05T10:0${index}:00.000Z`, actor: "gateway", payload: { index }, sourceRef: `event-${index}`,
    });
  }
  const result = readTaskStatistics(statisticsSources(store), task.taskId, { eventPageCap: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sources.eventsTruncated, true);
  assert.ok(result.metrics.limitations.includes("event_stream_truncated"));

  const full = readTaskStatistics(statisticsSources(store), task.taskId);
  assert.equal(full.ok, true);
  if (full.ok) {
    assert.equal(full.sources.eventsTruncated, false);
    assert.equal(full.sources.events, 6);
  }
});

test("statistics overview: window bounds, totals, attribution counts and explicit non-claims", (t) => {
  const { store } = tempStore(t);
  for (const [taskId, createdAt] of [["task-a", "2026-11-02T00:00:00.000Z"], ["task-b", "2026-11-03T00:00:00.000Z"], ["task-old", "2026-10-01T00:00:00.000Z"]] as const) {
    store.createOrGet({ taskId, messageId: `msg-${taskId}`, objective: `objective ${taskId}`, state: "accepted", createdAt });
  }
  const usageFor = (taskId: string) => taskId === "task-a"
    ? attributeTaskUsage({ taskId, records: [storedUsage({ taskId })], attemptIds: [ATTEMPT_A] })
    : null;
  const parsed = parseStatisticsQuery("?from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z&limit=10");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const overview = readStatisticsOverview(statisticsSources(store, usageFor), parsed.query);
  assert.equal(overview.ok, true);
  if (!overview.ok) return;

  assert.equal(overview.schemaVersion, STATISTICS_SCHEMA);
  assert.equal(overview.coverage.tasksRead, 3);
  assert.equal(overview.coverage.tasksIncluded, 2);
  assert.equal(overview.coverage.tasksExcludedOutsideWindow, 1);
  assert.equal(overview.rows.length, 2);
  assert.deepEqual(overview.rows.map(row => row.taskId), ["task-a", "task-b"]);
  assert.deepEqual(overview.totals.attribution, { exact: 1, connection_only: 0, unavailable: 1 });
  assert.deepEqual(overview.totals.usage.map(group => [group.unit, group.amount]), [["tokens", 100]]);
  // A state label alone is not an acceptance time: these synthetic tasks were
  // created already "accepted" but carry no reviewedAt, so the acceptance
  // counter stays 0 instead of reading the state as a finished review.
  assert.equal(overview.totals.acceptance.accepted, 0);
  assert.equal(overview.claims.savings, null);
  assert.equal(overview.claims.superiority, null);
  assert.ok(overview.limitations.includes("savings_not_measured"));
  assert.ok(overview.limitations.includes("superiority_not_measured"));
  assert.ok(overview.limitations.includes("usage_ledger_absent"));
});

test("statistics overview: without a ledger every task is attributed unavailable, never zero", (t) => {
  const { store } = tempStore(t);
  store.createOrGet({ taskId: "task-a", messageId: "msg-a", objective: "objective", state: "working", createdAt: "2026-11-02T00:00:00.000Z" });
  const parsed = parseStatisticsQuery("");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const overview = readStatisticsOverview(statisticsSources(store), parsed.query);
  assert.equal(overview.ok, true);
  if (!overview.ok) return;
  assert.deepEqual(overview.totals.attribution, { exact: 0, connection_only: 0, unavailable: 1 });
  assert.deepEqual(overview.totals.usage, []);
  assert.equal(overview.rows[0]?.usage.tokens, null);
});

// -------------------------------------------------------------- http routes --

test("statistics http: overview, detail, and path-shaped task ids map to exact statuses", (t) => {
  const { store } = tempStore(t);
  store.createOrGet({ taskId: "task-http", messageId: "msg-http", objective: "objective", state: "working", createdAt: "2026-11-05T10:00:00.000Z" });
  const sources: StatisticsSources = statisticsSources(store);

  const overview = handleStatisticsRequest(sources, "/workbench/v1/statistics", "?limit=5");
  assert.equal(overview?.status, 200);
  assert.equal((overview?.body as { schemaVersion?: string }).schemaVersion, STATISTICS_SCHEMA);

  const badLimit = handleStatisticsRequest(sources, "/workbench/v1/statistics", "?limit=500");
  assert.equal(badLimit?.status, 400);
  assert.equal((badLimit?.body as { error?: { code?: string } }).error?.code, "INVALID_LIMIT");

  const detail = handleStatisticsRequest(sources, "/workbench/v1/statistics/tasks/task-http", "");
  assert.equal(detail?.status, 200);

  const notFound = handleStatisticsRequest(sources, "/workbench/v1/statistics/tasks/missing-task", "");
  assert.equal(notFound?.status, 404);

  const traversal = handleStatisticsRequest(sources, "/workbench/v1/statistics/tasks/%2E%2E%2Fsecrets", "");
  assert.equal(traversal?.status, 400);
  assert.equal((traversal?.body as { error?: { code?: string } }).error?.code, "INVALID_TASK_ID");

  const unknownSubPath = handleStatisticsRequest(sources, "/workbench/v1/statistics/unknown", "");
  assert.equal(unknownSubPath?.status, 404);

  const otherPath = handleStatisticsRequest(sources, "/workbench/v1/tasks", "");
  assert.equal(otherPath, null);
  const otherPrefix = handleStatisticsRequest(sources, "/workbench/v1/statistics-extra", "");
  assert.equal(otherPrefix, null);
});

test("statistics http: a store failure is a 503, not an empty page", () => {
  const broken: StatisticsStore = {
    get: () => { throw new Error("synthetic store failure"); },
    listAttempts: () => [],
    listTaskEvents: () => ({ events: [], nextEventId: 0 }),
    getContract: () => ({ state: "absent" }),
    listTasksByCreatedCursor: () => { throw new Error("synthetic store failure"); },
    reviews: { list: () => [] },
  };
  const overview = handleStatisticsRequest(statisticsSources(broken), "/workbench/v1/statistics", "");
  assert.equal(overview?.status, 503);
  assert.equal((overview?.body as { error?: { code?: string } }).error?.code, "STORE_UNAVAILABLE");

  const detail = handleStatisticsRequest(statisticsSources(broken), "/workbench/v1/statistics/tasks/task-1", "");
  assert.equal(detail?.status, 503);
});
