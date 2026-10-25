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

import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StoredAttempt, StoredTask, TaskContractRead } from "./task-store.js";
import type { PersistedTaskContract } from "./task-contract.js";
import type { RunSnapshot } from "./run-journal.js";
import {
  adaptTaskViewFacts,
  type AdapterCancellationRecord,
  type TaskViewAdapterResult,
} from "./task-view-adapter.js";
import { runtimeVersion } from "./runtime-version.js";
import { REPORT_AUTHENTICATION_FORMAT } from "./report-authentication.js";
import { runEvidenceDigestOf } from "./coordinator.js";

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
export type TaskProjectionFailureCode =
  | "task_not_found"
  | "invalid_attempt_id"
  | "read_conflict"
  | "evidence_stale"
  | "store_unavailable"
  | "contract_integrity"
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

/**
 * The attempt id shape RunJournal accepts.
 *
 * Mirrors the pattern in run-journal.ts. An id outside it is never turned into
 * a path, so a traversal or a Windows-style path cannot be smuggled in through
 * a stored record.
 */
const ATTEMPT_ID_PATTERN = /^run-[a-f0-9-]{36}$/;

/**
 * Resolve the run directory for an attempt, or null when the id is not usable.
 *
 * Two independent checks: the id must match the accepted shape, and the
 * resolved directory must stay inside the configured runs directory.
 */
function attemptRunDirectory(runsDir: string, attemptId: string): string | null {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) return null;
  const base = path.resolve(runsDir);
  const directory = path.resolve(base, attemptId);
  if (!directory.startsWith(base + path.sep)) return null;
  return directory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** An optional field may be absent or null, but when present must be text. */
function optionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * An optional numeric field, matching the production types.
 *
 * `nativeStopCheck.activityAt` is `number | undefined` in run-journal.ts and
 * desktop-queue.ts writes a number there, so a number is the only accepted
 * value. Absent or null is treated as "no value": JSON drops undefined and
 * turns a non-finite number into null, and this field takes no part in the
 * stop rule, so neither case is worth rejecting.
 */
