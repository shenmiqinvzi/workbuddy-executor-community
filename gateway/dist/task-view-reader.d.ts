/**
 * Read-only task projection entry point.
 *
 * This module exposes the accepted legacy-record adapter through a callable
 * query: it reads one stored task, its current attempt row and that attempt's
 * run files, then returns the adapter's projection unchanged.
 *
 * What this is:
 *   - A read-only view of what is already stored. It reports what it could not
 *     establish instead of filling the gaps.
 *   - A snapshot of files read one after another, not a transaction. The read
 *     re-checks the current attempt and revision afterwards and refuses to assemble a result
 *     if the attempt changed, because joining two rounds would describe neither.
 *
 * What this is not:
 *   - It is not a complete vNext TaskView. No revision, no reviewId and no
 *     agreement binding is invented here.
 *   - It is not a synchronisation step. It never calls coordinator.sync,
 *     executionStatus, checkWorker, observeNative or any other entry point that
 *     could sync, migrate, dispatch or write. It creates no TaskStore, creates
 *     no directory and starts no native work.
 *   - It does not collect live state. No liveObservation is supplied, so the
 *     projection cannot claim a trusted queued/running/waiting_input state.
 *
 * File ownership: the run directory is always derived from the service's own
 * runs directory plus the attempt id the task record already carries. A caller
 * cannot supply a path.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoredAttempt, StoredTask, TaskContractRead } from "./task-store.js";
import type { PersistedTaskContract } from "./task-contract.js";
import { type TaskViewAdapterResult } from "./task-view-adapter.js";
/**
 * The store surface the reader needs.
 *
 * It is structural on purpose: the query must work against the store the
 * service already holds, and tests must be able to supply synthetic records
 * without opening a database. Only these two reads are ever performed.
 */
export interface TaskProjectionStore {
    get(taskId: string): StoredTask | undefined;
    listAttempts(taskId: string): StoredAttempt[];
    /**
     * The stored initial contract, verified. `absent` means the task predates
     * contracts; an `integrity_failure` means a record exists but cannot be
     * trusted, which is not the same answer.
     */
    getContract(taskId: string): TaskContractRead;
}
/** Everything the reader is allowed to touch. */
export interface TaskProjectionSources {
    /** The store instance the service already created. Never constructed here. */
    store: TaskProjectionStore;
    /** The service's runs directory. The reader never creates it. */
    runsDir: string;
}
/** Stable failure codes. A code never changes meaning once published. */
export type TaskProjectionFailureCode = "task_not_found" | "invalid_attempt_id" | "read_conflict" | "evidence_stale" | "store_unavailable" | "contract_integrity" | "state_unreadable" | "state_corrupt" | "cancel_unreadable" | "cancel_corrupt";
/** The task identity the query was able to establish. */
export interface TaskProjectionIdentity {
    taskId: string;
    attemptId: string | null;
    attempt: number | null;
    state: string;
}
/** A successful projection. The adapter result is passed through unchanged. */
export interface TaskProjectionSuccess {
    ok: true;
    readOnly: true;
    snapshotOnly: true;
    task: TaskProjectionIdentity;
    /**
     * The task row this projection was actually built from: the first
     * `store.get` read, whose attempt identity is re-checked against a second
     * read before the facts are assembled. Callers that need row facts
     * (workspace path, binding, createdAt, reviewedAt) must use this row
     * instead of fetching the task again, because a second read can already
     * describe newer row values (a concurrent acceptance with the same
     * attemptId); using it would mix two snapshots into one answer.
     */
    row: StoredTask;
    /**
     * The immutable initial contract, or null for a task that predates one.
     * A stored contract proves the terms were persisted; it does not prove that a
     * scope check, model verification, any check execution or independent review
     * has happened.
     */
    contract: PersistedTaskContract | null;
    projection: TaskViewAdapterResult;
}
/**
 * A failure the reader can name.
 *
 * Only a missing run file is treated as "absent" and folded into the
 * projection as a gap. Every other read problem stops here, so a permission
 * error or a corrupt file can never be reported as a task that has no data.
 */
export interface TaskProjectionFailure {
    ok: false;
    readOnly: true;
    snapshotOnly: true;
    code: TaskProjectionFailureCode;
    taskId: string;
    attemptId: string | null;
    /** The record or field the failure concerns. */
    field: string;
    message: string;
}
export type TaskProjectionResult = TaskProjectionSuccess | TaskProjectionFailure;
/** Shared application-service query surface; direct sources remain supported. */
export interface TaskProjectionQuery {
    readProjection(taskId: string): TaskProjectionResult;
}
/**
 * Read the projection of one stored task.
 *
 * The current attempt is selected only by the attempt id the task record
 * carries. A historical attempt row is never promoted to the current round,
 * and the run directory comes from the service's runs directory plus that
 * confirmed attempt id.
 */
export declare function readTaskProjection(sources: TaskProjectionSources, taskId: string): TaskProjectionResult;
/**
 * Register the read-only projection tool on an existing server.
 *
 * The tool takes only a task id. It deliberately has no detail switch: the
 * projection is always returned whole, so a presentation filter cannot drop
 * it. Nothing here writes, syncs or dispatches.
 */
export declare function registerTaskProjectionTool(server: McpServer, sources: TaskProjectionSources | TaskProjectionQuery): void;
