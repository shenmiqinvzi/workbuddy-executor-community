/**
 * Tests for the read-only record projection.
 *
 * Each case builds the existing record types by hand and states the facts it
 * expects. The expectations are derived from docs/TASK_VIEW_FACT_MAPPING.md,
 * not from a stored displayState, so a mistake in the adapter cannot hide
 * behind a mistake in a sample.
 *
 * Every case also checks that the projection never opens a write action: this
 * round returns export only.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { adaptTaskViewFacts, type TaskViewAdapterInput } from "../src/task-view-adapter.js";
import type { StoredAttempt, StoredTask } from "../src/task-store.js";
import type { RunSnapshot } from "../src/run-journal.js";

const TASK_ID = "task-synthetic-1";
const OTHER_TASK_ID = "task-synthetic-2";
const ATTEMPT_ID = "run-11111111-1111-1111-1111-111111111111";
const OTHER_ATTEMPT_ID = "run-22222222-2222-2222-2222-222222222222";
const SESSION_ID = "session-synthetic-1";
const OTHER_SESSION_ID = "session-synthetic-2";
const STOPPED_AT = "2026-10-18T10:20:00.000Z";

function task(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    taskId: TASK_ID,
    messageId: "msg-1",
    objective: "synthetic objective",
    state: "working",
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:05:00.000Z",
    sessionId: SESSION_ID,
    runtimeSource: "desktop_queue",
    attemptId: ATTEMPT_ID,
    attempt: 1,
    ...overrides,
  };
}

function attemptRow(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  return {
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    attempt: 1,
    messageId: "msg-1",
    sessionId: SESSION_ID,
    runtimeSource: "desktop_queue",
    state: "working",
    lastEventSeq: 0,
    artifacts: [],
    evidence: [],
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:05:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    attemptId: ATTEMPT_ID,
    taskId: TASK_ID,
    status: "working",
    driver: "desktop-queue",
    sessionId: SESSION_ID,
    runtimeSource: "desktop_queue",
    updatedAt: "2026-10-18T10:05:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<TaskViewAdapterInput> = {}): TaskViewAdapterInput {
  return { task: task(), attempt: attemptRow(), snapshot: snapshot(), ...overrides };
}

function hasGap(result: ReturnType<typeof adaptTaskViewFacts>, code: string): boolean {
  return result.gaps.some(entry => entry.code === code);
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

test("a task without a durable attempt id produces no identity", () => {
  const result = adaptTaskViewFacts({ task: task({ attemptId: undefined }), attempt: null, snapshot: null });
  assert.equal(result.facts, null);
  assert.equal(result.displayState, null);
  assert.deepEqual(result.allowedActions, ["export"]);
  assert.ok(hasGap(result, "attempt_missing"));
});

test("an attempt row naming another attempt is ignored instead of replacing the current one", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow({ attemptId: OTHER_ATTEMPT_ID }),
    snapshot: snapshot(),
  });
  // The current attempt comes from the task, so the facts still describe it;
  // the foreign row contributes nothing.
  assert.ok(result.facts);
  assert.equal(result.facts!.attemptId, ATTEMPT_ID);
  assert.equal(result.facts!.trust.identityMatches, false);
  assert.ok(hasGap(result, "attempt_identity_mismatch"));
});

test("an attempt id without an attempt row is reported and still projected", () => {
  const result = adaptTaskViewFacts({ task: task(), attempt: null, snapshot: snapshot() });
  assert.ok(result.facts);
  assert.equal(result.facts!.attemptId, ATTEMPT_ID);
  assert.ok(hasGap(result, "attempt_record_missing"));
});

test("a missing session id leaves the identity unknown rather than matching", () => {
  const result = adaptTaskViewFacts({
    task: task({ sessionId: undefined }),
    attempt: attemptRow({ sessionId: undefined }),
    snapshot: snapshot({ sessionId: undefined }),
  });
  assert.equal(result.facts!.trust.identityMatches, null);
  assert.ok(hasGap(result, "session_missing"));
});

/* ------------------------------------------------------------------ *
 * Snapshot association
 * ------------------------------------------------------------------ */

