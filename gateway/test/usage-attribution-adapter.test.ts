import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  UsageLedger,
  buildRequestObservationRows,
  recordRequestObservation,
  summarizeUnallocated,
  summarizeRequestCoverage,
  attributeTaskUsage,
  type RequestObservation,
  type UpstreamUsageRecord,
} from "../src/usage-attribution.js";

const TASK = "task-c03-attribution";
const ATTEMPT = "run-22222222-2222-2222-2222-222222222222";

function observation(overrides: Partial<RequestObservation> = {}): RequestObservation {
  return {
    requestId: "req-0001",
    taskId: TASK,
    attemptId: ATTEMPT,
    sessionId: "session-1",
    executorId: "dsh",
    runtimeSource: "dsh-harness",
    connectionId: "conn-1",
    providerId: "provider-1",
    modelId: "model-a",
    reasoningEffort: "high",
    role: "worker",
    occurredAt: "2026-11-07T01:00:00.000Z",
    observedAt: "2026-11-07T01:00:00.500Z",
    scopeKind: "unverified",
    ...overrides,
  };
}

test("rows are unavailable with a null amount, in both units, and never zero", () => {
  const rows = buildRequestObservationRows(observation(), new Date("2026-11-07T01:00:01.000Z"));
  assert.equal(rows.rejected.length, 0);
  assert.deepEqual(rows.records.map(row => [row.unit, row.valueKind, row.value]), [["tokens", "unavailable", null], ["credits", "unavailable", null]]);
  assert.deepEqual(rows.records[0].limitations, ["no_measured_amount", "task_attribution_inferred"]);
  assert.match(rows.records[0].method ?? "", /harness_does_not_report_usage/);
  assert.equal(rows.records[0].modelId, "model-a");
  assert.equal(rows.records[0].reasoningEffort, "high");
});

test("the same request and unit cannot be counted twice, and another role cannot rewrite it", () => {
  const ledger = new UsageLedger(new DatabaseSync(":memory:"), () => "2026-11-07T01:00:02.000Z");
  const first = recordRequestObservation(ledger, observation(), "conn-1");
  assert.equal(first.ok, true);
  assert.deepEqual(first.outcomes.map(outcome => outcome.status), ["inserted", "inserted"]);

  const duplicate = recordRequestObservation(ledger, observation(), "conn-1");
  assert.deepEqual(duplicate.outcomes.map(outcome => outcome.status), ["duplicate", "duplicate"]);

  // A second role for the same request does not create a second row: the first
  // observation keeps the row, so two roles can never double count a request.
  const otherRole = recordRequestObservation(ledger, observation({ role: "reviewer" }), "conn-1");
  assert.deepEqual(otherRole.outcomes.map(outcome => outcome.status), ["duplicate", "duplicate"]);
  assert.equal(ledger.count(), 2, "one request keeps one row per unit no matter how often it is replayed");
});

test("a retry is linked to its parent and flagged, not merged", () => {
  const ledger = new UsageLedger(new DatabaseSync(":memory:"));
  const rows = buildRequestObservationRows(observation({ requestId: "req-0002", retryOf: "req-0001", retryIndex: 1 }));
  assert.equal(rows.records[0].retryOf, "req-0001");
  assert.equal(rows.records[0].retryIndex, 1);
  assert.ok(rows.records[0].limitations.includes("request_retried"));

  const written = recordRequestObservation(ledger, observation({ requestId: "req-0002", retryOf: "req-0001", retryIndex: 1 }), "conn-1");
  assert.equal(written.ok, true);
  assert.equal(ledger.count(), 2);
});

test("a request with no attempt binding says so and stays out of task totals", () => {
  const rows = buildRequestObservationRows(observation({ attemptId: null, taskId: null }));
  assert.ok(rows.records[0].limitations.includes("attempt_binding_incomplete"));
  const summary = summarizeUnallocated(rows.records, TASK);
  assert.equal(summary.records, 2);
  assert.equal(summary.requests, 1, "two unit rows are still one request");
  assert.equal(summary.byReason.no_task, 2);
  assert.equal(summary.byReason.no_attempt, 2);
});

test("coverage keeps the denominator visible and an unknown denominator is never 100%", () => {
  const unknown = summarizeRequestCoverage({ observedRequests: 4, attributedRequests: 4 });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.ratio, null);
  assert.equal(unknown.totalRequests, null);
  assert.equal(unknown.unknownReason, "upstream_does_not_publish_request_count");

  const partial = summarizeRequestCoverage({ observedRequests: 4, attributedRequests: 3, totalRequests: 10 });
  assert.equal(partial.status, "partial");
  assert.equal(partial.ratio, 0.4);

  const complete = summarizeRequestCoverage({ observedRequests: 10, attributedRequests: 10, totalRequests: 10 });
  assert.equal(complete.status, "complete");
  assert.equal(complete.ratio, 1);

  const impossible = summarizeRequestCoverage({ observedRequests: 11, attributedRequests: 11, totalRequests: 10 });
  assert.equal(impossible.status, "unknown");
  assert.equal(impossible.ratio, null);
  assert.ok(impossible.limitations.includes("denominator_smaller_than_numerator"));
});

test("the ledger rows feed attributeTaskUsage without inventing a measured total", () => {
  const ledger = new UsageLedger(new DatabaseSync(":memory:"));
  recordRequestObservation(ledger, observation(), "conn-1");
  recordRequestObservation(ledger, observation({ requestId: "req-0003", role: "reviewer", taskId: "other-task" }), "conn-1");
  const records: UpstreamUsageRecord[] = [];
  for (const requestId of ["req-0001", "req-0003"]) {
    for (const unit of ["tokens", "credits"] as const) {
      records.push({
        requestId, retryOf: null, retryIndex: 0, occurredAt: "2026-11-07T01:00:00.000Z", observedAt: "2026-11-07T01:00:00.500Z",
        executorId: "dsh", runtimeSource: "dsh-harness", connectionId: "conn-1", providerId: "provider-1", modelId: "model-a",
        reasoningEffort: "high", sessionId: "session-1", taskId: requestId === "req-0001" ? TASK : "other-task",
        attemptId: ATTEMPT, role: requestId === "req-0001" ? "worker" : "reviewer", unit, currency: null,
        scopeKind: "unverified", scopeId: null, value: null, valueKind: "unavailable", method: "harness_does_not_report_usage",
        limitations: ["no_measured_amount", "task_attribution_inferred"],
      });
    }
  }
  const attribution = attributeTaskUsage({ taskId: TASK, records, attemptIds: [ATTEMPT] });
  assert.equal(attribution.attribution, "unavailable");
  assert.deepEqual(attribution.totals.map(group => [group.unit, group.amount, group.measuredRecords]), [["tokens", null, 0], ["credits", null, 0]],
    "an unmeasured request keeps a null amount per unit instead of a zero total");
  assert.equal(attribution.coverage.records, 2);
  assert.equal(attribution.coverage.measuredRecords, 0);
  assert.ok(attribution.limitations.includes("no_measured_amount"));
  assert.deepEqual(attribution.byRole.map(role => [role.role, role.records]), [["worker", 2], ["planner", 0], ["reviewer", 0], ["checker", 0]],
    "only the request that names this task is attributed, and the other task never leaks in");
});
