/**
 * Synthetic TaskView fixtures for the vNext contract.
 *
 * Contract source: docs/INTERFACE_CONTRACT.md
 *   - section 3  TaskView shape and displayState ordering
 *   - section 5  CheckResult / checker_error handling
 *   - section 6  MetricSummary semantics
 *   - section 7  the mock coverage list this file answers
 *
 * Everything here is invented. Project names, task ids, session ids, revisions,
 * hashes and file paths are fabricated for contract work only. No account, no
 * real run directory, no native session log and no private task record appears
 * in this file.
 *
 * Each sample declares the boundary scenarios it exhibits so the coverage is
 * machine-checkable rather than a claim in prose.
 */

import type {
  TaskView,
  TaskViewMetricSummary,
  TaskViewDisplayState,
} from "../../src/task-view.js";

/** Boundary scenarios the contract asks the first mock batch to cover. */
export const TASK_VIEW_BOUNDARIES = [
  "permission_details_unknown",
  "report_before_native_stop",
  "cancel_stop_unconfirmed",
  "late_report",
  "attempt_limit_exhausted",
  "disconnected",
  "checker_error",
  "scope_violation",
  "pre_existing_user_change",
  "stale_revision",
  "cost_unknown",
] as const;
export type TaskViewBoundary = (typeof TASK_VIEW_BOUNDARIES)[number];

/**
 * Scenario facts a sample records for itself.
 *
 * These live beside the view, never inside it: the contract's TaskView has no
 * field for "why this task ended" or "which checks are required", and this
 * module must not invent one. Keeping the facts in the sample lets the tests
 * assert them without teaching the production type a terminal-state inference
 * the contract does not define.
 */
export interface TaskViewSampleScenario {
  /**
   * Which decision produced the terminal state, recorded explicitly by the
   * sample. Timestamps alone cannot carry this: two equal instants do not
   * prove the cause.
   */
  terminalCause?: "deadline" | "cancellation" | "failure";
  /** When the report event occurred, when one did. */
  reportEventAt?: string | null;
  /** When the independent review was recorded for the current attempt. */
  reviewRecordedAt?: string | null;
  /**
   * The review the sample's accept action would cite. The contract requires
   * accept to reference a reviewId belonging to the current agreement and
   * current attempt, so the sample states both and the test checks they match
   * the view's own attempt. These are not TaskView fields.
   */
  reviewId?: string | null;
  reviewAttemptId?: string | null;
  /** Check ids the task agreement declares as required. */
  requiredCheckIds?: string[];
  /** Free-form note about what the sample demonstrates. */
  note?: string;
}

export interface TaskViewSample {
  /** Stable synthetic id of the sample itself. */
  id: string;
  /** Which displayState the sample demonstrates. */
  displayState: TaskViewDisplayState;
  /** Boundary scenarios this sample exhibits. */
  boundaries: TaskViewBoundary[];
  /** Revision that supersedes this sample, used by the stale-revision case. */
  supersededBy?: string;
  /** Scenario facts recorded by the sample, outside the contract view. */
  scenario?: TaskViewSampleScenario;
  /** The contract view under test. */
  view: TaskView;
}

/* ------------------------------------------------------------------ *
 * Shared synthetic building blocks.
 * ------------------------------------------------------------------ */

const PROJECT_ALPHA = { id: "synthetic-project-alpha", displayName: "示例项目 Alpha" } as const;
const PROJECT_BETA = { id: "synthetic-project-beta", displayName: "示例项目 Beta" } as const;

const SYNTHETIC_HASH = (n: string) => `sha256:synthetic${n.padEnd(58, "0").slice(0, 58)}`;

function emptyMetrics(taskId: string): TaskViewMetricSummary {
  return {
    schemaVersion: "workbuddy-executor/vnext-1",
    taskId,
    complete: false,
    timing: {
      wallElapsedSeconds: null,
      queueSeconds: null,
      inputWaitSeconds: null,
      reportToStopSeconds: null,
      stopToAcceptanceSeconds: null,
      observationLagSeconds: null,
    },
    calls: [],
    acceptance: {
      reviewCount: null,
      acceptedAt: null,
      requiredCheckTotal: null,
      requiredCheckPassed: null,
      requiredCheckUnknown: null,
      requiredCheckCheckerError: null,
    },
    rework: { rounds: null, reasons: [], workerSelfCorrectionRounds: null },
    recovery: { events: null, recoveredTasks: null },
    interventions: { episodes: null, requested: null, resolved: null, rejected: null, expired: null },
    usage: {
      catalogRateLabel: null,
      actualCredits: null,
      tokens: null,
      activeReasoningSeconds: null,
    },
    limitations: [],
  };
}

