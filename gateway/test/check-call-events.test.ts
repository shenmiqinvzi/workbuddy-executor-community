import test from "node:test";
import assert from "node:assert/strict";
import { reviewFixture } from "./support/review-fixture.js";
import { buildTaskMetricSummary } from "../src/task-metrics.js";
import type { StoredTaskEvent } from "../src/task-store.js";

/**
 * C04: the trusted producer for `local_check_finished`.
 *
 * `calls` was structurally always empty because nothing in the service ever
 * observed a check finishing. These tests pin the producer to facts the service
 * itself measured: a real bounded command, its real exit status, its real output
 * file sizes, and its real elapsed time. They also pin the two ways a naive
 * producer would lie: counting a check that never ran, and counting one executed
 * command once per verification pass.
 */
const calls = (store: { listTaskEvents(taskId: string): { events: StoredTaskEvent[] } }) =>
  store.listTaskEvents("task").events.filter(event => event.type === "local_check_finished");

test("C04 an executed independent command publishes one trusted local_check call", async t => {
  const f = await reviewFixture(t, "workbuddy", { command: true }); await f.finish();
  const run = await f.service.runReviewCommand({ ...f.op(), checkId: "test" });
  const events = calls(f.store);
  assert.equal(events.length, 1, "one executed command is one call fact");
  const [event] = events;
  assert.equal(event!.sourceRef, `review-call:command:${run.evidenceId}`);
  assert.equal(event!.payload.channel, "local_check");
  assert.equal(event!.payload.outcome, "succeeded");
  assert.equal(event!.payload.checkId, "test");
  assert.equal(event!.payload.kind, "command");
  assert.equal(event!.payload.checkStatus, "passed");
  assert.equal(typeof event!.payload.durationSeconds, "number");
  assert.ok((event!.payload.durationSeconds as number) >= 0);
  const bytes = event!.payload.bytes as { stdout?: number; stderr?: number };
  assert.equal(typeof bytes.stdout, "number");
  assert.ok((bytes.stdout as number) > 0, "the stdout layer is the real output file size, never invented");
  assert.ok(Date.parse(event!.observedAt) >= Date.parse(event!.occurredAt), "observation never precedes the check");
});

test("C04 a failed command is recorded as failed, not as an unknown or a pass", async t => {
  const f = await reviewFixture(t, "workbuddy", { command: true, commandExitCode: 7 }); await f.finish();
  const run = await f.service.runReviewCommand({ ...f.op(), checkId: "test" });
  assert.equal(run.status, "failed");
  const [event] = calls(f.store);
  assert.equal(event!.payload.outcome, "failed");
  assert.equal(event!.payload.checkStatus, "failed");
  assert.equal(event!.sourceRef, `review-call:command:${run.evidenceId}`);
});

test("C04 verification passes publish their own facts without re-counting the executed command", async t => {
  const f = await reviewFixture(t, "dsh", { command: true }); await f.finish();
  const run = await f.service.runReviewCommand({ ...f.op(), checkId: "test" });
  const first = f.checks(), afterFirst = calls(f.store).length;
  assert.equal(afterFirst, 1 + first.checks.length, "each evaluated check is one fact");
  const second = f.checks(), afterSecond = calls(f.store).length;
  assert.equal(afterSecond, afterFirst + second.checks.length);
  const events = calls(f.store);
  assert.equal(new Set(events.map(event => event.sourceRef)).size, afterSecond, "every fact has its own dedup key");
  const executed = events.filter(event => event.sourceRef === `review-call:command:${run.evidenceId}`);
  assert.equal(executed.length, 1, "two verification passes never duplicate one executed command");
  assert.equal(events.filter(event => event.payload.bytes !== undefined).length, 1, "only the executed command carries measured bytes");
});

test("C04 a check that never ran publishes no call at all", async t => {
  const f = await reviewFixture(t, "dsh", { semantic: true }); await f.finish();
  const batch = f.checks();
  assert.ok(batch.checks.every(check => check.kind !== "semantic"), "semantic checks are the reviewer's, not the program's");
  const before = calls(f.store).length;
  f.review(batch, "not_applicable");
  const after = calls(f.store);
  assert.equal(after.length, before);
  assert.equal(after.filter(event => event.payload.checkId === "behavior").length, 0, "not_applicable is not a successful call");
});

test("C04 the consumer sees non-empty calls with the measured byte layer", async t => {
  const f = await reviewFixture(t, "workbuddy", { command: true }); await f.finish();
  await f.service.runReviewCommand({ ...f.op(), checkId: "test" });
  f.checks();
  const metrics = buildTaskMetricSummary({
    task: f.current(), attempts: f.store.listAttempts("task"), events: f.store.listTaskEvents("task").events,
    reviews: f.store.reviews.list("task"), contract: null, usage: null,
  });
  const succeeded = metrics.calls.filter(call => call.channel === "local_check" && call.outcome === "succeeded");
  assert.equal(succeeded.length, 1);
  assert.ok(succeeded[0]!.count >= 3, "the executed command and the evaluated checks are all counted");
  assert.ok((succeeded[0]!.stdoutBytes ?? 0) > 0);
  assert.equal(metrics.calls.filter(call => call.outcome === "failed").length, 0);
});
