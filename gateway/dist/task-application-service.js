import { AdmissionError } from "./collaboration.js";
import { readTaskProjection } from "./task-view-reader.js";
import { stageTaskViewFromProjection, STAGE_TASK_VIEW_UNAVAILABLE, STAGE_TASK_VIEW_SCHEMA_VERSION } from "./task-view-stage.js";
/** The MCP entry point and future local HTTP adapter share this service. */
export class TaskApplicationService {
    coordinator;
    maxAttempts;
    runsDir;
    dsh;
    constructor(coordinator, maxAttempts, runsDir, dsh) {
        this.coordinator = coordinator;
        this.maxAttempts = maxAttempts;
        this.runsDir = runsDir;
        this.dsh = dsh;
        if (dsh && dsh.store !== coordinator.store)
            throw new Error("DSH and WorkBuddy must share the same TaskStore");
    }
    /** Trusted local setup and authorization seams; no HTTP write routes. */
    registerWorkspace(id, directory, displayName) { return this.coordinator.store.collaboration.registerWorkspace(id, directory, displayName); }
    createCollaborationPlan(contract, options) {
        return this.coordinator.store.collaboration.createPlan(contract, this.coordinator.modelPolicy(), options);
    }
    authorizeCollaborationPlan(planId, revision, source) {
        return this.coordinator.store.collaboration.authorizePlan(planId, revision, this.coordinator.modelPolicy(), source);
    }
    getCollaborationPlan(planId) { return this.coordinator.store.collaboration.getPlan(planId); }
    readQuotaResources(options = {}) {
        return this.coordinator.store.quotas.read(options);
    }
    readCreditBalances(connectionId) { return this.coordinator.store.creditBalances.read(connectionId); }
    /** Stored facts only: deliberately bypasses every synchronising coordinator method. */
    readProjection(taskId) {
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
    readStageView(taskId) {
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
    listStageViews(options) {
        const limit = Math.floor(options.limit);
        if (!Number.isFinite(limit) || limit !== Math.trunc(limit) || limit < 1 || limit > 100) {
            return { ok: false, readOnly: true, snapshotOnly: true, code: "invalid_cursor", field: "limit", message: "limit must be an integer between 1 and 100." };
        }
        if (options.afterTaskId !== undefined && (typeof options.afterTaskId !== "string" || options.afterTaskId.length === 0 || options.afterTaskId.length > 200)) {
            return { ok: false, readOnly: true, snapshotOnly: true, code: "invalid_cursor", field: "afterTaskId", message: "afterTaskId must be a stored task id of 1-200 characters." };
        }
        let page;
        try {
            page = this.coordinator.store.listTasksByCreatedCursor({ limit, afterTaskId: options.afterTaskId });
        }
        catch {
            return { ok: false, readOnly: true, snapshotOnly: true, code: "store_unavailable", field: "store.listTasksByCreatedCursor", message: "Reading the task list failed; this is not reported as an empty list." };
        }
        if (options.afterTaskId !== undefined && !page.anchorFound) {
            return { ok: false, readOnly: true, snapshotOnly: true, code: "invalid_cursor", field: "afterTaskId", message: "No stored task has this id; the cursor must name an existing task." };
        }
        const items = [];
        for (const listed of page.tasks) {
            const projection = this.readProjection(listed.taskId);
            if (projection.ok) {
                items.push({
                    ok: true,
                    taskId: listed.taskId,
                    view: stageTaskViewFromProjection({ task: projection.row, projection, contract: projection.contract }),
                });
            }
            else {
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
        let next;
        if (last === undefined) {
            next = null;
        }
        else {
            try {
                next = this.coordinator.store.hasTaskAfterCursor(last.taskId) ? last.taskId : null;
            }
            catch {
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
    listTaskEvents(taskId, options = {}) {
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
            if (!task)
                return { ok: false, code: "task_not_found", field: "taskId", message: "No stored task has this id; events are never fabricated for one." };
            const page = this.coordinator.store.listTaskEvents(taskId, { afterEventId, limit });
            return { ok: true, events: page.events, nextEventId: page.nextEventId };
        }
        catch {
            return { ok: false, code: "store_unavailable", field: "store.listTaskEvents", message: "Reading the event stream failed; this is not reported as an empty stream." };
        }
    }
    async send(input) {
        if (input.contract?.execution?.executorId === "dsh") {
            if (!this.dsh)
                throw new AdmissionError("EXECUTOR_UNAVAILABLE", "The original DSH adapter is unavailable; WorkBuddy cannot take over its task");
            if (!input.sessionId || input.constraints !== undefined || input.acceptanceCommands !== undefined || input.model !== undefined || input.timeoutSeconds !== undefined || input.sessionMode === "new")
                throw new AdmissionError("TASK_CONFLICT", "DSH requires an explicit original session and immutable contract terms");
            return this.dsh.send({ contract: input.contract, objective: input.objective, sessionId: input.sessionId, taskId: input.taskId, workspace: input.workspace });
        }
        return this.coordinator.send(input);
    }
    dshFor(taskId) {
        if (!this.coordinator.store.dshBindings.forTask(taskId))
            return undefined;
        if (!this.dsh)
            throw new Error("The original DSH adapter is unavailable; WorkBuddy cannot take over its task");
        return this.dsh;
    }
    continue(input) { return this.dshFor(input.taskId)?.continue(input) ?? this.coordinator.continue(input); }
    accept(...args) { return this.dshFor(args[0])?.accept(...args) ?? this.coordinator.accept(...args); }
    cancel(...args) { return this.dshFor(args[0])?.cancel(...args) ?? this.coordinator.cancel(...args); }
    respond(...args) { if (this.dshFor(args[0]))
        throw new AdmissionError("EXECUTOR_CAPABILITY_MISSING", "Resolve DSH input in its native UI; this adapter cannot approve permissions"); return this.coordinator.respond(...args); }
    reconcileReport(input) { if (this.dshFor(input.taskId))
        throw new AdmissionError("EXECUTOR_CAPABILITY_MISSING", "DSH reports require their original durable request events"); return this.coordinator.reconcileReport(input); }
    sync(taskId, limit) { return this.dshFor(taskId)?.sync(taskId, limit) ?? this.coordinator.sync(taskId, limit); }
    requireTask(taskId) { return this.coordinator.requireTask(taskId); }
    executionStatus(taskId) { return this.dshFor(taskId)?.executionStatus(taskId) ?? this.coordinator.executionStatus(taskId); }
    listTasks(limit) { return this.coordinator.store.listTasks({ limit }); }
    listTasksByCreatedCursor(options) { return this.coordinator.store.listTasksByCreatedCursor(options); }
    listMessages(taskId, limit, attemptId) { return this.coordinator.store.listMessages(taskId, limit, attemptId); }
    listAttempts(taskId) { return this.coordinator.store.listAttempts(taskId); }
    statusView(task) {
        const execution = this.executionStatus(task.taskId);
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
            const contract = this.coordinator.store.getContract(task.taskId);
            const attemptLimit = contract.state === "found" ? contract.record.effectiveMaxAttempts : contract.state === "absent" ? this.maxAttempts : 0;
            if (stopped && task.sessionId && (task.attempt ?? 0) < attemptLimit && (review || task.state === "blocked" || (task.state === "failed" && task.runtimeSource === "dsh")))
                allowedActions.push("rework");
            const reportReady = !["desktop_queue", "dsh"].includes(task.runtimeSource ?? "") || ("reportDigestPresent" in execution && execution.reportDigestPresent === true);
            if (stopped && review && task.sessionId && task.report?.rawText.trim() && reportReady && (["desktop_interactive", "desktop_queue"].includes(task.runtimeSource ?? "") || (task.runtimeSource === "dsh" && this.dsh)))
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