/**
 * vNext TaskView contract types.
 *
 * Authoritative source: docs/INTERFACE_CONTRACT.md
 *   - section 3  "TaskView 与按钮状态" -> field list, displayState, allowedActions
 *   - section 5  "检查与验收记录"       -> CheckResult
 *   - section 6  "事件与指标"           -> MetricSummary
 *
 * Scope: contract foundation only. This module declares types plus the closed
 * enumerations the contract spells out. It derives no state, opens no transport
 * and does not read the task database, so the panel work that follows can build
 * on it without touching the running gateway.
 *
 * Unknown values are expressed with `null` (never `0`, never the string "NA"),
 * as required by the contract preamble.
 */
/** Contract version these types describe. */
export const TASK_VIEW_SCHEMA_VERSION = "workbuddy-executor/vnext-1";
/* ------------------------------------------------------------------ *
 * Closed enumerations. The contract lists these members explicitly.
 * ------------------------------------------------------------------ */
/**
 * Contract section 3: "displayState 枚举：queued、running、waiting_input、
 * waiting_stop、needs_review、accepted、cancelled、failed、expired、unknown".
 */
export const TASK_VIEW_DISPLAY_STATES = [
    "queued",
    "running",
    "waiting_input",
    "waiting_stop",
    "needs_review",
    "accepted",
    "cancelled",
    "failed",
    "expired",
    "unknown",
];
/** Contract section 3: "动作枚举 submit/rework/cancel/review/accept/export". */
export const TASK_VIEW_ACTIONS = ["submit", "rework", "cancel", "review", "accept", "export"];
/**
 * The view itself never carries "submit"; the contract states that submit is
 * decided by health/capacity rather than by the task view.
 */
export const TASK_VIEW_OFFERABLE_ACTIONS = ["rework", "cancel", "review", "accept", "export"];
/** Contract section 5: "kind（provenance/scope/command/semantic）". */
export const TASK_VIEW_CHECK_KINDS = ["provenance", "scope", "command", "semantic"];
/** Contract section 5: "status 为 passed/failed/unknown/not_applicable/checker_error". */
export const TASK_VIEW_CHECK_STATUSES = ["passed", "failed", "unknown", "not_applicable", "checker_error"];
/** Contract section 5: "actor（program/independent_reviewer/worker）". */
export const TASK_VIEW_CHECK_ACTORS = ["program", "independent_reviewer", "worker"];
/** Contract section 3: "category 为 deliverable/metadata/unauthorized". */
export const TASK_VIEW_CHANGE_CATEGORIES = ["deliverable", "metadata", "unauthorized"];
//# sourceMappingURL=task-view.js.map