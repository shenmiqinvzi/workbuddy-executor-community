/**
 * Contract tests for the vNext TaskView types and the synthetic samples.
 *
 * These assert constraints the contract actually states, so a sample that
 * drifts away from the contract fails here rather than in the panel work that
 * follows. They deliberately avoid asserting each sample constant back.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_VIEW_ACTIONS,
  TASK_VIEW_CHECK_ACTORS,
  TASK_VIEW_CHECK_KINDS,
  TASK_VIEW_CHECK_STATUSES,
  TASK_VIEW_DISPLAY_STATES,
  TASK_VIEW_OFFERABLE_ACTIONS,
  type TaskView,
  type TaskViewCheckResult,
} from "../src/task-view.js";
import {
  TASK_VIEW_BOUNDARIES,
  TASK_VIEW_SAMPLES,
  samplesByDisplayState,
  type TaskViewSample,
} from "./fixtures/task-view-samples.js";

const allViews: TaskView[] = TASK_VIEW_SAMPLES.map(sample => sample.view);
const allChecks: TaskViewCheckResult[] = allViews.flatMap(view => view.checks);

/* ------------------------------------------------------------------ *
 * State coverage.
 * ------------------------------------------------------------------ */

test("the sample set covers every displayState the contract defines", () => {
  const covered = new Set(TASK_VIEW_SAMPLES.map(sample => sample.displayState));
  const missing = TASK_VIEW_DISPLAY_STATES.filter(state => !covered.has(state));
  assert.deepEqual(missing, [], `displayState not covered by any sample: ${missing.join(", ")}`);
  assert.equal(covered.size, TASK_VIEW_DISPLAY_STATES.length);
});

test("every sample declares a displayState that the contract defines", () => {
  for (const sample of TASK_VIEW_SAMPLES) {
    assert.ok(
      (TASK_VIEW_DISPLAY_STATES as readonly string[]).includes(sample.displayState),
      `sample ${sample.id} uses an undefined displayState ${sample.displayState}`,
    );
  }
});

test("every sample id is unique so a sample can be addressed on its own", () => {
  const ids = TASK_VIEW_SAMPLES.map(sample => sample.id);
  assert.equal(new Set(ids).size, ids.length);
});

/* ------------------------------------------------------------------ *
 * Required identity fields.
 * ------------------------------------------------------------------ */

test("every view carries the identity fields the contract requires", () => {
  for (const view of allViews) {
    assert.ok(view.taskId.trim(), "taskId must be present");
    assert.ok(view.revision.trim(), "revision must be present");
    assert.ok(view.title.trim(), "title must be present");
    assert.ok(view.workspace.id.trim(), "workspace.id must be present");
    assert.ok(view.workspace.displayName.trim(), "workspace.displayName must be present");
    assert.ok(view.attempt.id.trim(), "attempt.id must be present");
    assert.ok(view.attempt.number >= 1, "attempt.number must be a positive round");
    assert.ok(view.attempt.limit >= 1, "attempt.limit must be a positive limit");
  }
});

test("attempt.number never exceeds attempt.limit", () => {
  for (const view of allViews) {
    assert.ok(
      view.attempt.number <= view.attempt.limit,
      `task ${view.taskId} reports round ${view.attempt.number} above the limit ${view.attempt.limit}`,
    );
  }
});

test("a task id belongs to exactly one sample except the deliberate stale-revision pair", () => {
  const byTask = new Map<string, TaskViewSample[]>();
  for (const sample of TASK_VIEW_SAMPLES) {
    const list = byTask.get(sample.view.taskId) ?? [];
    list.push(sample);
    byTask.set(sample.view.taskId, list);
  }
  for (const [taskId, samples] of byTask) {
    if (samples.length === 1) continue;
    const stale = samples.filter(sample => sample.boundaries.includes("stale_revision"));
    assert.equal(samples.length, 2, `task ${taskId} has samples that are not the stale-revision pair`);
    assert.equal(stale.length, 1, `task ${taskId} repeats without marking the stale revision`);
  }
});

