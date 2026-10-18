import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { AcpLiveClient } from "./acp-live.js";
import { TaskCoordinator } from "./coordinator.js";
import { DesktopQueue } from "./desktop-queue.js";
import { listDesktopSessions } from "./desktop-runtime.js";
import { resultForDetail, type ResultDetail, type BriefResultOptions } from "./brief-result.js";
import { serviceStatus } from "./service-cli.js";
import { readServiceRegistration } from "./persistent-service.js";
import path from "node:path";
import { ensureWorkspace, listWorkspaces, listModels } from "./workspace-manager.js";
import { loadDotEnv } from "./env.js";
import { runtimeVersion } from "./runtime-version.js";
import { progressDelta } from "./progress-summary.js";

// Load this installation's .env so the MCP host does not have to export it or
// run the POSIX launcher. Explicit host variables always win.
loadDotEnv();
const config = loadConfig();
const client = new WorkBuddyClient(config);
const store = new TaskStore(config.dbFile);
const coordinator = new TaskCoordinator(config, store, client);
const server = new McpServer({ name: "codex-workbuddy-gateway", version: "0.7.0" });
const timeout = z.number().int().positive().max(86_400).optional();
const taskId = z.string().min(1).max(200);
const detail = z.enum(["full", "brief"]).optional().default("brief").describe("full preserves complete records. brief omits repeated goals/history/logs and clips the latest report to 2000 characters, while retaining identity, blockers and artifact paths. Brief summaries are not acceptance evidence.");

server.tool("workbuddy_health", "Probe the configured transport. Online means a connection is available; it does not prove login, model/skill availability, desktop visibility or task success.", { sessionId: z.string().optional(), detail }, ({ sessionId, detail }) => guard(async () => {
  const result = await client.health(sessionId);
  let sessions: unknown[] = [];
  if (config.backend === "desktop-acp") {
    try { sessions = AcpLiveClient.listSessions(config).map((endpoint) => ({ sessionId: endpoint.sessionId, ready: endpoint.desktopVisible === true, workspace: endpoint.sessionCwd ?? endpoint.cwd, source: endpoint.runtimeSource })); } catch {}
  }
  if (config.backend === "desktop-queue") sessions = new DesktopQueue(config).listeners();
  const registrationFile=config.serviceConfigFile??path.join(path.dirname(config.dbFile),"persistent-service.json");
  const registration=config.backend==="desktop-queue"?readServiceRegistration(registrationFile):undefined;
  const bound=registration&&path.resolve(registration.dbFile)===path.resolve(config.dbFile)&&(!sessionId||listWorkspaces(config).some(worker=>worker.sessionId===sessionId));
  const persistentService=config.backend==="desktop-queue"?(bound?serviceStatus(registrationFile):{installed:false}):undefined;
  const state=persistentService?.state as {updatedAt?:string;status?:string}|undefined;
  const serviceAvailable=Boolean(persistentService?.installed&&persistentService.launchdLoaded&&persistentService.desktopRegistered&&state?.updatedAt&&Date.now()-Date.parse(state.updatedAt)<30_000);
  return { ok: true, runtime: runtimeVersion, backend: config.backend, online: result.online, desktopSupervision: ["desktop-acp", "desktop-queue"].includes(config.backend), ready: result.ready ?? false, sessionId: result.sessionId??sessionId??persistentService?.sessionId, sessions, persistentService, workerCandidates: config.backend === "desktop-queue"&&!bound ? listDesktopSessions(config.workbuddyConfigDir) : undefined, status: result.online ? "transport_online" : serviceAvailable?(state?.status==="no_task"?"persistent_service_idle":"persistent_service_state"):"offline", message: serviceAvailable&&!result.online?(state?.status==="no_task"?"The persistent service is running. No temporary listener is needed while idle; queued tasks wake enrolled native WorkBuddy chats automatically.":"The persistent service is running; inspect its per-workspace state for active work, blockers or uncertain submission before any retry."):result.raw.msg, next: persistentService?.installed?"Pass workspace to send_task to create/reuse its native worker and route automatically. Queued/installed does not prove execution.":"Call ensure_workspace with an existing absolute project directory for native setup without manual chat creation. Login and native permissions remain in WorkBuddy." };
}, detail));