/* ------------------------------------------------------------------ *
 * Samples.
 * ------------------------------------------------------------------ */

/** queued: accepted by the server, no attempt is running yet. */
const queuedSample: TaskViewSample = {
  id: "queued-accepted",
  displayState: "queued",
  boundaries: [],
  view: {
    taskId: "synthetic-task-001",
    revision: "synthetic-revision-001",
    title: "合成样本：等待派工",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-001", number: 1, limit: 3 },
    binding: { sessionId: null, runtimeSource: "desktop_queue" },
    businessState: "queued",
    displayState: "queued",
    remoteStopped: false,
    allowedActions: ["export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T08:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T08:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T08:00:05.000Z",
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: null,
  },
};

/** running: the native session claimed the attempt and is still working. */
const runningSample: TaskViewSample = {
  id: "running-native-claimed",
  displayState: "running",
  boundaries: [],
  view: {
    taskId: "synthetic-task-002",
    revision: "synthetic-revision-002",
    title: "合成样本：原生执行中",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-002", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-002", runtimeSource: "desktop_queue" },
    businessState: "working",
    displayState: "running",
    remoteStopped: false,
    allowedActions: ["cancel", "export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T09:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T09:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T09:04:12.000Z",
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-002"),
      timing: {
        wallElapsedSeconds: null,
        queueSeconds: 42,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: 3,
      },
      calls: [
        {
          channel: "mcp",
          outcome: "succeeded",
          count: 2,
          stdoutBytes: null,
          stderrBytes: null,
          combinedBytes: null,
          wireBytes: null,
        },
      ],
    },
  },
};

/**
 * waiting_input with permission details that cannot be read.
 * The panel must say the details are unavailable and point at the native UI;
 * it must not guess a permission type or offer a gateway-side answer.
 */
const waitingInputSample: TaskViewSample = {
  id: "waiting-input-permission-details-unknown",
  displayState: "waiting_input",
  boundaries: ["permission_details_unknown"],
  view: {
    taskId: "synthetic-task-003",
    revision: "synthetic-revision-003",
    title: "合成样本：等待原生确认且详情不可用",
    workspace: PROJECT_BETA,
    attempt: { id: "synthetic-attempt-003", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-003", runtimeSource: "desktop_queue" },
    businessState: "blocked",
    displayState: "waiting_input",
    remoteStopped: false,
    allowedActions: ["cancel", "export"],
    blocker: {
      kind: "native_permission",
      summary: "需要在 WorkBuddy 中确认操作，但网关无法读取具体权限内容。",
      detailsStatus: "unavailable",
      toolName: null,
      commandSummary: null,
      targetPath: null,
      sessionTitle: "执行：示例项目 Beta",
      resolutionChannel: "native_ui",
      canRespondViaGateway: false,
    },
    timing: {
      createdAt: "2026-10-18T10:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T10:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T10:02:30.000Z",
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-003"),
      limitations: ["原生权限详情不可读；处理位置只能在原生界面确认。"],
    },
  },
};

/**
 * waiting_stop because the report arrived first and the native turn is still
 * busy. No terminal decision exists yet and no stop proof exists yet.
 */
const waitingStopReportFirstSample: TaskViewSample = {
  id: "waiting-stop-report-before-native-stop",
  displayState: "waiting_stop",
  boundaries: ["report_before_native_stop"],
  scenario: {
    reportEventAt: "2026-10-18T11:07:00.000Z",
    note: "报告事件先发生，原生停止证据在其后仍未取得。",
  },
  view: {
    taskId: "synthetic-task-004",
    revision: "synthetic-revision-004",
    title: "合成样本：报告先到但原生未停止",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-004", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-004", runtimeSource: "desktop_queue" },
    businessState: "needs_review",
    displayState: "waiting_stop",
    remoteStopped: false,
    allowedActions: ["cancel", "export"],
    blocker: {
      kind: "native_permission",
      summary: "已收到完成报告，但当前轮次的原生停止尚未确认。",
      detailsStatus: "unavailable",
      toolName: null,
      commandSummary: null,
      targetPath: null,
      sessionTitle: "执行：示例项目 Alpha",
      resolutionChannel: "native_ui",
      canRespondViaGateway: false,
    },
    timing: {
      createdAt: "2026-10-18T11:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T11:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T11:07:44.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-scope-004",
        kind: "scope",
        status: "unknown",
        attemptId: "synthetic-attempt-004",
        evidenceRefs: ["synthetic-evidence/scope-inventory-004"],
        inputHashes: [SYNTHETIC_HASH("1")],
        checkedAt: "2026-10-18T11:06:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
        coverage: "workspace_inventory",
      },
    ],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-004"),
      timing: {
        wallElapsedSeconds: null,
        queueSeconds: null,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: 12,
      },
    },
  },
};