test("a missing snapshot leaves the stop status unknown", () => {
  const result = adaptTaskViewFacts({ task: task(), attempt: attemptRow(), snapshot: null });
  assert.equal(result.facts!.stop.proven, null);
  assert.equal(result.facts!.stop.attemptId, null);
  assert.ok(hasGap(result, "snapshot_missing"));
  assert.notEqual(result.displayState, "accepted");
});

test("a snapshot of another task is not used for stop or report facts", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "needs_review" }),
    attempt: attemptRow({ state: "needs_review" }),
    snapshot: snapshot({ taskId: OTHER_TASK_ID, status: "needs_review", stopReason: "native_idle_verified" }),
  });
  assert.equal(result.facts!.stop.proven, null);
  assert.equal(result.facts!.stop.attemptId, null);
  assert.equal(result.facts!.trust.identityMatches, false);
  assert.ok(hasGap(result, "snapshot_identity_mismatch"));
});

test("a snapshot of another attempt is not used", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow(),
    snapshot: snapshot({ attemptId: OTHER_ATTEMPT_ID, stopReason: "native_idle_verified" }),
  });
  assert.equal(result.facts!.stop.proven, null);
  assert.ok(hasGap(result, "snapshot_identity_mismatch"));
});

test("a snapshot naming another session is not used", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow(),
    snapshot: snapshot({ sessionId: OTHER_SESSION_ID, stopReason: "native_idle_verified" }),
  });
  assert.equal(result.facts!.stop.proven, null);
  assert.ok(hasGap(result, "snapshot_identity_mismatch"));
});

/* ------------------------------------------------------------------ *
 * Stop proof
 * ------------------------------------------------------------------ */

test("a worker self report is not a confirmed stop", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "needs_review", report: { status: "completed", filesChanged: [], commandsRun: [], rawText: "done" } }),
    attempt: attemptRow({ state: "needs_review" }),
    snapshot: snapshot({ status: "needs_review", stopReason: "end_turn", text: "done" }),
  });
  assert.equal(result.facts!.stop.proven, false);
  assert.notEqual(result.displayState, "accepted");
  assert.notEqual(result.displayState, "needs_review");
});

test("an end_turn stop reason alone is not stop evidence", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow(),
    snapshot: snapshot({ status: "needs_review", stopReason: "end_turn" }),
  });
  assert.equal(result.facts!.stop.proven, false);
  assert.ok(hasGap(result, "stop_proof_absent"));
});

test("real program stop evidence is mapped with its instant", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "needs_review" }),
    attempt: attemptRow({ state: "needs_review" }),
    snapshot: snapshot({
      status: "needs_review",
      stopReason: "end_turn",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
  });
  assert.equal(result.facts!.stop.proven, true);
  assert.equal(result.facts!.stop.at, STOPPED_AT);
  assert.equal(result.facts!.stop.attemptId, ATTEMPT_ID);
});

test("old stop evidence without a reliable time still confirms the stop", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "needs_review" }),
    attempt: attemptRow({ state: "needs_review" }),
    snapshot: snapshot({ status: "needs_review", stopReason: "native_idle_verified" }),
  });
  assert.equal(result.facts!.stop.proven, true);
  assert.equal(result.facts!.stop.at, null);
  assert.ok(hasGap(result, "stop_time_unavailable"));
});

test("a bare nativeStoppedAt without a recorded source is not stop evidence", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow(),
    snapshot: snapshot({ nativeStoppedAt: STOPPED_AT }),
  });
  assert.equal(result.facts!.stop.proven, false);
});

/* ------------------------------------------------------------------ *
 * Report authentication
 * ------------------------------------------------------------------ */