function optionalNumber(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate the fields the adapter and the stop rule actually read.
 *
 * Only presence and type are checked: a legacy record may omit any optional
 * field, and fields this module does not read are left alone. The point is that
 * a wrong type can never reach Date.parse, where a number such as 0 would be
 * coerced into an instant and could manufacture a stop proof.
 */
function snapshotShapeProblem(value: Record<string, unknown>): string | null {
  if (typeof value.taskId !== "string" || !value.taskId.trim()) return "taskId";
  if (typeof value.attemptId !== "string" || !value.attemptId.trim()) return "attemptId";

  for (const field of [
    "driver",
    "sessionId",
    "runtimeSource",
    "nativeStoppedAt",
    "nativeStopSource",
    "stopReason",
    "text",
    "reportDigest",
  ]) {
    if (!optionalText(value[field])) return field;
  }

  const nativeFailure = value.nativeFailure;
  if (nativeFailure !== undefined && nativeFailure !== null) {
    if (!isRecord(nativeFailure)) return "nativeFailure";
    if (typeof nativeFailure.observedAt !== "string") return "nativeFailure.observedAt";
    if (!optionalText(nativeFailure.error)) return "nativeFailure.error";
  }

  const stopCheck = value.nativeStopCheck;
  if (stopCheck !== undefined && stopCheck !== null) {
    if (!isRecord(stopCheck)) return "nativeStopCheck";
    if (typeof stopCheck.since !== "string") return "nativeStopCheck.since";
    if (typeof stopCheck.checkedAt !== "string") return "nativeStopCheck.checkedAt";
    if (typeof stopCheck.observations !== "number" || !Number.isFinite(stopCheck.observations)) {
      return "nativeStopCheck.observations";
    }
    if (!optionalNumber(stopCheck.activityAt)) return "nativeStopCheck.activityAt";
  }

  const stopControl = value.stopControl;
  if (stopControl !== undefined && stopControl !== null) {
    if (!isRecord(stopControl)) return "stopControl";
    for (const field of ["requestedAt", "issuedAt", "acknowledgedAt", "checkedAt", "error", "state"]) {
      if (!optionalText(stopControl[field])) return `stopControl.${field}`;
    }
  }

  // The report authentication record is checked at runtime for the same reason
  // as the fields above: a wrongly typed value must not reach the verifier.
  // Only the format this build writes is checked field by field, so a future
  // version is reported as unsupported instead of corrupt.
  const authentication = value.reportAuthentication;
  if (authentication !== undefined && authentication !== null) {
    if (!isRecord(authentication)) return "reportAuthentication";
    if (typeof authentication.formatVersion !== "number" || !Number.isInteger(authentication.formatVersion)) {
      return "reportAuthentication.formatVersion";
    }
    if (authentication.formatVersion === REPORT_AUTHENTICATION_FORMAT) {
      for (const field of [
        "taskId",
        "attemptId",
        "sessionId",
        "runtimeSource",
        "reportedStatus",
        "reportDigest",
        "authenticatedAt",
      ]) {
        if (typeof authentication[field] !== "string") return `reportAuthentication.${field}`;
      }
    }
  }

  return null;
}

/** The cancellation record only carries a timestamp and a reason. */
function cancellationShapeProblem(value: Record<string, unknown>): string | null {
  if (!optionalText(value.requestedAt)) return "requestedAt";
  if (!optionalText(value.reason)) return "reason";
  return null;
}

/** A run file that is either absent (undefined) or readable. */
type RunFileRead<T> =
  | { ok: true; value: T | undefined }
  | {
      ok: false;
      code: "state_unreadable" | "state_corrupt" | "cancel_unreadable" | "cancel_corrupt";
      field: string;
      message: string;
    };

/**
 * Read one run file.
 *
 * Only ENOENT means "this file is not there". Any other read error is reported
 * as unreadable, invalid JSON or a wrong field type as corrupt, so none of them
 * can be mistaken for an attempt that simply has no record.
 */
function readRunFile<T>(
  file: string,
  kind: "state" | "cancel",
  shapeProblem: (value: Record<string, unknown>) => string | null,
): RunFileRead<T> {
  const name = kind === "state" ? "state.json" : "cancel.json";
  const corruptCode = kind === "state" ? "state_corrupt" : "cancel_corrupt";
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: undefined };
    return {
      ok: false,
      code: kind === "state" ? "state_unreadable" : "cancel_unreadable",
      field: name,
      message: `${name} could not be read; this is not reported as a missing file.`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        code: corruptCode,
        field: name,
        message: `${name} does not contain a JSON object.`,
      };
    }
    // A type assertion alone would let a wrongly typed field reach the adapter
    // and the stop rule, where a coerced value could look like evidence.
    const problem = shapeProblem(parsed as Record<string, unknown>);
    if (problem) {
      return {
        ok: false,
        code: corruptCode,
        field: `${name}.${problem}`,
        message: `${name} field ${problem} has a type this record does not allow.`,
      };
    }
    return { ok: true, value: parsed as T };
  } catch {
    return {
      ok: false,
      code: corruptCode,
      field: name,
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
  let task: StoredTask | undefined;
  try {
    task = sources.store.get(taskId);
  } catch {
    // A failing store is not an absent task. The message carries no database
    // content and no local path.
    return failure("store_unavailable", taskId, null, "store.get", "Reading the task record failed; this is not reported as a missing task.");
  }
  if (!task) {
    return failure("task_not_found", taskId, null, "taskId", "No stored task has this id.");
  }

  // The contract is read once, before any attempt work. Its absence is a
  // normal state for an older task; a read failure or a record that no longer
  // verifies is not.
  let contract: PersistedTaskContract | null = null;
  try {
    const read = sources.store.getContract(taskId);
    if (read.state === "integrity_failure") {
      // A record exists but cannot be trusted. Returning null would claim the
      // task has no contract, and returning the record would endorse it.
      return failure("contract_integrity", taskId, null, `contract.${read.integrity.problem}`, `The stored contract failed integrity: ${read.integrity.detail}. It is not repaired or rewritten here.`);
    }
    contract = read.state === "found" ? read.record : null;
  } catch {
    return failure("store_unavailable", taskId, null, "store.getContract", "Reading the task contract failed; this is not reported as a task without one.");
  }

  const attemptId = nonBlank(task.attemptId) ? task.attemptId.trim() : null;

  // A present but unusable attempt id is a malformed record, not a task with no
  // current attempt. No path is built from it and no file is read.
  const runDir = attemptId ? attemptRunDirectory(sources.runsDir, attemptId) : null;
  if (attemptId && !runDir) {
    return failure(
      "invalid_attempt_id",
      taskId,
      null,
      "task.attemptId",
      "The stored attempt id does not have the accepted shape or would resolve outside the runs directory; no record was read.",
    );
  }

  let attempts: StoredAttempt[];
  try {
    attempts = sources.store.listAttempts(taskId);
  } catch {
    return failure("store_unavailable", taskId, attemptId, "store.listAttempts", "Reading the attempt records failed; this is not reported as a missing attempt.");
  }
  const attempt = attemptId ? attempts.find(row => row.attemptId === attemptId) ?? null : null;
  const identity: TaskProjectionIdentity = {
    taskId: task.taskId,
    attemptId,
    attempt: typeof task.attempt === "number" ? task.attempt : null,
    state: task.state,
  };

  // Without a current attempt there is no round to read files for. The adapter
  // records the gap, and no directory is touched.
  if (!attemptId || !runDir) {
    const projection = adaptTaskViewFacts({ task, attempt: null, snapshot: null, cancellation: null });
    return { ok: true, readOnly: true, snapshotOnly: true, task: identity, row: task, contract, projection };
  }

  const state = readRunFile<RunSnapshot>(path.join(runDir, "state.json"), "state", snapshotShapeProblem);
  if (!state.ok) return failure(state.code, taskId, attemptId, state.field, state.message);

  const cancel = readRunFile<AdapterCancellationRecord>(path.join(runDir, "cancel.json"), "cancel", cancellationShapeProblem);
  if (!cancel.ok) return failure(cancel.code, taskId, attemptId, cancel.field, cancel.message);

  // The files were read one after another, so the current attempt is checked
  // again before the facts are assembled. A change means the records may come
  // from two different rounds, and joining them would describe neither.
  let after: StoredTask | undefined;
  try {
    after = sources.store.get(taskId);
  } catch {
    return failure("store_unavailable", taskId, attemptId, "store.get", "Re-reading the task record failed; the result was not assembled.");
  }
  if (!after) {
    return failure("read_conflict", taskId, attemptId, "taskId", "The task disappeared while its records were being read.");
  }
  const attemptAfter = nonBlank(after.attemptId) ? after.attemptId.trim() : null;
  if (attemptAfter !== attemptId) {
    return failure(
      "read_conflict",
      taskId,
      attemptId,
      "task.attemptId",
      "The current attempt changed while its records were being read; the result was not assembled from two rounds.",
    );
  }

  // Task/attempt rows and file evidence must describe the same revision.
  // A second connection may commit even when the attempt identity is stable.
  if (after.revision !== task.revision) {
    return failure("read_conflict", taskId, attemptId, "task.revision", "The task revision changed while its evidence was being read; retry the query.");
  }
  if (task.runEvidenceDigest) {
    if (!state.value || runEvidenceDigestOf(state.value, cancel.value) !== task.runEvidenceDigest) {
      return failure("evidence_stale", taskId, attemptId, "task.runEvidenceDigest", "Run evidence differs from the persisted revision; synchronise explicitly and retry. This query performed no write.");
    }
  } else if (task.revision && state.value) {
    return failure("evidence_stale", taskId, attemptId, "task.runEvidenceDigest", "Run evidence has not been bound to this revision; synchronise explicitly and retry. This query performed no write.");
  }

  const projection = adaptTaskViewFacts({
    task,
    attempt,
    snapshot: state.value,
    cancellation: cancel.value,
  });
  // `row` is the task row the projection was actually built from (`task`,
  // the first store.get). The re-read `after` row is only used for the
  // attempt-identity conflict check above: even with the same attemptId a
  // concurrent acceptance can change state/reviewedAt between the two reads,
  // and returning `after` here would mix the projected (old) facts with the
  // newer row values into one contradictory answer.
  return { ok: true, readOnly: true, snapshotOnly: true, task: identity, row: task, contract, projection };
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
export function registerTaskProjectionTool(server: McpServer, sources: TaskProjectionSources | TaskProjectionQuery): void {
  server.tool(
    "workbuddy_get_task_projection",
    "Read a stored task's read-only projection: the facts that could be established from existing records, the derived display state, and every fact that could not be established. This is a snapshot of stored files, not a complete vNext TaskView and not live state; it does not synchronise, dispatch or accept anything.",
    { taskId: z.string().min(1).max(200) },
    async ({ taskId }) => jsonResult({
      ...("readProjection" in sources ? sources.readProjection(taskId) : readTaskProjection(sources, taskId)),
      runtime: runtimeVersion,
    }),
  );
}