/**
 * waiting_stop after a cancellation whose native stop is still unconfirmed.
 * The cancellation decision exists, the stop proof does not, so the exclusive
 * capacity must not be released.
 */
const waitingStopCancelledSample: TaskViewSample = {
  id: "waiting-stop-cancelled-stop-unconfirmed",
  displayState: "waiting_stop",
  boundaries: ["cancel_stop_unconfirmed"],
  scenario: {
    terminalCause: "cancellation",
    note: "取消决定已发生，原生停止仍未确认，因此不释放排他。",
  },
  view: {
    taskId: "synthetic-task-005",
    revision: "synthetic-revision-005",
    title: "合成样本：已取消但停止未确认",
    workspace: PROJECT_BETA,
    attempt: { id: "synthetic-attempt-005", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-005", runtimeSource: "desktop_queue" },
    businessState: "cancelled",
    displayState: "waiting_stop",
    remoteStopped: false,
    allowedActions: ["cancel", "export"],
    blocker: {
      kind: "native_permission",
      summary: "取消已决定，但当前轮次的原生停止仍未确认；不能据此恢复任务。",
      detailsStatus: "unavailable",
      toolName: null,
      commandSummary: null,
      targetPath: null,
      sessionTitle: "执行：示例项目 Beta",
      resolutionChannel: "native_ui",
      canRespondViaGateway: false,
    },
    timing: {
      createdAt: "2026-10-18T12:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T12:30:00.000Z",
      terminalDecisionAt: "2026-10-18T12:09:00.000Z",
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T12:09:30.000Z",
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-005"),
      limitations: ["取消后的原生停止未确认，排他容量未释放。"],
    },
  },
};

/**
 * needs_review: the report is authenticated and the native stop is confirmed,
 * so independent review and acceptance become possible.
 */
const needsReviewSample: TaskViewSample = {
  id: "needs-review-stop-confirmed",
  displayState: "needs_review",
  boundaries: [],
  scenario: {
    requiredCheckIds: [
      "synthetic-check-provenance-006",
      "synthetic-check-scope-006",
      "synthetic-check-command-006",
      "synthetic-check-semantic-006",
    ],
    reviewRecordedAt: "2026-10-18T13:11:20.000Z",
    reviewId: "synthetic-review-006",
    reviewAttemptId: "synthetic-attempt-006",
    note: "本轮 review 已记录并产生 reviewId，独立语义检查在该阶段完成，因此可执行验收。",
  },
  view: {
    taskId: "synthetic-task-006",
    revision: "synthetic-revision-006",
    title: "合成样本：已停止待独立验收",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-006", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-006", runtimeSource: "desktop_queue" },
    businessState: "needs_review",
    displayState: "needs_review",
    remoteStopped: true,
    allowedActions: ["rework", "review", "accept", "export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T13:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T13:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: "2026-10-18T13:11:20.000Z",
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T13:11:25.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-provenance-006",
        kind: "provenance",
        status: "passed",
        attemptId: "synthetic-attempt-006",
        evidenceRefs: ["synthetic-evidence/provenance-006"],
        inputHashes: [SYNTHETIC_HASH("2")],
        checkedAt: "2026-10-18T13:10:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
      },
      {
        checkId: "synthetic-check-scope-006",
        kind: "scope",
        status: "passed",
        attemptId: "synthetic-attempt-006",
        evidenceRefs: ["synthetic-evidence/scope-inventory-006"],
        inputHashes: [SYNTHETIC_HASH("3")],
        checkedAt: "2026-10-18T13:10:10.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
        coverage: "workspace_inventory",
        mediatedToolPaths: ["src/example-module.ts"],
      },
      {
        checkId: "synthetic-check-command-006",
        kind: "command",
        status: "passed",
        attemptId: "synthetic-attempt-006",
        evidenceRefs: ["synthetic-evidence/command-log-006"],
        inputHashes: [SYNTHETIC_HASH("4")],
        checkedAt: "2026-10-18T13:10:40.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
      },
      {
        checkId: "synthetic-check-semantic-006",
        kind: "semantic",
        status: "passed",
        attemptId: "synthetic-attempt-006",
        evidenceRefs: ["synthetic-evidence/manual-note-006"],
        inputHashes: [SYNTHETIC_HASH("5")],
        checkedAt: "2026-10-18T13:11:20.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "independent_reviewer",
      },
    ],
    changes: [
      {
        path: "src/example-module.ts",
        kind: "file",
        category: "deliverable",
        status: "modified",
      },
    ],
    artifacts: [
      {
        artifactId: "synthetic-artifact-006",
        relativePath: "artifacts/example-output.txt",
        bytes: 2048,
        sha256: SYNTHETIC_HASH("6"),
      },
    ],
    metrics: {
      ...emptyMetrics("synthetic-task-006"),
      timing: {
        wallElapsedSeconds: null,
        queueSeconds: 18,
        inputWaitSeconds: null,
        reportToStopSeconds: 95,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: 5,
      },
      calls: [
        {
          channel: "native",
          outcome: "succeeded",
          count: 1,
          stdoutBytes: null,
          stderrBytes: null,
          combinedBytes: null,
          wireBytes: null,
        },
        {
          channel: "local_check",
          outcome: "succeeded",
          count: 3,
          stdoutBytes: 4096,
          stderrBytes: 0,
          combinedBytes: 4096,
          wireBytes: null,
        },
      ],
      acceptance: {
        reviewCount: 1,
        acceptedAt: null,
        requiredCheckTotal: 4,
        requiredCheckPassed: 4,
        requiredCheckUnknown: 0,
        requiredCheckCheckerError: 0,
      },
      usage: {
        catalogRateLabel: "free_policy_model",
        actualCredits: null,
        tokens: null,
        activeReasoningSeconds: null,
      },
      limitations: ["成本目录标签已知，实际计量未取得。"],
    },
  },
};

