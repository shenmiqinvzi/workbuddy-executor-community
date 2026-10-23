import type { TaskCoordinator, SendTaskInput } from "./coordinator.js";
import type { StoredTask } from "./task-store.js";
import { readTaskProjection } from "./task-view-reader.js";
import { stageTaskViewFromProjection, STAGE_TASK_VIEW_UNAVAILABLE, STAGE_TASK_VIEW_SCHEMA_VERSION, type StageTaskView } from "./task-view-stage.js";

/** A conservative status projection for existing tasks. This is not the vNext TaskView. */
export interface TaskStatusView {
  taskId: string;
  attemptId: string | null;
  sessionId: string | null;
  businessState: StoredTask["state"];
  displayState: "queued" | "running" | "waiting_input" | "waiting_stop" | "needs_review" | "accepted" | "cancelled" | "failed" | "unknown";
  remoteStopped: boolean;
  allowedActions: Array<"cancel" | "rework" | "accept">;
  lastObservedAt: string | null;
}

/**
 * Stage-1 read query outcomes, shared by the list and detail entries.
 *
 * The failure variants keep the projection's own failure codes verbatim, so a
 * permission error, a corrupt record or a mid-read attempt change is never
 * reported as "no tasks" or as a task without data. `store_unavailable`
 * additionally covers a list-level read failure of the store itself.
 */
export type StageReadResult =
  | {
      ok: true;
      readOnly: true;
      snapshotOnly: true;
      schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
      unavailable: typeof STAGE_TASK_VIEW_UNAVAILABLE;
      view: StageTaskView;
    }
  | {
      ok: false;
      readOnly: true;
      snapshotOnly: true;
      code: "task_not_found" | "invalid_task_id" | string;
      taskId: string;
      field: string;
      message: string;
    };

/** One page of the stable created_at ASC + task_id ASC list. */
export interface StageListResult {
  ok: true;
  readOnly: true;
  snapshotOnly: true;
  schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
  unavailable: typeof STAGE_TASK_VIEW_UNAVAILABLE;
  /**
   * One entry per listed task, in stable order. A failed entry keeps the
   * projection's failure code instead of an empty view; it never masks its
   * neighbours.
   */
  tasks: StageListItem[];
  /** The cursor to pass as afterTaskId, or null when no next page exists. */
  nextAfterTaskId: string | null;
}

/** A request-level list failure. Store failures are never cursor errors. */
export type StageListFailure = {
  ok: false;
  readOnly: true;
  snapshotOnly: true;
  code: "invalid_cursor" | "store_unavailable";
  field: string;
  message: string;
};

/** One list entry: either a stage view or the preserved projection failure. */
export type StageListItem =
  | { ok: true; taskId: string; view: StageTaskView }
  | { ok: false; taskId: string; code: string; field: string; message: string };

/** The MCP entry point and future local HTTP adapter share this service. */
export class TaskApplicationService {
  constructor(private readonly coordinator: TaskCoordinator, private readonly maxAttempts: number, private readonly runsDir: string) {}

  /** Stored facts only: deliberately bypasses every synchronising coordinator method. */
  readProjection(taskId: string) {
    return readTaskProjection({ store: this.coordinator.store, runsDir: this.runsDir }, taskId);
  }

