import type { Config } from "./config.js";
/** The auto-start entry is a convenience, never part of the dispatch effect
 * boundary: a login-item or profile failure must not turn an already prepared
 * native session into an unknown outcome. */
export type AutostartAttempt = {
    installed: boolean;
    reused: boolean;
    error?: string;
    startupWarning?: string;
};
export declare function installAutostartIfNeeded(registration: unknown, install: () => void): AutostartAttempt;
export declare function workerRegistration(config: Config): import("./persistent-service.js").ServiceRegistration | undefined;
export declare function ensureWorkspace(config: Config, input: {
    workspace: string;
    sessionId?: string;
    title?: string;
    model?: string;
    workerKey?: string;
    admissionTaskId?: string;
    admissionOperationId?: string;
}): Promise<{
    workspace: string;
    sessionId: string;
    persistentService: AutostartAttempt;
    next: string;
    created: boolean;
    worker: import("./workspace-workers.js").WorkspaceWorker;
    model?: string;
    ok: boolean;
}>;
export declare function listModels(config: Config, sessionId?: string): Promise<{
    models: Array<{
        id: string;
        name: string;
    }>;
    currentModel?: string;
    sessionId?: string;
    ok: boolean;
}>;
export declare function listWorkspaces(config: Config): {
    desktopRegistered: boolean;
    sessionId: string;
    workspace: string;
    state: "creating" | "ready" | "uncertain";
    selected: boolean;
    createdAt: string;
    updatedAt: string;
    error?: string;
}[];
