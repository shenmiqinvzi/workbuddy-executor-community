import type { Config } from "./config.js";
import { TaskStore } from "./task-store.js";
/** This adapter may wake the native chat; it must never execute the queue task. */
export interface NativeObservation {
    state: "idle" | "busy" | "waiting_input" | "offline";
    workspace?: string;
    reason?: string;
    activityAt?: number;
    latestWakeId?: string | null;
    failure?: {
        wakeId: string;
        error: string;
        observedAt: string;
        phase?: "session:sendMessage" | "native_history";
    };
}
export interface NativeDesktopTrigger {
    inspect(sessionId: string, options?: {
        readOnly?: boolean;
    }): Promise<NativeObservation>;
    setModel?(sessionId: string, model: string): Promise<{
        sessionId: string;
        model: string;
    }>;
    wakeIdle(sessionId: string, wakeId: string, prompt: string, model?: string): Promise<{
        accepted: boolean;
        receipt?: string;
        error?: string;
    }>;
    findWake?(sessionId: string, wakeId: string): Promise<boolean>;
    cancelAttempt?(sessionId: string, wakeId: string, workspace: string): Promise<void>;
}
export interface ServiceRegistration {
    version: 1;
    sessionId: string;
    workspace: string;
    projectDir: string;
    nodeBin: string;
    cdpPort: number;
    dbFile: string;
    runsDir: string;
    workbuddyConfigDir: string;
    cliElectronPath: string;
    intervalMs?: number;
    installedAt?: string;
    launchdLabel?: string;
    plistPath?: string;
    launchctlEnvPrevious?: {
        present: boolean;
        value?: string;
    };
}
export interface WakeIntent {
    version: 1;
    sessionId: string;
    attemptId: string;
    wakeId: string;
    state: "submitting" | "submitted" | "uncertain" | "rejected";
    receipt?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    submissions?: number;
}
export interface PumpResult {
    status: "no_task" | "session_busy" | "listener_ready" | "active_lease" | "unavailable" | "binding_mismatch" | "deadline_passed" | "wake_submitted" | "wake_pending" | "wake_uncertain" | "wake_rejected" | "native_blocked" | "waiting_input" | "stop_confirmed" | "stop_unconfirmed";
    sessionId: string;
    attemptId?: string;
    wakeId?: string;
    reason?: string;
}
export declare function serviceRegistrationPath(projectDir: string): string;
export declare function readServiceRegistration(file: string): ServiceRegistration | undefined;
export declare function validateServiceRegistration(value: ServiceRegistration): void;
export declare function registeredServiceConfig(config: Config, registration: ServiceRegistration): Config;
/** Explicit operator recovery, never part of the automatic pump/retry loop. */
export declare function recoverExpiredAttempt(config: Config, registration: ServiceRegistration, trigger: NativeDesktopTrigger, input: {
    taskId: string;
    attemptId: string;
    reason: string;
}): Promise<{
    taskId: string;
    attemptId: string;
    sessionId: string;
    state: string;
    taskCompleted: boolean;
    next: string;
    ok: true;
    alreadyRecovered: boolean;
}>;
/** Bounded reconciliation restores an existing report for review, never a new execution or acceptance. */
export declare function reconcileReportedAttempt(config: Config, registration: ServiceRegistration, trigger: NativeDesktopTrigger, input: {
    taskId: string;
    attemptId: string;
    reason: string;
}): Promise<{
    taskId: string;
    attemptId: string;
    state: string;
    next: string;
    ok: boolean;
    alreadyReconciled: boolean;
    taskCompleted: boolean;
}>;
/** One launchd service supervises every enrolled native session independently. */
export declare function pumpWorkspaceWorkers(config: Config, registration: ServiceRegistration, trigger: NativeDesktopTrigger, store: TaskStore): Promise<{
    workers: (PumpResult & {
        workspace: string;
    })[];
    status?: "waiting_input" | "stop_unconfirmed" | "no_task" | "session_busy" | "listener_ready" | "active_lease" | "unavailable" | "binding_mismatch" | "deadline_passed" | "wake_submitted" | "wake_pending" | "wake_uncertain" | "wake_rejected" | "native_blocked" | "stop_confirmed" | undefined;
    sessionId?: string | undefined;
    attemptId?: string;
    wakeId?: string;
    reason?: string;
    workspace?: string | undefined;
}>;
export declare class PersistentDesktopService {
    readonly registration: ServiceRegistration;
    private readonly trigger;
    private readonly store;
    private readonly config;
    private readonly root;
    constructor(config: Config, registration: ServiceRegistration, trigger: NativeDesktopTrigger, store: TaskStore);
    pump(): Promise<PumpResult>;
    private result;
    private candidates;
    private unresolvedAttempt;
    private unresolvedLease;
    private inspectAttempt;
    private stopAttempt;
    private pumpLocked;
}
