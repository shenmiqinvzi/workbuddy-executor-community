/**
 * Read-only projection of existing task records into TaskView facts.
 *
 * This module turns records that already exist into the facts that
 * deriveTaskDisplayState consumes, and reports the facts it could not
 * establish. The mapping rules, the reason each source is or is not used, and
 * the priority between competing terminal records are fixed in
 * docs/TASK_VIEW_FACT_MAPPING.md.
 *
 * What this is not:
 *   - It is not a complete TaskView. Existing storage has no vNext reviewId,
 *     no structured required-check list, no agreement version, no current
 *     source summary and no persisted revision, so the projection cannot
 *     claim to be an executable vNext service.
 *   - It is not a verifier. It compares and maps the values it is given; it
 *     does not authenticate a report, verify a lease, hash a source or prove
 *     that a native session is the one this task owns.
 *   - It is not a live observer. A stored snapshot's updatedAt is the time the
 *     record was saved, not evidence that the native side is active now.
 *
 * Order of work: the records are associated first, and only then are their
 * facts read. A record that belongs to another task or to another attempt
 * contributes no acceptance, terminal, stop or report fact, no matter what it
 * says.
 *
 * Purity: it reads no clock, file, database, network or process environment,
 * mutates nothing, and instantiates no store, journal or native adapter. It
 * reuses the existing pure predicate hasNativeStopEvidence for the stop rule.
 */

import type { StoredAttempt, StoredTask } from "./task-store.js";
import type { RunSnapshot } from "./run-journal.js";
import { hasNativeStopEvidence } from "./run-journal.js";
import type { TaskViewAllowedAction, TaskViewDisplayState } from "./task-view.js";
import type { TaskActionFacts } from "./task-view-actions.js";
import {
  deriveTaskDisplayState,
  type NativePhase,
  type ReportState,
  type TaskDisplayFacts,
  type TerminalDecisionCause,
} from "./task-view-state.js";
import { snapshotReportDigest, verifyReportAuthentication } from "./report-authentication.js";

/**
 * The cancellation record written next to an attempt.
 *
 * RunJournal.cancel() writes it with flag "wx", so the first cause survives
 * later requests; DesktopQueue.expire() writes reason "deadline".
 */
export interface AdapterCancellationRecord {
  requestedAt?: string;
  reason?: string;
}

/**
 * A live observation, when the caller has one.
 *
 * The caller must supply it only from an observing path that actually reached
 * the native side and verified that the session belongs to this attempt. This
 * module does not decide how long an observation stays valid: the caller
 * states observationCurrent, because deciding that would require a clock.
 *
 * identityMatches here is the live verification result and is kept apart from
 * whether the stored records happen to agree with each other. A live null or
 * false is never upgraded to true because the stored fields look complete.
 */
export interface LiveNativeObservation {
  /** What the observing path saw; "offline" means it could not reach the native side. */
  phase: "queued" | "running" | "waiting_input" | "offline";
  /** Whether the observer verified the session belongs to this attempt. */
  identityMatches: boolean | null;
  /** Whether the caller established that the observation still describes the present moment. */
  observationCurrent: boolean | null;
  /** Whether the observing path still holds a connection. */
  connected: boolean | null;
  /** Whether the attempt deadline has passed, as the observer established it. */
  deadlineReached: boolean | null;
}

/** Everything the projection reads. All of it comes from existing records. */
export interface TaskViewAdapterInput {
  /** TaskStore.get(taskId) or an entry of TaskStore.listTasks(). */
  task: StoredTask;
  /** The TaskStore.listAttempts(taskId) row for this attempt, when it exists. */
  attempt?: StoredAttempt | null;
  /** RunJournal(root, attemptId).snapshot(). */
  snapshot?: RunSnapshot | null;
  /** The attempt's cancel.json body, when the file exists. */
  cancellation?: AdapterCancellationRecord | null;
  /** A live observation from a real observing path, when one exists. */
  liveObservation?: LiveNativeObservation | null;
}

