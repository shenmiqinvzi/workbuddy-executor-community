/**
 * Tests for the pure allowed action derivation.
 *
 * The cases below are written from the contract rules directly, in their own
 * input/expectation table, rather than by replaying the synthetic TaskView
 * samples. The samples carry an allowedActions list that was authored by
 * hand; using it as the source of the expected answers would hide a mistake
 * in the derivation behind a mistake in the samples.
 *
 * Input semantics used throughout:
 *   - null on a flag means "not established", never "confirmed absent".
 *   - a review must name the attempt, the agreement version and the source
 *     summary it was taken against; a mismatch is a stale review.
 *   - a review count is never a reviewId.
 *   - the caller states whether it owns the attempt, so cancel is offered
 *     only then.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveTaskAllowedActions,
  type ActionCheckFacts,
  type TaskActionFacts,
} from "../src/task-view-actions.js";
import type { TaskViewAllowedAction } from "../src/task-view.js";
import type { TaskDisplayFacts } from "../src/task-view-state.js";

const TASK = "task-under-test";
const OTHER_TASK = "another-task";
const ATTEMPT = "attempt-under-test";
const PREVIOUS_ATTEMPT = "previous-attempt";
const AGREEMENT = "agreement-v1";
const SOURCE = "source-summary-abc";

/** Healthy online facts: the native side is running, no report, no decision. */
function display(overrides: Partial<TaskDisplayFacts> = {}): TaskDisplayFacts {
  return {
    attemptId: ATTEMPT,
    acceptance: { decision: "not_accepted", conflict: false },
    terminalDecision: { decided: false, cause: null, deadlineReached: false },
    stop: { attemptId: ATTEMPT, proven: false, at: null },
    nativeWaitingForInput: false,
    report: { attemptId: ATTEMPT, state: "absent" },
    nativePhase: "running",
    trust: { identityMatches: true, observationCurrent: true, connected: true },
    ...overrides,
  };
}

function check(overrides: Partial<ActionCheckFacts> = {}): ActionCheckFacts {
  return {
    checkId: "check-1",
    attemptId: ATTEMPT,
    kind: "command",
    status: "passed",
    actor: "program",
    ...overrides,
  };
}

/** The required checks a passing task carries: a scope check and a command check. */
function passingChecks(): ActionCheckFacts[] {
  return [
    check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
  ];
}

/** A review that is current for this task, attempt, agreement and source. */
function currentReview(): TaskActionFacts["review"] {
  return {
    reviewId: "review-1",
    taskId: TASK,
    attemptId: ATTEMPT,
    agreementVersion: AGREEMENT,
    sourceSummary: SOURCE,
  };
}

/** A review with every binding field blank. */
function noReview(): TaskActionFacts["review"] {
  return { reviewId: null, taskId: null, attemptId: null, agreementVersion: null, sourceSummary: null };
}

function facts(overrides: Partial<TaskActionFacts> = {}): TaskActionFacts {
  return {
    taskId: TASK,
    attemptId: ATTEMPT,
    agreementVersion: AGREEMENT,
    currentSourceSummary: SOURCE,
    display: display(),
    checks: [],
    requiredCheckIds: [],
    review: noReview(),
    rework: {
      attemptLimit: 3,
      attemptNumber: 1,
      continuationAllowed: true,
      modelVerified: true,
      modelPolicySatisfied: true,
    },
    cancellationAvailable: true,
    ...overrides,
  };
}

/**
 * A task that has stopped, reported and been reviewed, ready for acceptance.
 *
 * The stop is confirmed and the attempt budget remains, so rework is also
 * available here. The cases that study accept alone set rework aside with
 * reworkOfNoContinuation.
 */
