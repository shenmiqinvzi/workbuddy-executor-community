/**
 * P0-5 独立真实验证：计划、证据形状与预检（纯函数，无时钟、无 IO）。
 *
 * 三条硬规则，全部写进类型与返回值，不靠人记：
 *  1. 每一步都必须自带“这条证据不能证明什么”（mayNotProve 不可为空）；
 *  2. 证据只分“记到了 / 没记到”，不产出 pass/fail；
 *  3. 容量被别人占着时，预检直接报阻塞——不允许“先跑跑看”。
 */

export const VERIFICATION_PLAN_REVISION = "p0-5-verification-1";

export interface VerificationStep {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  /** 必须全部记到，这一步才算 recorded。 */
  readonly evidence: readonly string[];
  /** 这条证据允许我们说的话。 */
  readonly mayProve: string;
  /** 这条证据永远证明不了的事（不得为空）。 */
  readonly mayNotProve: string;
}

export const VERIFICATION_STEPS: readonly VerificationStep[] = Object.freeze([
  {
    id: "preflight",
    title: "预检",
    purpose: "记录容量占用者、派工开关、库路径与工作区可写性，确认这次验证不会碰到旧账本。",
    evidence: ["capacity", "dispatch_flag", "database_path", "workspace"],
    mayProve: "本次验证使用的状态目录与容量状态。",
    mayNotProve: "容量为空不等于旧任务没有副作用。",
  },
  {
    id: "reserve",
    title: "预留身份",
    purpose: "记下本次要用的 sessionId 与 workerKey，确保重试不会新建第二条会话。",
    evidence: ["reserved_session", "worker_key"],
    mayProve: "本次预留的身份是哪一个 UUID。",
    mayNotProve: "预留成功不代表原生端已经创建。",
  },
  {
    id: "native-create",
    title: "原生创建",
    purpose: "记录 createWorker 的返回身份、耗时与错误文本。",
    evidence: ["create_result", "elapsed_ms"],
    mayProve: "原生调用这一次返回了什么。",
    mayNotProve: "超时或抛错都不证明请求未到达原生端。",
  },
  {
    id: "desktop-registration",
    title: "桌面历史登记",
    purpose: "记录桌面历史库出现该会话的时间点（可能比创建晚）。",
    evidence: ["registered_at"],
    mayProve: "本地历史库在某一刻登记了这个会话。",
    mayNotProve: "没登记不等于没有创建；登记时间也不等于创建时间。",
  },
  {
    id: "dispatch",
    title: "派工",
    purpose: "记录派工请求编号、回执状态与租约结算结论。",
    evidence: ["request_id", "receipt_state", "lease"],
    mayProve: "网关发出过哪个派工请求，以及当时看到的回执与租约。",
    mayNotProve: "没有回执不等于没有副作用；租约过期只说明所有者没心跳。",
  },
  {
    id: "report-received",
    title: "收到报告",
    purpose: "记录报告文本、来源与收到时间。",
    evidence: ["report_text", "received_at"],
    mayProve: "某一刻收到了某段报告文本。",
    mayNotProve: "收到报告不等于原生已停止，也不等于独立验收通过。",
  },
  {
    id: "native-stop",
    title: "原生停止",
    purpose: "记录原生端的停止证据（不是报告文本）。",
    evidence: ["stop_evidence"],
    mayProve: "原生端在某一刻呈现出停止状态。",
    mayNotProve: "停止不等于结果正确，也不等于已经验收。",
  },
  {
    id: "independent-review",
    title: "独立审查",
    purpose: "记录审查者身份、审查对象与结论；审查者不得是执行者本人。",
    evidence: ["reviewer", "reviewed_artifact", "review_conclusion"],
    mayProve: "谁在什么材料上给出了什么结论。",
    mayNotProve: "审查通过不等于真实派工验收（源码验证≠真实派工验收）。",
  },
]);

export interface VerificationEvidence {
  readonly stepId: string;
  readonly kind: string;
  readonly value: string;
  readonly observedAt: string;
}

export type VerificationStepStatus = "recorded" | "missing";

/** 证据值里出现这些词，说明记到的是失败而不是结果；
 *  把 “identity_mismatch / reviewer=executor / error” 当成“记到了”会让下面的声明变成假话。 */
const FAILURE_VALUE = /^(?:identity_mismatch|mismatch|error|failed|failure|timeout|denied|rejected|refused|unknown)\b/i;
const UNKNOWN_VALUE = /^unknown\b/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** 有形状要求的证据：值必须真的是那种东西，不能靠“非空”过关。 */
const EVIDENCE_SHAPE: Readonly<Record<string, RegExp>> = Object.freeze({ reserved_session: UUID });

export function usableEvidence(item: VerificationEvidence): boolean {
  const value = item.value.trim();
  if (!value) return false;
  const shape = EVIDENCE_SHAPE[item.kind];
  if (shape && !shape.test(value)) return false;
  if (item.kind === "capacity" && UNKNOWN_VALUE.test(value)) return false;
  return !FAILURE_VALUE.test(value);
}

export interface VerificationStepResult {
  readonly id: string;
  readonly title: string;
  readonly status: VerificationStepStatus;
  readonly missing: readonly string[];
  readonly mayNotProve: string;
}

export interface VerificationSummary {
  readonly revision: string;
  readonly steps: readonly VerificationStepResult[];
  readonly recorded: number;
  readonly missing: number;
}

export function stepResult(step: VerificationStep, evidence: readonly VerificationEvidence[]): VerificationStepResult {
  const present = new Set(evidence.filter(item => item.stepId === step.id && usableEvidence(item)).map(item => item.kind));
  const missing = step.evidence.filter(kind => !present.has(kind));
  return {
    id: step.id,
    title: step.title,
    status: missing.length ? "missing" : "recorded",
    missing,
    mayNotProve: step.mayNotProve,
  };
}

