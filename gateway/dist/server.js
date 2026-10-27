import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { AcpLiveClient } from "./acp-live.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { DesktopQueue } from "./desktop-queue.js";
import { listDesktopSessions } from "./desktop-runtime.js";
import { resultForDetail } from "./brief-result.js";
import { serviceStatus } from "./service-cli.js";
import { readServiceRegistration } from "./persistent-service.js";
import path from "node:path";
import { listWorkspaces, listModels } from "./workspace-manager.js";
import { loadDotEnv } from "./env.js";
import { runtimeVersion } from "./runtime-version.js";
import { progressDelta } from "./progress-summary.js";
import { registerTaskProjectionTool } from "./task-view-reader.js";
import { runsDirectory } from "./run-journal.js";
import { AdmissionError } from "./collaboration.js";
import { configuredDshCoordinator } from "./dsh-runtime.js";
// Load this installation's .env so the MCP host does not have to export it or
// run the POSIX launcher. Explicit host variables always win.
loadDotEnv();
const config = loadConfig();
const client = new WorkBuddyClient(config);
const store = new TaskStore(config.dbFile);
const coordinator = new TaskCoordinator(config, store, client);
const tasks = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config), configuredDshCoordinator(store, runsDirectory(config)));
const server = new McpServer({ name: "codex-workbuddy-gateway", version: runtimeVersion.packageVersion });
const timeout = z.number().int().positive().max(86_400).optional();
const taskId = z.string().min(1).max(200);
const operation = { operationId: z.string().min(1).max(512).optional(), expectedRevision: z.string().min(1).nullable().optional(), expectedAttemptId: z.string().min(1).nullable().optional() };
const detail = z.enum(["full", "brief"]).optional().default("brief").describe("full preserves complete records. brief omits repeated goals/history/logs and clips the latest report to 2000 characters, while retaining identity, blockers and artifact paths. Brief summaries are not acceptance evidence.");
server.tool("workbuddy_health", "Probe the configured transport. Online means a connection is available; it does not prove login, model/skill availability, desktop visibility or task success.", { sessionId: z.string().optional(), detail }, ({ sessionId, detail }) => guard(async () => {
    const result = await client.health(sessionId);
    let sessions = [];
    if (config.backend === "desktop-acp") {
        try {
            sessions = AcpLiveClient.listSessions(config).map((endpoint) => ({ sessionId: endpoint.sessionId, ready: endpoint.desktopVisible === true, workspace: endpoint.sessionCwd ?? endpoint.cwd, source: endpoint.runtimeSource }));
        }
        catch { }
    }
    if (config.backend === "desktop-queue")
        sessions = new DesktopQueue(config).listeners();
    const registrationFile = config.serviceConfigFile ?? path.join(path.dirname(config.dbFile), "persistent-service.json");
    const registration = config.backend === "desktop-queue" ? readServiceRegistration(registrationFile) : undefined;
    const bound = registration && path.resolve(registration.dbFile) === path.resolve(config.dbFile) && (!sessionId || listWorkspaces(config).some(worker => worker.sessionId === sessionId));
    const persistentService = config.backend === "desktop-queue" ? (bound ? serviceStatus(registrationFile) : { installed: false }) : undefined;
    const state = persistentService?.state;
    const serviceAvailable = Boolean(persistentService?.installed && persistentService.launchdLoaded && persistentService.desktopRegistered && state?.updatedAt && Date.now() - Date.parse(state.updatedAt) < 30_000);
    return { ok: true, runtime: runtimeVersion, backend: config.backend, online: result.online, desktopSupervision: ["desktop-acp", "desktop-queue"].includes(config.backend), ready: result.ready ?? false, sessionId: result.sessionId ?? sessionId ?? persistentService?.sessionId, sessions, persistentService, workerCandidates: config.backend === "desktop-queue" && !bound ? listDesktopSessions(config.workbuddyConfigDir) : undefined, status: result.online ? "transport_online" : serviceAvailable ? (state?.status === "no_task" ? "persistent_service_idle" : "persistent_service_state") : "offline", message: serviceAvailable && !result.online ? (state?.status === "no_task" ? "The persistent service is running. No temporary listener is needed while idle; queued tasks wake enrolled native WorkBuddy chats automatically." : "The persistent service is running; inspect its per-workspace state for active work, blockers or uncertain submission before any retry.") : result.raw.msg, next: persistentService?.installed ? "Pass workspace to send_task to create/reuse its native worker and route automatically. Queued/installed does not prove execution." : "After choosing a model, pass a stable taskId, workspace and that model to send_task for admitted native setup. Login and native permissions remain in WorkBuddy." };
}, detail));
server.tool("workbuddy_ensure_workspace", "Compatibility entry. Standalone native preparation is refused; submit the user-selected model with a stable task identity through send_task to acquire shared admission first.", {
    workspaceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/).optional().describe("Optional stable project ID to register for immutable contract dispatch."),
    workspace: z.string().min(1).describe("Existing absolute project directory"), sessionId: z.string().min(1).optional(), title: z.string().min(1).max(200).optional(), model: z.string().trim().min(1).optional().describe("User-selected exact native model ID, required before preparing a session. Changes require an idle session without queued tasks."), detail,
    workerKey: z.string().trim().min(1).max(200).optional().describe("Stable task-scoped key for an isolated native conversation in the same project. Reuse the exact key on reconnect. Cannot be combined with sessionId."),
}, ({ detail, workspaceId, ...input }) => guard(async () => {
    if (!input.model)
        throw new AdmissionError("MODEL_SELECTION_REQUIRED", "Ask the user to choose an exact model before preparing a session.");
    throw new AdmissionError("OPERATION_REQUIRED", "Prepare the selected model through an authorized send_task operation; standalone model preparation cannot reserve a second workflow.");
}, detail));
server.tool("workbuddy_list_models", "Query models currently available in WorkBuddy, with optional session's selected model. Use returned IDs for model selection; availability does not prove quota or execution success.", { sessionId: z.string().min(1).optional(), detail }, ({ sessionId, detail }) => guard(() => listModels(config, sessionId), detail));
server.tool("workbuddy_list_workspaces", "List registered project directories, selected execution sessions and native registration status. An installed worker does not prove task success.", { detail }, ({ detail }) => guard(async () => ({ ok: true, workers: listWorkspaces(config) }), detail));
server.tool("workbuddy_prepare_worker", "Generate instructions for the selected real desktop chat. persistent:true installs a one-time native auto-wake service; false starts a temporary listener. Read-only: generating a prompt does not install or start anything.", { sessionId: z.string().min(1), persistent: z.boolean().optional().default(false) }, ({ sessionId, persistent }) => guard(async () => ({ ok: true, ...new DesktopQueue(config).prepare(sessionId, persistent) })));
server.tool("workbuddy_send_task", "Reserve and dispatch a task to a verified WorkBuddy desktop conversation. Repeated taskId never dispatches twice. Keep polling with workbuddy_wait, independently inspect the result, then continue or accept.", {
    ...operation, taskId: taskId.optional(), objective: z.string().min(1), workspace: z.string().optional().describe("Existing absolute project directory; automatically create or reuse its native WorkBuddy worker when sessionId is omitted."),
    sessionId: z.string().min(1).optional().describe("Real WorkBuddy desktop session ID. Required when several live sessions exist."),
    sessionMode: z.enum(["existing", "new"]).optional().default("existing").describe("Queue uses project routing with existing; pass workspace for automatic native creation or selection. ACP new is version-dependent."),
    model: z.string().trim().min(1).optional().describe("Exact model ID from workbuddy_list_models. The user must choose this exact model before dispatch; queue applies and verifies it at the next native wake."),
    constraints: z.array(z.string()).max(30).optional(), acceptanceCommands: z.array(z.string()).max(30).optional(), timeoutSeconds: timeout,
    scope: z.object({ allowedChanges: z.array(z.string()).max(100), permittedMetadata: z.array(z.string()).max(100) }).strict().optional().describe("Immutable exact-file/directory/** write scope for a non-contract task. Missing scope grants read-only access. Existing user changes remain protected; cannot be combined with contract."),
    contract: z.unknown().optional().describe("Optional immutable vnext-1/vnext-2 contract. Requires a registered workspace; vnext-2 also requires a plan authorized through the trusted application service. Do not combine with constraints/check overrides."),
    detail,
}, ({ detail, ...input }) => guard(() => {
    if (!input.contract && !input.model && (!input.taskId || !store.get(input.taskId)))
        throw new AdmissionError("MODEL_SELECTION_REQUIRED", "Ask the user to choose an exact model before dispatch.");
    return tasks.send(input);
}, detail));
server.tool("workbuddy_get_operation", "Read the original durable operation receipt. Unfinished operations never trigger a resend.", { operationId: z.string().min(1).max(512) }, ({ operationId }) => guard(async () => ({ ok: true, operation: tasks.getOperation(operationId) })));
server.tool("workbuddy_get_operation_recovery", "Read original recovery evidence, available local actions and immutable audits; no native calls or writes.", { operationId: z.string().min(1).max(512) }, ({ operationId }) => guard(async () => ({ ok: true, recovery: tasks.readOperationRecovery(operationId) })));
server.tool("workbuddy_observe_operation_recovery", "Explicitly collect the original source's existing report/stop events without dispatching, selecting models or cancelling. Human decisions require the local recovery console.", { operationId: z.string().min(1).max(512) }, ({ operationId }) => guard(async () => ({ ok: true, recovery: await tasks.observeOperationRecovery(operationId) })));
server.tool("workbuddy_get_task", "Synchronize progress for the current attempt; includes source/session identity, blockers and real final report. A WorkBuddy turn ending is needs_review, not accepted.", {
    taskId, includeMessages: z.boolean().optional().default(true), limit: z.number().int().positive().max(100).optional().default(100), detail, sinceEventSeq: z.number().int().nonnegative().optional(),
}, ({ taskId, includeMessages, limit, detail, sinceEventSeq }) => guard(async () => {
    const task = await tasks.sync(taskId, limit);
    return { ok: true, task, statusView: tasks.statusView(task), execution: tasks.executionStatus(taskId), messages: includeMessages ? tasks.listMessages(taskId, limit) : undefined, attempts: tasks.listAttempts(taskId), acceptance: "Inspect actual sources/files and verify relevant checks before acceptance." };
}, detail, { sinceEventSeq }));
server.tool("workbuddy_wait", "Wait up to 55 seconds for progress or a terminal/input state. Call repeatedly for long tasks; worker execution survives MCP disconnects. Do not tell the user the task is done until reviewing evidence.", {
    taskId, timeoutSeconds: z.number().int().min(0).max(55).optional().default(50), detail, sinceEventSeq: z.number().int().nonnegative().optional(),
}, ({ taskId, timeoutSeconds, detail, sinceEventSeq }) => guard(async () => {
    const before = tasks.requireTask(taskId);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let task = await tasks.sync(taskId);
    const pending = () => {
        const execution = tasks.executionStatus(taskId);
        return ["queued", "working"].includes(task.state) || (!execution.remoteStopped &&
            (task.state === "needs_review" || task.state === "cancelled" ||
                (task.state === "blocked" && (execution.cancellationRequested || execution.state === "stop_unconfirmed"))));
    };
    while (pending() && task.lastMessageId === before.lastMessageId && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
        task = await tasks.sync(taskId);
    }
    const execution = tasks.executionStatus(taskId);
    return { ok: true, task, statusView: tasks.statusView(task), execution, messages: tasks.listMessages(taskId, 100), next: pending() ? task.state === "needs_review" ? "Worker report received; use bounded wait calls until native stop is verified before rework or acceptance." : "Call wait again; continue supervision." : task.state === "needs_review" ? "Review actual output, then continue for corrections or accept with evidence." : task.state === "blocked" ? config.backend === "desktop-queue" ? "Read the blocker and execution state. Native permission/input stays in WorkBuddy's UI; do not resend or continue while execution is unresolved." : "Read the blocker. If waiting for input, use respond; inspect the original session before rework." : "Read the terminal result." };
}, detail, { sinceEventSeq }));
server.tool("workbuddy_list_tasks", "List durable task history after reconnecting. Use get/wait on active tasks to resume supervision; never automatically resend a disconnected task.", {
    limit: z.number().int().positive().max(100).optional().default(20), detail,
}, ({ limit, detail }) => guard(async () => {
    const listed = tasks.listTasks(limit);
    return { ok: true, tasks: listed, statusViews: listed.map(task => tasks.statusView(task)) };
}, detail));
server.tool("workbuddy_get_messages", "Synchronize and read current-attempt progress, tool updates and WorkBuddy report. Select an earlier attemptId to inspect history.", {
    taskId, attemptId: z.string().optional(), limit: z.number().int().positive().max(500).optional().default(100), detail,
}, ({ taskId, attemptId, limit, detail }) => guard(async () => ({ ok: true, task: await tasks.sync(taskId, 100), messages: tasks.listMessages(taskId, limit, attemptId) }), detail, { messageAttemptId: attemptId }));
server.tool("workbuddy_continue_task", "Send specific review feedback to the same verified desktop session. Original objective, constraints and checks remain in force. Refuses an overlapping prompt or switching sessions.", {
    ...operation, taskId, feedback: z.string().min(1).max(10_000), acceptanceCommands: z.array(z.string()).max(30).optional(), timeoutSeconds: timeout, model: z.string().min(1).optional(), detail,
}, ({ detail, ...input }) => guard(() => tasks.continue(input), detail));
server.tool("workbuddy_reconcile_report", "Restore an existing authenticated, on-time worker report for review when a later native error overwrote it. Requires the current attempt, verified native idle and original turn ownership. Does not dispatch a task or accept a result.", {
    taskId, attemptId: z.string().regex(/^run-[a-f0-9-]{36}$/), reason: z.string().trim().min(1).max(2000), detail,
}, ({ detail, ...input }) => guard(() => tasks.reconcileReport(input), detail));
server.tool("workbuddy_respond_task", "Respond to an active WorkBuddy permission or form request. Only offered single-action permission choices are accepted; never grants permanent access. Use submit with content for elicitation.", {
    taskId, decision: z.enum(["allow_once", "reject_once", "cancel", "submit"]), content: z.record(z.unknown()).optional(),
}, ({ taskId, decision, content }) => guard(async () => tasks.respond(taskId, decision, content)));
server.tool("workbuddy_accept_task", "Record acceptance only after independent verification of a real desktop WorkBuddy result. Supply concrete verification evidence and any actual artifact paths. This records an audit, it does not run checks for you.", {
    taskId, note: z.string().min(1).max(2_000), evidence: z.array(z.string().min(1)).min(1).max(30), artifactPaths: z.array(z.string().min(1)).max(100).optional(), detail,
}, ({ taskId, note, evidence, artifactPaths, detail }) => guard(async () => ({ ok: true, task: await tasks.accept(taskId, note, evidence, artifactPaths) }), detail));
server.tool("workbuddy_cancel_task", "Request cancellation and preserve an audit record. A cancellation request alone does not prove WorkBuddy stopped; inspect the desktop if it continues.", {
    taskId, reason: z.string().max(500).optional(), detail,
}, ({ taskId, reason, detail }) => guard(async () => tasks.cancel(taskId, reason), detail));
async function guard(action, detail = "full", options = {}) {
    try {
        const value = { ...await action(), runtime: runtimeVersion };
        const compact = resultForDetail(value, detail, options);
        if (detail === "brief" && value.task?.attemptId) {
            const key = `${value.task.taskId}:${value.task.attemptId}`;
            const previous = options.sinceEventSeq ?? summaryCursors.get(key) ?? 0;
            const delta = progressDelta(value.task, tasks.listMessages(value.task.taskId, 100), previous);
            compact.delta = delta;
            if (!delta.changed && compact.task)
                delete compact.task.latestReport;
            summaryCursors.set(key, value.task.lastEventSeq ?? 0);
        }
        return jsonResult(compact);
    }
    catch (error) {
        return jsonResult(resultForDetail({ ok: false, ...(error instanceof AdmissionError ? { code: error.code } : {}), ...(error.operationId ? { operationId: error.operationId, operationState: error.operationState, ...(error.recoveryOperationId ? { recoveryOperationId: error.recoveryOperationId } : { outcomeCode: "OUTCOME_UNKNOWN" }) } : {}), error: error.operationId ? "Observe the original operation; no automatic retry is allowed." : error instanceof Error ? error.message : String(error) }, detail));
    }
}
const summaryCursors = new Map();
function jsonResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
// Read-only projection of stored records. It reuses this process's store and
// runs directory, and never constructs a store, creates a directory, syncs or
// dispatches anything.
registerTaskProjectionTool(server, tasks);
await server.connect(new StdioServerTransport());
process.once("SIGINT", () => { store.close(); process.exit(0); });
process.once("SIGTERM", () => { store.close(); process.exit(0); });
//# sourceMappingURL=server.js.map