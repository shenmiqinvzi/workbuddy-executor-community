import type { TaskCoordinator, SendTaskInput } from "./coordinator.js";
import type { StoredTask } from "./task-store.js";

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

/** The MCP entry point and future local HTTP adapter share this service. */
export class TaskApplicationService {
  constructor(private readonly coordinator: TaskCoordinator, private readonly maxAttempts: number) {}

  send(input: SendTaskInput) { return this.coordinator.send(input); }
  continue(input: Parameters<TaskCoordinator["continue"]>[0]) { return this.coordinator.continue(input); }
  accept(...args: Parameters<TaskCoordinator["accept"]>) { return this.coordinator.accept(...args); }
  cancel(...args: Parameters<TaskCoordinator["cancel"]>) { return this.coordinator.cancel(...args); }
  respond(...args: Parameters<TaskCoordinator["respond"]>) { return this.coordinator.respond(...args); }
  sync(taskId: string, limit?: number) { return this.coordinator.sync(taskId, limit); }
  requireTask(taskId: string) { return this.coordinator.requireTask(taskId); }
  executionStatus(taskId: string) { return this.coordinator.executionStatus(taskId); }
  listTasks(limit: number) { return this.coordinator.store.listTasks({ limit }); }
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
    else if (execution.cancellationRequested) displayState = "waiting_stop";
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
