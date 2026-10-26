import type { DatabaseSync } from "node:sqlite";
import { type ExecutionSelection, type SupportedTaskContract } from "./task-contract.js";
export declare class AdmissionError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface RegisteredWorkspace {
    id: string;
    displayName: string;
    realPath: string;
    device: string;
    inode: string;
}
export interface ModelPolicy {
    version: string;
    maxAttempts: number;
    maxTimeoutSeconds: number;
    requireFree: true;
    allowed: ExecutionSelection[];
}
export interface CollaborationPlan {
    planId: string;
    revision: string;
    mode: "manual" | "recommend";
    decision: "delegate";
    reason: string;
    termsHash: string;
    policyVersion: string;
    createdAt: string;
    expiresAt: string;
    authorizedAt: string | null;
    authorizationSource: string | null;
    consumedBy: string | null;
    proposal: SupportedTaskContract;
}
export interface TaskAdmission {
    workspace: RegisteredWorkspace;
    execution: ExecutionSelection;
    policy: ModelPolicy;
    contractHash: string;
    planId: string | null;
    planRevision: string | null;
}
export interface ModelObservation {
    sessionId: string;
    modelId: string;
    selectedModel: string;
    credits: string;
    observedAt: string;
    level: "selected";
    providerId?: string;
    connectionId?: string;
    reasoningEffort?: string | null;
}
export interface AttemptAdmission {
    taskId: string;
    attemptId: string;
    deadlineAt: string;
    model: ModelObservation;
}
export declare function defaultModelPolicy(maxAttempts?: number): ModelPolicy;
export declare function enforceModelPolicy(policy: ModelPolicy, execution: ExecutionSelection): void;
export declare function verifySelectedModel(execution: ExecutionSelection, observed: ModelObservation | undefined, sessionId: string): asserts observed is ModelObservation;
/** Server-owned registry on the SAME SQLite connection as tasks and contracts.
 * No HTTP write routes or environment credentials are exposed by this module. */
export declare class CollaborationRegistry {
    private readonly db;
    constructor(db: DatabaseSync);
    registerWorkspace(id: string, directory: string, displayName: string): RegisteredWorkspace;
    getWorkspace(id: string): RegisteredWorkspace;
    currentPolicy(fallback: ModelPolicy): ModelPolicy;
    /** Trusted configuration operation; not a client approval field. */
    setPolicy(input: Omit<ModelPolicy, "version">): ModelPolicy;
    createPlan(submitted: unknown, policy: ModelPolicy, options: {
        mode: "manual" | "recommend";
        reason: string;
        ttlSeconds?: number;
    }): CollaborationPlan;
    getPlan(planId: string): CollaborationPlan;
    /** Called only by a trusted application action after actual user authorization. */
    authorizePlan(planId: string, revision: string, policy: ModelPolicy, authorizationSource: string): CollaborationPlan;
    prepare(contract: SupportedTaskContract, contractHash: string, policy: ModelPolicy, executor?: "workbuddy" | "dsh"): TaskAdmission;
    /** Must run inside the task/contract creation transaction; rechecks policy and plan. */
    saveTaskAdmission(taskId: string, contract: SupportedTaskContract, contractHash: string, policy: ModelPolicy, executor?: "workbuddy" | "dsh"): TaskAdmission;
    getTaskAdmission(taskId: string): TaskAdmission | null;
    saveAttempt(record: AttemptAdmission): void;
    getAttempt(attemptId: string): AttemptAdmission | null;
    private checkPlan;
    private read;
}
