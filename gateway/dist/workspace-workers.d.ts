import type { Config } from "./config.js";
import type { PreparationProbeRecord } from "./preparation-protocol.js";
export interface WorkspaceWorker {
    sessionId: string;
    workspace: string;
    state: "creating" | "ready" | "uncertain";
    selected: boolean;
    createdAt: string;
    updatedAt: string;
    error?: string;
}
export interface NativeWorkerCreator {
    createWorker(workspace: string, sessionId: string, title?: string): Promise<{
        sessionId: string;
        workspace: string;
    }>;
    setModel?(sessionId: string, model: string): Promise<{
        sessionId: string;
        model: string;
    }>;
    /** 只读观测：返回该会话当前是否在原生端可见；缺席不代表没有创建。 */
    probe?(sessionId: string, workspace: string): Promise<{
        sessionId: string;
        workspace: string;
    } | null>;
}
export declare function readWorkspaceWorkers(config: Config, fallback?: {
    workspace: string;
    sessionId: string;
}): WorkspaceWorker[];
/** This is our routing registry, never WorkBuddy's own database. */
export declare class WorkspaceWorkers {
    readonly config: Config;
    private readonly db;
    private readonly journal;
    constructor(config: Config);
    /**
     * 失败路径上的只读观测。它只记录“现在能看到什么”，不推导终态：
     * 查不到 ≠ 未创建，异常 ≠ 未到达。任何异常都不得顶替原来的失败原因。
     */
    private observePreparation;
    private safeProbe;
    /** 只读：某次预留身份上记录过的全部观测，按时间升序，永不改写。 */
    preparationProbes(sessionId: string): PreparationProbeRecord[];
    private decode;
    selected(workspace: string): WorkspaceWorker | undefined;
    list(): WorkspaceWorker[];
    seed(worker: {
        sessionId: string;
        workspace: string;
    }): void;
    select(workspace: string, sessionId: string): WorkspaceWorker;
    private keyed;
    private reserve;
    private verify;
    ensure(input: {
        workspace: string;
        sessionId?: string;
        title?: string;
        model?: string;
        workerKey?: string;
    }, native: NativeWorkerCreator): Promise<{
        created: boolean;
        worker: WorkspaceWorker;
        model?: string;
    }>;
    close(): void;
}
