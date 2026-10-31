import type { Config } from "./config.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { DesktopControlSession, type DesktopControlSnapshot } from "./desktop-control.js";
import { DesktopControlJournal, type DesktopControlKind } from "./desktop-control-journal.js";
export declare function desktopControlJournal(config: Config, env?: NodeJS.ProcessEnv): DesktopControlJournal;
declare function serviceFor(config: Config, store: TaskStore, env: NodeJS.ProcessEnv): {
    coordinator: TaskCoordinator;
    service: TaskApplicationService;
};
export declare function inspectDesktopControl(config: Config, taskId: string, kind: DesktopControlKind, env?: NodeJS.ProcessEnv): Promise<DesktopControlSnapshot>;
export declare function createDesktopControlSession(config: Config, env?: NodeJS.ProcessEnv): DesktopControlSession;
/** Optional factories are a trusted local test seam; the desktop worker never
 * receives them from a page, command line or serialized request. */
export declare function runDesktopControlWorker(config: Config, requestId: string, env?: NodeJS.ProcessEnv, hooks?: {
    inspect?: typeof inspectDesktopControl;
    serviceFor?: typeof serviceFor;
}): Promise<void>;
export {};