/**
 * A superseded revision of the same task as needsReviewSample.
 *
 * This is the snapshot the client still held: the report had already arrived
 * when it was taken, but the native stop had not been proven yet. The contract
 * puts that combination in waiting_stop, not in needs_review, so this old
 * snapshot shows waiting_stop. It keeps the allowedActions it had at the time
 * rather than being rewritten; the stale revision is refused later, when the
 * server re-verifies expectedRevision.
 */
const staleRevisionSample: TaskViewSample = {
  id: "waiting-stop-superseded-revision",
  displayState: "waiting_stop",
  boundaries: ["stale_revision", "report_before_native_stop"],
  supersededBy: "synthetic-revision-006",
  scenario: {
    reportEventAt: "2026-10-18T13:07:00.000Z",
    note: "旧快照已收到报告但停止未证实，按契约显示 waiting_stop；其 allowedActions 保留当时的状态。",
  },
  view: {
    taskId: "synthetic-task-006",
    revision: "synthetic-revision-005-superseded",
    title: "合成样本：旧修订快照等待原生停止",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-006", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-006", runtimeSource: "desktop_queue" },
    businessState: "needs_review",
    displayState: "waiting_stop",
    remoteStopped: false,
    allowedActions: ["cancel", "export"],
    blocker: {
      kind: "native_permission",
      summary: "旧快照已收到完成报告，但当前轮次的原生停止尚未确认。",
      detailsStatus: "unavailable",
      toolName: null,
      commandSummary: null,
      targetPath: null,
      sessionTitle: "执行：示例项目 Alpha",
      resolutionChannel: "native_ui",
      canRespondViaGateway: false,
    },
    timing: {
      createdAt: "2026-10-18T13:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T13:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T13:09:40.000Z",
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: null,
  },
};

