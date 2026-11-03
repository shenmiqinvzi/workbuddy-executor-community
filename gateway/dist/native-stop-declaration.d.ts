import type { DatabaseSync } from "node:sqlite";
import { type RunSnapshot } from "./run-journal.js";
import type { TaskStore } from "./task-store.js";
/** A human assertion that native execution has stopped.
 *
 * This is deliberately *not* native evidence: it never satisfies
 * `hasNativeStopEvidence`, it is never written into the run journal, and it is
 * stored under its own name so every later reader can see who claimed what.
 * Recovery may use it to close a workflow, but the decision record keeps
 * `proof: "declared_stop"`, which is a weaker fact than `native_stopped`.
 */
export interface NativeStopDeclaration {
    schemaVersion: "native-stop-declaration/1";
    declarationId: string;
    taskId: string;
    attemptId: string;
    revision: string;
    actor: string;
    statement: string;
    declaredAt: string;
    /** What the ledger said at declaration time, so a later reader can tell
     * whether the situation has changed since. */
    basis: {
        taskState: string;
        nativeStoppedAt: null;
        runStatus: string | null;
        reportDigest: string | null;
    };
}
/** Read the saved run record for one attempt. A malformed or missing file is
 * `null`, never a guess: a declaration cannot rest on evidence that is absent. */
export declare function readRunSnapshot(runsDir: string, attemptId: string | null | undefined): RunSnapshot | null;
export declare class NativeStopDeclarations {
    private readonly db;
    private readonly store;
    constructor(db: DatabaseSync, store: TaskStore);
    private decode;
    get(taskId: string, attemptId: string): NativeStopDeclaration | null;
    forTask(taskId: string): NativeStopDeclaration[];
    /** Record the assertion. It changes no task state, no capacity and no run
     * journal; only a later, separately authorized recovery uses it. */
    declare(input: {
        taskId: string;
        attemptId: string;
        revision: string;
        actor: string;
        statement: string;
        snapshot: RunSnapshot | null;
    }): NativeStopDeclaration;
}
