/**
 * Stage-2 read-only HTTP task view (schema `workbuddy-executor/stage-2`).
 *
 * Contract source: docs/INTERFACE_CONTRACT.md; stage scope fixed by the
 * 2026-10-23 development handoff, tasks T1/T2.
 *
 * This file declares the stage response shape and its mapping from the
 * read-only projection, and nothing else: no transport, no store, no clock.
 *
 * Relationship to the full vNext TaskView (docs/INTERFACE_CONTRACT.md
 * section 3), stated field by field so the stage response can never be
 * mistaken for the contract's complete view:
 *
 *   - `revision` carries the stored persisted view revision when one exists
 *     (T2: regenerated in the same transaction as every fact change,
 *     unguessable, not time-derived); null when the row predates it. The
 *     stored agreementVersion and contractHash belong to the initial
 *     contract, not to view revisions, and neither is reused as one.
 *   - `title` is null. Storage has no title field; the objective is not
 *     silently re-labelled as one.
 *   - `workspace` carries id/displayName null plus the stored directory path
 *     under `storedPath`. No workspace registration is bound yet (T3), so the
 *     contract's `{id, displayName}` cannot be filled and is not invented.
 *   - `attempt.limit` comes only from a verified stored contract's
 *     effectiveMaxAttempts. A task without a contract reports null rather
 *     than the policy default of 3.
 *   - `blocker` is always null, `checks`, `changes` and `artifacts` are
 *     always empty arrays, and `metrics` is always null. No check has run,
 *     the full vNext check inventory and metrics are not supplied; the adapter's
 *     action-capability gaps in `projection.gaps` name each unavailable fact
 *     instead of an empty list pretending "nothing was required".
 *     T5 adds the separate optional workspaceScope stored-facts extension.
 *   - `timing` keeps only stored instants: createdAt (stored), attemptDeadlineAt
 *     null (no per-attempt deadline is durably bound in this stage),
 *     terminalDecisionAt null (cause/time derivation is contract work that is
 *     not evidenced here), nativeStoppedAt (only when the stop proof is bound
 *     to the current attempt), reviewedAt (stored value; it does not assert
 *     an independent review), closedAt null, and lastObservedAt carrying the
 *     task record's own last-write time — a save time, never a live native
 *     observation, and the same fact in both list and detail.
 *   - businessState is the stored task state verbatim; displayState and
 *     remoteStopped are the projection's derived facts. Both keep unknown/null
 *     instead of guessing.
 *
 * Unknown values are null, never 0, never "NA", per the contract preamble.
 */
/** Stage schema marker. Distinct from the full `workbuddy-executor/vnext-1`. */
export const STAGE_TASK_VIEW_SCHEMA_VERSION = "workbuddy-executor/stage-2";
/** Task-level fields the stage view cannot establish, named for the client. */
export const STAGE_TASK_VIEW_UNAVAILABLE = [
    "title_unavailable",
    "workspace_binding_unavailable",
    "blocker_unavailable",
    "checks_unavailable",
    "changes_unavailable",
    "artifacts_unavailable",
    "metrics_unavailable",
    "attempt_deadline_unavailable",
    "terminal_decision_time_unavailable",
    "closed_at_unavailable",
];
/**
 * Map one stored task and its projection into the stage view.
 *
 * Pure: it reads no clock, file, database or network and mutates nothing.
 * All inputs are records that already exist. The stop instant is copied only
 * when the projection's facts bind the stop proof to the current attempt;
 * otherwise it stays null because the proof does not describe this attempt.
 *
 * task/projection/contract must come from one readProjection call for one
 * stored task; this function does not re-read or reconcile them.
 */
export function stageTaskViewFromProjection(input) {
    const { task, projection, contract } = input;
    const ok = projection.ok ? projection : null;
    const facts = ok?.projection.facts ?? null;
    const stopBound = facts !== null
        && facts.stop.proven === true
        && facts.stop.attemptId === facts.attemptId
        && facts.attemptId === (task.attemptId ?? null);
    return {
        schemaVersion: STAGE_TASK_VIEW_SCHEMA_VERSION,
        taskId: task.taskId,
        revision: task.revision ?? null,
        title: null,
        workspace: { id: null, displayName: null, storedPath: task.workspace ?? null },
        attempt: {
            id: task.attemptId ?? null,
            number: typeof task.attempt === "number" ? task.attempt : null,
            limit: contract !== null ? contract.effectiveMaxAttempts : null,
        },
        binding: { sessionId: task.sessionId ?? null, runtimeSource: task.runtimeSource ?? null },
        businessState: task.state,
        displayState: ok?.projection.displayState ?? null,
        remoteStopped: ok !== null && facts !== null ? stopBound : null,
        allowedActions: [],
        blocker: null,
        timing: {
            createdAt: task.createdAt ?? null,
            attemptDeadlineAt: null,
            terminalDecisionAt: null,
            nativeStoppedAt: stopBound ? facts.stop.at : null,
            reviewedAt: task.reviewedAt ?? null,
            closedAt: null,
            lastObservedAt: task.updatedAt ?? null,
        },
        checks: [],
        changes: [],
        artifacts: [],
        metrics: null,
        ...(ok?.workspaceScope ? { workspaceScope: ok.workspaceScope } : {}),
    };
}
//# sourceMappingURL=task-view-stage.js.map