  /**
   * Stage-1 read-only detail query for one stored task.
   *
   * It reuses readProjection's store and run-file reads — the same snapshot
   * semantics, the same failure codes, the same attempt re-check — and maps
   * the result into the stage view. The view is built from the task row the
   * projection itself verified (`projection.row`): a second store.get here
   * could already describe a later attempt after a concurrent rework, which
   * would mix two rounds into one answer, so no second read happens. Like
   * readProjection this never calls sync, executionStatus, checkWorker or any
   * dispatching entry point, creates no store and writes nothing.
   */
  readStageView(taskId: string): StageReadResult {
    if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 200) {
      return { ok: false, readOnly: true, snapshotOnly: true, code: "invalid_task_id", taskId: "", field: "taskId", message: "The task id must be 1-200 characters." };
    }
    const projection = this.readProjection(taskId);
    if (!projection.ok) {
      return { ok: false, readOnly: true, snapshotOnly: true, code: projection.code, taskId: projection.taskId, field: projection.field, message: projection.message };
    }
    // The contract is only carried through; a contract integrity failure is
    // reported by readProjection itself and never reaches this point.
    return {
      ok: true,
      readOnly: true,
      snapshotOnly: true,
      schemaVersion: STAGE_TASK_VIEW_SCHEMA_VERSION,
      unavailable: [...STAGE_TASK_VIEW_UNAVAILABLE],
      view: stageTaskViewFromProjection({ task: projection.row, projection, contract: projection.contract }),
    };
  }

  /**
   * Stage-1 read-only list query with the stable pagination contract.
   *
   * Ordering is created_at ASC + task_id ASC (the contract's stable cursor
   * order), read through TaskStore.listTasksByCreatedCursor. The existing MCP
   * list (updated_at DESC + offset) is deliberately untouched and is not
   * called from here.
   *
   * Failure policy (no silent swallow):
   *   - A store failure while reading the page, while probing the next-page
   *     cursor, or while reading any single task's row is a structured
   *     STORE_UNAVAILABLE failure for the whole request, never an empty page
   *     or a cursor error.
   *   - A per-task projection failure (corrupt record, unreadable file,
   *     contract integrity, mid-read attempt change, ...) is preserved
   *     per item: the item keeps its taskId plus the projection's failure
   *     code/field/message instead of a fabricated empty view, so a client can
   *     tell environment damage apart from data it asked for. An item-level
   *     failure never masks the rest of the page.
   *   - Cursor problems stay invalid_cursor and map to HTTP 400.
   *
   * Each item's view is built from the row its own readProjection verified
   * (projection.row), so a concurrent rework between the page read and the
   * item read yields that task's consistent single-round snapshot — or an
   * explicit read_conflict from the reader — never a mixture of two rounds.
   */
  listStageViews(options: { limit: number; afterTaskId?: string }): StageListResult | StageListFailure {
    const limit = Math.floor(options.limit);
    if (!Number.isFinite(limit) || limit !== Math.trunc(limit) || limit < 1 || limit > 100) {
      return { ok: false, readOnly: true, snapshotOnly: true, code: "invalid_cursor", field: "limit", message: "limit must be an integer between 1 and 100." };
    }
    if (options.afterTaskId !== undefined && (typeof options.afterTaskId !== "string" || options.afterTaskId.length === 0 || options.afterTaskId.length > 200)) {
      return { ok: false, readOnly: true, snapshotOnly: true, code: "invalid_cursor", field: "afterTaskId", message: "afterTaskId must be a stored task id of 1-200 characters." };
    }
    let page: { tasks: StoredTask[]; anchorFound: boolean };
    try {
      page = this.coordinator.store.listTasksByCreatedCursor({ limit, afterTaskId: options.afterTaskId });
    } catch {
      return { ok: false, readOnly: true, snapshotOnly: true, code: "store_unavailable", field: "store.listTasksByCreatedCursor", message: "Reading the task list failed; this is not reported as an empty list." };
    }
    if (options.afterTaskId !== undefined && !page.anchorFound) {
      return { ok: false, readOnly: true, snapshotOnly: true, code: "invalid_cursor", field: "afterTaskId", message: "No stored task has this id; the cursor must name an existing task." };
    }
    const items: StageListItem[] = [];
    for (const listed of page.tasks) {
      const projection = this.readProjection(listed.taskId);
      if (projection.ok) {
        items.push({
          ok: true,
          taskId: listed.taskId,
          view: stageTaskViewFromProjection({ task: projection.row, projection, contract: projection.contract }),
        });
      } else {
        items.push({
          ok: false,
          taskId: projection.taskId,
          code: projection.code,
          field: projection.field,
          message: projection.message,
        });
      }
    }
    const last = page.tasks.at(-1);
    // "There is another page" is answered by an extra existence probe, not by
    // page fullness, so a full final page ends with null instead of a cursor
    // the client would have to try once and learn was empty. A probe failure
    // is a store failure, not an answer of "no more data".
    let next: string | null;
    if (last === undefined) {
      next = null;
    } else {
      try {
        next = this.coordinator.store.hasTaskAfterCursor(last.taskId) ? last.taskId : null;
      } catch {
        return { ok: false, readOnly: true, snapshotOnly: true, code: "store_unavailable", field: "store.hasTaskAfterCursor", message: "Probing the next page failed; this is not reported as the end of the list." };
      }
    }
    return {
      ok: true,
      readOnly: true,
      snapshotOnly: true,
      schemaVersion: STAGE_TASK_VIEW_SCHEMA_VERSION,
      unavailable: [...STAGE_TASK_VIEW_UNAVAILABLE],
      tasks: items,
      nextAfterTaskId: next,
    };
  }

  send(input: SendTaskInput) { return this.coordinator.send(input); }
  continue(input: Parameters<TaskCoordinator["continue"]>[0]) { return this.coordinator.continue(input); }
  accept(...args: Parameters<TaskCoordinator["accept"]>) { return this.coordinator.accept(...args); }
  cancel(...args: Parameters<TaskCoordinator["cancel"]>) { return this.coordinator.cancel(...args); }
  respond(...args: Parameters<TaskCoordinator["respond"]>) { return this.coordinator.respond(...args); }
  reconcileReport(input: Parameters<TaskCoordinator["reconcileReport"]>[0]) { return this.coordinator.reconcileReport(input); }
  sync(taskId: string, limit?: number) { return this.coordinator.sync(taskId, limit); }
  requireTask(taskId: string) { return this.coordinator.requireTask(taskId); }
  executionStatus(taskId: string) { return this.coordinator.executionStatus(taskId); }
  listTasks(limit: number) { return this.coordinator.store.listTasks({ limit }); }
  listTasksByCreatedCursor(options: { limit: number; afterTaskId?: string }) { return this.coordinator.store.listTasksByCreatedCursor(options); }
  listMessages(taskId: string, limit: number, attemptId?: string) { return this.coordinator.store.listMessages(taskId, limit, attemptId); }
  listAttempts(taskId: string) { return this.coordinator.store.listAttempts(taskId); }

  statusView(task: StoredTask): TaskStatusView {
    const execution = this.coordinator.executionStatus(task.taskId);
    const stopped = execution.remoteStopped;
    const cancelled = task.state === "cancelled";
    const failed = task.state === "failed";
    const review = task.state === "needs_review" || task.state === "completed";
    const terminal = cancelled || failed;
    let displayState: TaskStatusView["displayState"];
    if (task.state === "accepted") displayState = "accepted";
    else if (terminal) displayState = stopped ? cancelled ? "cancelled" : "failed" : "waiting_stop";
    else if (execution.state === "waiting_input") displayState = "waiting_input";
    else if (review) displayState = stopped ? "needs_review" : "waiting_stop";
    else if (execution.cancellationRequested || execution.state === "stop_unconfirmed") displayState = "waiting_stop";
    else if (stopped && (task.state === "queued" || task.state === "working")) displayState = "unknown";
    else if (execution.state === "session_offline" || execution.state === "unknown") displayState = "unknown";
    else if (task.state === "queued") displayState = "queued";
    else if (task.state === "working") displayState = "running";
    else displayState = "unknown";

    const allowedActions: TaskStatusView["allowedActions"] = [];
    if (!terminal && task.state !== "accepted") {
      if (!stopped && !execution.cancellationRequested && ["queued", "running", "waiting_input"].includes(displayState)) allowedActions.push("cancel");
      if (stopped && task.sessionId && (task.attempt ?? 0) < this.maxAttempts && (review || task.state === "blocked")) allowedActions.push("rework");
      const reportReady = task.runtimeSource !== "desktop_queue" || ("reportDigestPresent" in execution && execution.reportDigestPresent === true);
      if (stopped && review && task.sessionId && task.report?.rawText.trim() && reportReady && ["desktop_interactive", "desktop_queue"].includes(task.runtimeSource ?? "")) allowedActions.push("accept");
    }
    return {
      taskId: task.taskId,
      attemptId: task.attemptId ?? null,
      sessionId: task.sessionId ?? null,
      businessState: task.state,
      displayState,
      remoteStopped: stopped,
      allowedActions,
      lastObservedAt: execution.observedAt ?? null,
    };
  }
}