test("a stale revision sample names the revision that supersedes it", () => {
  for (const sample of TASK_VIEW_SAMPLES) {
    if (!sample.boundaries.includes("stale_revision")) continue;
    assert.ok(sample.supersededBy, `sample ${sample.id} is stale but names no superseding revision`);
    const successor = TASK_VIEW_SAMPLES.find(other => other.view.revision === sample.supersededBy);
    assert.ok(successor, `sample ${sample.id} points at a revision no sample carries`);
    assert.equal(successor!.view.taskId, sample.view.taskId, "the superseding revision must belong to the same task");
    assert.notEqual(successor!.view.revision, sample.view.revision, "a revision cannot supersede itself");
  }
});

test("a task revision is never reused across different tasks", () => {
  const owner = new Map<string, string>();
  for (const view of allViews) {
    const previous = owner.get(view.revision);
    assert.equal(previous, undefined, `revision ${view.revision} is shared by two tasks`);
    owner.set(view.revision, view.taskId);
  }
});

/* ------------------------------------------------------------------ *
 * Unknown values use null, never 0 or "NA".
 * ------------------------------------------------------------------ */

test("unknown numeric and text values are null, never zero or the string NA", () => {
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node !== "object") {
      const text = String(node);
      // "unknown" is a contract member in its own right (displayState, check
      // status). What must never appear is a stand-in for an absent value.
      if (text === "NA" || text === "N/A" || text === "undefined" || text === "null") {
        offenders.push(`${path} = ${text}`);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  };
  for (const view of allViews) walk(view, view.taskId);
  assert.deepEqual(offenders, [], `unknown values must be expressed as null: ${offenders.join(", ")}`);
});

test("unobserved artifact size and hash are null rather than zero or an empty string", () => {
  for (const artifact of allViews.flatMap(view => view.artifacts)) {
    if (artifact.bytes === null) assert.notEqual(artifact.sha256, "", "an unobserved artifact has no hash string");
    if (artifact.sha256 === null) assert.notEqual(artifact.bytes, 0, "an unobserved artifact must not report zero bytes");
  }
});

test("the expired sample keeps an unobserved artifact size and hash null", () => {
  const expired = samplesByDisplayState("expired");
  assert.equal(expired.length, 1);
  const artifact = expired[0]!.view.artifacts[0];
  assert.ok(artifact, "the expired sample must carry the late artifact");
  assert.equal(artifact.bytes, null);
  assert.equal(artifact.sha256, null);
});

test("wall elapsed is derived only when both end facts exist", () => {
  const metrics = allViews.map(view => view.metrics).filter(metric => metric !== null);
  assert.ok(metrics.length > 0, "the samples must exercise the metrics block");
  for (const metric of metrics) {
    const view = allViews.find(candidate => candidate.metrics === metric)!;
    if (view.timing.closedAt === null) {
      assert.equal(metric.timing.wallElapsedSeconds, null, "an unclosed task has no wall elapsed value");
      continue;
    }
    const derived = (Date.parse(view.timing.closedAt) - Date.parse(view.timing.createdAt)) / 1000;
    assert.equal(
      metric.timing.wallElapsedSeconds,
      derived,
      `task ${view.taskId} reports wall elapsed ${metric.timing.wallElapsedSeconds} but closedAt-createdAt is ${derived}`,
    );
  }
});

test("cost measurements stay null while no real metering exists", () => {
  const metrics = allViews.map(view => view.metrics).filter(metric => metric !== null);
  for (const metric of metrics) {
    assert.equal(metric.usage.actualCredits, null, "actual credits stay null while no measurement exists");
    assert.equal(metric.usage.tokens, null);
    assert.equal(metric.usage.activeReasoningSeconds, null);
  }
});

test("a free catalogue label never turns into a measured zero cost", () => {
  const labelled = allViews
    .map(view => view.metrics)
    .filter((metric): metric is NonNullable<typeof metric> => metric !== null && metric.usage.catalogRateLabel !== null);
  assert.ok(labelled.length > 0, "the samples must exercise the catalogue rate label");
  for (const metric of labelled) {
    assert.equal(metric.usage.actualCredits, null, "a free label does not mean the workflow cost zero");
  }
});

