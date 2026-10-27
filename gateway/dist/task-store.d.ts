import type { LocalMessage } from "./workbuddy-client.js";
import { type PersistedTaskContract, type TaskContractIntegrity, type TaskContractPolicy, type TaskContractRejection } from "./task-contract.js";
import { CollaborationRegistry, type ModelPolicy, type ModelObservation } from "./collaboration.js";
import { QuotaStore } from "./quota-observation.js";
import { CreditBalanceStore } from "./credit-balance.js";
import { DshBindingStore } from "./dsh-bindings.js";
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
    /**
     * Persistent, unguessable view revision. Regenerated inside the same
     * transaction whenever a persisted fact changes; never derived from time.
     */
    revision?: string;
    /**
     * Digest of the external run evidence this task's view depends on (native
     * stop proof, report authentication, per-attempt report digest). Changing
     * evidence changes the view, so it is part of the fact signature (T2-R1).
     * Written only by supervised sync/acceptance paths, never by reads.
     */
    runEvidenceDigest?: string;
}
export interface TaskReport {
    status?: string;
    filesChanged: string[];
    commandsRun: string[];
    testResult?: string;
    remainingProblems?: string;
    rawText: string;
}
type NullableTaskFields = "report" | "reviewNote" | "reviewedAt" | "sessionId" | "runtimeSource" | "attemptId" | "attempt" | "lastEventSeq" | "artifacts" | "evidence" | "blockingReason" | "constraints" | "acceptanceCommands" | "cancelNote" | "runEvidenceDigest";
/**
 * Write-path event hint, not a stored column (T2-R2): true means the patch's
 * blockingReason came from an explicit worker input request (waiting_input or
 * metadata.blockedReason), the only source allowed to emit input_requested.
 * A blocked report without this hint is a worker failure and must not
 * fabricate an input request.
 */
export interface TaskPatchHints {
    inputRequested?: boolean;
}
export type TaskUpdate = Partial<Pick<StoredTask, "state" | "messageId" | "lastMessageId">> & {
    [Field in NullableTaskFields]?: StoredTask[Field] | null;
} & TaskPatchHints;
/**
 * A persisted task event: one logical fact about a task, identified by a
 * monotonically increasing eventId across all attempts of that task.
 *
 * `eventId` is allocated per task inside the writing transaction. Native
 * per-attempt sequences are preserved as `payload.nativeEventSeq`; replaying
 * the same native event must not create a second logical event (deduplicated
 * by sourceRef).
 */
export interface StoredTaskEvent {
    taskId: string;
    eventId: number;
    attemptId: string | null;
    type: string;
    occurredAt: string;
    observedAt: string;
    actor: string;
    payload: Record<string, unknown>;
    sourceRef: string | null;
}
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
    modelObservation?: ModelObservation;
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
    readonly collaboration: CollaborationRegistry;
    readonly quotas: QuotaStore;
    readonly creditBalances: CreditBalanceStore;
    readonly dshBindings: DshBindingStore;
    constructor(file: string);
    close(): void;
    /**
     * Append one logical task event with a monotonic per-task eventId.
     *
     * When `sourceRef` is set and already stored for this task, the event is a
     * replay of something already recorded: nothing is inserted and the existing
     * event is returned (idempotent dedup, contract :150). Otherwise the eventId
     * is allocated as MAX(event_id)+1 for the task inside the current
     * transaction.
     */
    appendTaskEvent(event: Omit<StoredTaskEvent, "eventId"> & {
        eventId?: number;
    }): StoredTaskEvent;
    /** Transaction-aware core of appendTaskEvent; caller must hold a transaction. */
    private appendTaskEventInTransaction;
    /**
     * Mirror per-attempt journal events into the persistent task event stream.
     *
     * Each journal event keeps its per-attempt sequence as the dedup key
     * (`attemptId:type:journal:seq`), so re-syncing the same native event never
     * produces a second logical event. Returns the events actually appended
     * (replays are omitted), in journal order.
     */
    mirrorJournalEvents(taskId: string, events: Array<{
        seq: number;
        type: string;
        createdAt: string;
        metadata?: Record<string, unknown>;
        contentText?: string;
    }>, context: {
        attemptId: string;
        actor: string;
        observedAt?: string;
        contentText?: string;
    }): StoredTaskEvent[];
    /**
     * Read the persistent event stream for a task, ascending by eventId.
     *
     * afterEventId is exclusive (0 = from the beginning); limit is bounded to
     * 200 per the events contract. Read-only: it writes nothing.
     *
     * nextEventId is the resumption cursor for THIS page (contract :27): the
     * last eventId actually returned, so a consumer paging with it can never
     * skip unread events. An empty page keeps the caller's afterEventId (the
     * stream simply has nothing more at that position), and an empty stream
     * yields 0. The stream-wide high-water mark is not a consumer cursor;
     * conflating the two silently skipped events between the last page and
     * the tail (T2-R6).
     */
    listTaskEvents(taskId: string, options?: {
        afterEventId?: number;
        limit?: number;
    }): {
        events: StoredTaskEvent[];
        nextEventId: number;
    };
    /** Whether the task has any persistent event with eventId > afterEventId. */
    hasTaskEventAfter(taskId: string, afterEventId: number): boolean;
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
    }, submitted: unknown, policy: TaskContractPolicy, admissionPolicy?: ModelPolicy, admissionExecutor?: "workbuddy" | "dsh"): TaskContractCreateResult;
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
    /**
     * Accept the reviewed attempt and close the task as one transaction
     * (T2-R4): the accepted state, review facts and the terminal task_closed
     * event commit together or not at all, so a crash between them can never
     * leave an accepted task without its closure event.
     */
    acceptAttempt(taskId: string, attemptId: string, patch: Omit<TaskUpdate, "attemptId" | "attempt">, closedEvent: {
        type: "task_closed";
        occurredAt: string;
        actor: string;
        payload: Record<string, unknown>;
        sourceRef: string | null;
    }, options?: {
        expectedStates?: TaskState[];
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
    /** Trusted local composition seam; nested operations use savepoints. */
    atomic<T>(operation: () => T): T;
    private transactionDepth;
    private transaction;
}
export declare function rowToTask(row: Record<string, unknown>): StoredTask;
export {};
