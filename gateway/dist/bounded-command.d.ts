export interface CommandSpec {
    executable: string;
    args: string[];
    cwd: string;
    timeoutSeconds: number;
    inputs?: string[];
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
