import type { DatabaseSync } from "node:sqlite";
import type { TaskStore, StoredTask } from "./task-store.js";
import { type OperationOptions } from "./operation-admission.js";
import type { TaskViewCheckResult } from "./task-view.js";
export type CheckStatus = "passed" | "failed" | "unknown" | "not_applicable" | "checker_error";
export interface ReviewCheck extends TaskViewCheckResult {
    id: string;
    checkId: string;
    kind: "provenance" | "scope" | "command" | "semantic";
    status: CheckStatus;
    attemptId: string;
    actor: "program" | "independent_reviewer" | "worker";
    evidenceRefs: string[];
    inputHashes: string[];
    fileHashes: Record<string, string>;
    checkedAt: string;
    checkerVersion: "t6-1";
    note: string;
}
export interface ReviewOptions extends OperationOptions {
    taskId: string;
}
export interface ReviewInput extends ReviewOptions {
    machineCheckIds: string[];
    semanticChecks: Array<{
        checkId: string;
        status: CheckStatus;
        note: string;
        evidenceRefs: string[];
    }>;
    note: string;
    supersedesReviewId?: string;
}
export interface ReviewRecord {
    reviewId: string;
    taskId: string;
    attemptId: string;
    basisRevision: string;
    committedRevision: string;
    bindingDigest: string;
    agreement: {
        hash: string;
        version: string | null;
    };
    runtimeSource: string;
    sessionId: string;
    machineCheckIds: string[];
    checks: ReviewCheck[];
    note: string;
    createdAt: string;
    reviewer: {
        actor: "independent_reviewer";
        channel: "trusted_local_coordinator";
    };
    supersedesReviewId: string | null;
    correction: "reviewer_error" | null;
}
/** One shared trust boundary for both executors. No model calls or implicit sync. */
export declare class TaskReviews {
    private readonly db;
    private readonly store;
    constructor(db: DatabaseSync, store: TaskStore);
    private save;
    private read;
    list(taskId: string): ReviewRecord[];
    get(taskId: string, reviewId: string): ReviewRecord;
    /** Advice from stored facts only. Actual accept always rechecks external evidence. */
    storedAcceptanceReady(task: StoredTask): boolean;
    private task;
    private terms;
    private binding;
    private fileHash;
    private optionalHash;
    private config;
    private check;
    /** Explicit write: collect existing authenticated command records and re-use T5 inventory. */
    checks(input: ReviewOptions, runsDir: string): {
        machineCheckIds: string[];
        checks: ReviewCheck[];
        revision: string;
    };
    private matches;
    /** Explicit isolated verification; executes only the exact JSON CommandSpec in the original agreement. */
    runCommand(input: ReviewOptions & {
        checkId: string;
    }, runsDir: string): Promise<{
        ok: boolean;
        evidenceId: string;
        status: "failed" | "passed" | "checker_error";
        exitCode: number;
        cleanupConfirmed: boolean;
        reason: string;
        revision: string;
    } & import("./operation-admission.js").OperationReceipt>;
    inspect(input: ReviewOptions & {
        note: string;
        files: string[];
    }, runsDir: string): {
        evidenceId: string;
        revision: string;
    };
    review(input: ReviewInput, runsDir: string): {
        reviewId: string;
        revision: string;
        review: ReviewRecord;
    };
    private verifyHashes;
    /** Called again by the storage acceptance gate under the same BEGIN IMMEDIATE. */
    assertAcceptance(task: StoredTask, reviewId?: string, expectedRevision?: string | null): ReviewRecord;
    accept(input: ReviewOptions & {
        reviewId: string;
    }): {
        task: StoredTask;
        reviewId: string;
    };
    private changed;
}
