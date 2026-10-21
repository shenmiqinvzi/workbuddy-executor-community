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
 *     re-checks the current attempt afterwards and refuses to assemble a result
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

import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StoredAttempt, StoredTask } from "./task-store.js";
import type { RunSnapshot } from "./run-journal.js";
import {
  adaptTaskViewFacts,
  type AdapterCancellationRecord,
  type TaskViewAdapterResult,
} from "./task-view-adapter.js";
import { runtimeVersion } from "./runtime-version.js";

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
}

/** Everything the reader is allowed to touch. */
export interface TaskProjectionSources {
  /** The store instance the service already created. Never constructed here. */
  store: TaskProjectionStore;
  /** The service's runs directory. The reader never creates it. */
  runsDir: string;
}

/** Stable failure codes. A code never changes meaning once published. */
export type TaskProjectionFailureCode =
  | "task_not_found"
  | "read_conflict"
  | "state_unreadable"
  | "state_corrupt"
  | "cancel_unreadable"
  | "cancel_corrupt";

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

function nonBlank(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failure(
  code: TaskProjectionFailureCode,
  taskId: string,
  attemptId: string | null,
  field: string,
  message: string,
): TaskProjectionFailure {
  return { ok: false, readOnly: true, snapshotOnly: true, code, taskId, attemptId, field, message };
}

/** A run file that is either absent (undefined) or readable. */
type RunFileRead<T> =
  | { ok: true; value: T | undefined }
  | { ok: false; code: "state_unreadable" | "state_corrupt" | "cancel_unreadable" | "cancel_corrupt"; message: string };

/**
 * Read one run file.
 *
 * Only ENOENT means "this file is not there". Any other read error is reported
 * as unreadable, and invalid content as corrupt, so neither can be mistaken for
 * an attempt that simply has no record.
 */
function readRunFile<T>(file: string, kind: "state" | "cancel"): RunFileRead<T> {
  const name = kind === "state" ? "state.json" : "cancel.json";
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: undefined };
    return {
      ok: false,
      code: kind === "state" ? "state_unreadable" : "cancel_unreadable",
      message: `${name} could not be read; this is not reported as a missing file.`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        code: kind === "state" ? "state_corrupt" : "cancel_corrupt",
        message: `${name} does not contain a JSON object.`,
      };
    }
    return { ok: true, value: parsed as T };
  } catch {
    return {
      ok: false,
      code: kind === "state" ? "state_corrupt" : "cancel_corrupt",
      message: `${name} is not valid JSON.`,
    };
  }
}

/**
 * Read the projection of one stored task.
 *
 * The current attempt is selected only by the attempt id the task record
 * carries. A historical attempt row is never promoted to the current round,
 * and the run directory comes from the service's runs directory plus that
 * confirmed attempt id.
 */
export function readTaskProjection(sources: TaskProjectionSources, taskId: string): TaskProjectionResult {
  const task = sources.store.get(taskId);
  if (!task) {
    return failure("task_not_found", taskId, null, "taskId", "No stored task has this id.");
  }

  const attemptId = nonBlank(task.attemptId) ? task.attemptId : null;
  const attempts = sources.store.listAttempts(taskId);
  const attempt = attemptId ? attempts.find(row => row.attemptId === attemptId) ?? null : null;
  const identity: TaskProjectionIdentity = {
    taskId: task.taskId,
    attemptId,
    attempt: typeof task.attempt === "number" ? task.attempt : null,
    state: task.state,
  };

  // Without a current attempt there is no round to read files for. The adapter
  // records the gap, and no directory is touched.
  if (!attemptId) {
    const projection = adaptTaskViewFacts({ task, attempt: null, snapshot: null, cancellation: null });
    return { ok: true, readOnly: true, snapshotOnly: true, task: identity, projection };
  }

  const runDir = path.join(sources.runsDir, attemptId);

  const state = readRunFile<RunSnapshot>(path.join(runDir, "state.json"), "state");
  if (!state.ok) return failure(state.code, taskId, attemptId, "state.json", state.message);

  const cancel = readRunFile<AdapterCancellationRecord>(path.join(runDir, "cancel.json"), "cancel");
  if (!cancel.ok) return failure(cancel.code, taskId, attemptId, "cancel.json", cancel.message);

  // The files were read one after another, so the current attempt is checked
  // again before the facts are assembled. A change means the records may come
  // from two different rounds, and joining them would describe neither.
  const after = sources.store.get(taskId);
  if (!after) {
    return failure("read_conflict", taskId, attemptId, "taskId", "The task disappeared while its records were being read.");
  }
  const attemptAfter = nonBlank(after.attemptId) ? after.attemptId : null;
  if (attemptAfter !== attemptId) {
    return failure(
      "read_conflict",
      taskId,
      attemptId,
      "task.attemptId",
      "The current attempt changed while its records were being read; the result was not assembled from two rounds.",
    );
  }

  const projection = adaptTaskViewFacts({
    task,
    attempt,
    snapshot: state.value,
    cancellation: cancel.value,
  });
  return { ok: true, readOnly: true, snapshotOnly: true, task: identity, projection };
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Register the read-only projection tool on an existing server.
 *
 * The tool takes only a task id. It deliberately has no detail switch: the
 * projection is always returned whole, so a presentation filter cannot drop
 * it. Nothing here writes, syncs or dispatches.
 */
export function registerTaskProjectionTool(server: McpServer, sources: TaskProjectionSources): void {
  server.tool(
    "workbuddy_get_task_projection",
    "Read a stored task's read-only projection: the facts that could be established from existing records, the derived display state, and every fact that could not be established. This is a snapshot of stored files, not a complete vNext TaskView and not live state; it does not synchronise, dispatch or accept anything.",
    { taskId: z.string().min(1).max(200) },
    async ({ taskId }) => jsonResult({ ...readTaskProjection(sources, taskId), runtime: runtimeVersion }),
  );
}
