import type { DatabaseSync } from "node:sqlite";
import { type OperationRecord } from "./operation-admission.js";
import type { TaskStore } from "./task-store.js";
export interface RecoveryInput {
    operationId: string;
    targetOperationId: string;
    action: "reconcile" | "close";
    reason: string;
    expectedOperationToken: string;
    expectedEvidenceToken: string;
    expectedRevision: string | null;
    expectedAttemptId: string | null;
}
export interface RecoveryDecision {
    operationId: string;
    targetOperationId: string;
    taskId: string;
    attemptId: string | null;
    action: "reconcile" | "close";
    proof: "queue_receipt" | "dsh_receipt" | "native_stopped" | "not_dispatched";
    actor: string;
    reason: string;
    confirmedAt: string;
    decidedAt: string;
    termsDigest: string;
    evidenceToken: string;
}
/** Immutable decisions and local authorizations. Never inferred from caller-provided evidence. */
export declare class RecoveryStore {
    private readonly db;
    private readonly store;
    constructor(db: DatabaseSync, store: TaskStore);
    private decode;
    get(operationId: string): RecoveryDecision | null;
    forOperation(target: string): RecoveryDecision | null;
    closure(taskId: string): RecoveryDecision | null;
    history(taskId: string): RecoveryDecision[];
    assertOpen(taskId: string): void;
    private proof;
    inspect(targetOperationId: string, runsDir: string): {
        schemaVersion: "operation-recovery-1";
        operation: OperationRecord;
        operationToken: string;
        revision: string | null;
        attemptId: string | null;
        evidenceToken: string;
        runEvidenceDigest: string | null;
        available: string[];
        proof: {
            reconcile: "queue_receipt" | "dsh_receipt" | null;
            close: "not_dispatched" | "native_stopped" | null;
        };
        capacity: {
            taskId: string;
            executor: string;
            operationId: string;
        } | null;
        history: RecoveryDecision[];
        note: string;
    };
    private validate;
    /** Trusted application seam, called only after an actual local human confirmation; never exposed as an HTTP/MCP tool. */
    authorize(input: RecoveryInput, runsDir: string, actor: string): `${string}-${string}-${string}-${string}-${string}`;
    resolve(input: RecoveryInput, runsDir: string, authorizationId: string): RecoveryDecision;
}
