import type { Config } from "./config.js";
import { TaskApplicationService } from "./task-application-service.js";
import { DesktopDispatchSession, type DesktopCatalogSource, type DesktopDraft } from "./desktop-dispatch.js";
import { DesktopDispatchJournal } from "./desktop-dispatch-journal.js";
export declare function assertDesktopDispatchDatabase(config: Config): void;
export declare function desktopModelCatalog(config: Config, env?: NodeJS.ProcessEnv): Promise<DesktopCatalogSource>;
export declare function desktopJournal(config: Config, env?: NodeJS.ProcessEnv): DesktopDispatchJournal;
export declare function createDesktopDispatchSession(config: Config, env?: NodeJS.ProcessEnv): DesktopDispatchSession;
/** Trusted worker composition after native confirmation. Existing backend
 * remains the sole owner of admission, preparation, execution and deadlines. */
export declare function sendDesktopAgreement(service: TaskApplicationService, draft: DesktopDraft): Promise<{
    ok: boolean;
    created: boolean;
    task: import("./task-store.js").StoredTask;
} | {
    ok: boolean;
    task: import("./task-store.js").StoredTask;
    error: string;
    created?: undefined;
    next?: undefined;
}>;
export declare function runDesktopDispatchWorker(config: Config, requestId: string, env?: NodeJS.ProcessEnv): Promise<void>;