/** Stable reason codes. A code never changes meaning once published. */
export type AdapterGapCode =
  | "attempt_missing"
  | "attempt_identity_mismatch"
  | "attempt_task_mismatch"
  | "attempt_session_mismatch"
  | "attempt_runtime_source_mismatch"
  | "attempt_record_missing"
  | "attempt_snapshot_mismatch"
  | "snapshot_missing"
  | "snapshot_identity_mismatch"
  | "session_missing"
  | "runtime_source_missing"
  | "stop_proof_absent"
  | "stop_time_unavailable"
  | "report_authentication_unverified"
  | "report_authentication_missing"
  | "report_authentication_unsupported"
  | "report_authentication_binding_mismatch"
  | "report_authentication_digest_mismatch"
  | "terminal_decision_undetermined"
  | "terminal_cause_conflict"
  | "cancellation_reason_missing"
  | "acceptance_conflict"
  | "live_observation_absent"
  | "review_id_unavailable"
  | "agreement_version_unavailable"
  | "source_summary_unavailable"
  | "required_checks_unavailable"
  | "model_verification_unavailable"
  | "action_facts_not_constructible";

/** One fact that could not be established, with the field it affects. */
export interface AdapterGap {
  code: AdapterGapCode;
  /** The fact field the gap affects, for example "stop.proven". */
  field: string;
  /** A stable, non-sensitive explanation. */
  reason: string;
}

/**
 * The projection result.
 *
 * facts and displayState are normally both null or both present. The one
 * exception is a task whose own record carries a final acceptance decision
 * while no current attempt can be established: the decision is a persistent
 * fact about the task, so displayState is "accepted" while facts stays null
 * because no attempt identity exists to attach the facts to. A caller must
 * therefore read displayState, not assume it follows facts.
 */
export interface TaskViewAdapterResult {
  /** The display facts, or null when no current attempt identity exists. */
  facts: TaskDisplayFacts | null;
  /** The display state; may be "accepted" with facts null (see above). */
  displayState: TaskViewDisplayState | null;
  /** Always null in this round: the vNext action inputs do not exist in storage. */
  actionFacts: TaskActionFacts | null;
  /** Always ["export"] in this round: no write action is opened. */
  allowedActions: TaskViewAllowedAction[];
  /** Every fact that could not be established, in a stable order. */
  gaps: AdapterGap[];
}

/** The only action this round offers. Write actions stay closed. */
const READ_ONLY_ACTIONS: TaskViewAllowedAction[] = ["export"];

function gap(code: AdapterGapCode, field: string, reason: string): AdapterGap {
  return { code, field, reason };
}

