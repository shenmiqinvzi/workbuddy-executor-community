import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { parseStatisticsQuery, readStatisticsOverview } from "../src/statistics-service.js";
import {
  buildStatisticsExport,
  coverageOf,
  describeStatisticsExportContract,
  freshnessOf,
  STATISTICS_EXPORT_SCHEMA,
  usageCoverage,
} from "../src/statistics-contract.js";

const TASK_A = "6f1a0a3e-0000-4000-8000-0000000000aa";

function tempStore(t: test.TestContext): TaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c05-export-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function seed(store: TaskStore): void {
  store.createOrGet({
    taskId: TASK_A, messageId: "m-1", objective: "export the statistics", state: "running",
    createdAt: "2026-11-07T00:00:00.000Z",
  });
}

function overviewOf(store: TaskStore) {
  const parsed = parseStatisticsQuery("");
  assert.equal(parsed.ok, true);
  const overview = readStatisticsOverview({ store }, parsed.ok ? parsed.query : (null as never));
  assert.equal(overview.ok, true);
  return overview;
}

test("the export is versioned, read-only and states its window semantics", t => {
  const store = tempStore(t);
  seed(store);
  const exported = buildStatisticsExport(overviewOf(store), { generatedAt: new Date("2026-11-07T00:05:00.000Z") });

  assert.equal(exported.schemaVersion, STATISTICS_EXPORT_SCHEMA);
  assert.equal(exported.contractVersion, "statistics-export-contract-1");
  assert.equal(exported.readOnly, true);
  assert.equal(exported.snapshotOnly, true);
  assert.equal(exported.windowSemantics, "task_created_at_utc_start_inclusive_end_exclusive");
  assert.equal(exported.claims.savings, null);
  assert.equal(exported.claims.superiority, null);
  assert.ok(exported.consumerRules.some(rule => /never triggers a model request/.test(rule)));
});

test("a figure nobody counted is unknown with a reason, never 100%", t => {
  const store = tempStore(t);
  seed(store);
  const exported = buildStatisticsExport(overviewOf(store), { generatedAt: new Date("2026-11-07T00:05:00.000Z") });

  // No usage ledger exists in this fixture: requests cannot be a ratio of 1.
  assert.equal(exported.coverage.requests.status, "unknown");
  assert.equal(exported.coverage.requests.denominator, null);
  assert.equal(exported.coverage.requests.unknownReason, "upstream_does_not_publish_request_count");
  assert.equal(exported.coverage.tokens.status, "unknown");
  assert.equal(exported.coverage.amounts.status, "unknown");
  assert.equal(exported.coverage.tasks.status, "complete");
  assert.equal(exported.coverage.tasks.numerator, 1);
});

test("tasks without an event stream make event coverage partial, not complete", t => {
  const events = coverageOf(3, 5, "tasks_without_event_stream");
  assert.equal(events.status, "partial");
  assert.equal(events.numerator, 3);
  assert.equal(events.denominator, 5);
  assert.equal(events.unknownReason, "tasks_without_event_stream");
  assert.equal(coverageOf(0, 0, "nothing_read").status, "unknown");
  assert.equal(coverageOf(5, 5, "nothing_missing").status, "complete");
});

test("usage coverage keeps requests, tokens and amounts apart", () => {
  const usage = usageCoverage([
    { unit: "tokens", currency: null, records: 4, measuredRecords: 0, amount: null },
    { unit: "credits", currency: null, records: 2, measuredRecords: 0, amount: null },
  ]);
  assert.deepEqual([usage.requests.numerator, usage.requests.denominator, usage.requests.status], [2, null, "unknown"]);
  assert.equal(usage.tokens.numerator, 4);
  assert.equal(usage.tokens.status, "unknown");
  assert.equal(usage.amounts.numerator, 2);
  assert.equal(usage.amounts.unknownReason, "price_not_published");
});

test("freshness labels an old window stale instead of re-dating it", () => {
  const fresh = freshnessOf(new Date("2026-11-07T00:10:00.000Z"), "2026-11-07T00:05:00.000Z", 900);
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.ageSeconds, 300);
  const stale = freshnessOf(new Date("2026-11-07T02:00:00.000Z"), "2026-11-07T00:05:00.000Z", 900);
  assert.equal(stale.status, "stale");
  assert.equal(stale.reason, "window_older_than_max_age");
  const unknown = freshnessOf(new Date("2026-11-07T00:10:00.000Z"), null, 900);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.ageSeconds, null);
  assert.equal(unknown.reason, "window_end_unknown");
});

test("the export carries the source limitations instead of summarizing them away", t => {
  const store = tempStore(t);
  seed(store);
  const overview = overviewOf(store);
  const exported = buildStatisticsExport(overview, { generatedAt: new Date("2026-11-07T00:05:00.000Z") });
  assert.deepEqual(exported.limitations, [...overview.limitations]);
  assert.ok(exported.limitations.includes("usage_ledger_absent"));

  const contract = describeStatisticsExportContract();
  assert.deepEqual(contract.coverageKeys, ["tasks", "events", "requests", "tokens", "amounts"]);
  assert.ok(contract.neverZeroFilled.includes("tokens"));
  assert.equal(contract.freshness.defaultMaxAgeSeconds, 900);
});
