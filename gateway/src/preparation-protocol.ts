/**
 * P0-3 原生准备可靠性：协议事实与探针分类（纯函数，无时钟、无 IO）。
 *
 * 这里只做一件事：把“本地看到了什么”翻译成“能主张什么”。
 * 规则来源（见 docs/T7D_P0_3_NATIVE_PREPARATION_PROTOCOL.md）：
 *  - 原生 createWorker 链路 = workspace:initialize → session:create → session:rename；
 *  - session:create 的幂等键是调用方自己生成的 session UUID（重放同一个 UUID 不会新建第二条）；
 *  - 原生没有“请求终态”查询：session:get 只能回答“这个会话现在在不在这里”，
 *    回答不了“刚才那次请求到底有没有被执行、有没有迟到创建”；
 *  - 因此 lateCreationExcluded = false，缺席（absent）永远不等于“未创建”。
 */

export const PREPARATION_PROTOCOL_REVISION = "native-preparation-1";

export interface NativePreparationProtocol {
  readonly revision: string;
  readonly creationChannel: string;
  readonly creationTimeoutMs: number;
  readonly idempotencyKey: "caller_supplied_session_uuid" | "none";
  readonly terminalQueryChannel: string | null;
  readonly terminalQueryProves: "presence_only" | "terminal_state" | "none";
  readonly lateCreationExcluded: boolean;
  readonly workspaceBindingVerified: boolean;
}

export const NATIVE_PREPARATION_PROTOCOL: NativePreparationProtocol = Object.freeze({
  revision: PREPARATION_PROTOCOL_REVISION,
  creationChannel: "session:create",
  creationTimeoutMs: 45_000,
  idempotencyKey: "caller_supplied_session_uuid",
  terminalQueryChannel: "session:get",
  terminalQueryProves: "presence_only",
  lateCreationExcluded: false,
  workspaceBindingVerified: true,
});

/** 给界面与文档共用的一句限制说明，不得改写成更强的结论。 */
export const PREPARATION_LIMITATION =
  "本地查不到会话不能证明原生端没有创建；超时和异常也不能证明请求未到达。保留预留身份，先核对，不要重放。";

export type PreparationProbeSource = "native_session_get" | "desktop_history" | "none";
export type PreparationProbeKind = "present" | "absent" | "identity_mismatch" | "unavailable";
export type PreparationConclusion = "created" | "not_observed" | "unconfirmed";

export interface PreparationProbeInput {
  source: PreparationProbeSource;
  expected: { sessionId: string; workspace: string };
  observed?: { sessionId: string; workspace: string } | null;
  error?: string | null;
}

export interface PreparationProbeClassification {
  kind: PreparationProbeKind;
  conclusion: PreparationConclusion;
  reason: string;
}

export interface PreparationProbeRecord extends PreparationProbeClassification {
  probeId: string;
  sessionId: string;
  workspace: string;
  source: PreparationProbeSource;
  gatewayPid: number;
  observedAt: string;
  error: string | null;
}

/** Windows 上路径大小写不敏感；这里只比较规范化后的字符串，不碰文件系统。 */
export function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+/g, "\\").replace(/\\+$/, "");
  const a = normalize(String(left));
  const b = normalize(String(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 把探针结果翻译成结论。任何一条规则都只能降级，不能升级：
 * 没有观测 → unconfirmed；观测为空 → not_observed（不是“未创建”）；身份不符 → unconfirmed。
 */
export function classifyPreparationProbe(input: PreparationProbeInput): PreparationProbeClassification {
  if (input.error) return { kind: "unavailable", conclusion: "unconfirmed", reason: "probe_failed" };
  if (input.source === "none") return { kind: "unavailable", conclusion: "unconfirmed", reason: "probe_not_supported" };
  const observed = input.observed ?? null;
  if (!observed) return { kind: "absent", conclusion: "not_observed", reason: "absence_is_not_proof" };
  if (observed.sessionId !== input.expected.sessionId) return { kind: "identity_mismatch", conclusion: "unconfirmed", reason: "session_identity_mismatch" };
  if (!sameWorkspacePath(observed.workspace, input.expected.workspace)) return { kind: "identity_mismatch", conclusion: "unconfirmed", reason: "workspace_identity_mismatch" };
  return { kind: "present", conclusion: "created", reason: "session_present" };
}

/** 只读文字化，供命令行与测试共用；不新增任何主张。 */
export function describePreparationProbe(record: PreparationProbeRecord): string {
  const label: Record<PreparationProbeKind, string> = {
    present: "原生端存在该会话",
    absent: "本地没有查到该会话（不等于未创建）",
    identity_mismatch: "查到的会话身份或工作区与预留不一致",
    unavailable: "本次未能观测（不等于未创建）",
  };
  return `${record.observedAt} ${record.source} → ${label[record.kind]}（${record.reason}）`;
}
