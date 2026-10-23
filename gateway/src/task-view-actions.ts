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
import {
  deriveTaskDisplayState,
  type DerivationFlag,
  type TaskDisplayFacts,
} from "./task-view-state.js";

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
 * The fixed order in which the actions are listed. The contract does not
 * order them, so a stable order is used: reading the list gives the same
 * result every time and no action appears twice.
 */
const ACTION_ORDER: readonly TaskViewAllowedAction[] = ["rework", "cancel", "review", "accept", "export"];

/** Whether a value is a string that carries something besides whitespace. */
function isNonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Whether a value is a usable positive integer, so that a budget is real. */
function isPositiveInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The one result a check id has for the current attempt. */
interface ResolvedCheck {
  kind: ActionCheckFacts["kind"];
  status: ActionCheckFacts["status"];
  actor: ActionCheckFacts["actor"];
}

/**
 * Group the records of the current attempt by check id.
 *
 * The records of other attempts are discarded first, because a record of an
 * earlier round says nothing about this one. Grouping by check id keeps two
 * different checks apart: two ids are two checks, and nothing about one says
 * how the other was run or by whom.
 */
function currentAttemptCheckGroups(facts: TaskActionFacts): Map<string, ActionCheckFacts[]> {
  const groups = new Map<string, ActionCheckFacts[]>();
  for (const record of facts.checks) {
    if (record.attemptId !== facts.attemptId) continue;
    const existing = groups.get(record.checkId);
    if (existing) existing.push(record);
    else groups.set(record.checkId, [record]);
  }
  return groups;
}

/**
 * Resolve one check id from the records that carry it.
 *
 * The result is usable only when every record of that id agrees on all three
 * of kind, status and actor. Kind is part of the identity: a record set that
 * calls the same id both a command check and a semantic check does not
 * describe one check, so neither result may be used. Resolving instead of
 * taking the first match also keeps the answer independent of the order the
 * records happen to be stored in, which is how a passed record could
 * otherwise hide a failed one.
 */
function resolveCheck(records: ActionCheckFacts[]): ResolvedCheck | null {
  const kinds = new Set(records.map(record => record.kind));
  const statuses = new Set(records.map(record => record.status));
  const actors = new Set(records.map(record => record.actor));
  if (kinds.size !== 1 || statuses.size !== 1 || actors.size !== 1) return null;
  const [kind] = kinds;
  const [status] = statuses;
  const [actor] = actors;
  if (kind === undefined || status === undefined || actor === undefined) return null;
  return { kind, status, actor };
}

/**
 * Whether any check id of the current attempt cannot be resolved.
 *
 * An unresolvable id means the record set does not describe one check, so it
 * is not known which result applies to the task. Acceptance is withheld until
 * that is resolved, whichever kind the conflicting records carry.
 */
function anyCheckUnresolved(groups: Map<string, ActionCheckFacts[]>): boolean {
  for (const records of groups.values()) {
    if (!resolveCheck(records)) return true;
  }
  return false;
}

/**
 * Whether every required check of the current attempt is strictly passed.
 *
 * The contract says the required checks must all pass, and that
 * not_applicable only applies to an item the agreement declared as
 * non-required in advance. An unknown or a checker_error result is never a
 * pass, a worker record never stands in for a machine or independent review
 * result, and a required id whose records disagree is not a pass either.
 */
function allRequiredChecksPassed(facts: TaskActionFacts, groups: Map<string, ActionCheckFacts[]>): boolean {
  for (const checkId of facts.requiredCheckIds) {
    if (!isNonBlank(checkId)) return false;
    const records = groups.get(checkId);
    if (!records) return false;
    const resolved = resolveCheck(records);
    if (!resolved) return false;
    if (resolved.status !== "passed") return false;
    if (resolved.actor === "worker") return false;
  }
  return true;
}

/**
 * Whether every scope check of the current attempt passed.
 *
 * The groups are examined one by one rather than by filtering the records to
 * the scope kind first: filtering first would hide a group that carries a
 * scope record next to a record of another kind, and such a group does not
 * establish that the scope passed.
 *
 * Each scope group must resolve, must be passed, and must not be a worker
 * record. Two different scope ids are two different checks, so they may be
 * run by different actors; one being a program check and the other an
 * independent review does not make either of them wrong.
 */
function scopeCheckPassed(groups: Map<string, ActionCheckFacts[]>): boolean {
  let sawScopeCheck = false;
  for (const records of groups.values()) {
    const resolved = resolveCheck(records);
    if (!resolved) {
      // An unresolvable group that carries a scope record leaves it unknown
      // whether the scope passed, so it cannot be skipped.
      if (records.some(record => record.kind === "scope")) return false;
      continue;
    }
    if (resolved.kind !== "scope") continue;
    sawScopeCheck = true;
    if (resolved.status !== "passed") return false;
    if (resolved.actor === "worker") return false;
  }
  return sawScopeCheck;
}

/**
 * Whether a review exists that is bound to the current task, attempt,
 * agreement and source.
 *
 * Both sides must carry a value and the values must be equal. A blank string
 * is not an identity, so a blank field on either side leaves the review
 * unbound and acceptance unavailable.
 */
function reviewIsCurrent(facts: TaskActionFacts): boolean {
  if (!isNonBlank(facts.taskId)) return false;
  if (!isNonBlank(facts.attemptId)) return false;
  if (!isNonBlank(facts.agreementVersion)) return false;
  if (!isNonBlank(facts.currentSourceSummary)) return false;

  const review = facts.review;
  if (!isNonBlank(review.reviewId)) return false;
  if (!isNonBlank(review.taskId) || review.taskId !== facts.taskId) return false;
  if (!isNonBlank(review.attemptId) || review.attemptId !== facts.attemptId) return false;
  if (!isNonBlank(review.agreementVersion) || review.agreementVersion !== facts.agreementVersion) return false;
  if (!isNonBlank(review.sourceSummary) || review.sourceSummary !== facts.currentSourceSummary) return false;
  return true;
}

