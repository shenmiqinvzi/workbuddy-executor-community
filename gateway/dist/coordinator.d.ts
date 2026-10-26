import type { Config } from "./config.js";
import { TaskStore, type StoredTask, type TaskReport } from "./task-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
export { runEvidenceDigestOf } from "./run-evidence.js";
import { type ModelObservation } from "./collaboration.js";
import type { OperationOptions } from "./operation-admission.js";
export interface SendTaskInput extends OperationOptions {
    taskId?: string;
    objective: string;
    workspace?: string;
    constraints?: string[];
    acceptanceCommands?: string[];
    timeoutSeconds?: number;
    sessionId?: string;
    model?: string;
    sessionMode?: "existing" | "new";
    contract?: unknown;
}
export declare class TaskCoordinator {
    private readonly config;
    readonly store: TaskStore;
    private readonly client;
    private readonly resolveWorkspace;
    private readonly observeModel;
    constructor(config: Config, store: TaskStore, client: WorkBuddyClient, resolveWorkspace?: (config: Config, input: {
        workspace: string;
        sessionId?: string;
        title?: string;
        model?: string;
        workerKey?: string;
        admissionTaskId?: string;
        admissionOperationId?: string;
    }) => Promise<{
        workspace: string;
        sessionId: string;
    }>, observeModel?: (config: Config, sessionId: string, model: string) => Promise<ModelObservation>);
    modelPolicy(): import("./collaboration.js").ModelPolicy;
    private requireDesktop;
    send(input: SendTaskInput): Promise<{
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
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
        message: string;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
        message?: undefined;
    }>;
    private prepareWorkspace;
    private sendAdmitted;
    private sendWithContract;
    private dispatch;
    sync(taskId: string, limit?: number): Promise<StoredTask>;
    observeRecovery(taskId: string): Promise<StoredTask>;
    /**
     * Close a cancelled/accepted task exactly once (T2-R3): once the business
     * terminal decision AND the native stop proof are both on record, record
     * the durable closure event. Dedup is by sourceRef (attempt+type), so
     * repeated syncs never duplicate it; no business state changes here and no
     * worker is re-dispatched. A terminal task without stop evidence stays
     * open until that proof arrives.
     */
    private closeTerminalTask;
    /**
     * Fold the current run snapshot's stop/authentication evidence into the
     * task row (T2-R1): the digest is part of the fact signature, so stop
     * evidence appearing or changing regenerates the revision without any task
     * business field changing. First-time confirmed stop proof also records the
     * contract's native_stop_confirmed event, deduplicated by sourceRef.
     * Plain reads without a snapshot write nothing.
     */
    private recordRunEvidence;
    continue(input: {
        taskId: string;
        feedback: string;
        acceptanceCommands?: string[];
        timeoutSeconds?: number;
        model?: string;
    } & OperationOptions): Promise<({
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
    private continueAdmitted;
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
    cancel(taskId: string, reason?: string): Promise<{
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
    requireTask(taskId: string): StoredTask;
}
export declare function parseReport(rawText: string): TaskReport;
export declare function buildTaskPrompt(input: SendTaskInput & {
    taskId: string;
}, feedback?: string): string;
/**
 * Whether a stored digest records confirmed stop proof FOR THIS ATTEMPT
 * (T2-R2): digests without an attemptId (legacy rows) only count when the
 * caller passes no attemptId to bind; per-attempt callers treat them as
 * "not recorded for this round", so rework rounds are never suppressed.
 */
export declare function digestRecordsStopFor(digest: string | undefined, attemptId: string | undefined): boolean;