test("a report without an authentication record stays unknown, not authenticated", () => {
  // The text and digest are present, but no record proves the origin of this
  // report was verified. Presence alone must never authenticate it.
  const result = adaptTaskViewFacts({
    task: task({ state: "needs_review", report: { status: "completed", filesChanged: [], commandsRun: [], rawText: "done" } }),
    attempt: attemptRow({ state: "needs_review" }),
    snapshot: snapshot({ status: "needs_review", reportDigest: "a".repeat(64), text: "done" }),
  });
  assert.equal(result.facts!.report.state, "unknown");
  assert.equal(result.facts!.report.attemptId, null);
  assert.ok(hasGap(result, "report_authentication_missing"));
});

test("no report at all is recorded as absent", () => {
  const result = adaptTaskViewFacts(input());
  assert.equal(result.facts!.report.state, "absent");
});

/* ------------------------------------------------------------------ *
 * Terminal decisions
 * ------------------------------------------------------------------ */

test("an explicit cancellation decision is not rewritten by a late report", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "cancelled", report: { status: "completed", filesChanged: [], commandsRun: [], rawText: "late" } }),
    attempt: attemptRow({ state: "cancelled" }),
    snapshot: snapshot({
      status: "cancelled",
      stopReason: "cancelled",
      text: "late",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
    cancellation: { requestedAt: "2026-10-18T10:10:00.000Z", reason: "cancellation" },
  });
  assert.equal(result.facts!.terminalDecision.decided, true);
  assert.equal(result.facts!.terminalDecision.cause, "cancellation");
  assert.equal(result.displayState, "cancelled");
});

test("a cancellation decision without stop proof is shown as waiting for the stop", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "cancelled" }),
    attempt: attemptRow({ state: "cancelled" }),
    snapshot: snapshot({ status: "cancelled", stopReason: "cancelled" }),
    cancellation: { requestedAt: "2026-10-18T10:10:00.000Z", reason: "cancellation" },
  });
  assert.equal(result.facts!.terminalDecision.decided, true);
  assert.equal(result.facts!.stop.proven, false);
  assert.equal(result.displayState, "waiting_stop");
});

test("a deadline decision with a confirmed stop is shown as expired", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "blocked" }),
    attempt: attemptRow({ state: "blocked" }),
    snapshot: snapshot({
      status: "blocked",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
    cancellation: { requestedAt: "2026-10-18T10:30:00.000Z", reason: "deadline" },
  });
  assert.equal(result.facts!.terminalDecision.decided, true);
  assert.equal(result.facts!.terminalDecision.cause, "deadline");
  assert.equal(result.facts!.terminalDecision.deadlineReached, true);
  assert.equal(result.displayState, "expired");
});

test("a failure state is mapped as a failure decision", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "failed" }),
    attempt: attemptRow({ state: "failed" }),
    snapshot: snapshot({
      status: "failed",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
  });
  assert.equal(result.facts!.terminalDecision.cause, "failure");
  assert.equal(result.displayState, "failed");
});

test("a plain blocked state does not establish a terminal decision", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "blocked", blockingReason: "WorkBuddy needs input" }),
    attempt: attemptRow({ state: "blocked" }),
    snapshot: snapshot({ status: "blocked" }),
  });
  assert.equal(result.facts!.terminalDecision.decided, null);
  assert.ok(hasGap(result, "terminal_decision_undetermined"));
});

test("an error text mentioning a timeout is not a deadline decision", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "blocked", blockingReason: "timeout while waiting" }),
    attempt: attemptRow({ state: "blocked" }),
    snapshot: snapshot({ status: "blocked", error: "request timeout" }),
  });
  assert.equal(result.facts!.terminalDecision.decided, null);
  assert.equal(result.facts!.terminalDecision.cause, null);
});

/* ------------------------------------------------------------------ *
 * Acceptance is persistent
 * ------------------------------------------------------------------ */

test("an accepted decision survives a disconnected and conflicting record", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "accepted", reviewedAt: "2026-10-18T10:40:00.000Z" }),
    attempt: attemptRow({ state: "needs_review" }),
    snapshot: snapshot({ status: "blocked" }),
  });
  assert.equal(result.facts!.acceptance.decision, "accepted");
  assert.equal(result.facts!.acceptance.conflict, true);
  assert.equal(result.displayState, "accepted");
  assert.ok(hasGap(result, "acceptance_conflict"));
});

