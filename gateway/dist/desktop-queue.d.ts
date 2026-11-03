import { type ValidationEvidence } from "./worker-result.js";
import type { Config } from "./config.js";
import { type RunRequest, type RunSnapshot } from "./run-journal.js";
import type { LocalMessage } from "./workbuddy-client.js";
import type { NativeObservation } from "./persistent-service.js";
interface DesktopActor {
    desktopPid: number;
}
export interface QueueTask {
    status: "task";
    taskId: string;
    attemptId: string;
    sessionId: string;
    leaseToken: string;
    prompt: string;
    workspace?: string;
    deadline: string;
    reporting: {
        resultFile: string;
        command: string;
    };
}
/** Prove the helper was launched by the native desktop app, not a standalone CLI or Codex. */
export declare function assertDesktopCaller(config: Config): DesktopActor;
export declare function windowsWorkerCommand(nodeBin: string, helperFile: string, workspace: string): string;
/** The generated worker command runs inside the native application's own shell,
 * which never inherits this gateway's environment. Without the pinned
 * configuration the CLI either fails on a machine with more than one WorkBuddy
 * installation or silently addresses another task database. */
/** What a bounded command record must prove before it stops blocking a native stop. */
export type OwnedCommandRecord = {
    endedAt?: string;
    cleanupConfirmed?: boolean;
    processStarted?: boolean;
    reason?: string;
};
/**
 * A command blocks stop confirmation unless it ended and its cleanup is either confirmed or
 * vacuous. A supervisor that never started a process (script blocked by execution policy,
 * unlaunchable executable) writes no marker, so no process tree was left behind to vouch for.
 * The distinction is recorded as `processStarted` by the bounded runner; older records lack it
 * and keep the strict behaviour.
 */
export declare function ownedCommandStopReason(record: OwnedCommandRecord | undefined): "no_end_evidence" | "cleanup_unconfirmed" | null;
export declare function workerEnvPrefix(config: Config): string;
/** Applies the pinned configuration to the invoked command, not to the `cd`. */
export declare function withWorkerEnv(command: string, prefix: string): string;
export declare class DesktopQueue {
    private readonly config;
    private readonly verifyActor;
    readonly root: string;
    private readonly listenersDir;
    constructor(config: Config, verifyActor?: () => DesktopActor);
    prepare(sessionId: string, persistent?: boolean, wakeOnce?: boolean): {
        sessionId: string;
        workspace: string;
        started: boolean;
        mode: string;
        prompt: string;
    } | {
        sessionId: string;
        workspace: string | undefined;
        started: boolean;
        prompt: string;
        mode?: undefined;
    };
    listeners(): Array<{
        sessionId: string;
        workspace?: string;
        ready: boolean;
        source: string;
    }>;
    start(request: RunRequest): void;
    private startLocked;
    claim(sessionId: string, waitSeconds?: number): Promise<QueueTask | {
        status: "retry";
        message: string;
    }>;
    progress(input: {
        sessionId: string;
        attemptId: string;
        leaseToken: string;
        text: string;
    }): {
        ok: true;
        cancellationRequested: boolean;
    };
    requestCancellation(attemptId: string): boolean;
    updateStopControl(attemptId: string, control: NonNullable<RunSnapshot["stopControl"]>): void;
    recordNativeHealth(attemptId: string, native: NativeObservation): void;
    authorizeCommand(input: {
        sessionId: string;
        attemptId: string;
        leaseToken: string;
    }): RunSnapshot;
    authorizeCommandPaths(input: {
        sessionId: string;
        attemptId: string;
        leaseToken: string;
    }, spec: {
        cwd: string;
        inputs?: string[];
    }): RunSnapshot;
    report(input: {
        sessionId: string;
        attemptId: string;
        leaseToken: string;
        status: "completed" | "blocked" | "failed" | "cancelled";
        text: string;
        artifacts: string[];
        validationRecords?: ValidationEvidence[];
    }): {
        ok: true;
        status: string;
    };
    /** Supervisor evidence can block or confirm stop, never manufacture success. */
    observeNative(attemptId: string, native: NativeObservation): RunSnapshot;
    /** Reconcile the old ordering bug using the existing authenticated report only. */
    reconcileReportedFailure(input: {
        taskId: string;
        attemptId: string;
        sessionId: string;
        workspace: string;
        reason: string;
    }, native: NativeObservation): {
        ok: boolean;
        alreadyReconciled: boolean;
        taskCompleted: boolean;
    };
    private completedReportBeforeFailure;
    private preserveReportedFailure;
    /** Close an expired attempt after a separate native idle check. This is NOT a worker result. */
    confirmExpiredStop(input: {
        taskId: string;
        attemptId: string;
        sessionId: string;
        workspace: string;
        observedAt: string;
        reason: string;
    }): {
        ok: true;
        alreadyRecovered: boolean;
    };
    private mutateClaim;
    messages(cursor: string, limit?: number): LocalMessage[];
    checkDeadline(attemptId: string): void;
    private isDue;
    private expire;
}
export {};