function nonBlank(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseable(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * The gaps that explain why TaskActionFacts cannot be constructed.
 *
 * Existing storage lacks every binding input the action derivation needs, so
 * the action facts stay null rather than being filled with blanks, default
 * true values or an empty required-check list that would read as "nothing was
 * required".
 */
function actionCapabilityGaps(): AdapterGap[] {
  return [
    gap("review_id_unavailable", "review.reviewId", "Storage keeps reviewNote and reviewedAt, not an immutable vNext reviewId; neither is used as one."),
    gap("agreement_version_unavailable", "agreementVersion", "submissionHash is the normalized initial submission, not a vNext agreement version."),
    gap("source_summary_unavailable", "currentSourceSummary", "No source summary is recorded for an attempt and this round does not scan sources."),
    gap("required_checks_unavailable", "requiredCheckIds", "No structured required-check list is recorded; an empty list is not assumed to mean nothing is required."),
    gap("model_verification_unavailable", "rework.modelVerified", "A model id or a free catalogue label is not a completed model verification."),
    gap("action_facts_not_constructible", "actionFacts", "TaskActionFacts stays null because the review, agreement and source bindings above are unavailable."),
  ];
}

/** The result when no current attempt identity can be established. */
function withoutFacts(gaps: AdapterGap[], displayState: TaskViewDisplayState | null = null): TaskViewAdapterResult {
  return {
    facts: null,
    displayState,
    actionFacts: null,
    allowedActions: [...READ_ONLY_ACTIONS],
    gaps: [...gaps, ...actionCapabilityGaps()],
  };
}

/**
 * Decide whether a stored report may be treated as authenticated.
 *
 * Three things must hold together: the snapshot belongs to this task and
 * attempt (the caller has already established that), the authentication record
 * is one this build understands and is bound to the same task, attempt, session
 * and runtime source, and the digest recomputed from the content on disk still
 * matches. A missing record, an unknown format version, a binding conflict or
 * altered content all leave the report unknown with the reason named; none of
 * them is reported as "no report".
 *
 * Authentication says the queue verified the origin of this report. It says
 * nothing about the work being accepted, and nothing about the native turn
 * having stopped.
 */
function authenticateReport(
  task: StoredTask,
  attempt: StoredAttempt | null,
  snapshot: RunSnapshot | null,
  attemptId: string,
): { state: "authenticated" } | { state: "unknown"; code: AdapterGapCode; reason: string } {
  if (!snapshot) {
    return { state: "unknown", code: "report_authentication_unverified", reason: "A report exists but no usable run snapshot is bound to this attempt, so its authentication cannot be checked." };
  }
  const record = snapshot.reportAuthentication;
  if (!record) {
    return { state: "unknown", code: "report_authentication_missing", reason: "This report has no authentication record; reports written before the record existed stay unknown." };
  }
  if (!nonBlank(task.sessionId)) {
    return { state: "unknown", code: "report_authentication_binding_mismatch", reason: "The task does not record the session the authentication must bind to." };
  }
  // The task row is written by the coordinator, which may not have run yet: a
  // report can be complete while task.runtimeSource is still empty. Fall back to
  // the source recorded on the current round, which the association checks have
  // already tied to this task and this attempt. Missing is never a match, no
  // default source is assumed, and any two stored sources that disagree still
  // refuse authentication.
  const declaredSources = [task.runtimeSource, attempt?.runtimeSource, snapshot.runtimeSource].filter(nonBlank);
  const distinctSources = [...new Set(declaredSources)];
  if (distinctSources.length !== 1) {
    return {
      state: "unknown",
      code: "report_authentication_binding_mismatch",
      reason: distinctSources.length === 0
        ? "No record carries a runtime source, so the authentication cannot be bound to one."
        : "The task, attempt row and snapshot disagree about the runtime source.",
    };
  }
  const runtimeSource = distinctSources[0]!;
  const recomputed = snapshotReportDigest(snapshot);
  if (!recomputed || recomputed !== snapshot.reportDigest) {
    return { state: "unknown", code: "report_authentication_digest_mismatch", reason: "The report content no longer matches the digest stored with it." };
  }
  const outcome = verifyReportAuthentication(record, {
    taskId: task.taskId,
    attemptId,
    sessionId: task.sessionId,
    runtimeSource,
    snapshotDigest: recomputed,
    ...(snapshot.driver === "dsh" && snapshot.dsh?.terminal ? { dshProvenance: { hostId: snapshot.dsh.hostId, requestId: snapshot.dsh.requestId, eventSeq: snapshot.dsh.terminal.seq } } : {}),
  });
  if (outcome.state === "authenticated") return { state: "authenticated" };
  switch (outcome.problem) {
    case "missing":
      return { state: "unknown", code: "report_authentication_missing", reason: "This report has no authentication record." };
    case "unsupported_format":
      return { state: "unknown", code: "report_authentication_unsupported", reason: "The authentication record uses a format this build does not verify." };
    case "digest_mismatch":
      return { state: "unknown", code: "report_authentication_digest_mismatch", reason: "The authentication record does not match the report content on disk." };
    default:
      return { state: "unknown", code: "report_authentication_binding_mismatch", reason: "The authentication record is bound to another task, attempt, session or runtime source." };
  }
}

/**
 * Project existing records into display facts.
 *
 * The returned gaps are ordered: identity, association, stop, report,
 * terminal decision, acceptance, live observation, then the action capability
 * gaps. The same input always produces the same result, and the input is not
 * modified.
 */
export function adaptTaskViewFacts(input: TaskViewAdapterInput): TaskViewAdapterResult {
  const gaps: AdapterGap[] = [];
  const { task } = input;
  const attempt = input.attempt ?? null;
  const snapshot = input.snapshot ?? null;
  const cancellation = input.cancellation ?? null;
  const live = input.liveObservation ?? null;

  // --- 1. the current attempt comes from the task alone ----------------
  // A historical attempt row must never be promoted to "the current attempt":
  // doing so would invent an identity for a task that has none.
  const attemptId = nonBlank(task.attemptId) ? task.attemptId : null;
  if (!attemptId) {
    gaps.push(gap("attempt_missing", "attemptId", "The stored task has no durable attempt id, so no identity is invented and no historical row is promoted."));
    // The task's own acceptance decision does not depend on a current
    // attempt, so it is kept even though no facts can be attached to it.
    if (task.state === "accepted") return withoutFacts(gaps, "accepted");
    return withoutFacts(gaps);
  }

  // --- 2. associate every record before reading any fact ---------------
  let attemptConflict = false;
  let snapshotConflict = false;
  let incomplete = false;

  const conflict = (code: AdapterGapCode, field: string, reason: string, onAttempt: boolean) => {
    if (onAttempt) attemptConflict = true;
    else snapshotConflict = true;
    gaps.push(gap(code, field, reason));
  };
  const missing = (code: AdapterGapCode, field: string, reason: string) => {
    incomplete = true;
    gaps.push(gap(code, field, reason));
  };

  if (!attempt) {
    gaps.push(gap("attempt_record_missing", "attemptId", "The attempt id is recorded but the attempt row was not supplied."));
  } else {
    if (attempt.attemptId !== attemptId) {
      conflict("attempt_identity_mismatch", "attempt.attemptId", "The attempt row names another attempt.", true);
    }
    if (attempt.taskId !== task.taskId) {
      conflict("attempt_task_mismatch", "attempt.taskId", "The attempt row belongs to another task.", true);
    }
    if (nonBlank(task.sessionId) && nonBlank(attempt.sessionId)) {
      if (attempt.sessionId !== task.sessionId) {
        conflict("attempt_session_mismatch", "attempt.sessionId", "The attempt row names another session.", true);
      }
    } else if (nonBlank(task.sessionId) !== nonBlank(attempt.sessionId)) {
      missing("session_missing", "attempt.sessionId", "One side records a session and the other does not; a missing session is not a match.");
    }
    if (nonBlank(task.runtimeSource) && nonBlank(attempt.runtimeSource)) {
      if (attempt.runtimeSource !== task.runtimeSource) {
        conflict("attempt_runtime_source_mismatch", "attempt.runtimeSource", "The attempt row names another runtime source.", true);
      }
    } else if (nonBlank(task.runtimeSource) !== nonBlank(attempt.runtimeSource)) {
      missing("runtime_source_missing", "attempt.runtimeSource", "One side records a runtime source and the other does not; a missing source is not a match.");
    }
  }

  if (snapshot) {
    if (snapshot.taskId !== task.taskId) {
      conflict("snapshot_identity_mismatch", "snapshot.taskId", "The snapshot belongs to another task.", false);
    }
    if (snapshot.attemptId !== attemptId) {
      conflict("snapshot_identity_mismatch", "snapshot.attemptId", "The snapshot belongs to another attempt.", false);
    }
    if (nonBlank(task.sessionId) && nonBlank(snapshot.sessionId)) {
      if (snapshot.sessionId !== task.sessionId) {
        conflict("snapshot_identity_mismatch", "snapshot.sessionId", "The snapshot names another session.", false);
      }
    } else if (nonBlank(task.sessionId) !== nonBlank(snapshot.sessionId)) {
      missing("session_missing", "snapshot.sessionId", "One side records a session and the other does not; a missing session is not a match.");
    }
    if (nonBlank(task.runtimeSource) && nonBlank(snapshot.runtimeSource)) {
      if (snapshot.runtimeSource !== task.runtimeSource) {
        conflict("snapshot_identity_mismatch", "snapshot.runtimeSource", "The snapshot was produced by another runtime source.", false);
      }
    } else if (nonBlank(task.runtimeSource) !== nonBlank(snapshot.runtimeSource)) {
      missing("runtime_source_missing", "snapshot.runtimeSource", "One side records a runtime source and the other does not; a missing source is not a match.");
    }
  } else {
    gaps.push(gap("snapshot_missing", "stop.proven", "No run snapshot was supplied, so the stop status is unknown."));
  }

  // Two records that both belong to this task and this attempt must also agree
  // with each other. Comparing only against the task would let a field the task
  // happens to be missing hide a direct conflict between the attempt row and
  // the snapshot.
  //
  // An attempt already judged foreign is not used here: it must not be allowed
  // to invalidate an otherwise matching snapshot.
  if (attempt && snapshot) {
    const attemptCoreOk = attempt.attemptId === attemptId && attempt.taskId === task.taskId;
    const snapshotCoreOk = snapshot.taskId === task.taskId && snapshot.attemptId === attemptId;
    if (attemptCoreOk && snapshotCoreOk && !attemptConflict && !snapshotConflict) {
      if (nonBlank(attempt.sessionId) && nonBlank(snapshot.sessionId)) {
        if (attempt.sessionId !== snapshot.sessionId) {
          conflict("attempt_snapshot_mismatch", "snapshot.sessionId", "The attempt row and the snapshot name different sessions.", false);
        }
      } else if (nonBlank(attempt.sessionId) !== nonBlank(snapshot.sessionId)) {
        missing("session_missing", "snapshot.sessionId", "The attempt row and the snapshot disagree about whether a session exists.");
      }
      if (nonBlank(attempt.runtimeSource) && nonBlank(snapshot.runtimeSource)) {
        if (attempt.runtimeSource !== snapshot.runtimeSource) {
          conflict("attempt_snapshot_mismatch", "snapshot.runtimeSource", "The attempt row and the snapshot name different runtime sources.", false);
        }
      } else if (nonBlank(attempt.runtimeSource) !== nonBlank(snapshot.runtimeSource)) {
        missing("runtime_source_missing", "snapshot.runtimeSource", "The attempt row and the snapshot disagree about whether a runtime source exists.");
      }
    }
  }

  // A record is usable only when it describes this task and this attempt.
  const attemptUsable = attempt !== null && !attemptConflict;
  const snapshotUsable = snapshot !== null && !snapshotConflict;
  const attemptState = attemptUsable ? attempt.state : null;
  const usableSnapshot = snapshotUsable ? snapshot : null;

  // A never-dispatched attempt has no native session by design, so the absence
  // of a session must not be read as an incomplete identity there.
  const neverDispatched = usableSnapshot?.nativeStopSource === "not_dispatched";
  if (!nonBlank(task.sessionId) && !neverDispatched) {
    // A session that no record carries is not a match: it is a missing fact.
    incomplete = true;
    gaps.push(gap("session_missing", "trust.identityMatches", "No session id is recorded, so the identity cannot be established as matching."));
  }
  if (!nonBlank(task.runtimeSource)) {
    incomplete = true;
    gaps.push(gap("runtime_source_missing", "trust.identityMatches", "No runtime source is recorded, so the source cannot be established as matching."));
  }

  // --- 3. stop proof ---------------------------------------------------
  let stopProven: boolean | null = null;
  let stopAt: string | null = null;
  let stopAttemptId: string | null = null;
  if (usableSnapshot) {
    stopProven = hasNativeStopEvidence(usableSnapshot);
    stopAttemptId = attemptId;
    stopAt = parseable(usableSnapshot.nativeStoppedAt) ? usableSnapshot.nativeStoppedAt : null;
    if (stopProven && !stopAt) {
      gaps.push(gap("stop_time_unavailable", "stop.at", "The stop evidence holds but carries no reliable stop instant; the proof still confirms the stop."));
    }
    if (!stopProven) {
      gaps.push(gap("stop_proof_absent", "stop.proven", "The snapshot carries no native stop evidence for this attempt."));
    }
  } else if (snapshot) {
    gaps.push(gap("snapshot_identity_mismatch", "stop.proven", "The snapshot does not belong to this task and attempt, so its stop evidence is not used."));
  }

  // --- 4. report -------------------------------------------------------
  // A report-shaped record in the attempt's own directory means a report
  // exists, even when the snapshot is later rejected as foreign. Reading that
  // as "no report" would be a false negative, so the raw snapshot counts here;
  // authentication below still needs a usable one.
  const hasReportText =
    nonBlank(task.report?.rawText) ||
    Boolean(snapshot && (nonBlank(snapshot.text) || nonBlank(snapshot.reportDigest)));
  let reportState: ReportState;
  let reportAttemptId: string | null = null;
  if (!hasReportText) {
    reportState = "absent";
    reportAttemptId = attemptId;
  } else {
    const authentication = authenticateReport(task, attemptUsable ? attempt : null, usableSnapshot, attemptId);
    if (authentication.state === "authenticated") {
      // The queue verified the origin of this report and the digest still
      // matches the content on disk. Authentication is not acceptance.
      reportState = "authenticated";
      reportAttemptId = attemptId;
    } else {
      reportState = "unknown";
      gaps.push(gap(authentication.code, "report.state", authentication.reason));
    }
  }

  // --- 5. terminal decision -------------------------------------------
  // The cancellation record is authoritative for the cause because it is the
  // only record that carries one, and RunJournal.cancel() writes it with flag
  // "wx" so a later cancellation request cannot replace the first reason.
  // That immutability orders cancellation reasons among themselves; it does
  // not establish a global order against every other terminal state, so a
  // coarse state is never used to rename an explicit reason, and a missing
  // reason is never defaulted.
  const cancellationRecorded = cancellation !== null && cancellation !== undefined;
  const cancelReason = cancellationRecorded && nonBlank(cancellation.reason) ? cancellation.reason : null;
  const cancelled = task.state === "cancelled" || attemptState === "cancelled";
  const failed = task.state === "failed" || attemptState === "failed";

  let decided: boolean | null = null;
  let cause: TerminalDecisionCause | null = null;
  if (cancelReason === "deadline") {
    decided = true;
    cause = "deadline";
  } else if (cancelReason !== null) {
    // "operator" is RunJournal.cancel()'s default reason; the record was
    // written by the cancel entry point, so it is a structured decision.
    decided = true;
    cause = "cancellation";
  } else if (cancellationRecorded) {
    // A cancellation request exists but carries no reason. The request is a
    // decision, so the task is not simply running; the cause, however, is not
    // established and must not be defaulted to operator or deadline.
    decided = true;
    gaps.push(gap("cancellation_reason_missing", "terminalDecision.cause", "A cancellation record exists but carries no reason; the cause is not defaulted."));
  } else if (cancelled && failed) {
    decided = true;
    gaps.push(gap("terminal_cause_conflict", "terminalDecision.cause", "The task and attempt records name different terminal outcomes and no reason record orders them."));
  } else if (cancelled) {
    decided = true;
    cause = "cancellation";
  } else if (failed) {
    decided = true;
    cause = "failure";
  } else if (task.state === "accepted" || attemptState === "accepted") {
    decided = false;
  } else if (task.state === "needs_review" || task.state === "completed" || task.state === "queued" || task.state === "working") {
    decided = false;
  } else {
    // A plain blocked state does not say why it blocked: it can come from a
    // deadline, a native failure or a waiting input. Guessing the cause from
    // the state or from an error string is not allowed.
    gaps.push(gap("terminal_decision_undetermined", "terminalDecision.decided", "The stored state does not establish whether a terminal decision exists."));
  }

  const deadlineReached: boolean | null = cancelReason === "deadline" ? true : (live?.deadlineReached ?? null);

  // --- 6. acceptance ---------------------------------------------------
  // Only the task's own record can establish acceptance for this task. An
  // accepted state on an attempt row counts only when that row is this
  // attempt, so a foreign attempt can never accept the current task.
  const acceptedByTask = task.state === "accepted";
  const acceptedByAttempt = attemptState === "accepted";
  const acceptanceDecision: "accepted" | "not_accepted" = acceptedByTask || acceptedByAttempt ? "accepted" : "not_accepted";
  let acceptanceConflict = false;
  if (acceptanceDecision === "accepted") {
    if (acceptedByTask && attempt !== null && !attemptUsable) {
      acceptanceConflict = true;
      gaps.push(gap("acceptance_conflict", "acceptance.conflict", "The task is accepted but the supplied attempt row is not this attempt; the decision is kept and the foreign row is ignored."));
    } else if (acceptedByTask && attemptUsable && !acceptedByAttempt) {
      acceptanceConflict = true;
      gaps.push(gap("acceptance_conflict", "acceptance.conflict", "The task is accepted but its current attempt row is not; the decision is kept and the conflict is reported."));
    }
    if (snapshotConflict) {
      acceptanceConflict = true;
      gaps.push(gap("acceptance_conflict", "acceptance.conflict", "The acceptance decision is kept although the surrounding evidence does not belong to this attempt."));
    }
  }

  // --- 7. live observation ---------------------------------------------
  let nativePhase: NativePhase = "unknown";
  let nativeWaitingForInput: boolean | null = null;
  let observationCurrent: boolean | null = null;
  let connected: boolean | null = null;
  if (live) {
    // NativePhase describes whether the attempt is queued, working, or not
    // working. A native side waiting for a human is not working, so it maps to
    // "idle"; the waiting fact itself is carried by nativeWaitingForInput.
    nativePhase =
      live.phase === "offline" ? "unknown" : live.phase === "waiting_input" ? "idle" : live.phase;
    nativeWaitingForInput = live.phase === "waiting_input";
    observationCurrent = live.observationCurrent;
    connected = live.connected;
  } else {
    gaps.push(gap("live_observation_absent", "nativePhase", "No live observation was supplied; a stored snapshot's updatedAt is a save time and does not prove the native side is active."));
  }

  // --- 8. trust --------------------------------------------------------
  // Record agreement and live verification are different facts. When a live
  // observation exists its verdict is used as-is: a live null or false is
  // never promoted to true because the stored fields look complete.
  const recordIdentityComplete = !attemptConflict && !snapshotConflict && !incomplete;
  let identityMatches: boolean | null;
  if (attemptConflict || snapshotConflict) identityMatches = false;
  else if (live) identityMatches = live.identityMatches;
  else if (recordIdentityComplete) identityMatches = true;
  else identityMatches = null;

  const facts: TaskDisplayFacts = {
    attemptId,
    acceptance: { decision: acceptanceDecision, conflict: acceptanceConflict },
    terminalDecision: { decided, cause, deadlineReached },
    stop: { attemptId: stopAttemptId, proven: stopProven, at: stopAt },
    nativeWaitingForInput,
    report: { attemptId: reportAttemptId, state: reportState },
    nativePhase,
    trust: { identityMatches, observationCurrent, connected },
  };

  return {
    facts,
    displayState: deriveTaskDisplayState(facts),
    actionFacts: null,
    allowedActions: [...READ_ONLY_ACTIONS],
    gaps: [...gaps, ...actionCapabilityGaps()],
  };
}