/* ------------------------------------------------------------------ *
 * Live states need a live observation
 * ------------------------------------------------------------------ */

test("a stale working snapshot alone is not shown as a live state", () => {
  const result = adaptTaskViewFacts(input());
  assert.equal(result.facts!.nativePhase, "unknown");
  assert.equal(result.facts!.trust.observationCurrent, null);
  assert.equal(result.facts!.trust.connected, null);
  assert.notEqual(result.displayState, "running");
  assert.notEqual(result.displayState, "queued");
  assert.equal(result.displayState, "unknown");
  assert.ok(hasGap(result, "live_observation_absent"));
});

test("a stored waitingInput flag alone is not a live waiting input", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow(),
    snapshot: snapshot({ waitingInput: true }),
  });
  assert.equal(result.facts!.nativeWaitingForInput, null);
  assert.notEqual(result.displayState, "waiting_input");
});

test("a live observation can establish a running state", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow(),
    snapshot: snapshot(),
    liveObservation: {
      phase: "running",
      identityMatches: true,
      observationCurrent: true,
      connected: true,
      deadlineReached: false,
    },
  });
  assert.equal(result.facts!.nativePhase, "running");
  assert.equal(result.displayState, "running");
});

test("a live observation can establish a waiting input state", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow(),
    snapshot: snapshot(),
    liveObservation: {
      phase: "waiting_input",
      identityMatches: true,
      observationCurrent: true,
      connected: true,
      deadlineReached: false,
    },
  });
  assert.equal(result.facts!.nativeWaitingForInput, true);
  assert.equal(result.displayState, "waiting_input");
});

test("a live observation that is stale or disconnected does not establish a live state", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow(),
    snapshot: snapshot(),
    liveObservation: {
      phase: "running",
      identityMatches: true,
      observationCurrent: false,
      connected: false,
      deadlineReached: false,
    },
  });
  assert.notEqual(result.displayState, "running");
  assert.equal(result.displayState, "unknown");
});

/* ------------------------------------------------------------------ *
 * Action capability gaps
 * ------------------------------------------------------------------ */

test("the action facts stay null and every missing binding is reported", () => {
  const result = adaptTaskViewFacts(input());
  assert.equal(result.actionFacts, null);
  for (const code of [
    "review_id_unavailable",
    "agreement_version_unavailable",
    "source_summary_unavailable",
    "required_checks_unavailable",
    "model_verification_unavailable",
    "action_facts_not_constructible",
  ]) {
    assert.ok(hasGap(result, code), `missing gap ${code}`);
  }
});

test("every projection offers export only", () => {
  const inputs: TaskViewAdapterInput[] = [
    input(),
    { task: task({ state: "accepted" }), attempt: attemptRow({ state: "accepted" }), snapshot: snapshot() },
    { task: task({ state: "cancelled" }), attempt: attemptRow({ state: "cancelled" }), snapshot: snapshot() },
    { task: task({ attemptId: undefined }), attempt: null, snapshot: null },
    { task: task(), attempt: attemptRow(), snapshot: null },
  ];
  for (const candidate of inputs) {
    assert.deepEqual(adaptTaskViewFacts(candidate).allowedActions, ["export"]);
  }
});

/* ------------------------------------------------------------------ *
 * Association must be settled before any record fact is used
 * ------------------------------------------------------------------ */

test("an accepted attempt of another task does not accept this task", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "needs_review" }),
    attempt: attemptRow({ taskId: OTHER_TASK_ID, state: "accepted" }),
    snapshot: snapshot({ status: "needs_review" }),
  });
  assert.equal(result.facts!.acceptance.decision, "not_accepted");
  assert.notEqual(result.displayState, "accepted");
  assert.ok(hasGap(result, "attempt_task_mismatch"));
});

