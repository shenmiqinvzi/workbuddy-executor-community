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
import type { TaskViewAllowedAction, TaskViewDisplayState } from "./task-view.js";
import type { TaskActionFacts } from "./task-view-actions.js";
import { type TaskDisplayFacts } from "./task-view-state.js";
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
export type AdapterGapCode = "attempt_missing" | "attempt_identity_mismatch" | "attempt_task_mismatch" | "attempt_session_mismatch" | "attempt_runtime_source_mismatch" | "attempt_record_missing" | "attempt_snapshot_mismatch" | "snapshot_missing" | "snapshot_identity_mismatch" | "session_missing" | "runtime_source_missing" | "stop_proof_absent" | "stop_time_unavailable" | "report_authentication_unverified" | "terminal_decision_undetermined" | "terminal_cause_conflict" | "cancellation_reason_missing" | "acceptance_conflict" | "live_observation_absent" | "review_id_unavailable" | "agreement_version_unavailable" | "source_summary_unavailable" | "required_checks_unavailable" | "model_verification_unavailable" | "action_facts_not_constructible";
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
/**
 * Project existing records into display facts.
 *
 * The returned gaps are ordered: identity, association, stop, report,
 * terminal decision, acceptance, live observation, then the action capability
 * gaps. The same input always produces the same result, and the input is not
 * modified.
 */
export declare function adaptTaskViewFacts(input: TaskViewAdapterInput): TaskViewAdapterResult;
