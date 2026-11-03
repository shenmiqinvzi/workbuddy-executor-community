/**
 * P0-5 独立真实验证：计划、证据形状与预检（纯函数，无时钟、无 IO）。
 *
 * 三条硬规则，全部写进类型与返回值，不靠人记：
 *  1. 每一步都必须自带“这条证据不能证明什么”（mayNotProve 不可为空）；
 *  2. 证据只分“记到了 / 没记到”，不产出 pass/fail；
 *  3. 容量被别人占着时，预检直接报阻塞——不允许“先跑跑看”。
 */
export declare const VERIFICATION_PLAN_REVISION = "p0-5-verification-1";
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
export declare const VERIFICATION_STEPS: readonly VerificationStep[];
export interface VerificationEvidence {
    readonly stepId: string;
    readonly kind: string;
    readonly value: string;
    readonly observedAt: string;
}
export type VerificationStepStatus = "recorded" | "missing";
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
export declare function stepResult(step: VerificationStep, evidence: readonly VerificationEvidence[]): VerificationStepResult;
export declare function verificationSummary(evidence: readonly VerificationEvidence[]): VerificationSummary;
export interface VerificationClaim {
    readonly claim: string;
    readonly limitation: string;
}
/**
 * 允许对外说的话，由“哪几步有证据”机械推导。
 * 没有对应证据时返回空数组——不说比说错安全。
 */
export declare function allowedClaims(evidence: readonly VerificationEvidence[]): VerificationClaim[];
export interface PreflightInput {
    readonly occupant: {
        taskId: string;
        executor: string;
        operationId: string;
    } | null;
    readonly dispatchEnabled: boolean;
    readonly databasePath: string;
    readonly workspace: string;
    readonly workspaceWritable: boolean;
}
export interface PreflightReport {
    readonly revision: string;
    readonly ready: boolean;
    readonly blockers: readonly string[];
    readonly observed: {
        readonly capacity: string;
        readonly dispatch: string;
        readonly database: string;
        readonly workspace: string;
    };
    readonly reminder: string;
}
export declare function preflightReport(input: PreflightInput): PreflightReport;