/* ------------------------------------------------------------------ *
 * Enum discipline.
 * ------------------------------------------------------------------ */

test("allowed actions only use contract members and never offer submit in a view", () => {
  for (const view of allViews) {
    for (const action of view.allowedActions) {
      assert.ok(
        (TASK_VIEW_ACTIONS as readonly string[]).includes(action),
        `task ${view.taskId} offers unknown action ${action}`,
      );
      assert.notEqual(action, "submit", "submit is decided by health/capacity and must not appear in a view");
      assert.ok(
        (TASK_VIEW_OFFERABLE_ACTIONS as readonly string[]).includes(action),
        `task ${view.taskId} offers ${action} which the view must not carry`,
      );
    }
  }
});

test("every check uses contract kinds, statuses and actors", () => {
  for (const check of allChecks) {
    assert.ok((TASK_VIEW_CHECK_KINDS as readonly string[]).includes(check.kind), `unknown check kind ${check.kind}`);
    assert.ok(
      (TASK_VIEW_CHECK_STATUSES as readonly string[]).includes(check.status),
      `unknown check status ${check.status}`,
    );
    assert.ok(
      (TASK_VIEW_CHECK_ACTORS as readonly string[]).includes(check.actor),
      `unknown check actor ${check.actor}`,
    );
  }
});

test("a check belongs to the attempt of the view that carries it", () => {
  for (const view of allViews) {
    for (const check of view.checks) {
      assert.equal(check.attemptId, view.attempt.id, `check ${check.checkId} references another attempt`);
    }
  }
});

test("a scope check declares the coverage it observed", () => {
  for (const check of allChecks) {
    if (check.kind !== "scope") continue;
    assert.equal(check.coverage, "workspace_inventory", `scope check ${check.checkId} must state its coverage`);
  }
});

test("an accepted task has only passed among its required checks", () => {
  // The contract requires the required checks to pass. It does not say that
  // every check a view happens to carry is required, so the samples declare
  // which check ids the agreement requires and only those are judged.
  // not_applicable is deliberately not accepted here: contract section 5
  // allows it only for a pre-declared non-required item, so it can never
  // stand in for a required check.
  const accepted = samplesByDisplayState("accepted");
  assert.ok(accepted.length > 0, "the accepted state needs a sample");
  for (const sample of accepted) {
    const required = sample.scenario?.requiredCheckIds;
    assert.ok(required?.length, `accepted sample ${sample.id} must declare its required checks`);
    const byId = new Map(sample.view.checks.map(check => [check.checkId, check]));
    for (const checkId of required!) {
      const check = byId.get(checkId);
      assert.ok(check, `accepted sample ${sample.id} is missing required check ${checkId}`);
      assert.equal(
        check!.status,
        "passed",
        `accepted task ${sample.view.taskId} has a required check that is ${check!.status}`,
      );
    }
  }
});

test("a required check is never left unknown or checker_error on an accepted task", () => {
  for (const sample of samplesByDisplayState("accepted")) {
    const required = new Set(sample.scenario?.requiredCheckIds ?? []);
    const observed = new Set(sample.view.checks.map(check => check.checkId));
    for (const checkId of required) {
      assert.ok(observed.has(checkId), `accepted sample ${sample.id} never observed required check ${checkId}`);
    }
  }
});

