import type { TaskCoordinator, SendTaskInput } from "./coordinator.js";
import type { DshTaskCoordinator } from "./dsh-coordinator.js";
import type { OperationOptions } from "./operation-admission.js";
import type { RecoveryInput } from "./operation-recovery.js";
import type { ReviewOptions, ReviewInput } from "./task-reviews.js";
import type { StoredTask, StoredTaskEvent } from "./task-store.js";
import { STAGE_TASK_VIEW_UNAVAILABLE, STAGE_TASK_VIEW_SCHEMA_VERSION, type StageTaskView } from "./task-view-stage.js";
/** A conservative status projection for existing tasks. This is not the vNext TaskView. */
export interface TaskStatusView {
    taskId: string;
    attemptId: string | null;
    sessionId: string | null;
    businessState: StoredTask["state"];
    displayState: "queued" | "running" | "waiting_input" | "waiting_stop" | "needs_review" | "accepted" | "cancelled" | "failed" | "unknown";
    remoteStopped: boolean;
    allowedActions: Array<"cancel" | "rework" | "accept">;
    lastObservedAt: string | null;
}
/**
 * Stage-1 read query outcomes, shared by the list and detail entries.
 *
 * The failure variants keep the projection's own failure codes verbatim, so a
 * permission error, a corrupt record or a mid-read attempt change is never
 * reported as "no tasks" or as a task without data. `store_unavailable`
 * additionally covers a list-level read failure of the store itself.
 */
