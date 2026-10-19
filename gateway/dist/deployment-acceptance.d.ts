import { type Config } from "./config.js";
type Scenario = "normal" | "rework" | "cancel";
/** Saved evidence only: no native connection, synchronization, dispatch or stop request. */
export declare function checkDeploymentTask(config: Config, scenario: Scenario, taskId?: string): {
    status: string;
    reason: string;
};
export declare function runDeploymentCheck(args?: string[]): Promise<void>;
export {};
