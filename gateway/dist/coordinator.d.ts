import type { Config } from "./config.js";
import { TaskStore, type StoredTask, type TaskReport } from "./task-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
export interface SendTaskInput {
    taskId?: string;
    objective: string;
    workspace?: string;
    constraints?: string[];
    acceptanceCommands?: string[];
    timeoutSeconds?: number;
    sessionId?: string;
    model?: string;
    sessionMode?: "existing" | "new";
}
export declare class TaskCoordinator {
    private readonly config;
    readonly store: TaskStore;
    private readonly client;
    private readonly resolveWorkspace;
    constructor(config: Config, store: TaskStore, client: WorkBuddyClient, resolveWorkspace?: (config: Config, input: {
        workspace: string;
        sessionId?: string;
        title?: string;
        model?: string;
        workerKey?: string;
    }) => Promise<{
        workspace: string;
        sessionId: string;
    }>);
    private requireDesktop;
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
    private dispatch;
    sync(taskId: string, limit?: number): Promise<StoredTask>;
    continue(input: {
        taskId: string;
        feedback: string;
        acceptanceCommands?: string[];
        timeoutSeconds?: number;
        model?: string;
    }): Promise<{
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
    accept(taskId: string, note: string, evidence: string[], artifactPaths?: string[]): Promise<StoredTask>;
    respond(taskId: string, decision: "allow_once" | "reject_once" | "cancel" | "submit", content?: Record<string, unknown>): {
        ok: boolean;
        taskId: string;
        message: string;
    };
    executionStatus(taskId: string): {
        state: string;
        remoteStopped: boolean;
        cancellationRequested?: undefined;
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
    reconcileReport(input: {
        taskId: string;
        attemptId: string;
        reason: string;
    }): Promise<{
        task: StoredTask;
        execution: {
            state: string;
            remoteStopped: boolean;
            cancellationRequested?: undefined;
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
    cancel(taskId: string, reason?: string): Promise<{
        message: string;
        state: string;
        remoteStopped: boolean;
        cancellationRequested?: undefined;
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
    requireTask(taskId: string): StoredTask;
}
export declare function parseReport(rawText: string): TaskReport;
export declare function buildTaskPrompt(input: SendTaskInput & {
    taskId: string;
}, feedback?: string): string;
