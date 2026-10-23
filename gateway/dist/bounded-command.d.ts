export interface CommandSpec {
    executable: string;
    args: string[];
    cwd: string;
    timeoutSeconds: number;
    inputs?: string[];
}
/**
 * Why the Windows job supervisor did not produce a result.
 *
 * The supervisor starts PowerShell, compiles its C# helper with Add-Type and
 * only then begins supervising, so its total time is startup + the command's
 * own bound + cleanup. When the parent watchdog fires, the run reports 125 and
 * the supervisor's own verdict is lost; without this evidence it is impossible
 * to tell a slow startup from a genuinely stuck helper.
 */
export interface CommandFailureEvidence {
    /** True when the parent watchdog killed the supervisor because it never returned. */
    watchdogFired: boolean;
    /** The supervisor exit code, or null when it never exited. */
    helperExitCode: number | null;
    /** Wall time from spawning the supervisor to the failure. */
    elapsedMs: number;
    /** Bytes the supervisor wrote to stdout. */
    stdoutBytes: number;
    /** The bounded tail of the supervisor stderr. */
    stderrTail: string;
}
export declare function runBounded(spec: CommandSpec, directory: string, options?: {
    cancelFile?: string;
    reportBy?: string;
}): Promise<{
    stdout: string;
    stderr: string;
    record: string;
    exitCode: number;
    reason: string;
    cleanupConfirmed: boolean;
    pid?: number;
    ownership?: string;
    failure?: CommandFailureEvidence;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    before: {
        [k: string]: string;
    };
    after: {
        [k: string]: string;
    };
    executable: string;
    args: string[];
    cwd: string;
    timeoutSeconds: number;
    inputs?: string[];
}>;
