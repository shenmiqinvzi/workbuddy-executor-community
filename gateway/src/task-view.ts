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
] as const;
export type TaskViewDisplayState = (typeof TASK_VIEW_DISPLAY_STATES)[number];

/** Contract section 3: "动作枚举 submit/rework/cancel/review/accept/export". */
export const TASK_VIEW_ACTIONS = ["submit", "rework", "cancel", "review", "accept", "export"] as const;
export type TaskViewAction = (typeof TASK_VIEW_ACTIONS)[number];

/**
 * The view itself never carries "submit"; the contract states that submit is
 * decided by health/capacity rather than by the task view.
 */
export const TASK_VIEW_OFFERABLE_ACTIONS = ["rework", "cancel", "review", "accept", "export"] as const;
export type TaskViewAllowedAction = (typeof TASK_VIEW_OFFERABLE_ACTIONS)[number];

/** Contract section 5: "kind（provenance/scope/command/semantic）". */
export const TASK_VIEW_CHECK_KINDS = ["provenance", "scope", "command", "semantic"] as const;
export type TaskViewCheckKind = (typeof TASK_VIEW_CHECK_KINDS)[number];

/** Contract section 5: "status 为 passed/failed/unknown/not_applicable/checker_error". */
export const TASK_VIEW_CHECK_STATUSES = ["passed", "failed", "unknown", "not_applicable", "checker_error"] as const;
export type TaskViewCheckStatus = (typeof TASK_VIEW_CHECK_STATUSES)[number];

/** Contract section 5: "actor（program/independent_reviewer/worker）". */
export const TASK_VIEW_CHECK_ACTORS = ["program", "independent_reviewer", "worker"] as const;
export type TaskViewCheckActor = (typeof TASK_VIEW_CHECK_ACTORS)[number];

/** Contract section 3: "category 为 deliverable/metadata/unauthorized". */
export const TASK_VIEW_CHANGE_CATEGORIES = ["deliverable", "metadata", "unauthorized"] as const;
export type TaskViewChangeCategory = (typeof TASK_VIEW_CHANGE_CATEGORIES)[number];

/* ------------------------------------------------------------------ *
 * Fields the contract does not close.
 *
 * For these the contract shows a single example member. They stay open so this
 * file cannot silently narrow the contract; the observed members are listed for
 * documentation only and are not an exhaustive range.
 * ------------------------------------------------------------------ */

/** businessState is exemplified with "blocked" only; the contract does not close it. */
export type KnownTaskViewBusinessState =
  | "queued"
  | "working"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "needs_review"
  | "accepted";
export type TaskViewBusinessState = KnownTaskViewBusinessState | (string & {});

/** binding.runtimeSource is exemplified with "desktop_queue"; "desktop_interactive" also occurs upstream. */
export type KnownTaskViewRuntimeSource = "desktop_queue" | "desktop_interactive";
export type TaskViewRuntimeSource = KnownTaskViewRuntimeSource | (string & {});

/** blocker.kind is exemplified with "native_permission"; the contract does not close it. */
export type KnownTaskViewBlockerKind = "native_permission";
export type TaskViewBlockerKind = KnownTaskViewBlockerKind | (string & {});

/** blocker.detailsStatus is exemplified with "unavailable"; the contract does not close it. */
export type KnownTaskViewDetailsStatus = "unavailable";
export type TaskViewDetailsStatus = KnownTaskViewDetailsStatus | (string & {});

/** blocker.resolutionChannel is exemplified with "native_ui"; the contract does not close it. */
export type KnownTaskViewResolutionChannel = "native_ui";
export type TaskViewResolutionChannel = KnownTaskViewResolutionChannel | (string & {});

/* ------------------------------------------------------------------ *
 * TaskView building blocks.
 * ------------------------------------------------------------------ */

/** Contract section 3 TaskView example: workspace is {id, displayName}. */
export interface TaskViewWorkspace {
  id: string;
  displayName: string;
}

/** Contract section 3 TaskView example: attempt is {id, number, limit}. */
export interface TaskViewAttempt {
  id: string;
  number: number;
  limit: number;
}

/**
 * Contract section 3 TaskView example: binding is {sessionId, runtimeSource}.
 * sessionId is nullable because a reconnect can lose the native session identity;
 * an unknown session must be null rather than a placeholder.
 */
export interface TaskViewBinding {
  sessionId: string | null;
  runtimeSource: TaskViewRuntimeSource;
}

/**
 * Contract section 3 blocker object. Every detail field is nullable: when the
 * native permission details cannot be read the contract requires the panel to
 * say "details unavailable" instead of inventing a permission type.
 */
export interface TaskViewBlocker {
  kind: TaskViewBlockerKind;
  summary: string;
  detailsStatus: TaskViewDetailsStatus;
  toolName: string | null;
  commandSummary: string | null;
  targetPath: string | null;
  sessionTitle: string;
  resolutionChannel: TaskViewResolutionChannel;
  canRespondViaGateway: boolean;
}

/**
 * Contract section 6 timing facts. Each field carries one distinct fact:
 * terminalDecisionAt is the cancel/fail/deadline decision time, nativeStoppedAt
 * is the time proven by native stop evidence, reviewedAt is the acceptance
 * decision, closedAt is derived, lastObservedAt is the last observation.
 */