export function verificationSummary(evidence: readonly VerificationEvidence[]): VerificationSummary {
  const steps = VERIFICATION_STEPS.map(step => stepResult(step, evidence));
  return {
    revision: VERIFICATION_PLAN_REVISION,
    steps,
    recorded: steps.filter(step => step.status === "recorded").length,
    missing: steps.filter(step => step.status === "missing").length,
  };
}

export interface VerificationClaim {
  readonly claim: string;
  readonly limitation: string;
}

export interface ClaimContext {
  /** 执行者是谁；不给就说明“审查者不是执行者”这件事没有被核对过。 */
  readonly executor?: string;
}

/**
 * 允许对外说的话，由“哪几步有证据”机械推导。
 * 没有对应证据时返回空数组——不说比说错安全。
 */
export function allowedClaims(evidence: readonly VerificationEvidence[], context: ClaimContext = {}): VerificationClaim[] {
  const done = (id: string) => stepResult(VERIFICATION_STEPS.find(step => step.id === id)!, evidence).status === "recorded";
  const value = (stepId: string, kind: string) => evidence.find(item => item.stepId === stepId && item.kind === kind && usableEvidence(item))?.value.trim() ?? "";
  const claims: VerificationClaim[] = [];
  if (done("preflight")) claims.push({ claim: "本次验证在独立状态目录中开始，旧账本未被打开写入。", limitation: "独立目录不证明旧任务的副作用范围。" });
  if (done("reserve") && done("native-create")) {
    const reserved = value("reserve", "reserved_session");
    const created = UUID.exec(value("native-create", "create_result"))?.[0] ?? "";
    const same = !!reserved && !!created && reserved.toLowerCase() === created.toLowerCase();
    claims.push(same
      ? { claim: "本次预留身份与原生返回身份一致。", limitation: "一致不等于该会话已被派工或产生结果。" }
      : { claim: "记录到预留身份与原生创建返回，但两份证据没有指向同一个会话 UUID。", limitation: "没有核对成一致，就不能说身份一致。" });
  }
  if (done("dispatch")) claims.push({ claim: "网关记录到一次派工请求及其回执。", limitation: "回执状态不等于最终结果。" });
  if (done("report-received") && !done("native-stop")) claims.push({ claim: "已收到报告，但原生停止尚未确认。", limitation: "报告收到≠原生停止≠独立验收。" });
  if (done("report-received") && done("native-stop")) claims.push({ claim: "已收到报告，且记录到原生停止证据。", limitation: "停止证据不等于结果正确。" });
  if (done("independent-review")) {
    const reviewer = value("independent-review", "reviewer").toLowerCase();
    const executor = (context.executor ?? "").trim().toLowerCase();
    const selfReview = /^(?:executor|self|author|executor-self|same-as-executor)$/.test(reviewer);
    // “不是执行者”只有在知道执行者是谁时才是事实；没给执行者就只能说记录了一份审查结论。
    const independent = !!reviewer && !selfReview && executor.length > 0 && reviewer !== executor;
    claims.push(independent
      ? { claim: "存在一份由非执行者给出的审查结论。", limitation: "审查通过仍不等同真实派工验收。" }
      : { claim: "记录到一份审查结论，但审查者与执行者的独立性没有得到核对。", limitation: "审查通过仍不等同真实派工验收；身份未核对时更不能当成独立审查。" });
  }
  return claims;
}

export interface PreflightInput {
  readonly occupant: { taskId: string; executor: string; operationId: string } | null;
  readonly dispatchEnabled: boolean;
  readonly databasePath: string;
  /** 账本里是否真的有一张可读的 workflow_capacity 表；
   *  表缺失时“没看到占用者”只说明看不见，不说明容量是空的。 */
  readonly capacityTable: boolean;
  readonly workspace: string;
  readonly workspaceWritable: boolean;
}

export interface PreflightReport {
  readonly revision: string;
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly observed: { readonly capacity: string; readonly dispatch: string; readonly database: string; readonly workspace: string };
  readonly reminder: string;
}

export function preflightReport(input: PreflightInput): PreflightReport {
  const blockers: string[] = [];
  if (input.occupant) blockers.push(`capacity_held_by_another_task: ${input.occupant.taskId} (${input.occupant.operationId})`);
  if (input.databasePath && !input.capacityTable) blockers.push(`capacity_table_missing: ${input.databasePath} (workflow_capacity 表不存在或不可读)`);
  if (!input.dispatchEnabled) blockers.push("dispatch_not_enabled: WORKBUDDY_DESKTOP_DISPATCH_ENABLED 未设为 1");
  if (!input.workspaceWritable) blockers.push(`workspace_not_writable: ${input.workspace}`);
  if (!input.databasePath) blockers.push("database_path_missing");
  return {
    revision: VERIFICATION_PLAN_REVISION,
    ready: blockers.length === 0,
    blockers,
    observed: {
      capacity: input.occupant
        ? `occupied by ${input.occupant.taskId}`
        : !input.databasePath
          ? "unknown (database missing)"
          : input.capacityTable ? "free" : "unknown (workflow_capacity missing)",
      dispatch: input.dispatchEnabled ? "enabled" : "disabled",
      database: input.databasePath || "missing",
      workspace: input.workspace || "missing",
    },
    reminder: "预检通过只代表“可以开始记录”，不代表任何一次真实派工会成功。容量被别人占着时必须先停手，不要用新任务去挤。",
  };
}
