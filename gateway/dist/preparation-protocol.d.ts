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
export declare const PREPARATION_PROTOCOL_REVISION = "native-preparation-1";
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
export declare const NATIVE_PREPARATION_PROTOCOL: NativePreparationProtocol;
/** 给界面与文档共用的一句限制说明，不得改写成更强的结论。 */
export declare const PREPARATION_LIMITATION = "\u672C\u5730\u67E5\u4E0D\u5230\u4F1A\u8BDD\u4E0D\u80FD\u8BC1\u660E\u539F\u751F\u7AEF\u6CA1\u6709\u521B\u5EFA\uFF1B\u8D85\u65F6\u548C\u5F02\u5E38\u4E5F\u4E0D\u80FD\u8BC1\u660E\u8BF7\u6C42\u672A\u5230\u8FBE\u3002\u4FDD\u7559\u9884\u7559\u8EAB\u4EFD\uFF0C\u5148\u6838\u5BF9\uFF0C\u4E0D\u8981\u91CD\u653E\u3002";
export type PreparationProbeSource = "native_session_get" | "desktop_history" | "none";
export type PreparationProbeKind = "present" | "absent" | "identity_mismatch" | "unavailable";
export type PreparationConclusion = "created" | "not_observed" | "unconfirmed";
export interface PreparationProbeInput {
    source: PreparationProbeSource;
    expected: {
        sessionId: string;
        workspace: string;
    };
    observed?: {
        sessionId: string;
        workspace: string;
    } | null;
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
export declare function sameWorkspacePath(left: string, right: string): boolean;
/**
 * 把探针结果翻译成结论。任何一条规则都只能降级，不能升级：
 * 没有观测 → unconfirmed；观测为空 → not_observed（不是“未创建”）；身份不符 → unconfirmed。
 */
export declare function classifyPreparationProbe(input: PreparationProbeInput): PreparationProbeClassification;
/** 只读文字化，供命令行与测试共用；不新增任何主张。 */
export declare function describePreparationProbe(record: PreparationProbeRecord): string;
