import { readTaskProjection } from "./task-view-reader.js";
/** The MCP entry point and future local HTTP adapter share this service. */
export class TaskApplicationService {
    coordinator;
    maxAttempts;
    runsDir;
    constructor(coordinator, maxAttempts, runsDir) {
        this.coordinator = coordinator;
        this.maxAttempts = maxAttempts;
        this.runsDir = runsDir;
    }
    /** Stored facts only: deliberately bypasses every synchronising coordinator method. */
    readProjection(taskId) {
        return readTaskProjection({ store: this.coordinator.store, runsDir: this.runsDir }, taskId);
    }
    send(input) { return this.coordinator.send(input); }
    continue(input) { return this.coordinator.continue(input); }
    accept(...args) { return this.coordinator.accept(...args); }
    cancel(...args) { return this.coordinator.cancel(...args); }
    respond(...args) { return this.coordinator.respond(...args); }
    reconcileReport(input) { return this.coordinator.reconcileReport(input); }
    sync(taskId, limit) { return this.coordinator.sync(taskId, limit); }
    requireTask(taskId) { return this.coordinator.requireTask(taskId); }
    executionStatus(taskId) { return this.coordinator.executionStatus(taskId); }
    listTasks(limit) { return this.coordinator.store.listTasks({ limit }); }
    listMessages(taskId, limit, attemptId) { return this.coordinator.store.listMessages(taskId, limit, attemptId); }
    listAttempts(taskId) { return this.coordinator.store.listAttempts(taskId); }
    statusView(task) {
        const execution = this.coordinator.executionStatus(task.taskId);
        const stopped = execution.remoteStopped;
        const cancelled = task.state === "cancelled";
        const failed = task.state === "failed";
        const review = task.state === "needs_review" || task.state === "completed";
        const terminal = cancelled || failed;
        let displayState;
        if (task.state === "accepted")
            displayState = "accepted";
        else if (terminal)
            displayState = stopped ? cancelled ? "cancelled" : "failed" : "waiting_stop";
        else if (execution.state === "waiting_input")
            displayState = "waiting_input";
        else if (review)
            displayState = stopped ? "needs_review" : "waiting_stop";
        else if (execution.cancellationRequested || execution.state === "stop_unconfirmed")
            displayState = "waiting_stop";
        else if (stopped && (task.state === "queued" || task.state === "working"))
            displayState = "unknown";
        else if (execution.state === "session_offline" || execution.state === "unknown")
            displayState = "unknown";
        else if (task.state === "queued")
            displayState = "queued";
        else if (task.state === "working")
            displayState = "running";
        else
            displayState = "unknown";
        const allowedActions = [];
        if (!terminal && task.state !== "accepted") {
            if (!stopped && !execution.cancellationRequested && ["queued", "running", "waiting_input"].includes(displayState))
                allowedActions.push("cancel");
            if (stopped && task.sessionId && (task.attempt ?? 0) < this.maxAttempts && (review || task.state === "blocked"))
                allowedActions.push("rework");
            const reportReady = task.runtimeSource !== "desktop_queue" || ("reportDigestPresent" in execution && execution.reportDigestPresent === true);
            if (stopped && review && task.sessionId && task.report?.rawText.trim() && reportReady && ["desktop_interactive", "desktop_queue"].includes(task.runtimeSource ?? ""))
                allowedActions.push("accept");
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
//# sourceMappingURL=task-application-service.js.map