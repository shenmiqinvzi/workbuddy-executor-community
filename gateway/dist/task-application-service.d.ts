import type { TaskCoordinator, SendTaskInput } from "./coordinator.js";
import type { StoredTask } from "./task-store.js";
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
    /** Task ids in stable order; the cursor echoes the last id of this page. */
    tasks: StageTaskView[];
    /** The cursor to pass as afterTaskId, or null when this page is the last. */
    nextAfterTaskId: string | null;
}
/** The MCP entry point and future local HTTP adapter share this service. */
export declare class TaskApplicationService {
    private readonly coordinator;
    private readonly maxAttempts;
    private readonly runsDir;
    constructor(coordinator: TaskCoordinator, maxAttempts: number, runsDir: string);
    /** Stored facts only: deliberately bypasses every synchronising coordinator method. */
    readProjection(taskId: string): import("./task-view-reader.js").TaskProjectionResult;
    /**
     * Stage-1 read-only detail query for one stored task.
     *
     * It reuses readProjection's store and run-file reads — the same snapshot
     * semantics, the same failure codes, the same attempt re-check — and maps
     * the result into the stage view. Like readProjection it never calls sync,
     * executionStatus, checkWorker or any dispatching entry point, creates no
     * store and writes nothing.
     */
    readStageView(taskId: string): StageReadResult;
    /**
     * Stage-1 read-only list query with the stable pagination contract.
     *
     * Ordering is created_at ASC + task_id ASC (the contract's stable cursor
     * order), read through TaskStore.listTasksByCreatedCursor. The existing MCP
     * list (updated_at DESC + offset) is deliberately untouched and is not
     * called from here. The views are assembled from per-task stage reads, so a
     * page is a sequence of snapshots read one after another, not one
     * transaction; a task changing mid-page shows its newer facts and never a
     * fabricated mixture.
     */
    listStageViews(options: {
        limit: number;
        afterTaskId?: string;
    }): StageListResult | {
        ok: false;
        readOnly: true;
        snapshotOnly: true;
        code: "invalid_cursor";
        field: string;
        message: string;
    };
    /** The already-fetched task row for a projection that just read it. */
    private requireStoredTask;
    send(input: SendTaskInput): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask;
        message: string;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask | undefined;
        next: string;
        error?: undefined;
    } | {
        ok: boolean;
        task: StoredTask;
        error: string;
        created?: undefined;
        next?: undefined;
    }>;
    continue(input: Parameters<TaskCoordinator["continue"]>[0]): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask | undefined;
        next: string;
        error?: undefined;
    } | {
        ok: boolean;
        task: StoredTask;
        error: string;
        created?: undefined;
        next?: undefined;
    }>;
    accept(...args: Parameters<TaskCoordinator["accept"]>): Promise<StoredTask>;
    cancel(...args: Parameters<TaskCoordinator["cancel"]>): Promise<{
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