function acceptableTask(overrides: Partial<TaskActionFacts> = {}): TaskActionFacts {
  return facts({
    display: display({
      report: { attemptId: ATTEMPT, state: "authenticated" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      nativePhase: "idle",
    }),
    checks: passingChecks(),
    requiredCheckIds: ["scope-1", "command-1"],
    review: currentReview(),
    ...overrides,
  });
}

/** Rework conditions that never allow a new execution. */
function reworkOfNoContinuation(attemptNumber = 1): TaskActionFacts["rework"] {
  return {
    attemptLimit: 3,
    attemptNumber,
    continuationAllowed: false,
    modelVerified: false,
    modelPolicySatisfied: false,
  };
}

interface Case {
  name: string;
  facts: TaskActionFacts;
  expected: TaskViewAllowedAction[];
}

const CASES: Case[] = [
  /* ---- export is always available ---- */
  {
    name: "a running task offers cancel and export",
    facts: facts(),
    expected: ["cancel", "export"],
  },
  {
    name: "a task whose cancellation is not established offers only export",
    facts: facts({ cancellationAvailable: null }),
    expected: ["export"],
  },
  {
    name: "a task whose cancellation is confirmed absent offers only export",
    facts: facts({ cancellationAvailable: false }),
    expected: ["export"],
  },
  {
    name: "a queued task offers cancel and export",
    facts: facts({ display: display({ nativePhase: "queued" }) }),
    expected: ["cancel", "export"],
  },

  /* ---- waiting_input ---- */
  {
    name: "a task waiting for input offers cancel and export",
    facts: facts({ display: display({ nativeWaitingForInput: true, nativePhase: "idle" }) }),
    expected: ["cancel", "export"],
  },
  {
    name: "a task waiting for input on a disconnected native side offers only export",
    facts: facts({
      display: display({
        nativeWaitingForInput: true,
        nativePhase: "idle",
        trust: { identityMatches: true, observationCurrent: true, connected: false },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "a task waiting for input with an unknown identity offers only export",
    facts: facts({
      display: display({
        nativeWaitingForInput: true,
        nativePhase: "idle",
        trust: { identityMatches: null, observationCurrent: true, connected: true },
      }),
    }),
    expected: ["export"],
  },

  /* ---- unknown ---- */
  {
    name: "a task with unknown facts offers only export",
    facts: facts({
      display: display({
        trust: { identityMatches: null, observationCurrent: null, connected: false },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "a task with an identity mismatch offers only export",
    facts: facts({
      display: display({
        trust: { identityMatches: false, observationCurrent: true, connected: true },
      }),
    }),
    expected: ["export"],
  },

  /* ---- waiting_stop ---- */
  {
    name: "a task waiting for the native stop offers cancel and export",
    facts: facts({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: false, at: null },
      }),
    }),
    expected: ["cancel", "export"],
  },
  {
    name: "a task waiting for the native stop offers no review or accept or rework",
    facts: facts({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: false, at: null },
      }),
      checks: passingChecks(),
      requiredCheckIds: ["scope-1", "command-1"],
      review: currentReview(),
    }),
    expected: ["cancel", "export"],
  },
  {
    name: "a cancelled task without a stop proof offers cancel and export",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: false, at: null },
      }),
    }),
    expected: ["cancel", "export"],
  },

  /* ---- terminal states ---- */
  {
    name: "an accepted task offers only export",
    facts: facts({
      display: display({
        acceptance: { decision: "accepted", conflict: false },
        terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "a cancelled task offers only export",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "an expired task offers only export",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "deadline", deadlineReached: true },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "an expired task with a late report offers only export",
    facts: facts({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        terminalDecision: { decided: true, cause: "deadline", deadlineReached: true },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
      checks: passingChecks(),
      requiredCheckIds: ["scope-1", "command-1"],
      review: currentReview(),
    }),
    expected: ["export"],
  },

  /* ---- needs_review ---- */
  {
    name: "a task awaiting review offers review and export",
    // The stop is confirmed and the attempt budget remains, so rework is
    // available as well. A review record is not needed to offer rework, and
    // its absence only withholds accept.
    facts: facts({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
      }),
    }),
    expected: ["rework", "review", "export"],
  },
  {
    name: "a fully accepted task offers accept, review, rework and export",
    // The task is awaiting review with a confirmed stop and a remaining
    // budget, so every action that the contract allows here is offered.
    facts: acceptableTask(),
    expected: ["rework", "review", "accept", "export"],
  },
  {
    name: "a task whose review is missing offers no accept",
    facts: acceptableTask({
      review: noReview(),
      rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a review of an earlier attempt does not enable accept",
    facts: acceptableTask({
      review: { reviewId: "review-old", taskId: TASK, attemptId: PREVIOUS_ATTEMPT, agreementVersion: AGREEMENT, sourceSummary: SOURCE },
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a review of an earlier agreement does not enable accept",
    facts: acceptableTask({
      review: { reviewId: "review-old", taskId: TASK, attemptId: ATTEMPT, agreementVersion: "agreement-v0", sourceSummary: SOURCE },
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a review taken against another source does not enable accept",
    facts: acceptableTask({
      review: { reviewId: "review-old", taskId: TASK, attemptId: ATTEMPT, agreementVersion: AGREEMENT, sourceSummary: "source-summary-old" },
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a changed source invalidates the review and withholds accept",
    facts: acceptableTask({ currentSourceSummary: "source-summary-new", rework: reworkOfNoContinuation() }),
    expected: ["review", "export"],
  },
  {
    name: "an unknown required check withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "unknown", actor: "program" }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a required check that could not run withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "checker_error", actor: "program" }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a required check marked not applicable withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "not_applicable", actor: "program" }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a failed required check withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "failed", actor: "program" }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a missing required check withholds accept",
    facts: acceptableTask({
      checks: [check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" })],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a required check recorded for another attempt withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "passed", actor: "program", attemptId: PREVIOUS_ATTEMPT }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a required check recorded by the worker withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "passed", actor: "worker" }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a failed scope check withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "failed", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "an unknown scope check withholds accept",
    facts: acceptableTask({
      checks: [
        check({ checkId: "scope-1", kind: "scope", status: "unknown", actor: "program" }),
        check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
      ],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a missing scope check withholds accept",
    facts: acceptableTask({
      checks: [check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" })],
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "an unauthenticated report withholds accept and the review action",
    // An unauthenticated report with a confirmed stop is not a task awaiting
    // review, so the display state is unknown and only export is offered.
    facts: acceptableTask({
      display: display({
        report: { attemptId: ATTEMPT, state: "unauthenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
      }),
    rework: reworkOfNoContinuation(),
    }),
    expected: ["export"],
  },
  {
    name: "a report for another attempt withholds accept and the review action",
    // A report of another attempt cannot be used for this one, so the facts
    // do not establish a task awaiting review and only export is offered.
    facts: acceptableTask({
      display: display({
        report: { attemptId: PREVIOUS_ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
      }),
    rework: reworkOfNoContinuation(),
    }),
    expected: ["export"],
  },
  {
    name: "an unknown identity withholds accept",
    facts: acceptableTask({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
        trust: { identityMatches: null, observationCurrent: true, connected: true },
      }),
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a stop proof for another attempt withholds accept",
    // A proof of another attempt does not confirm this one, so the stop is
    // unproven and the task waits for the stop. Only cancel and export are
    // offered there.
    facts: acceptableTask({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: PREVIOUS_ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
      }),
    rework: reworkOfNoContinuation(),
    }),
    expected: ["cancel", "export"],
  },
  {
    name: "a stop proof without a reliable time still allows accept",
    facts: acceptableTask({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: null },
        nativePhase: "idle",
      }),
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "accept", "export"],
  },

  /* ---- rework ---- */
  {
    name: "a task awaiting review offers rework when the stop is confirmed and the budget remains",
    facts: acceptableTask(),
    expected: ["rework", "review", "accept", "export"],
  },
  {
    name: "a task awaiting review offers no rework while the stop is unproven",
    facts: facts({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: false, at: null },
      }),
      checks: passingChecks(),
      requiredCheckIds: ["scope-1", "command-1"],
      review: currentReview(),
    }),
    expected: ["cancel", "export"],
  },
  {
    name: "an exhausted attempt budget offers no rework",
    facts: acceptableTask({
      rework: {
        attemptLimit: 3,
        attemptNumber: 3,
        continuationAllowed: true,
        modelVerified: true,
        modelPolicySatisfied: true,
      },
    }),
    expected: ["review", "accept", "export"],
  },
  {
    name: "an unverified model offers no rework",
    facts: acceptableTask({
      rework: {
        attemptLimit: 3,
        attemptNumber: 1,
        continuationAllowed: true,
        modelVerified: null,
        modelPolicySatisfied: true,
      },
    }),
    expected: ["review", "accept", "export"],
  },
  {
    name: "a model that does not satisfy the free model policy offers no rework",
    facts: acceptableTask({
      rework: {
        attemptLimit: 3,
        attemptNumber: 1,
        continuationAllowed: true,
        modelVerified: true,
        modelPolicySatisfied: false,
      },
    }),
    expected: ["review", "accept", "export"],
  },
  {
    name: "a task whose continuation is not permitted offers no rework",
    facts: acceptableTask({
      rework: {
        attemptLimit: 3,
        attemptNumber: 1,
        continuationAllowed: false,
        modelVerified: true,
        modelPolicySatisfied: true,
      },
    }),
    expected: ["review", "accept", "export"],
  },
  {
    name: "a task whose continuation is unknown offers no rework",
    facts: acceptableTask({
      rework: {
        attemptLimit: 3,
        attemptNumber: 1,
        continuationAllowed: null,
        modelVerified: true,
        modelPolicySatisfied: true,
      },
    }),
    expected: ["review", "accept", "export"],
  },
  {
    name: "a failed task offers no rework without an explicit recovery policy",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
      rework: {
        attemptLimit: 3,
        attemptNumber: 1,
        continuationAllowed: false,
        modelVerified: true,
        modelPolicySatisfied: true,
      },
    }),
    expected: ["export"],
  },
  {
    name: "a failed task offers rework when a recovery policy allows continuing",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
      rework: {
        attemptLimit: 3,
        attemptNumber: 1,
        continuationAllowed: true,
        modelVerified: true,
        modelPolicySatisfied: true,
      },
    }),
    expected: ["rework", "export"],
  },
  {
    name: "a cancelled task offers no rework",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "an expired task offers no rework",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "deadline", deadlineReached: true },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
    }),
    expected: ["export"],
  },

  /* ---- persistent facts across a lost connection ---- */
  {
    name: "a disconnected native side does not clear an existing acceptance",
    facts: acceptableTask({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
        trust: { identityMatches: true, observationCurrent: false, connected: false },
      }),
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "accept", "export"],
  },
  {
    name: "a disconnected native side does not clear a recorded review",
    facts: facts({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
        trust: { identityMatches: true, observationCurrent: false, connected: false },
      }),
    rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "review and accept do not require the model service to be reachable",
    facts: acceptableTask({
      rework: {
        attemptLimit: 3,
        attemptNumber: 1,
        continuationAllowed: true,
        modelVerified: false,
        modelPolicySatisfied: false,
      },
    }),
    expected: ["review", "accept", "export"],
  },

  /* ---- the outer identity must agree with the display facts ---- */
  {
    name: "an attempt mismatch between the outer facts and the display offers only export",
    facts: facts({ attemptId: ATTEMPT, display: display({ attemptId: PREVIOUS_ATTEMPT }) }),
    expected: ["export"],
  },
  {
    name: "an attempt mismatch withholds accept even when everything else lines up",
    facts: acceptableTask({ attemptId: ATTEMPT, display: display({
      attemptId: PREVIOUS_ATTEMPT,
      report: { attemptId: PREVIOUS_ATTEMPT, state: "authenticated" },
      stop: { attemptId: PREVIOUS_ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      nativePhase: "idle",
    }) }),
    expected: ["export"],
  },

  /* ---- the review must be bound to the current task ---- */
  {
    name: "a review of another task does not enable accept",
    facts: acceptableTask({
      review: { ...currentReview(), taskId: OTHER_TASK },
      rework: reworkOfNoContinuation(),
    }),
    expected: ["review", "export"],
  },
  {
    name: "a blank current task id cannot bind a review",
    facts: acceptableTask({ taskId: "   ", rework: reworkOfNoContinuation() }),
    expected: ["review", "export"],
  },
  {
    name: "a review with a blank review id does not enable accept",
    facts: acceptableTask({ review: { ...currentReview(), reviewId: "   " }, rework: reworkOfNoContinuation() }),
    expected: ["review", "export"],
  },
  {
    name: "a review with a blank task id does not enable accept",
    facts: acceptableTask({ review: { ...currentReview(), taskId: "  " }, rework: reworkOfNoContinuation() }),
    expected: ["review", "export"],
  },
  {
    name: "a review with a blank attempt id does not enable accept",
    facts: acceptableTask({ review: { ...currentReview(), attemptId: " " }, rework: reworkOfNoContinuation() }),
    expected: ["review", "export"],
  },
  {
    name: "a review with a blank agreement version does not enable accept",
    facts: acceptableTask({ review: { ...currentReview(), agreementVersion: "   " }, rework: reworkOfNoContinuation() }),
    expected: ["review", "export"],
  },
  {
    name: "a review with a blank source summary does not enable accept",
    facts: acceptableTask({ review: { ...currentReview(), sourceSummary: "" }, rework: reworkOfNoContinuation() }),
    expected: ["review", "export"],
  },

  /* ---- rework needs an established identity ---- */
  {
    name: "a failed task with a mismatched identity withholds rework",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        trust: { identityMatches: false, observationCurrent: true, connected: true },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "a failed task with an unknown identity withholds rework",
    facts: facts({
      display: display({
        terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        trust: { identityMatches: null, observationCurrent: true, connected: true },
      }),
    }),
    expected: ["export"],
  },
  {
    name: "a task awaiting review with a mismatched identity offers review but not accept or rework",
    facts: acceptableTask({
      display: display({
        report: { attemptId: ATTEMPT, state: "authenticated" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        nativePhase: "idle",
        trust: { identityMatches: false, observationCurrent: true, connected: true },
      }),
    }),
    expected: ["review", "export"],
  },
];

test("every case derives the expected actions", () => {
  for (const entry of CASES) {
    assert.deepEqual(
      deriveTaskAllowedActions(entry.facts),
      entry.expected,
      `${entry.name}: expected ${JSON.stringify(entry.expected)}`,
    );
  }
});

test("the case table names every case uniquely", () => {
  const names = CASES.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length);
});

test("the derived actions never contain submit", () => {
  for (const entry of CASES) {
    const actions = deriveTaskAllowedActions(entry.facts);
    assert.ok(!actions.includes("submit" as TaskViewAllowedAction), `${entry.name} offered submit`);
  }
});

test("the derived actions never repeat an action", () => {
  for (const entry of CASES) {
    const actions = deriveTaskAllowedActions(entry.facts);
    assert.equal(new Set(actions).size, actions.length, `${entry.name} repeated an action`);
  }
});

test("the derived actions keep a fixed order", () => {
  const order: TaskViewAllowedAction[] = ["rework", "cancel", "review", "accept", "export"];
  for (const entry of CASES) {
    const actions = deriveTaskAllowedActions(entry.facts);
    const positions = actions.map(action => order.indexOf(action));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      `${entry.name} is not in the fixed order`,
    );
  }
});

test("the derivation does not modify its input", () => {
  for (const entry of CASES) {
    const before = JSON.stringify(entry.facts);
    deriveTaskAllowedActions(entry.facts);
    assert.equal(JSON.stringify(entry.facts), before, `${entry.name}: the derivation mutated its input`);
  }
});

test("the derivation is stable for the same facts", () => {
  for (const entry of CASES) {
    assert.deepEqual(
      deriveTaskAllowedActions(entry.facts),
      deriveTaskAllowedActions(entry.facts),
      `${entry.name}: the derivation is not deterministic`,
    );
  }
});

test("every terminal state offers export and nothing that changes the task", () => {
  const terminal: Array<[string, TaskActionFacts]> = [
    [
      "accepted",
      facts({
        display: display({
          acceptance: { decision: "accepted", conflict: false },
          terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
          stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        }),
      }),
    ],
    [
      "cancelled",
      facts({
        display: display({
          terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
          stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        }),
      }),
    ],
    [
      "expired",
      facts({
        display: display({
          terminalDecision: { decided: true, cause: "deadline", deadlineReached: true },
          stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
        }),
      }),
    ],
    [
      "unknown",
      facts({
        display: display({
          trust: { identityMatches: null, observationCurrent: null, connected: false },
        }),
      }),
    ],
  ];
  for (const [name, input] of terminal) {
    const actions = deriveTaskAllowedActions(input);
    assert.deepEqual(actions, ["export"], `${name} offered ${JSON.stringify(actions)}`);
  }
});

test("a review count never stands in for a reviewId", () => {
  // The facts carry no count at all; only a reviewId can enable accept.
  const withoutReview = acceptableTask({
    review: { reviewId: null, taskId: TASK, attemptId: ATTEMPT, agreementVersion: AGREEMENT, sourceSummary: SOURCE },
  });
  assert.ok(
    !deriveTaskAllowedActions(withoutReview).includes("accept"),
    "a review without an id must not enable accept",
  );
  const withReview = acceptableTask();
  assert.ok(deriveTaskAllowedActions(withReview).includes("accept"));
});

test("a cancelled task is never offered rework even when the budget remains", () => {
  const cancelled = facts({
    display: display({
      terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    rework: {
      attemptLimit: 3,
      attemptNumber: 1,
      continuationAllowed: true,
      modelVerified: true,
      modelPolicySatisfied: true,
    },
  });
  assert.ok(!deriveTaskAllowedActions(cancelled).includes("rework"));
});

/* ------------------------------------------------------------------ *
 * Check records: order must not decide the answer.
 * ------------------------------------------------------------------ */

test("conflicting required check records withhold accept in either order", () => {
  // A first-match lookup would return passed for one order and failed for the
  // other. The same records must give the same answer whatever order they
  // arrive in, and a disagreement is never a pass.
  const scope = check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" });
  const passed = check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" });
  const failed = check({ checkId: "command-1", kind: "command", status: "failed", actor: "program" });

  const orders: Array<[string, ActionCheckFacts[]]> = [
    ["passed then failed", [scope, passed, failed]],
    ["failed then passed", [scope, failed, passed]],
  ];
  const results = orders.map(([, records]) =>
    deriveTaskAllowedActions(acceptableTask({ checks: records, rework: reworkOfNoContinuation() })),
  );
  assert.deepEqual(results[0], results[1], "the record order changed the derived actions");
  for (const [label, actions] of orders.map((order, index) => [order[0], results[index]] as const)) {
    assert.ok(!actions!.includes("accept"), `${label}: conflicting records must withhold accept`);
  }
});

test("conflicting scope records withhold accept in either order", () => {
  const command = check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" });
  const passedScope = check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" });
  const failedScope = check({ checkId: "scope-2", kind: "scope", status: "failed", actor: "program" });

  const orders: Array<[string, ActionCheckFacts[]]> = [
    ["passed then failed", [command, passedScope, failedScope]],
    ["failed then passed", [command, failedScope, passedScope]],
  ];
  const results = orders.map(([, records]) =>
    deriveTaskAllowedActions(acceptableTask({ checks: records, rework: reworkOfNoContinuation() })),
  );
  assert.deepEqual(results[0], results[1], "the scope record order changed the derived actions");
  for (const actions of results) {
    assert.ok(!actions.includes("accept"), "a failed scope record must withhold accept");
  }
});

test("duplicate check records that agree still allow accept", () => {
  // A repeated record that carries the same result is not a conflict.
  const records = [
    check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
    check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
  ];
  const derived = deriveTaskAllowedActions(
    acceptableTask({ checks: records, rework: reworkOfNoContinuation() }),
  );
  assert.deepEqual(derived, ["review", "accept", "export"]);
});

test("a check record of another attempt never contributes to this one", () => {
  // The other attempt's passed record must not fill in for the missing
  // current record.
  const records = [
    check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "command-1", kind: "command", status: "passed", actor: "program", attemptId: PREVIOUS_ATTEMPT }),
  ];
  const derived = deriveTaskAllowedActions(
    acceptableTask({ checks: records, rework: reworkOfNoContinuation() }),
  );
  assert.ok(!derived.includes("accept"));
});

test("two scope checks of different ids may be run by different actors", () => {
  // Two ids are two checks. One being a program check and the other an
  // independent review is not a conflict, so acceptance stays available.
  const records = [
    check({ checkId: "scope-program", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "scope-review", kind: "scope", status: "passed", actor: "independent_reviewer" }),
    check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
  ];
  const derived = deriveTaskAllowedActions(
    acceptableTask({
      checks: records,
      requiredCheckIds: ["scope-program", "scope-review", "command-1"],
      rework: reworkOfNoContinuation(),
    }),
  );
  assert.deepEqual(derived, ["review", "accept", "export"]);
});

test("two scope checks of different ids still block acceptance when one fails", () => {
  const records = [
    check({ checkId: "scope-program", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "scope-review", kind: "scope", status: "failed", actor: "independent_reviewer" }),
    check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
  ];
  const derived = deriveTaskAllowedActions(
    acceptableTask({ checks: records, rework: reworkOfNoContinuation() }),
  );
  assert.ok(!derived.includes("accept"));
});

test("two scope checks of different ids still block acceptance when one is a worker record", () => {
  const records = [
    check({ checkId: "scope-program", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "scope-review", kind: "scope", status: "passed", actor: "worker" }),
    check({ checkId: "command-1", kind: "command", status: "passed", actor: "program" }),
  ];
  const derived = deriveTaskAllowedActions(
    acceptableTask({ checks: records, rework: reworkOfNoContinuation() }),
  );
  assert.ok(!derived.includes("accept"));
});

test("a check id recorded as both a command and a semantic check withholds accept", () => {
  // Kind is part of a check's identity. Two different kinds under one id do
  // not describe one check, so neither result may be used.
  const records = [
    check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "misc-1", kind: "command", status: "passed", actor: "program" }),
    check({ checkId: "misc-1", kind: "semantic", status: "passed", actor: "program" }),
  ];
  const derived = deriveTaskAllowedActions(
    acceptableTask({ checks: records, rework: reworkOfNoContinuation() }),
  );
  assert.ok(!derived.includes("accept"));
});

test("a check id recorded as both a scope check and another kind withholds accept", () => {
  // Filtering the records to the scope kind first would hide this group and
  // let the remaining scope check carry the acceptance on its own.
  const records = [
    check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "scope-2", kind: "scope", status: "passed", actor: "program" }),
    check({ checkId: "scope-2", kind: "command", status: "passed", actor: "program" }),
  ];
  const derived = deriveTaskAllowedActions(
    acceptableTask({ checks: records, rework: reworkOfNoContinuation() }),
  );
  assert.ok(!derived.includes("accept"));
});

