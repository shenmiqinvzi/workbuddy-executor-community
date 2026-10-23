import type { LocalMessage } from "./workbuddy-client.js";
import { type PersistedTaskContract, type TaskContractIntegrity, type TaskContractPolicy, type TaskContractRejection } from "./task-contract.js";
export type TaskState = "queued" | "working" | "completed" | "blocked" | "failed" | "cancelled" | "needs_review" | "accepted";
export interface StoredTask {
    taskId: string;
    messageId: string;
    objective: string;
    /** Immutable normalized initial submission; survives rework and reconnects. */
    submissionHash?: string;
    workspace?: string;
    constraints?: string[];
    acceptanceCommands?: string[];
    state: TaskState;
    createdAt: string;
    updatedAt: string;
    lastMessageId?: string;
    report?: TaskReport;
    cancelNote?: string;
    reviewNote?: string;
    reviewedAt?: string;
    sessionId?: string;
    /** A backend/source identifier. Credentials must never be stored here. */
    runtimeSource?: string;
    attemptId?: string;
    attempt?: number;
    lastEventSeq?: number;
    artifacts?: string[];
    evidence?: string[];
    blockingReason?: string;
}
export interface TaskReport {
    status?: string;
    filesChanged: string[];
    commandsRun: string[];
    testResult?: string;
    remainingProblems?: string;
    rawText: string;
}
type NullableTaskFields = "report" | "reviewNote" | "reviewedAt" | "sessionId" | "runtimeSource" | "attemptId" | "attempt" | "lastEventSeq" | "artifacts" | "evidence" | "blockingReason" | "constraints" | "acceptanceCommands" | "cancelNote";
export type TaskUpdate = Partial<Pick<StoredTask, "state" | "messageId" | "lastMessageId">> & {
    [Field in NullableTaskFields]?: StoredTask[Field] | null;
};
/**
 * The outcome of creating a task together with its initial contract.
 *
 * `task_without_contract` is the legacy case: the task already exists from a
 * build that stored no contract. It is reported as itself and never repaired
 * from the task's current objective or acceptance commands.
 */
export type TaskContractCreateResult = {
    status: "created";
    task: StoredTask;
    record: PersistedTaskContract;
} | {
    status: "existing_same";
    task: StoredTask;
    record: PersistedTaskContract;
} | {
    status: "conflict";
    task: StoredTask;
    record: PersistedTaskContract;
} | {
    status: "task_without_contract";
    task: StoredTask;
} | {
    status: "rejected";
    rejection: TaskContractRejection;
};
/** What a contract read found, keeping "no contract" apart from "broken". */
export type TaskContractRead = {
    state: "found";
    record: PersistedTaskContract;
} | {
    state: "absent";
} | {
    state: "integrity_failure";
    integrity: TaskContractIntegrity;
};
export interface AttemptReservation {
    attemptId: string;
    messageId: string;
    sessionId?: string;
    runtimeSource?: string;
    state?: "queued" | "working";
    acceptanceCommands?: string[];
}
export interface StoredAttempt {
    taskId: string;
    attemptId: string;
    attempt: number;
    messageId: string;
    sessionId?: string;
    runtimeSource?: string;
    state: TaskState;
    lastEventSeq: number;
    artifacts: string[];
    evidence: string[];
    report?: TaskReport;
    blockingReason?: string;
    reviewNote?: string;
    reviewedAt?: string;
    cancelNote?: string;
    createdAt: string;
    updatedAt: string;
}
export declare class TaskStore {
    readonly file: string;
    private readonly db;
    constructor(file: string);
    close(): void;
    createOrGet(task: Omit<StoredTask, "createdAt" | "updatedAt"> & {
        createdAt?: string;
    }): {
        task: StoredTask;
        created: boolean;
    };
    get(taskId: string): StoredTask | undefined;
    /**
     * Read the stored contract for a task.
     *
     * A plain read: it initializes nothing, migrates nothing, repairs nothing and
     * never backfills a contract for a task that has none. A row that parses but
     * no longer verifies is reported as an integrity failure, which is not the
     * same answer as "this task has no contract".
     */
    getContract(taskId: string): TaskContractRead;
    /**
     * Create a task and its initial contract as one unit.
     *
     * The submitted contract is validated and normalized here, and the digest is
     * computed from that normalized content, so a caller cannot pass a digest
     * that does not describe what is being stored. Idempotency is then decided by
     * comparing computed digests, never by a caller-supplied value.
     *
     * The task row, the attempt snapshot and the contract are written inside a
     * single transaction, so a failure leaves neither half behind. Idempotency is
     * decided by the primary key rather than by a prior read: the insert either
     * wins or conflicts, and only the winner writes a contract. Two connections
     * racing on one task id therefore cannot both create it, and no nested
     * transaction is needed.
     */
    createTaskWithContract(task: Omit<StoredTask, "createdAt" | "updatedAt" | "objective"> & {
        createdAt?: string;
        objective?: string;
    }, submitted: unknown, policy: TaskContractPolicy): TaskContractCreateResult;
    listTasks(options?: {
        state?: TaskState;
        states?: TaskState[];
        limit?: number;
        offset?: number;
    }): StoredTask[];
    /**
     * Stage read path for the stable list contract: `created_at` ascending with
     * `task_id` as the tiebreaker, bounded by a keyset cursor instead of an
     * offset, so concurrent updates cannot shift rows between pages.
     *
     * This deliberately does not replace listTasks: the existing MCP list keeps
     * its updated_at DESC + offset behaviour unchanged, and callers must not
     * silently switch between the two orders. createdAt is compared as stored
     * text; every writer in this build stores Date.toISOString() values, so the
     * byte order is the chronological order.
     *
     * Read-only: it writes nothing, never repairs stored timestamps and never
     * touches the filesystem.
     */
    listTasksByCreatedCursor(options: {
        limit: number;
        afterTaskId?: string;
    }): {
        tasks: StoredTask[];
        anchorFound: boolean;
    };
    /**
     * Whether at least one task sorts strictly after the cursor row.
     *
     * The read is one indexed lookup, so the list entry can promise "there is
     * another page" only when one really exists; a full final page then ends
     * with nextAfterTaskId null instead of a cursor the client must try once
     * and learn was empty.
     */
    hasTaskAfterCursor(afterTaskId: string): boolean;
    /** Reserve before spawning a worker, atomically across MCP processes. */
    beginAttempt(taskId: string, reservation: AttemptReservation): StoredTask;
    update(taskId: string, patch: TaskUpdate): StoredTask;
    /** A late old worker cannot overwrite a newer rework attempt. */
    updateAttempt(taskId: string, attemptId: string, patch: Omit<TaskUpdate, "attemptId" | "attempt">, options?: {
        expectedStates?: TaskState[];
        preserveTerminal?: boolean;
    }): {
        task: StoredTask;
        applied: boolean;
    };
    listAttempts(taskId: string): StoredAttempt[];
    addMessages(taskId: string, messages: LocalMessage[]): number;
    /** Read recent events for the current attempt, with history explicitly selectable. */
    listMessages(taskId: string, limit?: number, attemptId?: string): LocalMessage[];
    private writeUpdate;
    private saveAttempt;
    private transaction;
}
export declare function rowToTask(row: Record<string, unknown>): StoredTask;
export {};