export interface TaskViewTiming {
  createdAt: string;
  attemptDeadlineAt: string | null;
  terminalDecisionAt: string | null;
  nativeStoppedAt: string | null;
  reviewedAt: string | null;
  closedAt: string | null;
  lastObservedAt: string;
}

/**
 * Contract section 5 CheckResult. A worker record never substitutes for an
 * independent acceptance record, which is why actor is part of the shape.
 */
export interface TaskViewCheckResult {
  checkId: string;
  kind: TaskViewCheckKind;
  status: TaskViewCheckStatus;
  attemptId: string;
  evidenceRefs: string[];
  inputHashes: string[];
  checkedAt: string;
  checkerVersion: string;
  actor: TaskViewCheckActor;
  /** Scope checks carry the coverage they actually observed. */
  coverage?: "workspace_inventory";
  /** Tool paths the gateway could actually observe, when known. */
  mediatedToolPaths?: string[];
}

/**
 * Contract section 3 changes entries: {path, kind, category, status}.
 * kind and status are not closed by the contract and stay open strings.
 */
export interface TaskViewChange {
  path: string;
  kind: string;
  category: TaskViewChangeCategory;
  status: string;
}

/**
 * Contract section 3 artifacts entries: {artifactId, relativePath, bytes, sha256}.
 * bytes and sha256 are null while the artifact has not been observed yet.
 */
export interface TaskViewArtifact {
  artifactId: string;
  relativePath: string;
  bytes: number | null;
  sha256: string | null;
}

/** Contract section 6: wall elapsed and the separable sub-intervals. */
export interface TaskViewTimingMetrics {
  wallElapsedSeconds: number | null;
  queueSeconds: number | null;
  inputWaitSeconds: number | null;
  reportToStopSeconds: number | null;
  stopToAcceptanceSeconds: number | null;
  observationLagSeconds: number | null;
}

/** Contract section 6: calls grouped by channel and outcome. */
export interface TaskViewCallMetric {
  channel: "mcp" | "cli" | "native" | "local_check";
  outcome: "succeeded" | "failed" | "outcome_unknown";
  count: number;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  combinedBytes: number | null;
  wireBytes: number | null;
}

/** Contract section 6: acceptance counters. */
export interface TaskViewAcceptanceMetrics {
  reviewCount: number | null;
  acceptedAt: string | null;
  requiredCheckTotal: number | null;
  requiredCheckPassed: number | null;
  requiredCheckUnknown: number | null;
  requiredCheckCheckerError: number | null;
}

/** Contract section 6: rework rounds actually sent, and why. */
export interface TaskViewReworkMetrics {
  rounds: number | null;
  reasons: Array<"worker_content" | "worker_scope" | "reviewer_error" | "unknown">;
  workerSelfCorrectionRounds: number | null;
}

/** Contract section 6: recovery counters, kept apart from rework. */
export interface TaskViewRecoveryMetrics {
  events: number | null;
  recoveredTasks: number | null;
}

/** Contract section 6: manual interventions, deduplicated by episode. */
export interface TaskViewInterventionMetrics {
  episodes: number | null;
  requested: number | null;
  resolved: number | null;
  rejected: number | null;
  expired: number | null;
}

/**
 * Contract section 6: usage separates the catalogue rate label from the actually
 * consumed credits, tokens and active reasoning time. A free catalogue label
 * does not mean the whole workflow cost nothing, and unmeasured values stay null.
 */
export interface TaskViewUsageMetrics {
  catalogRateLabel: string | null;
  actualCredits: number | null;
  tokens: number | null;
  activeReasoningSeconds: number | null;
}

/**
 * Contract section 6: MetricSummary. Every numeric that could not be measured
 * is null; a CSV export renders those as NA, the JSON view does not.
 */
export interface TaskViewMetricSummary {
  schemaVersion: string;
  taskId: string;
  complete: boolean;
  timing: TaskViewTimingMetrics;
  calls: TaskViewCallMetric[];
  acceptance: TaskViewAcceptanceMetrics;
  rework: TaskViewReworkMetrics;
  recovery: TaskViewRecoveryMetrics;
  interventions: TaskViewInterventionMetrics;
  usage: TaskViewUsageMetrics;
  limitations: string[];
}

/**
 * Contract section 3 TaskView.
 *
 * businessState keeps the raw business/native fact, displayState is the derived
 * presentation state, and both are carried side by side so the presentation
 * never rewrites the stored state.
 */
export interface TaskView {
  taskId: string;
  /** Persisted, unguessable view revision id. The client echoes it back; it never increments it locally. */
  revision: string;
  title: string;
  workspace: TaskViewWorkspace;
  attempt: TaskViewAttempt;
  binding: TaskViewBinding;
  businessState: TaskViewBusinessState;
  displayState: TaskViewDisplayState;
  /** true means stop proof for the current attempt exists; false does not mean "still running". */
  remoteStopped: boolean;
  /** Server-side suggestion. The server re-verifies before executing anything. */
  allowedActions: TaskViewAllowedAction[];
  /** null when nothing blocks the task. */
  blocker: TaskViewBlocker | null;
  timing: TaskViewTiming;
  checks: TaskViewCheckResult[];
  changes: TaskViewChange[];
  artifacts: TaskViewArtifact[];
  metrics: TaskViewMetricSummary | null;
}
