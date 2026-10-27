import type { TaskCoordinator, SendTaskInput } from "./coordinator.js";
import type { DshTaskCoordinator } from "./dsh-coordinator.js";
import type { OperationOptions } from "./operation-admission.js";
import type { RecoveryInput } from "./operation-recovery.js";
import { AdmissionError } from "./collaboration.js";
import type { StoredTask, StoredTaskEvent } from "./task-store.js";
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
  constructor(private readonly coordinator: TaskCoordinator, private readonly maxAttempts: number, private readonly runsDir: string, readonly dsh?: DshTaskCoordinator) {
    if (dsh && dsh.store !== coordinator.store) throw new Error("DSH and WorkBuddy must share the same TaskStore");
  }

  /** Trusted local setup and authorization seams; no HTTP write routes. */
  registerWorkspace(id: string, directory: string, displayName: string) { return this.coordinator.store.collaboration.registerWorkspace(id, directory, displayName); }
  createCollaborationPlan(contract: unknown, options: { mode: "manual" | "recommend"; reason: string; ttlSeconds?: number } & Pick<OperationOptions, "operationId">) {
    const { operationId, ...parameters } = options;
    return this.coordinator.store.operations.metadata("plan_create", (contract as { taskId?: string })?.taskId ?? "", { contract, ...parameters }, { operationId },
      () => this.coordinator.store.collaboration.createPlan(contract, this.coordinator.modelPolicy(), parameters));
  }
  authorizeCollaborationPlan(planId: string, expectedPlanRevision: string, source: string, options: Pick<OperationOptions, "operationId"> = {}) {
    const taskId = this.coordinator.store.collaboration.getPlan(planId).proposal.taskId;
    return this.coordinator.store.operations.metadata("plan_authorize", taskId, { planId, expectedPlanRevision, source }, options,
      () => this.coordinator.store.collaboration.authorizePlan(planId, expectedPlanRevision, this.coordinator.modelPolicy(), source), { planId, expectedPlanRevision });
  }
  getCollaborationPlan(planId: string) { return this.coordinator.store.collaboration.getPlan(planId); }
  readQuotaResources(options: { connectionId?: string; modelId?: string; limit?: number } = {}) {
    return this.coordinator.store.quotas.read(options);
  }
  readCreditBalances(connectionId?: string) { return this.coordinator.store.creditBalances.read(connectionId); }

  getOperation(operationId: string) { return this.coordinator.store.operations.get(operationId); }
  listUnfinishedOperations() { return this.coordinator.store.operations.listUnfinished(); }
  readOperationRecovery(targetOperationId: string) { return this.coordinator.store.recoveries.inspect(targetOperationId, this.runsDir); }
  getOperationRecoveryDecision(operationId: string) { return this.coordinator.store.recoveries.get(operationId); }
  authorizeOperationRecovery(input: RecoveryInput, actor: string) { return this.coordinator.store.recoveries.authorize(input, this.runsDir, actor); }
  resolveOperationRecovery(input: RecoveryInput, authorizationId: string) { return this.coordinator.store.recoveries.resolve(input, this.runsDir, authorizationId); }
  async observeOperationRecovery(targetOperationId: string) {
    const view = this.readOperationRecovery(targetOperationId);
    if (this.coordinator.store.get(view.operation.taskId)?.attemptId && !this.coordinator.store.recoveries.closure(view.operation.taskId)) {
      const dsh = this.dshFor(view.operation.taskId);
      if (dsh) await dsh.sync(view.operation.taskId, 100, true);
      else {
        if (view.operation.executor === "dsh") throw new AdmissionError("EXECUTOR_UNAVAILABLE", "The original DSH source is unavailable; no fallback is allowed.");
        await this.coordinator.observeRecovery(view.operation.taskId);
      }
    }
    return this.readOperationRecovery(targetOperationId);
  }

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

  /**
   * Read the persistent task event stream (T2).
   *
   * Pure read: afterEventId is exclusive (0 = from the beginning), limit is
   * bounded 1-200 (default 100), events ascend by the monotonic per-task
   * eventId, and nothing is written — a missing task is a task_not_found
   * failure, never an implicit creation. nextEventId is the last returned id,
   * or the original afterEventId on an empty page, including at stream end.
   */
  listTaskEvents(taskId: string, options: { afterEventId?: number; limit?: number } = {}):
    { ok: true; events: StoredTaskEvent[]; nextEventId: number }
    | { ok: false; code: "task_not_found" | "invalid_task_id" | "invalid_cursor" | "store_unavailable"; field: string; message: string } {
    if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 200) {
      return { ok: false, code: "invalid_task_id", field: "taskId", message: "The task id must be 1-200 characters." };
    }
    const afterEventId = options.afterEventId ?? 0;
    if (!Number.isInteger(afterEventId) || afterEventId < 0) {
      return { ok: false, code: "invalid_cursor", field: "afterEventId", message: "afterEventId must be a non-negative integer." };
    }
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return { ok: false, code: "invalid_cursor", field: "limit", message: "limit must be an integer between 1 and 200." };
    }
    try {
      const task = this.coordinator.store.get(taskId);
      if (!task) return { ok: false, code: "task_not_found", field: "taskId", message: "No stored task has this id; events are never fabricated for one." };
      const page = this.coordinator.store.listTaskEvents(taskId, { afterEventId, limit });
      return { ok: true, events: page.events, nextEventId: page.nextEventId };
    } catch {
      return { ok: false, code: "store_unavailable", field: "store.listTaskEvents", message: "Reading the event stream failed; this is not reported as an empty stream." };
    }
  }

  async send(input: SendTaskInput) {
    const executor = (input.contract as { execution?: { executorId?: unknown } } | undefined)?.execution?.executorId === "dsh" ? "dsh" : "workbuddy";
    const prior = input.operationId ? this.coordinator.store.operations.get(input.operationId) : null;
    if (prior && prior.executor !== executor) throw new AdmissionError("OPERATION_CONFLICT", "The original operation selected a different executor.");
    if (prior && executor === "dsh" && (input.constraints !== undefined || input.acceptanceCommands !== undefined || input.scope !== undefined || input.model !== undefined || input.timeoutSeconds !== undefined || input.sessionMode === "new")) throw new AdmissionError("OPERATION_CONFLICT", "The original DSH operation did not include these overrides.");
    if (prior && executor === "dsh" && !this.dsh) {
      const { operationId, expectedRevision, expectedAttemptId } = input;
      const parameters = { contract: input.contract, objective: input.objective, sessionId: input.sessionId, taskId: input.taskId, workspace: input.workspace };
      const taskId = input.taskId ?? (input.contract as { taskId: string }).taskId;
      return this.coordinator.store.operations.run("send", taskId, "dsh", parameters, { operationId, expectedRevision, expectedAttemptId }, prior.binding,
        async (): Promise<never> => { throw new AdmissionError("EXECUTOR_UNAVAILABLE", "The original DSH adapter is unavailable."); });
    }
    if ((input.contract as { execution?: { executorId?: unknown } } | undefined)?.execution?.executorId === "dsh") {
      if (!this.dsh) throw new AdmissionError("EXECUTOR_UNAVAILABLE", "The original DSH adapter is unavailable; WorkBuddy cannot take over its task");
      if (!input.sessionId || input.constraints !== undefined || input.acceptanceCommands !== undefined || input.scope !== undefined || input.model !== undefined || input.timeoutSeconds !== undefined || input.sessionMode === "new") throw new AdmissionError("TASK_CONFLICT", "DSH requires an explicit original session and immutable contract terms");
      return this.dsh.send({ contract: input.contract, objective: input.objective, sessionId: input.sessionId, taskId: input.taskId, workspace: input.workspace, operationId: input.operationId, expectedRevision: input.expectedRevision, expectedAttemptId: input.expectedAttemptId });
    }
    return this.coordinator.send(input);
  }
  private dshFor(taskId: string) {
    if (!this.coordinator.store.dshBindings.forTask(taskId)) return undefined;
    if (!this.dsh) throw new Error("The original DSH adapter is unavailable; WorkBuddy cannot take over its task");
    return this.dsh;
  }
  continue(input: Parameters<TaskCoordinator["continue"]>[0]) {
    const prior = input.operationId ? this.coordinator.store.operations.get(input.operationId) : null;
    if (prior?.executor === "dsh" && !this.dsh) {
      const { operationId, expectedRevision, expectedAttemptId, ...parameters } = input;
      return this.coordinator.store.operations.run("rework", input.taskId, "dsh", parameters, { operationId, expectedRevision, expectedAttemptId }, prior.binding,
        async (): Promise<never> => { throw new AdmissionError("EXECUTOR_UNAVAILABLE", "The original DSH adapter is unavailable."); });
    }
    return this.dshFor(input.taskId)?.continue(input) ?? this.coordinator.continue(input);
  }
  accept(...args: Parameters<TaskCoordinator["accept"]>) { return this.dshFor(args[0])?.accept(...args) ?? this.coordinator.accept(...args); }
  cancel(...args: Parameters<TaskCoordinator["cancel"]>) { return this.dshFor(args[0])?.cancel(...args) ?? this.coordinator.cancel(...args); }
  respond(...args: Parameters<TaskCoordinator["respond"]>) { if (this.dshFor(args[0])) throw new AdmissionError("EXECUTOR_CAPABILITY_MISSING", "Resolve DSH input in its native UI; this adapter cannot approve permissions"); return this.coordinator.respond(...args); }
  reconcileReport(input: Parameters<TaskCoordinator["reconcileReport"]>[0]) { if (this.dshFor(input.taskId)) throw new AdmissionError("EXECUTOR_CAPABILITY_MISSING", "DSH reports require their original durable request events"); return this.coordinator.reconcileReport(input); }
  async sync(taskId: string, limit?: number) {
    const task = await (this.dshFor(taskId)?.sync(taskId, limit) ?? this.coordinator.sync(taskId, limit));
    if (task.attemptId && ["needs_review", "completed"].includes(task.state) && this.executionStatus(taskId).remoteStopped && this.coordinator.store.workspaceProtection.readView(taskId).baseline !== "missing") {
      this.coordinator.store.workspaceProtection.review(taskId, task.attemptId);
      return this.coordinator.store.get(taskId)!;
    }
    return task;
  }
  requireTask(taskId: string) { return this.coordinator.requireTask(taskId); }
  executionStatus(taskId: string) { return this.dshFor(taskId)?.executionStatus(taskId) ?? this.coordinator.executionStatus(taskId); }
  listTasks(limit: number) { return this.coordinator.store.listTasks({ limit }); }
  listTasksByCreatedCursor(options: { limit: number; afterTaskId?: string }) { return this.coordinator.store.listTasksByCreatedCursor(options); }
  listMessages(taskId: string, limit: number, attemptId?: string) { return this.coordinator.store.listMessages(taskId, limit, attemptId); }
  listAttempts(taskId: string) { return this.coordinator.store.listAttempts(taskId); }

  statusView(task: StoredTask): TaskStatusView {
    const execution = this.executionStatus(task.taskId);
    const stopped = execution.remoteStopped;
    const cancelled = task.state === "cancelled";
    const failed = task.state === "failed";
    const review = task.state === "needs_review" || task.state === "completed";
    const terminal = cancelled || failed;
    const scope = this.coordinator.store.workspaceProtection.readView(task.taskId, task.attemptId);
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
      const contract = this.coordinator.store.getContract(task.taskId);
      const attemptLimit = contract.state === "found" ? contract.record.effectiveMaxAttempts : contract.state === "absent" ? this.maxAttempts : 0;
      if (scope.baseline === "present" && stopped && task.sessionId && (task.attempt ?? 0) < attemptLimit && (review || task.state === "blocked" || (task.state === "failed" && task.runtimeSource === "dsh"))) allowedActions.push("rework");
      const reportReady = !["desktop_queue", "dsh"].includes(task.runtimeSource ?? "") || ("reportDigestPresent" in execution && execution.reportDigestPresent === true);
      if (scope.baseline === "present" && scope.check?.status === "passed" && stopped && review && task.sessionId && task.report?.rawText.trim() && reportReady && (["desktop_interactive", "desktop_queue"].includes(task.runtimeSource ?? "") || (task.runtimeSource === "dsh" && this.dsh))) allowedActions.push("accept");
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