test("a cancelled or failed attempt of another task does not decide this task", () => {
  const cancelledRow = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow({ taskId: OTHER_TASK_ID, state: "cancelled" }),
    snapshot: snapshot(),
  });
  assert.equal(cancelledRow.facts!.terminalDecision.decided, false);
  assert.equal(cancelledRow.facts!.terminalDecision.cause, null);
  assert.notEqual(cancelledRow.displayState, "cancelled");

  const failedRow = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow({ taskId: OTHER_TASK_ID, state: "failed" }),
    snapshot: snapshot(),
  });
  assert.equal(failedRow.facts!.terminalDecision.decided, false);
  assert.notEqual(failedRow.displayState, "failed");
});

test("an accepted task with a conflicting attempt keeps the decision and reports the conflict", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "accepted" }),
    attempt: attemptRow({ attemptId: OTHER_ATTEMPT_ID, state: "accepted" }),
    snapshot: snapshot(),
  });
  assert.ok(result.facts);
  assert.equal(result.facts!.attemptId, ATTEMPT_ID);
  assert.equal(result.facts!.acceptance.decision, "accepted");
  assert.equal(result.facts!.acceptance.conflict, true);
  assert.equal(result.displayState, "accepted");
  assert.ok(hasGap(result, "acceptance_conflict"));
});

test("an accepted task without an attempt id keeps the decision and invents no identity", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "accepted", attemptId: undefined }),
    attempt: attemptRow(),
    snapshot: snapshot(),
  });
  assert.equal(result.facts, null);
  assert.equal(result.displayState, "accepted");
  assert.deepEqual(result.allowedActions, ["export"]);
  assert.ok(hasGap(result, "attempt_missing"));
});

test("a task without a current attempt id does not adopt a historical row", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "working", attemptId: undefined }),
    attempt: attemptRow({ attemptId: OTHER_ATTEMPT_ID }),
    snapshot: snapshot({ attemptId: OTHER_ATTEMPT_ID }),
  });
  assert.equal(result.facts, null);
  assert.equal(result.displayState, null);
  assert.ok(hasGap(result, "attempt_missing"));
});

/* ------------------------------------------------------------------ *
 * Live identity is a separate fact from record agreement
 * ------------------------------------------------------------------ */

test("a live identity that is unknown or false never yields a trusted live state", () => {
  const base = {
    task: task({ state: "working" }),
    attempt: attemptRow(),
    snapshot: snapshot(),
  };
  for (const identityMatches of [null, false] as const) {
    const result = adaptTaskViewFacts({
      ...base,
      liveObservation: {
        phase: "running",
        identityMatches,
        observationCurrent: true,
        connected: true,
        deadlineReached: false,
      },
    });
    assert.equal(result.facts!.trust.identityMatches, identityMatches);
    assert.notEqual(result.displayState, "running", `identityMatches=${String(identityMatches)} produced running`);
    assert.notEqual(result.displayState, "queued");
    assert.notEqual(result.displayState, "waiting_input");
  }
});

test("a verified live identity still yields a trusted live state", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow(),
    snapshot: snapshot(),
    liveObservation: {
      phase: "running",
      identityMatches: true,
      observationCurrent: true,
      connected: true,
      deadlineReached: false,
    },
  });
  assert.equal(result.facts!.trust.identityMatches, true);
  assert.equal(result.displayState, "running");
});

/* ------------------------------------------------------------------ *
 * First terminal cause wins
 * ------------------------------------------------------------------ */

test("a first deadline record is not reordered by a later cancelled state", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "cancelled" }),
    attempt: attemptRow({ state: "cancelled" }),
    snapshot: snapshot({
      status: "cancelled",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
    cancellation: { requestedAt: "2026-10-18T10:30:00.000Z", reason: "deadline" },
  });
  assert.equal(result.facts!.terminalDecision.cause, "deadline");
  assert.equal(result.displayState, "expired");
});