server.tool("workbuddy_ensure_workspace", "Create or reuse a dedicated native WorkBuddy session. Use a stable workerKey such as taskId for a clean conversation in the same workspace; repeating the key reuses its reserved identity, even after uncertain creation. sessionId instead selects an existing real session. Queued tasks retain their original bindings.", {
  workspace:z.string().min(1).describe("Existing absolute project directory"),sessionId:z.string().min(1).optional(),title:z.string().min(1).max(200).optional(),model:z.string().trim().min(1).optional().describe("Optional exact native model ID. Changes require an idle session without queued tasks."),detail,
  workerKey:z.string().trim().min(1).max(200).optional().describe("Stable task-scoped key for an isolated native conversation in the same project. Reuse the exact key on reconnect. Cannot be combined with sessionId."),
}, ({detail,...input})=>guard(()=>ensureWorkspace(config,input),detail));

server.tool("workbuddy_list_models", "Query models currently available in WorkBuddy, with optional session's selected model. Use returned IDs for model selection; availability does not prove quota or execution success.", {sessionId:z.string().min(1).optional(),detail}, ({sessionId,detail})=>guard(()=>listModels(config,sessionId),detail));

server.tool("workbuddy_list_workspaces", "List registered project directories, selected execution sessions and native registration status. An installed worker does not prove task success.", {detail}, ({detail})=>guard(async()=>({ok:true,workers:listWorkspaces(config)}),detail));

server.tool("workbuddy_prepare_worker", "Generate instructions for the selected real desktop chat. persistent:true installs a one-time native auto-wake service; false starts a temporary listener. Read-only: generating a prompt does not install or start anything.", { sessionId: z.string().min(1), persistent: z.boolean().optional().default(false) }, ({ sessionId, persistent }) => guard(async () => ({ ok: true, ...new DesktopQueue(config).prepare(sessionId, persistent) })));

server.tool("workbuddy_send_task", "Reserve and dispatch a task to a verified WorkBuddy desktop conversation. Repeated taskId never dispatches twice. Keep polling with workbuddy_wait, independently inspect the result, then continue or accept.", {
  taskId: taskId.optional(), objective: z.string().min(1), workspace: z.string().optional().describe("Existing absolute project directory; automatically create or reuse its native WorkBuddy worker when sessionId is omitted."),
  sessionId: z.string().min(1).optional().describe("Real WorkBuddy desktop session ID. Required when several live sessions exist."),
  sessionMode: z.enum(["existing", "new"]).optional().default("existing").describe("Queue uses project routing with existing; pass workspace for automatic native creation or selection. ACP new is version-dependent."),
  model: z.string().trim().min(1).optional().describe("Exact model ID from workbuddy_list_models. Queue applies and verifies it at the next native wake; omit to use the session's selected model."),
  constraints: z.array(z.string()).max(30).optional(), acceptanceCommands: z.array(z.string()).max(30).optional(), timeoutSeconds: timeout,
  detail,
}, ({ detail, ...input }) => guard(() => coordinator.send(input), detail));

server.tool("workbuddy_get_task", "Synchronize progress for the current attempt; includes source/session identity, blockers and real final report. A WorkBuddy turn ending is needs_review, not accepted.", {
  taskId, includeMessages: z.boolean().optional().default(true), limit: z.number().int().positive().max(100).optional().default(100), detail, sinceEventSeq:z.number().int().nonnegative().optional(),
}, ({ taskId, includeMessages, limit, detail, sinceEventSeq }) => guard(async () => {
  const task = await coordinator.sync(taskId, limit);
  return { ok: true, task, execution: coordinator.executionStatus(taskId), messages: includeMessages ? store.listMessages(taskId, limit) : undefined, attempts: store.listAttempts(taskId), acceptance: "Inspect actual sources/files and verify relevant checks before acceptance." };
}, detail, {sinceEventSeq}));

server.tool("workbuddy_wait", "Wait up to 55 seconds for progress or a terminal/input state. Call repeatedly for long tasks; worker execution survives MCP disconnects. Do not tell the user the task is done until reviewing evidence.", {
  taskId, timeoutSeconds: z.number().int().min(0).max(55).optional().default(50), detail, sinceEventSeq:z.number().int().nonnegative().optional(),
}, ({ taskId, timeoutSeconds, detail, sinceEventSeq }) => guard(async () => {
  const before = coordinator.requireTask(taskId);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let task = await coordinator.sync(taskId);
  const pending = () => ["queued", "working"].includes(task.state) || (!coordinator.executionStatus(taskId).remoteStopped && (task.state === "needs_review" || ["cancelled","blocked"].includes(task.state) && coordinator.executionStatus(taskId).cancellationRequested));
  while (pending() && task.lastMessageId === before.lastMessageId && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    task = await coordinator.sync(taskId);
  }
  const execution = coordinator.executionStatus(taskId);
  return { ok: true, task, execution, messages: store.listMessages(taskId, 100), next: pending() ? task.state === "needs_review" ? "Worker report received; use bounded wait calls until native stop is verified before rework or acceptance." : "Call wait again; continue supervision." : task.state === "needs_review" ? "Review actual output, then continue for corrections or accept with evidence." : task.state === "blocked" ? config.backend === "desktop-queue" ? "Read the blocker and execution state. Native permission/input stays in WorkBuddy's UI; do not resend or continue while execution is unresolved." : "Read the blocker. If waiting for input, use respond; inspect the original session before rework." : "Read the terminal result." };
}, detail, {sinceEventSeq}));

