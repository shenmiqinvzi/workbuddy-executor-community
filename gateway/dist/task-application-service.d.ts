import type { TaskCoordinator, SendTaskInput } from "./coordinator.js";
import type { StoredTask } from "./task-store.js";
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
/** The MCP entry point and future local HTTP adapter share this service. */
export declare class TaskApplicationService {
    private readonly coordinator;
    private readonly maxAttempts;
    private readonly runsDir;
    constructor(coordinator: TaskCoordinator, maxAttempts: number, runsDir: string);
    /** Stored facts only: deliberately bypasses every synchronising coordinator method. */
    readProjection(taskId: string): import("./task-view-reader.js").TaskProjectionResult;
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
    listMessages(taskId: string, limit: number, attemptId?: string): import("./workbuddy-client.js").LocalMessage[];
    listAttempts(taskId: string): import("./task-store.js").StoredAttempt[];
    statusView(task: StoredTask): TaskStatusView;
}