test("a first deadline record is not reordered by a later failed state", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "failed" }),
    attempt: attemptRow({ state: "failed" }),
    snapshot: snapshot({
      status: "failed",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
    cancellation: { requestedAt: "2026-10-18T10:30:00.000Z", reason: "deadline" },
  });
  assert.equal(result.facts!.terminalDecision.cause, "deadline");
});

test("disagreeing terminal states without a first-cause record report the conflict", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "cancelled" }),
    attempt: attemptRow({ state: "failed" }),
    snapshot: snapshot({
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
  });
  assert.equal(result.facts!.terminalDecision.decided, true);
  assert.equal(result.facts!.terminalDecision.cause, null);
  assert.ok(hasGap(result, "terminal_cause_conflict"));
});

/* ------------------------------------------------------------------ *
 * Association fields: session and runtime source
 * ------------------------------------------------------------------ */

test("an attempt row with another runtime source is not used", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow({ runtimeSource: "desktop-acp" }),
    snapshot: snapshot(),
  });
  assert.equal(result.facts!.trust.identityMatches, false);
  assert.ok(hasGap(result, "attempt_runtime_source_mismatch"));
});

test("an attempt row naming another session is not used", () => {
  const result = adaptTaskViewFacts({
    task: task(),
    attempt: attemptRow({ sessionId: OTHER_SESSION_ID }),
    snapshot: snapshot(),
  });
  assert.equal(result.facts!.trust.identityMatches, false);
  assert.ok(hasGap(result, "attempt_session_mismatch"));
});

test("a session recorded on one side only leaves the identity unknown", () => {
  const result = adaptTaskViewFacts({
    task: task({ sessionId: undefined }),
    attempt: attemptRow({ sessionId: SESSION_ID }),
    snapshot: snapshot({ sessionId: SESSION_ID }),
  });
  assert.equal(result.facts!.trust.identityMatches, null);
  assert.ok(hasGap(result, "session_missing"));
});

/* ------------------------------------------------------------------ *
 * Never-dispatched attempts
 * ------------------------------------------------------------------ */

test("a never-dispatched attempt can confirm a stop without a native session", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "cancelled", sessionId: undefined }),
    attempt: attemptRow({ state: "cancelled", sessionId: undefined }),
    snapshot: snapshot({
      status: "cancelled",
      sessionId: undefined,
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "not_dispatched",
    }),
    cancellation: { requestedAt: "2026-10-18T10:10:00.000Z", reason: "cancellation" },
  });
  assert.equal(result.facts!.stop.proven, true);
  assert.equal(result.facts!.stop.at, STOPPED_AT);
  assert.equal(result.displayState, "cancelled");
  assert.ok(!hasGap(result, "session_missing"));
});

/* ------------------------------------------------------------------ *
 * Attempt and snapshot must also agree with each other
 * ------------------------------------------------------------------ */

