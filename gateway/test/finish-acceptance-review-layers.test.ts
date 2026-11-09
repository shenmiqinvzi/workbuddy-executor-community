/**
 * L08 acceptance — area 3: independent review layers.
 *
 * Every case builds the fact through the product's public surface (authenticated report + native stop),
 * then asserts the persisted state, not the wording of an error alone. The delivery line's own T6 tests
 * are not imported, copied or modified here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acceptanceFixture } from "./support/finish-acceptance-fixture.js";

test("L08 command semantics: a declared command is unknown until it is run, and unknown never accepts", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { command: true });
  await f.finish();
  const batch = f.checks();
  const command = batch.checks.find(check => check.checkId === "command")!;
  assert.equal(command.status, "unknown");
  assert.equal(batch.checks.find(check => check.checkId === "$provenance")!.status, "passed");
  const review = f.review(batch);
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "CHECKS_REQUIRED" });
  assert.equal(f.current().state, "needs_review");
  assert.equal(f.store().listTaskEvents("l08-task").events.filter(event => event.type === "task_closed").length, 0);

  const run = await f.service.runReviewCommand({ ...f.op(), checkId: "command" });
  assert.equal(run.status, "passed");
  assert.equal(run.exitCode, 0);
  const rerun = f.checks();
  assert.equal(rerun.checks.find(check => check.checkId === "command")!.status, "passed");
  const passingReview = f.review(rerun);
  const accepted = f.service.acceptReview({ ...f.op(), reviewId: passingReview.reviewId });
  assert.equal(accepted.task.state, "accepted");
  assert.equal(f.store().operations.isClosed(f.current()), true);
});

test("L08 a failing independent command is not worker content failure and never accepts", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { command: true, commandExitCode: 3 });
  await f.finish();
  const run = await f.service.runReviewCommand({ ...f.op(), checkId: "command" });
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 3);
  const before = f.current();
  const batch = f.checks();
  assert.equal(batch.checks.find(check => check.checkId === "command")!.status, "failed");
  const review = f.review(batch);
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "CHECKS_REQUIRED" });
  const after = f.current();
  assert.equal(after.state, before.state, "a checker outcome must not move the task to failed");
  assert.equal(after.attempt, before.attempt, "a checker outcome must not consume worker attempts");
  assert.equal(after.attemptId, before.attemptId);
});

test("L08 corrupted command evidence is checker_error, never failed, never accepted", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { command: true });
  await f.finish();
  const run = await f.service.runReviewCommand({ ...f.op(), checkId: "command" });
  assert.equal(run.status, "passed");
  const attemptId = f.current().attemptId!;
  const commandDir = path.join(f.runs, attemptId, "commands");
  const recordFile = fs.readdirSync(commandDir).filter(name => name.endsWith(".json")).map(name => path.join(commandDir, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]!;
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as { stdout: string; stderr: string };
  fs.rmSync(record.stdout);
  const batch = f.checks();
  const command = batch.checks.find(check => check.checkId === "command")!;
  assert.equal(command.status, "checker_error");
  assert.match(command.note, /no worker failure was inferred/i);
  const review = f.review(batch);
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "CHECKS_REQUIRED" });
  assert.equal(f.current().state, "needs_review");
});

test("L08 reviewId is immutable, single-use and bound to one attempt", async t => {
  const f = await acceptanceFixture(t, "dsh", { semantic: true });
  await f.finish();
  const first = f.review(f.checks(), "unknown");
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: first.reviewId }), { code: "CHECKS_REQUIRED" });
  const corrected = f.review(f.checks(), "passed", first.reviewId);
  const history = f.service.listReviews("l08-task");
  assert.equal(history.length, 2);
  assert.equal(history[1]!.supersedesReviewId, first.reviewId);
  assert.equal(history[1]!.correction, "reviewer_error");
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: first.reviewId }), { code: "REVIEW_STALE" });
  const accepted = f.service.acceptReview({ ...f.op(), reviewId: corrected.reviewId });
  assert.equal(accepted.task.state, "accepted");

  const db = new DatabaseSync(f.store().file);
  assert.throws(() => db.prepare("UPDATE task_review_records SET body='{}' WHERE id=?").run(corrected.reviewId), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM task_review_records WHERE id=?").run(corrected.reviewId), /immutable/);
  db.close();
});

test("L08 empty or unknown evidence can never be promoted to a passing review", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish();
  const batch = f.checks();
  assert.throws(() => f.service.review({ ...f.op(), machineCheckIds: [], semanticChecks: [], note: "L08 empty review" }), { code: "INVALID_REVIEW" });
  assert.throws(() => f.service.review({ ...f.op(), machineCheckIds: ["invented-batch"], semanticChecks: [], note: "L08 forged batch" }), { code: "REVIEW_EVIDENCE_UNKNOWN" });
  assert.throws(
    () => f.service.review({ ...f.op(), machineCheckIds: batch.machineCheckIds, semanticChecks: [{ checkId: "behavior", status: "passed", note: "self", evidenceRefs: ["worker-says-so"] }], note: "L08 forged evidence" }),
    { code: "REVIEW_EVIDENCE_UNKNOWN" },
  );
  assert.throws(() => f.service.review({ ...f.op(), machineCheckIds: batch.machineCheckIds, semanticChecks: [], note: "L08 actor override", actor: "program" }), { code: "INVALID_REVIEW" });
  assert.equal(f.current().state, "needs_review");
});

test("L08 a tampered baseline or workspace after review refuses acceptance", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish();
  const review = f.review();
  fs.writeFileSync(path.join(f.workspace, "NOTES.md"), "changed outside the allowed scope\n");
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }));
  assert.equal(f.current().state, "needs_review");
  assert.equal(f.store().operations.isClosed(f.current()), false);
});

test("L08 an earlier attempt's review and command record cannot prove a new attempt", async t => {
  const f = await acceptanceFixture(t, "dsh", { semantic: true, command: true });
  await f.finish();
  const firstRun = await f.service.runReviewCommand({ ...f.op(), checkId: "command" });
  assert.equal(firstRun.status, "passed");
  const firstReview = f.review();
  await f.service.continue({ taskId: "l08-task", feedback: "L08 synthetic content correction" });
  await f.finish();
  assert.equal(f.current().attempt, 2);
  const staleReview = f.service.listReviews("l08-task")[0]!;
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: staleReview.reviewId }), { code: "REVIEW_STALE" });
  const batch = f.checks();
  assert.equal(batch.checks.find(check => check.checkId === "command")!.status, "unknown", "an old attempt's command record is not new evidence");
  const recycled = f.review(batch);
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: recycled.reviewId }), { code: "CHECKS_REQUIRED" });
  const secondRun = await f.service.runReviewCommand({ ...f.op(), checkId: "command" });
  assert.equal(secondRun.status, "passed");
  const secondReview = f.review(f.checks());
  assert.equal(f.service.acceptReview({ ...f.op(), reviewId: secondReview.reviewId }).task.state, "accepted");
});

test("L08 acceptance is atomic: one closure, idempotent receipt, no second accept path", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish();
  const review = f.review();
  const input = { ...f.op(), reviewId: review.reviewId };
  const accepted = f.service.acceptReview(input);
  assert.equal(accepted.task.state, "accepted");
  assert.deepEqual(f.service.acceptReview(input), accepted);
  assert.equal(f.store().listTaskEvents("l08-task").events.filter(event => event.type === "task_closed").length, 1);
  assert.equal(f.store().operations.isClosed(f.current()), true);
  assert.throws(() => f.service.acceptReview({ ...input, operationId: "l08-second-accept" }));
  assert.throws(() => f.service.review({ ...f.op(), machineCheckIds: [], semanticChecks: [], note: "L08 post-close review" }), { code: "REVIEW_REQUIRED" });
  assert.equal(f.current().state, "accepted");
});

test("L08 a cancelled workflow cannot be reviewed, accepted or re-dispatched by an old review", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish();
  const review = f.review();
  await f.service.cancel("l08-task", "Synthetic user cancellation");
  assert.equal(f.current().state, "cancelled");
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "REVIEW_REQUIRED" });
  assert.equal(f.current().state, "cancelled");
  // F-CAP-2: the cancellation reconciles the stop it collected, so this cancelled
  // workflow is closed here — with its native stop proven — and its shared
  // capacity slot is free for the next task. The old reading (still open after a
  // confirmed stop) is exactly what left the slot occupied forever.
  assert.equal(f.store().operations.isClosed(f.current()), true);
});

test("F-CAP-2 a cancelled workflow without stop proof keeps its capacity slot", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish(false);
  await f.service.cancel("l08-task", "Synthetic user cancellation");
  assert.equal(f.current().state, "cancelled");
  assert.equal(f.store().operations.isClosed(f.current()), false);
});

test("L08 review refuses a fabricated authenticated report; the missing native stop is the reason", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish(false);
  assert.throws(() => f.checks(), { code: "STOP_UNCONFIRMED" });
  assert.equal(f.current().state, "needs_review");
  f.queue.observeNative(f.current().attemptId!, { state: "idle", workspace: f.workspace });
  await f.service.sync("l08-task");
  const batch = f.checks();
  assert.equal(batch.checks.find(check => check.checkId === "$provenance")!.status, "passed");
});

// F-REVIEW-1: the tools take three flat fields while the status view used to
// print the same values only nested, so a reviewer copying the view had to guess
// the flattening. Both spellings now carry one set of values.
test("F-REVIEW-1 the status view exposes the review reference flat and nested", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish();
  const task = f.current();
  const view = f.service.statusView(task);
  assert.equal(view.expectedRevision, task.revision);
  assert.equal(view.expectedAttemptId, task.attemptId);
  assert.deepEqual(view.reviewOperation, { operationId: null, expectedRevision: task.revision, expectedAttemptId: task.attemptId });
});

// F-CAP-3: a task that crossed its deadline is blocked, and a blocked attempt
// could never close, so one stall occupied the single dispatch slot forever.
test("F-CAP-3 a blocked attempt cancelled after its stop proof closes and frees its slot", async t => {
  const f = await acceptanceFixture(t, "workbuddy", { semantic: true });
  await f.finish();
  f.store().update("l08-task", { state: "blocked", blockingReason: "the task deadline passed", cancelNote: "synthetic user cancellation" });
  assert.equal(f.store().operations.isClosed(f.current()), false);
  await f.service.sync("l08-task");
  assert.equal(f.current().state, "cancelled");
  assert.equal(f.store().operations.isClosed(f.current()), true);
});