test("not_applicable is never used for a required check", () => {
  // Contract section 5: not_applicable only applies to an item the agreement
  // declared as non-required in advance.
  for (const sample of TASK_VIEW_SAMPLES) {
    const required = new Set(sample.scenario?.requiredCheckIds ?? []);
    for (const check of sample.view.checks) {
      if (check.status !== "not_applicable") continue;
      assert.ok(
        !required.has(check.checkId),
        `sample ${sample.id} marks the required check ${check.checkId} as not_applicable`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Display ordering rules from contract section 3.
 * ------------------------------------------------------------------ */

test("a terminal decision without stop proof is displayed as waiting_stop", () => {
  for (const view of allViews) {
    const hasTerminalDecision = view.timing.terminalDecisionAt !== null;
    if (!hasTerminalDecision) continue;
    if (view.remoteStopped) continue;
    assert.equal(
      view.displayState,
      "waiting_stop",
      `task ${view.taskId} decided ${view.businessState} without stop proof but shows ${view.displayState}`,
    );
  }
});

test("a terminal decision with a confirmed stop shows a terminal display state", () => {
  // The contract lists expired, cancelled and failed as the terminal displays.
  // Which one applies is a property of the task agreement and the decision
  // record, not of the timestamps: two equal instants do not prove the cause.
  // The samples therefore declare the cause themselves and this test only
  // checks that a decided and stopped task is not shown as a live state.
  for (const view of allViews) {
    if (!view.remoteStopped) continue;
    if (view.timing.terminalDecisionAt === null) continue;
    assert.ok(
      ["expired", "cancelled", "failed", "accepted"].includes(view.displayState),
      `task ${view.taskId} decided and stopped but shows ${view.displayState}`,
    );
  }
});

test("a sample that declares a terminal cause shows the matching terminal display", () => {
  const expected: Record<string, TaskView["displayState"]> = {
    deadline: "expired",
    cancellation: "cancelled",
    failure: "failed",
  };
  const declared = TASK_VIEW_SAMPLES.filter(sample => sample.scenario?.terminalCause);
  assert.ok(declared.length > 0, "the samples must declare their terminal causes explicitly");
  for (const sample of declared) {
    const cause = sample.scenario!.terminalCause!;
    assert.ok(
      sample.view.timing.terminalDecisionAt !== null,
      `sample ${sample.id} declares a ${cause} cause without a terminal decision time`,
    );
    if (!sample.view.remoteStopped) {
      // The decision exists but the stop proof does not, so the contract keeps
      // the task in waiting_stop regardless of which cause produced it.
      assert.equal(
        sample.view.displayState,
        "waiting_stop",
        `sample ${sample.id} decided ${cause} without stop proof but shows ${sample.view.displayState}`,
      );
    } else {
      assert.equal(
        sample.view.displayState,
        expected[cause],
        `sample ${sample.id} declares a ${cause} cause with a confirmed stop but shows ${sample.view.displayState}`,
      );
    }
  }
});

test("the expired sample records its deadline decision before the late report", () => {
  const expired = TASK_VIEW_SAMPLES.find(sample => sample.boundaries.includes("late_report"));
  assert.ok(expired, "the late-report boundary needs a sample");
  const scenario = expired!.scenario;
  assert.ok(scenario, "the late-report sample must describe its events");
  assert.equal(scenario!.terminalCause, "deadline");
  assert.ok(scenario!.reportEventAt, "the late-report sample must record when the report event happened");
  assert.ok(
    scenario!.reportEventAt! > expired!.view.timing.terminalDecisionAt!,
    "the late report must be observed after the terminal decision",
  );
  assert.ok(
    expired!.view.timing.lastObservedAt >= scenario!.reportEventAt!,
    "the last observation must not precede the late report it claims to have seen",
  );
});

test("an accepted task keeps a confirmed stop and an acceptance timestamp", () => {
  for (const sample of samplesByDisplayState("accepted")) {
    assert.equal(sample.view.remoteStopped, true, "acceptance requires a confirmed native stop");
    assert.ok(sample.view.timing.reviewedAt, "acceptance must record the review time");
    assert.ok(sample.view.timing.closedAt, "a closed task must record the close time");
  }
});

test("accept is offered only when the current attempt has a recorded review", () => {
  // The contract requires accept to reference a reviewId of the current
  // agreement and current source. Without a recorded review for the current
  // attempt there is no reviewId to reference, so accept cannot be offered.
  for (const sample of TASK_VIEW_SAMPLES) {
    const reviewCount = sample.view.metrics?.acceptance.reviewCount;
    const hasCurrentReview = reviewCount !== null && reviewCount !== undefined && reviewCount > 0;
    if (!hasCurrentReview) {
      assert.ok(
        !sample.view.allowedActions.includes("accept"),
        `sample ${sample.id} offers accept without a recorded review (reviewCount=${String(reviewCount)})`,
      );
    }
  }
});

test("a view that offers accept names a review recorded for its own attempt", () => {
  const offering = TASK_VIEW_SAMPLES.filter(sample => sample.view.allowedActions.includes("accept"));
  assert.ok(offering.length > 0, "the accept action needs a sample that can offer it");
  for (const sample of offering) {
    const recorded = sample.scenario?.reviewRecordedAt;
    assert.ok(recorded, `sample ${sample.id} offers accept without a recorded review event`);
    if (sample.view.timing.nativeStoppedAt !== null) {
      assert.ok(
        recorded! >= sample.view.timing.nativeStoppedAt,
        `sample ${sample.id} records the review before the native stop it depends on`,
      );
    }
    // A task that has not been accepted yet has no acceptance timestamp; the
    // review it cites must still exist when accept becomes possible.
    if (sample.view.timing.reviewedAt !== null) {
      assert.ok(
        recorded! <= sample.view.timing.reviewedAt!,
        `sample ${sample.id} records the review after the acceptance that cites it`,
      );
    }
  }
});

test("a review the accept action cites belongs to the view's own attempt", () => {
  // The contract requires accept to reference a reviewId that belongs to the
  // current agreement and the current attempt. The reviewId and the attempt
  // it was recorded against are sample facts, not TaskView fields, so the
  // test checks them against the attempt the view carries.
  const offering = TASK_VIEW_SAMPLES.filter(sample => sample.view.allowedActions.includes("accept"));
  assert.ok(offering.length > 0, "the accept action needs a sample that can offer it");
  for (const sample of offering) {
    const reviewId = sample.scenario?.reviewId;
    const reviewAttemptId = sample.scenario?.reviewAttemptId;
    assert.ok(reviewId, `sample ${sample.id} offers accept without a reviewId`);
    assert.ok(reviewAttemptId, `sample ${sample.id} offers accept without naming the attempt the review belongs to`);
    assert.equal(
      reviewAttemptId,
      sample.view.attempt.id,
      `sample ${sample.id} cites a review recorded against another attempt`,
    );
    const checks = sample.view.checks.filter(check => check.attemptId === reviewAttemptId);
    assert.ok(
      checks.length > 0,
      `sample ${sample.id} cites a review for an attempt that carries no check`,
    );
  }
});

test("a view that offers accept has already observed the review it cites", () => {
  // A view cannot offer an action that depends on a fact it has not observed
  // yet. The cited review must therefore already be covered by the view's
  // last observation.
  const offering = TASK_VIEW_SAMPLES.filter(sample => sample.view.allowedActions.includes("accept"));
  assert.ok(offering.length > 0, "the accept action needs a sample that can offer it");
  for (const sample of offering) {
    const recorded = sample.scenario?.reviewRecordedAt;
    assert.ok(recorded, `sample ${sample.id} offers accept without a recorded review event`);
    assert.ok(
      recorded! <= sample.view.timing.lastObservedAt,
      `sample ${sample.id} offers accept for a review recorded after its last observation`,
    );
  }
});

test("a stale revision differs from the revision that supersedes it", () => {
  // The stale revision is refused by the server when it re-verifies
  // expectedRevision. There is no runtime service in this stage, so the
  // contract level fact that can be checked here is only that the two
  // revisions are different and belong to the same task.
  const stale = TASK_VIEW_SAMPLES.filter(sample => sample.boundaries.includes("stale_revision"));
  assert.ok(stale.length > 0, "the stale-revision boundary needs a sample");
  for (const sample of stale) {
    assert.ok(sample.supersededBy, `sample ${sample.id} is stale but names no superseding revision`);
    assert.notEqual(
      sample.view.revision,
      sample.supersededBy,
      `sample ${sample.id} cannot be stale against its own revision`,
    );
    const successor = TASK_VIEW_SAMPLES.find(other => other.view.revision === sample.supersededBy);
    assert.ok(successor, `sample ${sample.id} points at a revision no sample carries`);
    assert.equal(
      successor!.view.taskId,
      sample.view.taskId,
      "the stale revision and its successor must belong to the same task",
    );
  }
});

test("a view never observes a stop before the moment it claims to have stopped", () => {
  // Only views that carry a stop timestamp can be compared. Contract section
  // 6 allows a confirmed stop whose exact time is not recoverable, in which
  // case nativeStoppedAt is null and there is nothing to order against.
  for (const sample of TASK_VIEW_SAMPLES) {
    const view = sample.view;
    if (view.timing.nativeStoppedAt === null) continue;
    assert.ok(
      view.timing.lastObservedAt >= view.timing.nativeStoppedAt,
      `sample ${sample.id} last observed at ${view.timing.lastObservedAt} before the stop at ${view.timing.nativeStoppedAt}`,
    );
  }
});

test("a confirmed stop may have no recoverable stop timestamp", () => {
  // Contract section 6: "旧证据缺少可靠时间则为 null". The stop evidence can
  // be trusted while the exact instant is unknown, so the view keeps
  // remoteStopped true and leaves nativeStoppedAt null.
  const withUnknownStopTime = TASK_VIEW_SAMPLES.filter(
    sample => sample.view.remoteStopped && sample.view.timing.nativeStoppedAt === null,
  );
  assert.ok(
    withUnknownStopTime.length > 0,
    "a sample must cover a confirmed stop whose exact time is unknown",
  );
  for (const sample of withUnknownStopTime) {
    assert.ok(
      sample.view.timing.lastObservedAt !== null,
      `sample ${sample.id} must still carry a last observation time`,
    );
  }
});

test("a confirmed stop with a known timestamp is compared against the observation", () => {
  for (const sample of TASK_VIEW_SAMPLES) {
    if (!sample.view.remoteStopped) continue;
    if (sample.view.timing.nativeStoppedAt === null) continue;
    assert.ok(
      sample.view.timing.lastObservedAt >= sample.view.timing.nativeStoppedAt,
      `sample ${sample.id} last observed before the stop it reports`,
    );
  }
});

test("a report that arrived before the native stop cannot offer acceptance", () => {
  const reportFirst = TASK_VIEW_SAMPLES.filter(sample => sample.boundaries.includes("report_before_native_stop"));
  assert.ok(reportFirst.length > 0, "the report-before-stop boundary needs a sample");
  for (const sample of reportFirst) {
    assert.equal(sample.view.remoteStopped, false, "the native stop must still be unproven");
    assert.equal(sample.view.displayState, "waiting_stop");
    assert.ok(
      !sample.view.allowedActions.includes("accept"),
      "acceptance must be refused while the native stop is unproven",
    );
    assert.ok(
      !sample.view.allowedActions.includes("rework"),
      "rework must be refused while the native stop is unproven",
    );
  }
});

test("a report that arrived with an unproven stop is shown as waiting_stop", () => {
  // Contract section 3 rule 4: "报告已到但未停止：waiting_stop". This holds
  // for the old snapshot as well, which already had the report but had not
  // observed the native stop.
  for (const sample of TASK_VIEW_SAMPLES) {
    if (sample.scenario?.reportEventAt === undefined) continue;
    if (sample.view.remoteStopped) continue;
    assert.equal(
      sample.view.displayState,
      "waiting_stop",
      `sample ${sample.id} has a report without a proven stop but shows ${sample.view.displayState}`,
    );
  }
});

test("the old snapshot of a reported task is still waiting_stop", () => {
  const stale = TASK_VIEW_SAMPLES.filter(sample => sample.boundaries.includes("stale_revision"));
  assert.ok(stale.length > 0, "the stale-revision boundary needs a sample");
  for (const sample of stale) {
    assert.equal(
      sample.view.displayState,
      "waiting_stop",
      `the old snapshot of ${sample.view.taskId} must show waiting_stop, not ${sample.view.displayState}`,
    );
    assert.equal(sample.view.remoteStopped, false, "the old snapshot had not observed the native stop");
    assert.equal(
      sample.view.businessState,
      "needs_review",
      "the old snapshot still carries the business fact that a report had arrived",
    );
  }
});

test("a cancelled task without a confirmed stop offers no rework", () => {
  for (const sample of TASK_VIEW_SAMPLES.filter(s => s.boundaries.includes("cancel_stop_unconfirmed"))) {
    assert.equal(sample.view.displayState, "waiting_stop");
    assert.equal(sample.view.remoteStopped, false);
    assert.ok(!sample.view.allowedActions.includes("rework"), "a cancelled task cannot be reworked");
    assert.ok(!sample.view.allowedActions.includes("accept"), "a cancelled task cannot be accepted");
  }
});

test("an expired task offers no rework and no acceptance", () => {
  for (const sample of samplesByDisplayState("expired")) {
    assert.ok(!sample.view.allowedActions.includes("rework"), "an expired task offers no continuation");
    assert.ok(!sample.view.allowedActions.includes("accept"), "a late report on an expired task cannot be accepted");
    assert.ok(sample.view.timing.terminalDecisionAt, "expiry needs the deadline decision time");
  }
});

test("a waiting_input view routes the user to the native UI and offers no rework or accept", () => {
  for (const sample of samplesByDisplayState("waiting_input")) {
    assert.ok(sample.view.blocker, "waiting_input needs a blocker describing where to act");
    assert.equal(sample.view.blocker!.resolutionChannel, "native_ui");
    assert.equal(sample.view.blocker!.canRespondViaGateway, false);
    assert.ok(!sample.view.allowedActions.includes("rework"));
    assert.ok(!sample.view.allowedActions.includes("accept"));
  }
});

test("an unknown display state keeps the exclusive capacity and offers no destructive action", () => {
  for (const sample of samplesByDisplayState("unknown")) {
    assert.equal(sample.view.remoteStopped, false);
    assert.ok(!sample.view.allowedActions.includes("cancel"), "an unobserved task must not offer a destructive action");
  }
});

test("a needs_review task keeps the review action available", () => {
  for (const sample of samplesByDisplayState("needs_review")) {
    assert.ok(sample.view.allowedActions.includes("review"), "needs_review must offer the review action");
  }
});

test("an independent semantic check is not claimed before the review stage", () => {
  // A semantic check is the reviewer's own work. On a task that is still
  // waiting for its review, no semantic result may already be on file.
  for (const sample of TASK_VIEW_SAMPLES) {
    if (sample.view.displayState !== "needs_review") continue;
    if (sample.scenario?.reviewRecordedAt) continue;
    const semantic = sample.view.checks.filter(check => check.kind === "semantic");
    for (const check of semantic) {
      assert.notEqual(
        check.status,
        "passed",
        `sample ${sample.id} claims a passed semantic check before any review was recorded`,
      );
      assert.deepEqual(
        check.evidenceRefs,
        [],
        `sample ${sample.id} attaches evidence to a semantic check that was never performed`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Boundary coverage.
 * ------------------------------------------------------------------ */

test("every boundary the contract asks for is exercised by at least one sample", () => {
  const covered = new Set(TASK_VIEW_SAMPLES.flatMap(sample => sample.boundaries));
  const missing = TASK_VIEW_BOUNDARIES.filter(boundary => !covered.has(boundary));
  assert.deepEqual(missing, [], `boundary not covered by any sample: ${missing.join(", ")}`);
});

test("a sample only declares boundaries it actually exhibits", () => {
  const permission = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("permission_details_unknown"));
  assert.ok(permission, "the permission-details boundary needs a sample");
  const blocker = permission!.view.blocker;
  assert.ok(blocker, "the permission-details sample needs a blocker");
  assert.equal(blocker!.detailsStatus, "unavailable");
  assert.equal(blocker!.toolName, null);
  assert.equal(blocker!.commandSummary, null);
  assert.equal(blocker!.targetPath, null);

  const exhausted = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("attempt_limit_exhausted"));
  assert.ok(exhausted, "the attempt-limit boundary needs a sample");
  assert.equal(exhausted!.view.attempt.number, exhausted!.view.attempt.limit, "the exhausted round must sit at the limit");
  assert.ok(!exhausted!.view.allowedActions.includes("rework"), "no fourth dispatch may be offered");

  const checkerError = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("checker_error"));
  assert.ok(checkerError, "the checker-error boundary needs a sample");
  const errored = checkerError!.view.checks.filter(check => check.status === "checker_error");
  assert.equal(errored.length, 1, "the checker-error sample must keep the original checker_error result");
  assert.ok(
    !errored.some(check => check.actor === "worker"),
    "a checker error must not be recorded as a worker failure",
  );

  const scope = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("scope_violation"));
  assert.ok(scope, "the scope-violation boundary needs a sample");
  assert.ok(
    scope!.view.changes.some(change => change.category === "unauthorized"),
    "a scope violation must be visible as an unauthorized change",
  );

  const userChange = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("pre_existing_user_change"));
  assert.ok(userChange, "the pre-existing-user-change boundary needs a sample");
  assert.ok(
    userChange!.view.changes.some(change => change.status === "attribution_unresolved"),
    "the user change must stay visible as an unresolved attribution, not be swallowed",
  );
  assert.ok(
    !userChange!.view.changes.some(change => change.category === "unauthorized"),
    "a change that cannot be attributed to this round must not be classified as an unauthorized delta",
  );
  assert.ok(
    userChange!.view.changes.every(change => change.path === "src/example-module.ts"),
    "the conflicting change must sit on the same delivered file, not on a separate path",
  );
  assert.ok(
    userChange!.view.checks.some(check => check.kind === "scope" && check.status === "unknown"),
    "an unresolved attribution is an unknown scope result, not a failed one",
  );

  const disconnected = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("disconnected"));
  assert.ok(disconnected, "the disconnect boundary needs a sample");
  assert.equal(disconnected!.view.displayState, "unknown");
  assert.equal(disconnected!.view.binding.sessionId, null, "a lost native session identity is null, not a placeholder");

  const late = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("late_report"));
  assert.ok(late, "the late-report boundary needs a sample");
  assert.equal(late!.view.displayState, "expired");
  assert.ok(late!.view.timing.terminalDecisionAt, "the deadline decision precedes the late report");
  assert.ok(
    late!.view.timing.lastObservedAt > late!.view.timing.terminalDecisionAt!,
    "the late report is observed after the terminal decision",
  );

  const costUnknown = TASK_VIEW_SAMPLES.find(s => s.boundaries.includes("cost_unknown"));
  assert.ok(costUnknown, "the unknown-cost boundary needs a sample");
  assert.equal(costUnknown!.view.metrics!.usage.actualCredits, null);
});

/* ------------------------------------------------------------------ *
 * Synthetic-data hygiene.
 * ------------------------------------------------------------------ */

test("no sample leaks a real absolute path, account or native session log", () => {
  const forbidden = [
    /[A-Za-z]:[\\/]/,            // any drive-letter absolute path
    /Users[\\/]/,               // POSIX home directory
    /\\Users\\/,
    /sk-[A-Za-z0-9]{8,}/,       // API key shape
    /at-[A-Za-z0-9]{8,}/,       // token shape
    /\.workbuddy-ai/,
    /task_history/i,
    /\\AppData\\/,
  ];
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      for (const pattern of forbidden) {
        if (pattern.test(node)) offenders.push(`${path}: ${node}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    }
  };
  for (const view of allViews) walk(view, view.taskId);
  assert.deepEqual(offenders, [], `samples must stay synthetic: ${offenders.join(" | ")}`);
});

test("the sample set stays free of real project names", () => {
  const identifiers = allViews.map(view => view.workspace.id);
  for (const id of identifiers) {
    assert.ok(id.startsWith("synthetic-"), `workspace id ${id} must be marked synthetic`);
  }
});

test("the metrics block reports the schema version the contract names", () => {
  for (const metric of allViews.map(view => view.metrics).filter(m => m !== null)) {
    assert.equal(metric.schemaVersion, "workbuddy-executor/vnext-1");
    assert.ok(metric.taskId.trim());
  }
});
