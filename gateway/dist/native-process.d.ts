import { execFileSync } from "node:child_process";
export interface NativeProcess {
    pid: number;
    ppid: number;
    exe?: string;
    commandLine?: string;
}
/**
 * Read the Windows process table once through the OS. This only inspects
 * process metadata: it never starts, stops or reconfigures another program.
 */
export declare function windowsPowerShellPath(): string;
export declare function windowsProcessTable(run?: typeof execFileSync): NativeProcess[];
export declare function hasProcess(pid: number, table?: NativeProcess[]): boolean;
/** Compare an executable path from the process table with a configured path. */
export declare function sameExecutable(candidate: string | undefined, configured: string): boolean;
