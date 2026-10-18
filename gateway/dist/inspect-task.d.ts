import { type Config } from './config.js';
/** Offline diagnostic snapshot. No constructors that create/migrate stores,
 * no permissions changes, native RPC, task claims, or worker result submission. */
export declare function inspectTask(config: Config, taskId: string): {
    ok: boolean;
    readOnly: boolean;
    snapshotOnly: boolean;
    checkedAt: string;
    task: import("./task-store.js").StoredTask;
    messages: any[];
    execution: {
        state: string;
        remoteStopped: boolean;
        observedAt: string | undefined;
        cancellationRequested: boolean;
        deadline: string | undefined;
        claimDeadline: string | undefined;
    };
    workerResult: {
        present: boolean;
        authenticated: boolean;
        status?: string;
        file?: string;
        bytes?: number;
    };
    next: string;
};
export declare function runInspect(argument: string | undefined): void;