test("a session conflict between the attempt and the snapshot is not hidden by a missing task field", () => {
  const result = adaptTaskViewFacts({
    task: task({ sessionId: undefined }),
    attempt: attemptRow({ sessionId: SESSION_ID }),
    snapshot: snapshot({
      sessionId: OTHER_SESSION_ID,
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
  });
  assert.equal(result.facts!.stop.proven, null);
  assert.equal(result.facts!.trust.identityMatches, false);
  assert.ok(hasGap(result, "attempt_snapshot_mismatch"));
});

test("a runtime source conflict between the attempt and the snapshot is not hidden by a missing task field", () => {
  const result = adaptTaskViewFacts({
    task: task({ runtimeSource: undefined }),
    attempt: attemptRow({ runtimeSource: "desktop_acp" }),
    snapshot: snapshot({
      runtimeSource: "desktop_queue",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
  });
  assert.equal(result.facts!.stop.proven, null);
  assert.equal(result.facts!.trust.identityMatches, false);
  assert.ok(hasGap(result, "attempt_snapshot_mismatch"));
});

test("a foreign attempt does not invalidate an independently matching snapshot", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "needs_review" }),
    attempt: attemptRow({ taskId: OTHER_TASK_ID, sessionId: OTHER_SESSION_ID }),
    snapshot: snapshot({
      status: "needs_review",
      sessionId: SESSION_ID,
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
  });
  assert.equal(result.facts!.stop.proven, true);
  assert.ok(!hasGap(result, "attempt_snapshot_mismatch"));
  assert.ok(hasGap(result, "attempt_task_mismatch"));
});

/* ------------------------------------------------------------------ *
 * A cancellation record without a reason is still a decision
 * ------------------------------------------------------------------ */

test("a cancellation record without a reason is not treated as no decision", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow({ state: "working" }),
    snapshot: snapshot({ status: "working" }),
    cancellation: { requestedAt: "2026-10-18T10:10:00.000Z" },
  });
  assert.equal(result.facts!.terminalDecision.decided, true);
  assert.equal(result.facts!.terminalDecision.cause, null);
  assert.ok(hasGap(result, "cancellation_reason_missing"));
  // No stop proof, so the task waits for the stop rather than looking active.
  assert.equal(result.displayState, "waiting_stop");
  assert.notEqual(result.displayState, "running");
});

test("a cancellation without a reason and with a confirmed stop is unknown, not running", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow({ state: "working" }),
    snapshot: snapshot({
      status: "working",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
    cancellation: { requestedAt: "2026-10-18T10:10:00.000Z" },
  });
  assert.equal(result.facts!.terminalDecision.decided, true);
  assert.equal(result.facts!.terminalDecision.cause, null);
  assert.equal(result.facts!.stop.proven, true);
  assert.equal(result.displayState, "unknown");
});

test("a cancellation without a reason does not override a persisted acceptance", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "accepted" }),
    attempt: attemptRow({ state: "accepted" }),
    snapshot: snapshot(),
    cancellation: { requestedAt: "2026-10-18T10:10:00.000Z" },
  });
  assert.equal(result.displayState, "accepted");
});

test("a cancellation record that carries a reason still names the cause", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "cancelled" }),
    attempt: attemptRow({ state: "cancelled" }),
    snapshot: snapshot({
      status: "cancelled",
      nativeStoppedAt: STOPPED_AT,
      nativeStopSource: "native_idle",
    }),
    cancellation: { requestedAt: "2026-10-18T10:10:00.000Z", reason: "cancellation" },
  });
  assert.equal(result.facts!.terminalDecision.cause, "cancellation");
  assert.equal(result.displayState, "cancelled");
  assert.ok(!hasGap(result, "cancellation_reason_missing"));
});

test("no cancellation record at all still allows a trusted live state", () => {
  const result = adaptTaskViewFacts({
    task: task({ state: "working" }),
    attempt: attemptRow({ state: "working" }),
    snapshot: snapshot(),
    liveObservation: {
      phase: "running",
      identityMatches: true,
      observationCurrent: true,
      connected: true,
      deadlineReached: false,
    },
  });
  assert.equal(result.facts!.terminalDecision.decided, false);
  assert.equal(result.displayState, "running");
  assert.ok(!hasGap(result, "cancellation_reason_missing"));
});

/* ------------------------------------------------------------------ *
 * Purity
 * ------------------------------------------------------------------ */

test("the projection does not modify its input", () => {
  const candidate = input();
  const before = JSON.stringify(candidate);
  adaptTaskViewFacts(candidate);
  assert.equal(JSON.stringify(candidate), before);
});

test("the projection is deterministic for the same input", () => {
  const candidate = input();
  assert.deepEqual(adaptTaskViewFacts(candidate), adaptTaskViewFacts(candidate));
});

test("the gap list is stable across runs", () => {
  const candidate = input();
  const first = adaptTaskViewFacts(candidate).gaps.map(entry => `${entry.code}:${entry.field}`);
  const second = adaptTaskViewFacts(candidate).gaps.map(entry => `${entry.code}:${entry.field}`);
  assert.deepEqual(first, second);
});
