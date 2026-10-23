/**
 * Stage-1 read-only HTTP task view (schema `workbuddy-executor/stage-1`).
 *
 * Contract source: docs/INTERFACE_CONTRACT.md; stage scope fixed by the
 * 2026-10-23 development handoff, task T1.
 *
 * This file declares the stage response shape and its mapping from the
 * read-only projection, and nothing else: no transport, no store, no clock.
 *
 * Relationship to the full vNext TaskView (docs/INTERFACE_CONTRACT.md
 * section 3), stated field by field so the stage response can never be
 * mistaken for the contract's complete view:
 *
 *   - `revision` is always null. Storage keeps no persisted view revision;
 *     the stored agreementVersion and contractHash belong to the initial
 *     contract, not to view revisions, and neither is reused as one. A
 *     persistent revision arrives with T2.
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
 *     no scope inventory exists and no metric was measured; the adapter's
 *     action-capability gaps in `projection.gaps` name each unavailable fact
 *     instead of an empty list pretending "nothing was required".
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

import type { TaskProjectionResult } from "./task-view-reader.js";
import type { StoredTask } from "./task-store.js";
import type { PersistedTaskContract } from "./task-contract.js";
import type { TaskViewDisplayState } from "./task-view.js";

/** Stage schema marker. Distinct from the full `workbuddy-executor/vnext-1`. */
export const STAGE_TASK_VIEW_SCHEMA_VERSION = "workbuddy-executor/stage-1";

/** Task-level fields the stage view cannot establish, named for the client. */
export const STAGE_TASK_VIEW_UNAVAILABLE = [
  "revision_persistent_unavailable",
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
] as const;
export type StageTaskViewUnavailable = (typeof STAGE_TASK_VIEW_UNAVAILABLE)[number];

/**
 * The stage list item / detail body.
 *
 * Every field that the full contract requires but this stage cannot evidence
 * is present with its empty value (null or []), so clients see one shape and
 * the schemaVersion tells them which guarantees apply.
 */
export interface StageTaskView {
  schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
  taskId: string;
  /** Always null in this stage: no persisted view revision exists yet (T2). */
  revision: null;
  /** Always null in this stage: storage has no title field. */
  title: null;
  /** id/displayName null; storedPath is the raw stored workspace, when any. */
  workspace: { id: null; displayName: null; storedPath: string | null };
  attempt: { id: string | null; number: number | null; limit: number | null };
  /** Stored binding facts; both may be null on records that lack them. */
  binding: { sessionId: string | null; runtimeSource: string | null };
  /** The stored task state, verbatim, never rewritten for display. */
  businessState: string;
  /** The projection's derived display state, or null when it cannot derive one. */
  displayState: TaskViewDisplayState | null;
  /** The projection's stop fact for the current attempt; false is not "running". */
  remoteStopped: boolean | null;
  /** Stage offers no actions: export stays closed until its source exists. */
  allowedActions: [];
  /** Always null in this stage. */
  blocker: null;
  /** Stored instants only; see the module doc for each null's meaning. */
  timing: {
    createdAt: string | null;
    attemptDeadlineAt: null;
    terminalDecisionAt: null;
    nativeStoppedAt: string | null;
    reviewedAt: string | null;
    closedAt: null;
    lastObservedAt: string | null;
  };
  /** Always [] in this stage; see STAGE_TASK_VIEW_UNAVAILABLE. */
  checks: [];
  /** Always [] in this stage. */
  changes: [];
  /** Always [] in this stage. */
  artifacts: [];
  /** Always null in this stage. */
  metrics: null;
}

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
export function stageTaskViewFromProjection(input: {
  task: StoredTask;
  projection: TaskProjectionResult;
  contract: PersistedTaskContract | null;
}): StageTaskView {
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
    revision: null,
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
      nativeStoppedAt: stopBound ? facts!.stop.at : null,
      reviewedAt: task.reviewedAt ?? null,
      closedAt: null,
      lastObservedAt: task.updatedAt ?? null,
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: null,
  };
}