test("a kind conflict withholds accept in either record order", () => {
  const scope = check({ checkId: "scope-1", kind: "scope", status: "passed", actor: "program" });
  const asCommand = check({ checkId: "misc-1", kind: "command", status: "passed", actor: "program" });
  const asSemantic = check({ checkId: "misc-1", kind: "semantic", status: "passed", actor: "program" });

  const orders: Array<[string, ActionCheckFacts[]]> = [
    ["command then semantic", [scope, asCommand, asSemantic]],
    ["semantic then command", [scope, asSemantic, asCommand]],
  ];
  const results = orders.map(([, records]) =>
    deriveTaskAllowedActions(acceptableTask({ checks: records, rework: reworkOfNoContinuation() })),
  );
  assert.deepEqual(results[0], results[1], "the record order changed the derived actions");
  for (const actions of results) {
    assert.ok(!actions.includes("accept"), "a kind conflict must withhold accept");
  }
});

/* ------------------------------------------------------------------ *
 * Attempt budget: unknown or invalid values never allow rework.
 * ------------------------------------------------------------------ */

test("an unknown or invalid attempt budget withholds rework without blocking accept", () => {
  const permissive: TaskActionFacts["rework"] = {
    attemptLimit: 3,
    attemptNumber: 1,
    continuationAllowed: true,
    modelVerified: true,
    modelPolicySatisfied: true,
  };
  const budgets: Array<[string, TaskActionFacts["rework"]]> = [
    ["a null limit", { ...permissive, attemptLimit: null }],
    ["a NaN limit", { ...permissive, attemptLimit: Number.NaN }],
    ["an infinite limit", { ...permissive, attemptLimit: Number.POSITIVE_INFINITY }],
    ["a zero limit", { ...permissive, attemptLimit: 0 }],
    ["a negative limit", { ...permissive, attemptLimit: -3 }],
    ["a fractional limit", { ...permissive, attemptLimit: 2.5 }],
    ["a null number", { ...permissive, attemptNumber: null }],
    ["a NaN number", { ...permissive, attemptNumber: Number.NaN }],
    ["an infinite number", { ...permissive, attemptNumber: Number.POSITIVE_INFINITY }],
    ["a zero number", { ...permissive, attemptNumber: 0 }],
    ["a negative number", { ...permissive, attemptNumber: -1 }],
    ["a fractional number", { ...permissive, attemptNumber: 1.5 }],
  ];
  for (const [label, rework] of budgets) {
    const derived = deriveTaskAllowedActions(acceptableTask({ rework }));
    assert.ok(!derived.includes("rework"), `${label} must not allow rework`);
    assert.ok(derived.includes("accept"), `${label} must not block accept`);
  }
});

test("a valid attempt budget still allows rework", () => {
  // The control case for the budget table: a real positive integer budget is
  // accepted, so the table above is not passing for some unrelated reason.
  const derived = deriveTaskAllowedActions(
    acceptableTask({
      rework: {
        attemptLimit: 3,
        attemptNumber: 2,
        continuationAllowed: true,
        modelVerified: true,
        modelPolicySatisfied: true,
      },
    }),
  );
  assert.ok(derived.includes("rework"));
});