server.tool("workbuddy_list_tasks", "List durable task history after reconnecting. Use get/wait on active tasks to resume supervision; never automatically resend a disconnected task.", {
  limit: z.number().int().positive().max(100).optional().default(20), detail,
}, ({ limit, detail }) => guard(async () => ({ ok: true, tasks: store.listTasks({ limit }) }), detail));

server.tool("workbuddy_get_messages", "Synchronize and read current-attempt progress, tool updates and WorkBuddy report. Select an earlier attemptId to inspect history.", {
  taskId, attemptId: z.string().optional(), limit: z.number().int().positive().max(500).optional().default(100), detail,
}, ({ taskId, attemptId, limit, detail }) => guard(async () => ({ ok: true, task: await coordinator.sync(taskId, 100), messages: store.listMessages(taskId, limit, attemptId) }), detail, { messageAttemptId: attemptId }));

server.tool("workbuddy_continue_task", "Send specific review feedback to the same verified desktop session. Original objective, constraints and checks remain in force. Refuses an overlapping prompt or switching sessions.", {
  taskId, feedback: z.string().min(1).max(10_000), acceptanceCommands: z.array(z.string()).max(30).optional(), timeoutSeconds: timeout, model: z.string().min(1).optional(), detail,
}, ({ detail, ...input }) => guard(() => coordinator.continue(input), detail));

server.tool("workbuddy_respond_task", "Respond to an active WorkBuddy permission or form request. Only offered single-action permission choices are accepted; never grants permanent access. Use submit with content for elicitation.", {
  taskId, decision: z.enum(["allow_once", "reject_once", "cancel", "submit"]), content: z.record(z.unknown()).optional(),
}, ({ taskId, decision, content }) => guard(async () => coordinator.respond(taskId, decision, content)));

server.tool("workbuddy_accept_task", "Record acceptance only after independent verification of a real desktop WorkBuddy result. Supply concrete verification evidence and any actual artifact paths. This records an audit, it does not run checks for you.", {
  taskId, note: z.string().min(1).max(2_000), evidence: z.array(z.string().min(1)).min(1).max(30), artifactPaths: z.array(z.string().min(1)).max(100).optional(), detail,
}, ({ taskId, note, evidence, artifactPaths, detail }) => guard(async () => ({ ok: true, task: await coordinator.accept(taskId, note, evidence, artifactPaths) }), detail));

server.tool("workbuddy_cancel_task", "Request cancellation and preserve an audit record. A cancellation request alone does not prove WorkBuddy stopped; inspect the desktop if it continues.", {
  taskId, reason: z.string().max(500).optional(), detail,
}, ({ taskId, reason, detail }) => guard(async () => coordinator.cancel(taskId, reason), detail));

async function guard(action: () => Promise<unknown>, detail: ResultDetail = "full", options: BriefResultOptions = {}) {
  try {
    const value={...await action() as object,runtime:runtimeVersion} as {task?:import("./task-store.js").StoredTask;delta?:unknown};
    const compact=resultForDetail(value, detail, options) as {task?:{latestReport?:unknown};delta?:unknown};
    if(detail==="brief" && value.task?.attemptId) {
      const key=`${value.task.taskId}:${value.task.attemptId}`;
      const previous=options.sinceEventSeq??summaryCursors.get(key)??0;
      const delta=progressDelta(value.task,store.listMessages(value.task.taskId,100),previous);
      compact.delta=delta;
      if(!delta.changed && compact.task)delete compact.task.latestReport;
      summaryCursors.set(key,value.task.lastEventSeq??0);
    }
    return jsonResult(compact);
  }
  catch (error) { return jsonResult(resultForDetail({ ok: false, error: error instanceof Error ? error.message : String(error) }, detail)); }
}
const summaryCursors = new Map<string,number>();
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
await server.connect(new StdioServerTransport());
process.once("SIGINT", () => { store.close(); process.exit(0); });
process.once("SIGTERM", () => { store.close(); process.exit(0); });