/** accepted: a real independent acceptance decision closed the task. */
const acceptedSample: TaskViewSample = {
  id: "accepted-final",
  displayState: "accepted",
  boundaries: [],
  scenario: {
    reviewRecordedAt: "2026-10-18T14:20:30.000Z",
    reviewId: "synthetic-review-007",
    reviewAttemptId: "synthetic-attempt-007",
    requiredCheckIds: ["synthetic-check-provenance-007", "synthetic-check-semantic-007"],
    note: "本轮 review 已记录并产生 reviewId，验收决定引用该 reviewId。",
  },
  view: {
    taskId: "synthetic-task-007",
    revision: "synthetic-revision-007",
    title: "合成样本：独立验收通过",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-007", number: 2, limit: 3 },
    binding: { sessionId: "synthetic-session-007", runtimeSource: "desktop_queue" },
    businessState: "accepted",
    displayState: "accepted",
    remoteStopped: true,
    allowedActions: ["export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T14:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T14:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: "2026-10-18T14:12:00.000Z",
      reviewedAt: "2026-10-18T14:21:35.000Z",
      closedAt: "2026-10-18T14:21:35.000Z",
      lastObservedAt: "2026-10-18T14:21:36.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-provenance-007",
        kind: "provenance",
        status: "passed",
        attemptId: "synthetic-attempt-007",
        evidenceRefs: ["synthetic-evidence/provenance-007"],
        inputHashes: [SYNTHETIC_HASH("7")],
        checkedAt: "2026-10-18T14:11:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
      },
      {
        checkId: "synthetic-check-semantic-007",
        kind: "semantic",
        status: "passed",
        attemptId: "synthetic-attempt-007",
        evidenceRefs: ["synthetic-evidence/manual-note-007"],
        inputHashes: [SYNTHETIC_HASH("8")],
        checkedAt: "2026-10-18T14:20:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "independent_reviewer",
      },
    ],
    changes: [
      {
        path: "src/example-module.ts",
        kind: "file",
        category: "deliverable",
        status: "modified",
      },
    ],
    artifacts: [
      {
        artifactId: "synthetic-artifact-007",
        relativePath: "artifacts/example-output.txt",
        bytes: 3072,
        sha256: SYNTHETIC_HASH("9"),
      },
    ],
    metrics: {
      ...emptyMetrics("synthetic-task-007"),
      complete: true,
      timing: {
        wallElapsedSeconds: 1295,
        queueSeconds: 21,
        inputWaitSeconds: 60,
        reportToStopSeconds: 88,
        stopToAcceptanceSeconds: 575,
        observationLagSeconds: 1,
      },
      acceptance: {
        reviewCount: 1,
        acceptedAt: "2026-10-18T14:21:35.000Z",
        requiredCheckTotal: 2,
        requiredCheckPassed: 2,
        requiredCheckUnknown: 0,
        requiredCheckCheckerError: 0,
      },
      rework: { rounds: 1, reasons: ["worker_content"], workerSelfCorrectionRounds: null },
      recovery: { events: 0, recoveredTasks: 0 },
      interventions: { episodes: 0, requested: 0, resolved: 0, rejected: 0, expired: 0 },
      usage: {
        catalogRateLabel: "free_policy_model",
        actualCredits: null,
        tokens: null,
        activeReasoningSeconds: null,
      },
      limitations: ["成本目录标签已知，实际计量未取得。"],
    },
  },
};

/** cancelled: the cancellation decision is confirmed and the native stop is proven. */
const cancelledSample: TaskViewSample = {
  id: "cancelled-stop-confirmed",
  displayState: "cancelled",
  boundaries: [],
  scenario: { terminalCause: "cancellation" },
  view: {
    taskId: "synthetic-task-008",
    revision: "synthetic-revision-008",
    title: "合成样本：取消并确认停止",
    workspace: PROJECT_BETA,
    attempt: { id: "synthetic-attempt-008", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-008", runtimeSource: "desktop_queue" },
    businessState: "cancelled",
    displayState: "cancelled",
    remoteStopped: true,
    allowedActions: ["export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T15:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T15:30:00.000Z",
      terminalDecisionAt: "2026-10-18T15:04:10.000Z",
      nativeStoppedAt: "2026-10-18T15:04:48.000Z",
      reviewedAt: null,
      closedAt: "2026-10-18T15:04:48.000Z",
      lastObservedAt: "2026-10-18T15:04:50.000Z",
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-008"),
      complete: true,
      timing: {
        wallElapsedSeconds: 288,
        queueSeconds: 12,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: 2,
      },
      rework: { rounds: 0, reasons: [], workerSelfCorrectionRounds: null },
    },
  },
};

/**
 * failed: the observed delivery changed a path outside the declared scope, so
 * acceptance is refused.
 */
const failedScopeSample: TaskViewSample = {
  id: "failed-strict-scope-violation",
  displayState: "failed",
  boundaries: ["scope_violation"],
  scenario: { terminalCause: "failure" },
  view: {
    taskId: "synthetic-task-009",
    revision: "synthetic-revision-009",
    title: "合成样本：越界改动导致失败",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-009", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-009", runtimeSource: "desktop_queue" },
    businessState: "failed",
    displayState: "failed",
    remoteStopped: true,
    allowedActions: ["rework", "export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T16:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T16:30:00.000Z",
      terminalDecisionAt: "2026-10-18T16:08:00.000Z",
      nativeStoppedAt: "2026-10-18T16:08:30.000Z",
      reviewedAt: null,
      closedAt: "2026-10-18T16:08:30.000Z",
      lastObservedAt: "2026-10-18T16:08:31.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-scope-009",
        kind: "scope",
        status: "failed",
        attemptId: "synthetic-attempt-009",
        evidenceRefs: ["synthetic-evidence/scope-inventory-009", "synthetic-evidence/outside-scope-009"],
        inputHashes: [SYNTHETIC_HASH("10")],
        checkedAt: "2026-10-18T16:07:40.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
        coverage: "workspace_inventory",
        mediatedToolPaths: ["src/example-module.ts", "tools/other-tool.ts"],
      },
    ],
    changes: [
      {
        path: "src/example-module.ts",
        kind: "file",
        category: "deliverable",
        status: "modified",
      },
      {
        path: "tools/other-tool.ts",
        kind: "file",
        category: "unauthorized",
        status: "outside_declared_scope",
      },
    ],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-009"),
      complete: true,
      timing: {
        wallElapsedSeconds: 510,
        queueSeconds: 24,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: 1,
      },
      limitations: ["越界覆盖范围仅限可观测增量，未声称覆盖完整进程文件系统。"],
    },
  },
};

