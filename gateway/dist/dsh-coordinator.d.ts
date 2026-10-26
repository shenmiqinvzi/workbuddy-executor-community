import type { TaskStore, StoredTask } from "./task-store.js";
import type { DshTransport } from "./dsh-client.js";
import type { ExecutionSelection } from "./task-contract.js";
import type { OperationOptions } from "./operation-admission.js";
type ModelRate = {
    credits: string | null;
    observedAt: string;
};
/** Trusted source metadata, separate from native selection verification. Missing
 * pricing stays unknown; only an explicit free-only policy requires a rate. */
export type DshRateObserver = (selection: ExecutionSelection) => Promise<ModelRate>;
/** Compatibility alias for integrations opting into a free-only policy. */
export type DshFreeRateVerifier = DshRateObserver;
/** Shared TaskStore owns business state. The transport owns native sessions,
 * durable request events and cancellation. No workflow/Reviewer is created. */
export declare class DshTaskCoordinator {
    readonly store: TaskStore;
    readonly client: DshTransport;
    readonly runsDir: string;
    private readonly observeRate?;
    constructor(store: TaskStore, client: DshTransport, runsDir: string, observeRate?: DshRateObserver | undefined);
    policy(): import("./collaboration.js").ModelPolicy;
    owns(taskId: string): boolean;
    private task;
    private binding;
    discover(workspace: string, hostId?: string, sessionId?: string): Promise<{
        queriedDirectory: string;
        hostId: string;
        candidates: import("./deepseek-client.js").DeepSeekSession[];
        selected: import("./deepseek-client.js").DeepSeekSession | undefined;
        reason: string;
    }>;
    models(hostId: string): Promise<import("./dsh-client.js").DshCatalog>;
    private checkedSession;
    private observation;
    send(input: {
        contract: unknown;
        sessionId: string;
        objective: string;
        hostId?: string;
        taskId?: string;
        workspace?: string;
    } & OperationOptions): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask;
    }>;
    private sendAdmitted;
    private dispatch;
    private fold;
    sync(taskId: string, limit?: number, observeOnly?: boolean): Promise<StoredTask>;
    executionStatus(taskId: string): {
        state: string;
        remoteStopped: boolean;
        cancellationRequested: boolean;
        reportDigestPresent: boolean;
        observedAt: string | undefined;
        deadline: string | undefined;
        stopProofScope: string;
    };
    cancel(taskId: string, reason?: string): Promise<{
        state: string;
        remoteStopped: boolean;
        cancellationRequested: boolean;
        reportDigestPresent: boolean;
        observedAt: string | undefined;
        deadline: string | undefined;
        stopProofScope: string;
        ok: boolean;
        task: StoredTask;
    }>;
    continue(input: {
        taskId: string;
        feedback: string;
        model?: string;
        timeoutSeconds?: number;
        acceptanceCommands?: string[];
    } & OperationOptions): Promise<({
        ok: boolean;
        created: boolean;
        task: StoredTask;
        code?: undefined;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
        code: string;
    }) & import("./operation-admission.js").OperationReceipt>;
    private continueAdmitted;
    accept(taskId: string, note: string, evidence: string[], artifactPaths?: string[]): Promise<StoredTask>;
}
export {};
