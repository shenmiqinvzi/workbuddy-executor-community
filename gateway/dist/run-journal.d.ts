import type { Config } from "./config.js";
import type { LocalMessage } from "./workbuddy-client.js";
import type { NativeRateLimit } from "./native-turn-failure.js";
import type { ReportAuthentication } from "./report-authentication.js";
export type RunStatus = "queued" | "working" | "needs_review" | "blocked" | "failed" | "cancelled";
export interface RunRequest {
    attemptId: string;
    taskId: string;
    prompt: string;
    workspace?: string;
    sessionId?: string;
    model?: string;
    sessionMode?: "existing" | "new";
    timeoutSeconds: number;
    /** Trusted contract reservation; never extended when the queue receives it. */
    deadline?: string;
}
export interface RunSnapshot {
    attemptId: string;
    taskId: string;
    status: RunStatus;
    pid?: number;
    driver?: "desktop-acp" | "desktop-queue";
    deadline?: string;
    claimDeadline?: string;
    sessionId?: string;
    runtimeSource?: string;
    text?: string;
    stopReason?: string;
    error?: string;
    nativeRateLimit?: NativeRateLimit;
    nativeFailure?: {
        wakeId: string;
        error: string;
        observedAt: string;
        phase?: "session:sendMessage" | "native_history";
    };
    nativeStopCheck?: {
        since: string;
        checkedAt: string;
        observations: number;
        activityAt?: number;
    };
    postReportFailure?: {
        error: string;
        observedAt: string;
        reportReceivedAt: string;
        phase?: "session:sendMessage" | "native_history";
    };
    waitingInput?: boolean;
    artifacts?: string[];
    reportDigest?: string;
    /**
     * Written only by DesktopQueue.report(), in the same save as the report and
     * only after its identity, lease, deadline and validation checks passed.
     * Absent on older records and on late or replayed reports.
     */
    reportAuthentication?: ReportAuthentication;
    validationRecords?: Array<{
        path: string;
        sha256: string;
    }>;
    nativeIdleSince?: string;
    nativeStoppedAt?: string;
    nativeStopSource?: "native_idle" | "not_dispatched";
    stopControl?: {
        requestedAt: string;
        issuedAt?: string;
        acknowledgedAt?: string;
        checkedAt?: string;
        error?: string;
        state: "requested" | "stop_unconfirmed" | "stopped";
    };
    progress?: {
        stage: string;
        completed: string;
        running: string;
        blocker: string;
        lastMeaningfulAt: string;
        reportedAt: string;
    };
    reportBy?: string;
    nativeHealth?: {
        state: string;
        observedAt: string;
        reason?: string;
    };
    updatedAt: string;
}
export interface RunEvent {
    seq: number;
    type: string;
    text: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
}
/** A worker report ends its lease, not necessarily the native model/tool turn. */
export declare function hasNativeStopEvidence(snapshot: RunSnapshot | undefined): boolean;
export declare function runsDirectory(config: Config): string;
export declare function writePrivateJson(file: string, value: unknown): void;
export declare class RunJournal {
    readonly root: string;
    readonly attemptId: string;
    readonly dir: string;
    private seq;
    constructor(root: string, attemptId: string);
    static newId(): string;
    request(): RunRequest;
    snapshot(): RunSnapshot | undefined;
    save(snapshot: RunSnapshot): void;
    append(type: string, text: string, metadata?: Record<string, unknown>): RunEvent;
    events(after?: number, limit?: number): RunEvent[];
    cancel(reason?: string): void;
    cancellationRequested(): boolean;
    checkWorker(): void;
}
export declare class DurableRuns {
    private readonly config;
    readonly root: string;
    constructor(config: Config);
    start(request: RunRequest): Promise<void>;
    messages(cursor: string, limit?: number): LocalMessage[];
    cancel(attemptId: string): boolean;
    respond(attemptId: string, decision: "allow_once" | "reject_once" | "cancel" | "submit", content?: Record<string, unknown>): void;
}
