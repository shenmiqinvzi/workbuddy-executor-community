import { DshTaskCoordinator } from "./dsh-coordinator.js";
import type { TaskStore } from "./task-store.js";
/** Explicit private configuration only; enabling an adapter never widens the
 * persisted model policy, confirms a plan or starts a provider request. */
export declare function configuredDshCoordinator(store: TaskStore, runsDir: string, env?: NodeJS.ProcessEnv): DshTaskCoordinator | undefined;