export type StageReadResult = {
    ok: true;
    readOnly: true;
    snapshotOnly: true;
    schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
    unavailable: typeof STAGE_TASK_VIEW_UNAVAILABLE;
    view: StageTaskView;
} | {
    ok: false;
    readOnly: true;
    snapshotOnly: true;
    code: "task_not_found" | "invalid_task_id" | string;
    taskId: string;
    field: string;
    message: string;
};
/** One page of the stable created_at ASC + task_id ASC list. */
export interface StageListResult {
    ok: true;
    readOnly: true;
    snapshotOnly: true;
    schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
    unavailable: typeof STAGE_TASK_VIEW_UNAVAILABLE;
    /**
     * One entry per listed task, in stable order. A failed entry keeps the
     * projection's failure code instead of an empty view; it never masks its
     * neighbours.
     */
    tasks: StageListItem[];
    /** The cursor to pass as afterTaskId, or null when no next page exists. */
    nextAfterTaskId: string | null;
}
/** A request-level list failure. Store failures are never cursor errors. */
export type StageListFailure = {
    ok: false;
    readOnly: true;
    snapshotOnly: true;
    code: "invalid_cursor" | "store_unavailable";
    field: string;
    message: string;
};
/** One list entry: either a stage view or the preserved projection failure. */
export type StageListItem = {
    ok: true;
    taskId: string;
    view: StageTaskView;
} | {
    ok: false;
    taskId: string;
    code: string;
    field: string;
    message: string;
};
/** The MCP entry point and future local HTTP adapter share this service. */
export declare class TaskApplicationService {
    private readonly coordinator;
    private readonly maxAttempts;
    private readonly runsDir;
    readonly dsh?: DshTaskCoordinator | undefined;
    constructor(coordinator: TaskCoordinator, maxAttempts: number, runsDir: string, dsh?: DshTaskCoordinator | undefined);
    /** Trusted local setup and authorization seams; no HTTP write routes. */
    registerWorkspace(id: string, directory: string, displayName: string): import("./collaboration.js").RegisteredWorkspace;
    createCollaborationPlan(contract: unknown, options: {
        mode: "manual" | "recommend";
        reason: string;
        ttlSeconds?: number;
    } & Pick<OperationOptions, "operationId">): import("./collaboration.js").CollaborationPlan;
    authorizeCollaborationPlan(planId: string, expectedPlanRevision: string, source: string, options?: Pick<OperationOptions, "operationId">): import("./collaboration.js").CollaborationPlan;
    private planPolicy;
    getCollaborationPlan(planId: string): import("./collaboration.js").CollaborationPlan;
    readQuotaResources(options?: {
        connectionId?: string;
        modelId?: string;
        limit?: number;
    }): {
        schemaVersion: string;
        readOnly: true;
        connections: {
            connectionId: string;
            status: string;
            errorCode: string | null;
            snapshotId: string | null;
            collectedAt: string | null;
            sourceObservedAt: string | null;
            expiresAt: string | null;
            freshness: string;
        }[];
        observations: ({
            connectionId: string;
            snapshotId: string;
            sourceObservedAt: string | null;
            collectedAt: string;
            scopeId: string;
            scopeKind: "gateway_pool";
            shared: true;
            modelId: string;
            realm: string;
            unit: "tokens";
            valueKind: "estimated" | "unavailable";
            availability: "available" | "exhausted" | "unknown";
            used: number | null;
            budget: number | null;
            remaining: number | null;
            resetAt: string | null;
            method: string;
            limitations: string[];
        } & {
            connectionIds: string[];
        })[];
        truncated: boolean;
        attribution: "connection_only";
        actualTaskCredits: null;
        actualTaskTokens: null;
    };
    readCreditBalances(connectionId?: string): {
        schemaVersion: string;
        readOnly: true;
        connections: {
            connectionId: string;
            status: string;
            errorCode: string | null;
            snapshotId: string | null;
            collectedAt: string | null;
            cacheFreshness: string;
        }[];
        balances: {
            shared: true;
            scopeKind: "gateway_region_pool";
            balanceFreshness: string;
            limitations: string[];
            errorCode: string | null;
            snapshotId: string;
            connectionId: string;
            scopeId: string;
            realm: "cn" | "intl";
            unit: "credit";
            valueKind: "reported_cache";
            balance: number | null;
            accountsEnabled: number;
            accountsWithData: number;
            coverage: "complete" | "partial" | "unavailable";
            latestMemberObservedAt: string | null;
            collectedAt: string;
            cacheExpiresAt: string;
            connectionIds: string[];
        }[];
        actualTaskCredits: null;
        attribution: "connection_only";
    };
    getOperation(operationId: string): import("./operation-admission.js").OperationRecord | null;
    reviewChecks(input: ReviewOptions): {
        machineCheckIds: string[];
        checks: import("./task-reviews.js").ReviewCheck[];
        revision: string;
    };
    runReviewCommand(input: ReviewOptions & {
        checkId: string;
    }): Promise<{
        ok: boolean;
        evidenceId: string;
        status: "failed" | "passed" | "checker_error";
        exitCode: number;
        cleanupConfirmed: boolean;
        reason: string;
        revision: string;
    } & import("./operation-admission.js").OperationReceipt>;
    recordInspection(input: ReviewOptions & {
        note: string;
        files: string[];
    }): {
        evidenceId: string;
        revision: string;
    };
    review(input: ReviewInput): {
        reviewId: string;
        revision: string;
        review: import("./task-reviews.js").ReviewRecord;
    };
    acceptReview(input: ReviewOptions & {
        reviewId: string;
    }): {
        task: StoredTask;
        reviewId: string;
    };
    listReviews(taskId: string): import("./task-reviews.js").ReviewRecord[];
    listUnfinishedOperations(): import("./operation-admission.js").OperationRecord[];
    readOperationRecovery(targetOperationId: string): {
        schemaVersion: "operation-recovery-1";
        operation: import("./operation-admission.js").OperationRecord;
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
        history: import("./operation-recovery.js").RecoveryDecision[];
        note: string;
    };
    getOperationRecoveryDecision(operationId: string): import("./operation-recovery.js").RecoveryDecision | null;
    authorizeOperationRecovery(input: RecoveryInput, actor: string): `${string}-${string}-${string}-${string}-${string}`;
    resolveOperationRecovery(input: RecoveryInput, authorizationId: string): import("./operation-recovery.js").RecoveryDecision;
    observeOperationRecovery(targetOperationId: string): Promise<{
        schemaVersion: "operation-recovery-1";
        operation: import("./operation-admission.js").OperationRecord;
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
        history: import("./operation-recovery.js").RecoveryDecision[];
        note: string;
    }>;
    /** Stored facts only: deliberately bypasses every synchronising coordinator method. */
    readProjection(taskId: string): import("./task-view-reader.js").TaskProjectionResult;
    /**
     * Stage-1 read-only detail query for one stored task.
     *
     * It reuses readProjection's store and run-file reads — the same snapshot
     * semantics, the same failure codes, the same attempt re-check — and maps
     * the result into the stage view. The view is built from the task row the
     * projection itself verified (`projection.row`): a second store.get here
     * could already describe a later attempt after a concurrent rework, which
     * would mix two rounds into one answer, so no second read happens. Like
     * readProjection this never calls sync, executionStatus, checkWorker or any
     * dispatching entry point, creates no store and writes nothing.
     */
    readStageView(taskId: string): StageReadResult;
    /**
     * Stage-1 read-only list query with the stable pagination contract.
     *
     * Ordering is created_at ASC + task_id ASC (the contract's stable cursor
     * order), read through TaskStore.listTasksByCreatedCursor. The existing MCP
     * list (updated_at DESC + offset) is deliberately untouched and is not
     * called from here.
     *
     * Failure policy (no silent swallow):
     *   - A store failure while reading the page, while probing the next-page
     *     cursor, or while reading any single task's row is a structured
     *     STORE_UNAVAILABLE failure for the whole request, never an empty page
     *     or a cursor error.
     *   - A per-task projection failure (corrupt record, unreadable file,
     *     contract integrity, mid-read attempt change, ...) is preserved
     *     per item: the item keeps its taskId plus the projection's failure
     *     code/field/message instead of a fabricated empty view, so a client can
     *     tell environment damage apart from data it asked for. An item-level
     *     failure never masks the rest of the page.
     *   - Cursor problems stay invalid_cursor and map to HTTP 400.
     *
     * Each item's view is built from the row its own readProjection verified
     * (projection.row), so a concurrent rework between the page read and the
     * item read yields that task's consistent single-round snapshot — or an
     * explicit read_conflict from the reader — never a mixture of two rounds.
     */
    listStageViews(options: {
        limit: number;
        afterTaskId?: string;
    }): StageListResult | StageListFailure;
    /**
     * Read the persistent task event stream (T2).
     *
     * Pure read: afterEventId is exclusive (0 = from the beginning), limit is
     * bounded 1-200 (default 100), events ascend by the monotonic per-task
     * eventId, and nothing is written — a missing task is a task_not_found
     * failure, never an implicit creation. nextEventId is the last returned id,
     * or the original afterEventId on an empty page, including at stream end.
     */
    listTaskEvents(taskId: string, options?: {
        afterEventId?: number;
        limit?: number;
    }): {
        ok: true;
        events: StoredTaskEvent[];
        nextEventId: number;
    } | {
        ok: false;
        code: "task_not_found" | "invalid_task_id" | "invalid_cursor" | "store_unavailable";
        field: string;
        message: string;
    };
    send(input: SendTaskInput): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask;
    } | {
        ok: boolean;
        task: StoredTask;
        error: string;
        created?: undefined;
        next?: undefined;
    }>;
    private dshFor;
    continue(input: Parameters<TaskCoordinator["continue"]>[0]): Promise<({
        ok: boolean;
        created: boolean;
        task: StoredTask;
        code?: undefined;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
        code: string;
    }) & import("./operation-admission.js").OperationReceipt> | Promise<({
        ok: boolean;
        created: boolean;
        task: StoredTask;
        next: string;
        error?: undefined;
    } | {
        ok: boolean;
        task: StoredTask;
        error: string;
        created?: undefined;
        next?: undefined;
    }) & import("./operation-admission.js").OperationReceipt>;
    accept(...args: Parameters<TaskCoordinator["accept"]>): Promise<StoredTask>;
    cancel(...args: Parameters<TaskCoordinator["cancel"]>): Promise<{
        state: string;
        remoteStopped: boolean;
        cancellationRequested: boolean;
        reportDigestPresent: boolean;
        observedAt: string | undefined;
        deadline: string | undefined;
        stopProofScope: string;
        ok: boolean;
        task: StoredTask;
    }> | Promise<{
        message: string;
        state: string;
        remoteStopped: boolean;
        cancellationRequested?: undefined;
        reportDigestPresent?: undefined;
        stopReason?: undefined;
        observedAt?: undefined;
        deadline?: undefined;
        claimDeadline?: undefined;
        reportBy?: undefined;
        progress?: undefined;
        stopControl?: undefined;
        nativeHealth?: undefined;
        nativeRateLimit?: undefined;
        postReportFailure?: undefined;
        nativeStopCheck?: undefined;
        ok: boolean;
        task: StoredTask;
        executionState?: undefined;
        execution?: undefined;
    } | {
        message: string;
        state: string;
        remoteStopped: boolean;
        cancellationRequested: boolean;
        reportDigestPresent: boolean;
        stopReason: string | undefined;
        observedAt: string;
        deadline: string | undefined;
        claimDeadline: string | undefined;
        reportBy: string | undefined;
        progress: {
            stage: string;
            completed: string;
            running: string;
            blocker: string;
            lastMeaningfulAt: string;
            reportedAt: string;
        } | undefined;
        stopControl: {
            requestedAt: string;
            issuedAt?: string;
            acknowledgedAt?: string;
            checkedAt?: string;
            error?: string;
            state: "requested" | "stop_unconfirmed" | "stopped";
        } | undefined;
        nativeHealth: {
            state: string;
            observedAt: string;
            reason?: string;
        } | undefined;
        nativeRateLimit: import("./native-turn-failure.js").NativeRateLimit | undefined;
        postReportFailure: {
            error: string;
            observedAt: string;
            reportReceivedAt: string;
            phase?: "session:sendMessage" | "native_history";
        } | undefined;
        nativeStopCheck: {
            since: string;
            checkedAt: string;
            observations: number;
            activityAt?: number;
        } | undefined;
        ok: boolean;
        task: StoredTask;
        executionState?: undefined;
        execution?: undefined;
    } | {
        ok: boolean;
        cancellationRequested: boolean;
        remoteStopped: boolean;
        executionState: string;
        execution: {
            state: string;
            remoteStopped: boolean;
            cancellationRequested?: undefined;
            reportDigestPresent?: undefined;
            stopReason?: undefined;
            observedAt?: undefined;
            deadline?: undefined;
            claimDeadline?: undefined;
            reportBy?: undefined;
            progress?: undefined;
            stopControl?: undefined;
            nativeHealth?: undefined;
            nativeRateLimit?: undefined;
            postReportFailure?: undefined;
            nativeStopCheck?: undefined;
        } | {
            state: string;
            remoteStopped: boolean;
            cancellationRequested: boolean;
            reportDigestPresent: boolean;
            stopReason: string | undefined;
            observedAt: string;
            deadline: string | undefined;
            claimDeadline: string | undefined;
            reportBy: string | undefined;
            progress: {
                stage: string;
                completed: string;
                running: string;
                blocker: string;
                lastMeaningfulAt: string;
                reportedAt: string;
            } | undefined;
            stopControl: {
                requestedAt: string;
                issuedAt?: string;
                acknowledgedAt?: string;
                checkedAt?: string;
                error?: string;
                state: "requested" | "stop_unconfirmed" | "stopped";
            } | undefined;
            nativeHealth: {
                state: string;
                observedAt: string;
                reason?: string;
            } | undefined;
            nativeRateLimit: import("./native-turn-failure.js").NativeRateLimit | undefined;
            postReportFailure: {
                error: string;
                observedAt: string;
                reportReceivedAt: string;
                phase?: "session:sendMessage" | "native_history";
            } | undefined;
            nativeStopCheck: {
                since: string;
                checkedAt: string;
                observations: number;
                activityAt?: number;
            } | undefined;
        };
        task: StoredTask;
    }>;
    respond(...args: Parameters<TaskCoordinator["respond"]>): {
        ok: boolean;
        taskId: string;
        message: string;
    };
    reconcileReport(input: Parameters<TaskCoordinator["reconcileReport"]>[0]): Promise<{
        task: StoredTask;
        execution: {
            state: string;
            remoteStopped: boolean;
            cancellationRequested?: undefined;
            reportDigestPresent?: undefined;
            stopReason?: undefined;
            observedAt?: undefined;
            deadline?: undefined;
            claimDeadline?: undefined;
            reportBy?: undefined;
            progress?: undefined;
            stopControl?: undefined;
            nativeHealth?: undefined;
            nativeRateLimit?: undefined;
            postReportFailure?: undefined;
            nativeStopCheck?: undefined;
        } | {
            state: string;
            remoteStopped: boolean;
            cancellationRequested: boolean;
            reportDigestPresent: boolean;
            stopReason: string | undefined;
            observedAt: string;
            deadline: string | undefined;
            claimDeadline: string | undefined;
            reportBy: string | undefined;
            progress: {
                stage: string;
                completed: string;
                running: string;
                blocker: string;
                lastMeaningfulAt: string;
                reportedAt: string;
            } | undefined;
            stopControl: {
                requestedAt: string;
                issuedAt?: string;
                acknowledgedAt?: string;
                checkedAt?: string;
                error?: string;
                state: "requested" | "stop_unconfirmed" | "stopped";
            } | undefined;
            nativeHealth: {
                state: string;
                observedAt: string;
                reason?: string;
            } | undefined;
            nativeRateLimit: import("./native-turn-failure.js").NativeRateLimit | undefined;
            postReportFailure: {
                error: string;
                observedAt: string;
                reportReceivedAt: string;
                phase?: "session:sendMessage" | "native_history";
            } | undefined;
            nativeStopCheck: {
                since: string;
                checkedAt: string;
                observations: number;
                activityAt?: number;
            } | undefined;
        };
        taskId: string;
        attemptId: string;
        state: string;
        next: string;
        ok: boolean;
        alreadyReconciled: boolean;
        taskCompleted: boolean;
    }>;
    sync(taskId: string, limit?: number): Promise<StoredTask>;
    requireTask(taskId: string): StoredTask;
    executionStatus(taskId: string): {
        state: string;
        remoteStopped: boolean;
        cancellationRequested: boolean;
        reportDigestPresent: boolean;
        observedAt: string | undefined;
        deadline: string | undefined;
        stopProofScope: string;
    } | {
        state: string;
        remoteStopped: boolean;
        cancellationRequested?: undefined;
        reportDigestPresent?: undefined;
        stopReason?: undefined;
        observedAt?: undefined;
        deadline?: undefined;
        claimDeadline?: undefined;
        reportBy?: undefined;
        progress?: undefined;
        stopControl?: undefined;
        nativeHealth?: undefined;
        nativeRateLimit?: undefined;
        postReportFailure?: undefined;
        nativeStopCheck?: undefined;
    } | {
        state: string;
        remoteStopped: boolean;
        cancellationRequested: boolean;
        reportDigestPresent: boolean;
        stopReason: string | undefined;
        observedAt: string;
        deadline: string | undefined;
        claimDeadline: string | undefined;
        reportBy: string | undefined;
        progress: {
            stage: string;
            completed: string;
            running: string;
            blocker: string;
            lastMeaningfulAt: string;
            reportedAt: string;
        } | undefined;
        stopControl: {
            requestedAt: string;
            issuedAt?: string;
            acknowledgedAt?: string;
            checkedAt?: string;
            error?: string;
            state: "requested" | "stop_unconfirmed" | "stopped";
        } | undefined;
        nativeHealth: {
            state: string;
            observedAt: string;
            reason?: string;
        } | undefined;
        nativeRateLimit: import("./native-turn-failure.js").NativeRateLimit | undefined;
        postReportFailure: {
            error: string;
            observedAt: string;
            reportReceivedAt: string;
            phase?: "session:sendMessage" | "native_history";
        } | undefined;
        nativeStopCheck: {
            since: string;
            checkedAt: string;
            observations: number;
            activityAt?: number;
        } | undefined;
    };
    listTasks(limit: number): StoredTask[];
    listTasksByCreatedCursor(options: {
        limit: number;
        afterTaskId?: string;
    }): {
        tasks: StoredTask[];
        anchorFound: boolean;
    };
    listMessages(taskId: string, limit: number, attemptId?: string): import("./workbuddy-client.js").LocalMessage[];
    listAttempts(taskId: string): import("./task-store.js").StoredAttempt[];
    statusView(task: StoredTask): TaskStatusView;
}