/**
 * expired: the deadline decided the task, the native stop is proven and a late
 * report arrived afterwards. The late report stays readable but cannot be
 * accepted, and this version offers no continuation from expired.
 */
const expiredSample: TaskViewSample = {
  id: "expired-late-report",
  displayState: "expired",
  boundaries: ["late_report"],
  scenario: {
    terminalCause: "deadline",
    reportEventAt: "2026-10-18T17:36:00.000Z",
    note: "截止决定先发生，迟到报告在其后到达；报告可查阅但不可验收。",
  },
  view: {
    taskId: "synthetic-task-010",
    revision: "synthetic-revision-010",
    title: "合成样本：到期后收到迟到报告",
    workspace: PROJECT_BETA,
    attempt: { id: "synthetic-attempt-010", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-010", runtimeSource: "desktop_queue" },
    businessState: "failed",
    displayState: "expired",
    remoteStopped: true,
    allowedActions: ["export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T17:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T17:30:00.000Z",
      terminalDecisionAt: "2026-10-18T17:30:00.000Z",
      nativeStoppedAt: "2026-10-18T17:33:12.000Z",
      reviewedAt: null,
      closedAt: "2026-10-18T17:33:12.000Z",
      lastObservedAt: "2026-10-18T17:41:05.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-command-010",
        kind: "command",
        status: "unknown",
        attemptId: "synthetic-attempt-010",
        evidenceRefs: ["synthetic-evidence/late-report-010"],
        inputHashes: [SYNTHETIC_HASH("11")],
        checkedAt: "2026-10-18T17:36:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
      },
    ],
    changes: [],
    artifacts: [
      {
        artifactId: "synthetic-artifact-010",
        relativePath: "artifacts/late-output.txt",
        bytes: null,
        sha256: null,
      },
    ],
    metrics: {
      ...emptyMetrics("synthetic-task-010"),
      complete: true,
      timing: {
        wallElapsedSeconds: 1992,
        queueSeconds: 14,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: 475,
      },
      limitations: ["迟到报告可查阅但不可验收；产物字节与哈希尚未观测。"],
    },
  },
};

/** unknown: the connection to the native side is gone and the facts are insufficient. */
/**
 * needs_review where the native stop is proven but the exact stop moment is
 * not recoverable.
 *
 * Contract section 6: "旧证据缺少可靠时间则为 null". The stop evidence exists
 * and is trusted, so remoteStopped is true, but the recorded stop instant is
 * null and the sub-intervals that depend on it stay null as well.
 */
