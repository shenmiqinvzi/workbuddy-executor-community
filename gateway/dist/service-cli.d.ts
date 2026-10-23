import { windowsProcessTable } from "./native-process.js";
import { type Config } from "./config.js";
import { type ServiceRegistration } from "./persistent-service.js";
interface CommandResult {
    status: number;
    stdout: string;
    stderr?: string;
}
export type LaunchctlRunner = (args: string[]) => CommandResult;
export declare function launchdPlist(registration: ServiceRegistration, configFile: string): string;
export interface InstallServiceOptions {
    config: Config;
    sessionId: string;
    workspace: string;
    projectDir: string;
    nodeBin?: string;
    cdpPort: number;
    intervalMs?: number;
    /** Explicit test/platform injection; production uses the actual macOS account. */
    platform?: NodeJS.Platform;
    homeDir?: string;
    uid?: number;
}
export declare function installService(options: InstallServiceOptions, run?: LaunchctlRunner): {
    ok: true;
    registration: ServiceRegistration;
    configFile: string;
    restartWorkBuddyRequired: boolean;
};
/** WSH requires a Unicode BOM to preserve paths beyond the system code page. */
export declare function windowsStartupScript(projectDir: string, nodeBin: string, configFile: string): Buffer;
/**
 * Windows has no launchd. The same supervision loop runs as a detached Node
 * process, started now and re-started at logon through the Startup folder.
 */
export declare function installServiceWindows(options: InstallServiceOptions): {
    ok: true;
    registration: ServiceRegistration;
    configFile: string;
    restartWorkBuddyRequired: boolean;
};
export declare function serviceStatus(configFile: string, run?: LaunchctlRunner, uid?: number | undefined): Record<string, unknown>;
export declare function verifyServiceProcess(registration: ServiceRegistration, configFile: string, pid: number, table?: import("./native-process.js").NativeProcess[]): void;
export declare function serviceProcessToStop(registration: ServiceRegistration, configFile: string, table: ReturnType<typeof windowsProcessTable>, recordedPid?: number): number | undefined;
export declare function uninstallService(configFile: string, run?: LaunchctlRunner, uid?: number | undefined): Record<string, unknown>;
export {};