/**
 * Whether accept may be offered.
 *
 * Every condition of contract section 5 must hold: the task is awaiting
 * review, the identity matches, the report is authenticated for this
 * attempt, the native stop is confirmed, the required checks all passed, the
 * scope has no conflict, and a reviewId is bound to the current task, the
 * current attempt, the current agreement and the current source. A condition
 * that is unknown, stale, blank or conflicting withholds the action. A review
 * count is not a reviewId and never replaces one.
 */
function acceptIsAvailable(facts: TaskActionFacts, displayState: ReturnType<typeof deriveTaskDisplayState>): boolean {
  if (displayState !== "needs_review") return false;
  if (facts.display.trust.identityMatches !== true) return false;
  if (facts.display.report.attemptId !== facts.attemptId) return false;
  if (facts.display.report.state !== "authenticated") return false;
  if (facts.display.stop.attemptId !== facts.attemptId) return false;
  if (facts.display.stop.proven !== true) return false;
  const groups = currentAttemptCheckGroups(facts);
  if (anyCheckUnresolved(groups)) return false;
  if (!scopeCheckPassed(groups)) return false;
  if (!allRequiredChecksPassed(facts, groups)) return false;
  if (!reviewIsCurrent(facts)) return false;
  return true;
}

/**
 * Whether rework may be offered.
 *
 * A rework starts new execution, so it needs a matching identity, a confirmed
 * stop, a real attempt budget that is not exhausted, a policy that allows
 * continuing, and a model that the server has verified against the free model
 * policy.
 *
 * The identity check is deliberately explicit. A report and a stop proof that
 * are still valid do not prove that the native side is the same executor this
 * task owns, so an unknown or mismatched identity must not dispatch another
 * round to it. A lost connection on its own is not a mismatch: as long as the
 * identity is established, a disconnected observation does not clear the
 * facts that already exist.
 *
 * A cancelled or expired task cannot be continued. A failed task is continued
 * only where an explicit recovery policy allows it, never because the word
 * failed appears.
 */
function reworkIsAvailable(facts: TaskActionFacts, displayState: ReturnType<typeof deriveTaskDisplayState>): boolean {
  if (displayState === "accepted" || displayState === "cancelled" || displayState === "expired") return false;
  if (displayState === "unknown") return false;
  if (facts.display.trust.identityMatches !== true) return false;
  if (facts.display.stop.attemptId !== facts.attemptId) return false;
  if (facts.display.stop.proven !== true) return false;
  if (facts.rework.continuationAllowed !== true) return false;
  if (!isPositiveInteger(facts.rework.attemptLimit)) return false;
  if (!isPositiveInteger(facts.rework.attemptNumber)) return false;
  if (facts.rework.attemptNumber >= facts.rework.attemptLimit) return false;
  if (facts.rework.modelVerified !== true) return false;
  if (facts.rework.modelPolicySatisfied !== true) return false;
  return true;
}

/**
 * Derive the actions the panel may offer for a task.
 *
 * The display state comes from deriveTaskDisplayState, so the actions and
 * the state always agree. The result is a suggestion: the server re-verifies
 * every condition before it executes anything, and an action that was
 * offered a moment ago may be stale.
 */
export function deriveTaskAllowedActions(facts: TaskActionFacts): TaskViewAllowedAction[] {
  // The outer identity and the attempt inside display must describe the same
  // attempt. A mismatch means the caller combined two records, so nothing
  // beyond reading the existing snapshot is safe to offer.
  if (facts.attemptId !== facts.display.attemptId) return ["export"];

  const displayState = deriveTaskDisplayState(facts.display);
  const offered = new Set<TaskViewAllowedAction>();

  // Export reads an existing task snapshot. It is available for every task
  // and never depends on the native side being reachable.
  offered.add("export");

  switch (displayState) {
    case "accepted":
    case "cancelled":
    case "expired":
    case "unknown":
      // A closed task offers no further work, and an unknown one offers
      // nothing that could act on facts that are not established.
      break;

    case "queued":
    case "running":
    case "waiting_input":
      // The contract allows cancel here. It is offered only when the caller
      // established that it owns the attempt and the control conditions.
      if (facts.cancellationAvailable === true) offered.add("cancel");
      break;

    case "waiting_stop":
      // The stop is not proven. Cancel means asking this task to stop or
      // asking again for the stop to be observed; it never means the task has
      // stopped, and nothing may be reviewed, accepted or reworked here.
      if (facts.cancellationAvailable === true) offered.add("cancel");
      break;

    case "needs_review":
      // A review may be recorded. Accept needs every condition of contract
      // section 5, not the display state alone.
      offered.add("review");
      if (acceptIsAvailable(facts, displayState)) offered.add("accept");
      if (reworkIsAvailable(facts, displayState)) offered.add("rework");
      break;

    case "failed":
      // A failed task may only be continued where an explicit recovery
      // policy allows it, which the caller states.
      if (reworkIsAvailable(facts, displayState)) offered.add("rework");
      break;
  }

  // The order is fixed and no action appears twice. submit is never offered:
  // the contract decides it from health and capacity, not from a task view.
  return ACTION_ORDER.filter(action => offered.has(action));
}