const stopTimeUnknownSample: TaskViewSample = {
  id: "needs-review-stop-confirmed-time-unknown",
  displayState: "needs_review",
  boundaries: [],
  scenario: {
    requiredCheckIds: ["synthetic-check-provenance-014"],
    reviewRecordedAt: "2026-10-18T21:04:30.000Z",
    reviewId: "synthetic-review-014",
    reviewAttemptId: "synthetic-attempt-014",
    note: "停止证据已确认，但旧证据没有可靠的停止时刻，因此 nativeStoppedAt 为 null。",
  },
  view: {
    taskId: "synthetic-task-014",
    revision: "synthetic-revision-014",
    title: "合成样本：停止已确认但停止时间未知",
    workspace: PROJECT_BETA,
    attempt: { id: "synthetic-attempt-014", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-014", runtimeSource: "desktop_queue" },
    businessState: "needs_review",
    displayState: "needs_review",
    remoteStopped: true,
    allowedActions: ["rework", "review", "accept", "export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T21:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T21:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T21:05:00.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-provenance-014",
        kind: "provenance",
        status: "passed",
        attemptId: "synthetic-attempt-014",
        evidenceRefs: ["synthetic-evidence/provenance-014"],
        inputHashes: [SYNTHETIC_HASH("14")],
        checkedAt: "2026-10-18T21:03:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
      },
    ],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-014"),
      timing: {
        wallElapsedSeconds: null,
        queueSeconds: null,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: null,
      },
      acceptance: {
        reviewCount: 1,
        acceptedAt: null,
        requiredCheckTotal: 1,
        requiredCheckPassed: 1,
        requiredCheckUnknown: 0,
        requiredCheckCheckerError: 0,
      },
      limitations: ["停止证据成立但缺少可靠停止时刻，依赖该时刻的区间保持 null。"],
    },
  },
};

const unknownSample: TaskViewSample = {
  id: "unknown-disconnected",
  displayState: "unknown",
  boundaries: ["disconnected"],
  view: {
    taskId: "synthetic-task-011",
    revision: "synthetic-revision-011",
    title: "合成样本：断线后事实不足",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-011", number: 1, limit: 3 },
    binding: { sessionId: null, runtimeSource: "desktop_queue" },
    businessState: "working",
    displayState: "unknown",
    remoteStopped: false,
    allowedActions: ["export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T18:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T18:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: null,
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T18:03:00.000Z",
    },
    checks: [],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-011"),
      timing: {
        wallElapsedSeconds: null,
        queueSeconds: null,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: null,
      },
      limitations: ["断线期间无法观察；离线时段不计为活跃监督，排他容量保留。"],
    },
  },
};

/**
 * failed after the attempt limit is exhausted, with the cost measurement still
 * unknown. No fourth dispatch may be offered.
 */
const failedAttemptLimitSample: TaskViewSample = {
  id: "failed-attempt-limit-exhausted",
  displayState: "failed",
  boundaries: ["attempt_limit_exhausted", "cost_unknown"],
  scenario: { terminalCause: "failure" },
  view: {
    taskId: "synthetic-task-012",
    revision: "synthetic-revision-012",
    title: "合成样本：三轮耗尽",
    workspace: PROJECT_BETA,
    attempt: { id: "synthetic-attempt-012", number: 3, limit: 3 },
    binding: { sessionId: "synthetic-session-012", runtimeSource: "desktop_queue" },
    businessState: "failed",
    displayState: "failed",
    remoteStopped: true,
    allowedActions: ["export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T19:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T19:30:00.000Z",
      terminalDecisionAt: "2026-10-18T19:52:00.000Z",
      nativeStoppedAt: "2026-10-18T19:52:20.000Z",
      reviewedAt: null,
      closedAt: "2026-10-18T19:52:20.000Z",
      lastObservedAt: "2026-10-18T19:52:21.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-semantic-012",
        kind: "semantic",
        status: "failed",
        attemptId: "synthetic-attempt-012",
        evidenceRefs: ["synthetic-evidence/manual-note-012"],
        inputHashes: [SYNTHETIC_HASH("12")],
        checkedAt: "2026-10-18T19:51:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "independent_reviewer",
      },
    ],
    changes: [],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-012"),
      complete: true,
      timing: {
        wallElapsedSeconds: 3140,
        queueSeconds: 19,
        inputWaitSeconds: null,
        reportToStopSeconds: null,
        stopToAcceptanceSeconds: null,
        observationLagSeconds: 1,
      },
      rework: { rounds: 2, reasons: ["worker_content", "worker_content"], workerSelfCorrectionRounds: null },
      usage: {
        catalogRateLabel: "free_policy_model",
        actualCredits: null,
        tokens: null,
        activeReasoningSeconds: null,
      },
      limitations: ["轮次已耗尽，不提供第四次派发；实际消耗未取得计量，保持 null。"],
    },
  },
};

