/**
 * Pure derivation of TaskView.allowedActions.
 *
 * Contract source: docs/INTERFACE_CONTRACT.md
 *   - section 3  "TaskView 与按钮状态" -> the action enum, the display rules
 *                 and the statement that a view never carries submit
 *   - section 4  "变更操作、幂等与排他" -> rework, cancel, reviews and accept
 *                 carry operationId, expectedRevision and expectedAttemptId
 *   - section 5  "检查与验收记录"     -> the conditions accept requires
 *
 * Scope of this module:
 *   - It turns the facts the caller supplies into a suggestion of which
 *     actions the panel may offer. It executes nothing.
 *   - It reads no clock, no database, no network and no file, mutates nothing,
 *     and never inspects a file on this machine. It is not a safety check:
 *     the contract requires the server to re-verify every condition again
 *     before it executes an action, and this function cannot stand in for
 *     that. A button that was enabled a moment ago may be stale.
 *   - It does not accept a client supplied allowedActions list as its answer.
 *     The caller passes facts; the function decides.
 *   - It derives the actions only. The display state is derived separately by
 *     deriveTaskDisplayState, which this module reuses.
 *
 * What this module actually proves, and what it does not:
 *   - It compares the values it is given. A non-blank string that equals the
 *     current value is treated as the same identity. Equality of two strings
 *     is the whole binding check.
 *   - It does not hash the source, does not re-read a review record, does not
 *     confirm that a review was produced by an independent reviewer, does not
 *     bind a task to a native session, and does not verify that evidence
 *     exists behind a check reference. Those remain the caller's work; this
 *     module only refuses to offer an action when the values it was given are
 *     blank, disagree, or are not established.
 *   - Every flag means the server established the fact from its own record,
 *     not that a client said so. A fact that could not be established is
 *     null, and null never enables an action.
 *   - Check records are grouped by check id after the records of other
 *     attempts are dropped. One id is one check, and its records must agree on
 *     kind, status and actor before the result can be used. Two ids are two
 *     checks, so they may be run by different actors. An id whose records
 *     disagree leaves the result unresolved, which withholds acceptance.
 */
import type { TaskViewAllowedAction } from "./task-view.js";
import { type DerivationFlag, type TaskDisplayFacts } from "./task-view-state.js";
/**
 * The check records of the current attempt, as the server recorded them.
 *
 * The shape mirrors the contract's CheckResult but keeps only what the
 * acceptance conditions need. The caller maps its own records onto it.
 */
export interface ActionCheckFacts {
    checkId: string;
    /** The attempt the record belongs to. */
    attemptId: string;
    kind: "provenance" | "scope" | "command" | "semantic";
    status: "passed" | "failed" | "unknown" | "not_applicable" | "checker_error";
    /**
     * The check must not be a worker's own report. A worker record cannot
     * stand in for an independent acceptance record.
     */
    actor: "program" | "independent_reviewer" | "worker";
}
/**
 * The review that an accept would cite.
 *
 * The contract requires accept to reference a reviewId that belongs to the
 * current agreement and the current source. Every field is compared, so a
 * review of another task, an earlier attempt, an earlier agreement or an
 * earlier source cannot be used. A blank field never matches anything.
 */
export interface ReviewFacts {
    reviewId: string | null;
    /** The task the review belongs to. */
    taskId: string | null;
    attemptId: string | null;
    /** The agreement version the review was taken against. */
    agreementVersion: string | null;
    /** The source summary the review was taken against. */
    sourceSummary: string | null;
}
/**
 * The conditions that make a rework possible.
 *
 * A rework starts a new execution, so it is the only action that depends on
 * the model policy and on there being another attempt available. Both budget
 * fields are nullable so that an unknown budget is expressed as null instead
 * of being guessed; a null budget never allows a new execution.
 */
export interface ReworkFacts {
    /** The attempts the agreement allows in total, or null when unknown. */
    attemptLimit: number | null;
    /** The number of the attempt the rework would continue from, or null when unknown. */
    attemptNumber: number | null;
    /**
     * Whether the agreement and the task policy allow this task to continue
     * at all. A cancelled or expired task cannot be continued, and a failed
     * task may only be continued where an explicit recovery policy says so.
     */
    continuationAllowed: DerivationFlag;
    /**
     * The model the rework would use, when the server has verified it. The
     * model policy is only consulted for an action that starts new execution.
     */
    modelVerified: DerivationFlag;
    /** Whether the verified model satisfies the free model policy. */
    modelPolicySatisfied: DerivationFlag;
}
/**
 * Every fact the action derivation reads.
 *
 * The outer identity fields describe the task and attempt the caller is
 * asking about. They must agree with the attempt inside display, otherwise
 * the caller mixed two records and only export is offered.
 */
export interface TaskActionFacts {
    /** The task these facts describe. */
    taskId: string;
    /** The attempt these facts describe. Must equal display.attemptId. */
    attemptId: string;
    /** The agreement version currently in force. */
    agreementVersion: string;
    /** The source summary as it stands now. */
    currentSourceSummary: string;
    /** The facts the display state is derived from. */
    display: TaskDisplayFacts;
    /** The check records of the current attempt. */
    checks: ActionCheckFacts[];
    /** The check ids the agreement declares as required. */
    requiredCheckIds: string[];
    /** The review an accept would cite. */
    review: ReviewFacts;
    /** The conditions for a rework. */
    rework: ReworkFacts;
    /**
     * Whether the current worker may be cancelled, that is whether the caller
     * owns the attempt and the control conditions are known. The contract ties
     * cancel to the exclusive capacity of the task.
     */
    cancellationAvailable: DerivationFlag;
}
/**
 * Derive the actions the panel may offer for a task.
 *
 * The display state comes from deriveTaskDisplayState, so the actions and
 * the state always agree. The result is a suggestion: the server re-verifies
 * every condition before it executes anything, and an action that was
 * offered a moment ago may be stale.
 */
export declare function deriveTaskAllowedActions(facts: TaskActionFacts): TaskViewAllowedAction[];
