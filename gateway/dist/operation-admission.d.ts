import type { DatabaseSync } from "node:sqlite";
import { AdmissionError } from "./collaboration.js";
import type { StoredTask, TaskStore } from "./task-store.js";
export interface OperationOptions {
    operationId?: string;
    expectedRevision?: string | null;
    expectedAttemptId?: string | null;
}
export type OperationState = "reserved" | "effect_started" | "succeeded" | "rejected" | "outcome_unknown";
export interface OperationReceipt {
    operationId: string;
    operationState: OperationState;
    outcomeCode?: "OUTCOME_UNKNOWN";
}
export interface PreparationBinding {
    taskId: string;
    workspace: string;
    sessionId: string | null;
    model: string;
    workerKey: string | null;
    title: string | null;
}
export interface OperationRecord {
    operationId: string;
    kind: string;
    taskId: string;
    attemptId: string | null;
    parameterDigest: string;
    expectedRevision: string | null;
    expectedAttemptId: string | null;
    executor: string;
    binding: unknown;
    state: OperationState;
    resolvedBinding?: {
        sessionId: string | null;
        runtimeSource: string | null;
    };
    preparationBinding?: PreparationBinding;
    preparationSessionId?: string;
    preparationEnteredAt?: string;
    effectStartedAt?: string;
    phaseVersion?: 1;
    dispatchEnteredAt?: string;
    preparationCompletedAt?: string;
    createdAt: string;
    updatedAt: string;
    result?: unknown;
    error?: {
        code: string;
        message: string;
    };
}
export declare class OperationOutcomeError extends AdmissionError {
    readonly operationId: string;
    readonly operationState: OperationState;
    constructor(operationId: string, operationState: OperationState);
}
/** JSON data only; never hash transport metadata by accident or omit unknown behavior fields. */
export declare function operationDigest(value: unknown): string;
/** SQLite is the arbiter. The local promises only let same-process callers await a receipt. */
export declare class OperationAdmission {
    private readonly db;
    private readonly store;
    private readonly pending;
    constructor(db: DatabaseSync, store: TaskStore);
    get(operationId: string): OperationRecord | null;
    listUnfinished(): OperationRecord[];
    forTask(taskId: string): OperationRecord[];
    preparationReturned(operationId: string): void;
    private assertUnresolved;
    originalBinding(taskId: string): unknown;
    originalSession(taskId: string): string | null;
    private save;
    compatibilityOperation(kind: string, taskId: string, parameters: unknown): OperationRecord | null;
    assertTaskVersion(record: OperationRecord): void;
    /** Only a receipt explicitly saved before any native boundary proves a clean dispatch refusal. */
    provenNotDispatched(taskId: string, attemptId: string): boolean;
    /** Persist the exact route chosen by the admitted coordinator, before calling its native adapter. */
    reservePreparation(operationId: string, target: PreparationBinding): void;
    preparationBoundary(operationId: string | undefined, target: PreparationBinding, resolvedSessionId?: string, enter?: boolean): void;
    /** Closing requires all existing durable facts, never idle/TTL or a business label alone. */
    isClosed(task: StoredTask): boolean;
    occupant(): {
        taskId: string;
        executor: string;
        operationId: string;
    } | null;
    /** Called under BEGIN IMMEDIATE, also used by compatibility queue/worker gates. */
    claim(taskId: string, executor: string, operationId: string): void;
    private admit;
    /** Commit before every possibly mutating native call; never roll this back with its receipt. */
    nativeBoundary(taskId: string, attemptId?: string, phase?: "prepare" | "dispatch"): void;
    /** Existing queue receipts may wake exactly their original attempt, under its retained workflow. */
    assertExecution(taskId: string, attemptId: string, target?: {
        sessionId: string;
        model?: string;
        workspace?: string;
    }): void;
    executeQueueAttempt<T>(taskId: string, attemptId: string, target: {
        sessionId: string;
        model?: string;
        workspace?: string;
    }, action: () => T): T;
    private replay;
    run<T extends object>(kind: string, taskId: string, executor: string, parameters: unknown, options: OperationOptions, binding: unknown, action: (operation: OperationRecord) => Promise<T>): Promise<T & OperationReceipt>;
    /** Internal queue persistence has its own stable receipt, while retaining its parent's workflow. */
    enqueue(taskId: string, attemptId: string, parameters: unknown, action: () => void, preflight?: () => void): void;
    metadata<T>(kind: string, taskId: string, parameters: unknown, options: Pick<OperationOptions, "operationId">, action: () => T, binding?: unknown): T;
    /** Synchronous review writes and acceptance commit with their durable receipt. */
    local<T>(kind: string, taskId: string, parameters: unknown, options: OperationOptions, action: () => T): T;
    /** A bounded independent command is an external effect, never a worker dispatch. */
    reviewCommandBoundary(operationId: string): void;
}