/**
 * needs_review where the checker itself failed and where a change the user had
 * already made cannot be reliably separated from the worker's change.
 *
 * The conflict is on the same delivered file, not on a separate path: a path
 * outside the agreed scope that existed before dispatch is the user's own
 * business and must not be reclassified as this round's unauthorized delta.
 * What is left is one delivered file whose contents cannot be attributed, so
 * the scope check reports "needs independent attribution" instead of "failed".
 */
const needsReviewCheckerErrorSample: TaskViewSample = {
  id: "needs-review-checker-error-and-user-change-conflict",
  displayState: "needs_review",
  boundaries: ["checker_error", "pre_existing_user_change"],
  scenario: {
    note: "用户改动与 worker 改动落在同一交付文件上，无法可靠区分，等待独立核对。",
    requiredCheckIds: ["synthetic-check-command-013", "synthetic-check-scope-013"],
  },
  view: {
    taskId: "synthetic-task-013",
    revision: "synthetic-revision-013",
    title: "合成样本：验收器错误且交付文件归因不明",
    workspace: PROJECT_ALPHA,
    attempt: { id: "synthetic-attempt-013", number: 1, limit: 3 },
    binding: { sessionId: "synthetic-session-013", runtimeSource: "desktop_queue" },
    businessState: "needs_review",
    displayState: "needs_review",
    remoteStopped: true,
    allowedActions: ["rework", "review", "export"],
    blocker: null,
    timing: {
      createdAt: "2026-10-18T20:00:00.000Z",
      attemptDeadlineAt: "2026-10-18T20:30:00.000Z",
      terminalDecisionAt: null,
      nativeStoppedAt: "2026-10-18T20:14:00.000Z",
      reviewedAt: null,
      closedAt: null,
      lastObservedAt: "2026-10-18T20:15:10.000Z",
    },
    checks: [
      {
        checkId: "synthetic-check-command-013",
        kind: "command",
        status: "checker_error",
        attemptId: "synthetic-attempt-013",
        evidenceRefs: ["synthetic-evidence/checker-log-013"],
        inputHashes: [SYNTHETIC_HASH("13")],
        checkedAt: "2026-10-18T20:13:00.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
      },
      {
        checkId: "synthetic-check-scope-013",
        kind: "scope",
        status: "unknown",
        attemptId: "synthetic-attempt-013",
        evidenceRefs: ["synthetic-evidence/scope-inventory-013", "synthetic-evidence/attribution-open-013"],
        inputHashes: [SYNTHETIC_HASH("14")],
        checkedAt: "2026-10-18T20:14:30.000Z",
        checkerVersion: "synthetic-checker-1",
        actor: "program",
        coverage: "workspace_inventory",
        mediatedToolPaths: ["src/example-module.ts"],
      },
    ],
    changes: [
      {
        path: "src/example-module.ts",
        kind: "file",
        category: "deliverable",
        status: "attribution_unresolved",
      },
    ],
    artifacts: [],
    metrics: {
      ...emptyMetrics("synthetic-task-013"),
      acceptance: {
        reviewCount: 0,
        acceptedAt: null,
        requiredCheckTotal: 2,
        requiredCheckPassed: 0,
        requiredCheckUnknown: 1,
        requiredCheckCheckerError: 1,
      },
      limitations: [
        "验收器错误按 reviewer_error 处理，不计为 worker 内容失败。",
        "同一交付文件上的用户改动与本轮改动无法可靠区分，等待独立核对；派工前已存在的范围外路径不计入本轮增量。",
      ],
    },
  },
};

/* ------------------------------------------------------------------ *
 * Exported collection.
 * ------------------------------------------------------------------ */

export const TASK_VIEW_SAMPLES: readonly TaskViewSample[] = [
  queuedSample,
  runningSample,
  waitingInputSample,
  waitingStopReportFirstSample,
  waitingStopCancelledSample,
  needsReviewSample,
  staleRevisionSample,
  acceptedSample,
  cancelledSample,
  failedScopeSample,
  expiredSample,
  unknownSample,
  failedAttemptLimitSample,
  needsReviewCheckerErrorSample,
  stopTimeUnknownSample,
];

export function samplesByDisplayState(state: TaskViewDisplayState): TaskViewSample[] {
  return TASK_VIEW_SAMPLES.filter(sample => sample.displayState === state);
}
