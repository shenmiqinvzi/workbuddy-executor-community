import type { TaskStore, StoredTask } from "./task-store.js";
import type { DshTransport } from "./dsh-client.js";
import type { ExecutionSelection } from "./task-contract.js";
type FreeRate = {
    credits: string;
    observedAt: string;
};
/** Trusted backend integration, never a caller-supplied 'free' flag. The DSH
 * native catalog has no rates: absent verifier means dispatch is unavailable. */
export type DshFreeRateVerifier = (selection: ExecutionSelection) => Promise<FreeRate>;
/** Shared TaskStore owns business state. The transport owns native sessions,
 * durable request events and cancellation. No workflow/Reviewer is created. */
export declare class DshTaskCoordinator {
    readonly store: TaskStore;
    readonly client: DshTransport;
    readonly runsDir: string;
    private readonly verifyFree?;
    constructor(store: TaskStore, client: DshTransport, runsDir: string, verifyFree?: DshFreeRateVerifier | undefined);
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
    }): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask;
        code: string;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
    }>;
    private dispatch;
    private fold;
    sync(taskId: string, limit?: number): Promise<StoredTask>;
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
    }): Promise<{
        ok: boolean;
        created: boolean;
        task: StoredTask;
        code?: undefined;
    } | {
        ok: boolean;
        created: boolean;
        task: StoredTask;
        code: string;
    }>;
    accept(taskId: string, note: string, evidence: string[], artifactPaths?: string[]): Promise<StoredTask>;
}
export {};
