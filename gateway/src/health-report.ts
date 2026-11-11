import path from "node:path";
import type { Config } from "./config.js";
import type { WorkBuddyClient } from "./workbuddy-client.js";
import { AcpLiveClient } from "./acp-live.js";
import { DesktopQueue } from "./desktop-queue.js";
import { listDesktopSessions } from "./desktop-runtime.js";
import { readServiceRegistration } from "./persistent-service.js";
import { serviceStatus } from "./service-cli.js";
import { listWorkspaces } from "./workspace-manager.js";
import { runtimeVersion } from "./runtime-version.js";

/**
 * The health reading shared by the full MCP server and the read-only health entry.
 *
 * Everything here is a read: transport probing, listener listings, the service
 * registration file and the desktop session table (opened read-only). No task
 * store is opened, so asking "is this installation ready?" never creates a
 * database, runs a migration or touches a queue row.
 *
 * `observer` names the process that actually answered, so a caller can compare
 * the child identity with its own instead of assuming they are the same.
 */
export async function healthReport(input: { config: Config; client: WorkBuddyClient; sessionId?: string }) {
  const { config, client, sessionId } = input;
  const result = await client.health(sessionId);
  let sessions: unknown[] = [];
  if (config.backend === "desktop-acp") {
    try { sessions = AcpLiveClient.listSessions(config).map((endpoint) => ({ sessionId: endpoint.sessionId, ready: endpoint.desktopVisible === true, workspace: endpoint.sessionCwd ?? endpoint.cwd, source: endpoint.runtimeSource })); } catch {}
  }
  if (config.backend === "desktop-queue") sessions = new DesktopQueue(config).listeners();
  const registrationFile = config.serviceConfigFile ?? path.join(path.dirname(config.dbFile), "persistent-service.json");
  const registration = config.backend === "desktop-queue" ? readServiceRegistration(registrationFile) : undefined;
  const bound = registration && path.resolve(registration.dbFile) === path.resolve(config.dbFile) && (!sessionId || listWorkspaces(config).some(worker => worker.sessionId === sessionId));
  const persistentService = config.backend === "desktop-queue" ? (bound ? serviceStatus(registrationFile) : { installed: false }) : undefined;
  const state = persistentService?.state as { updatedAt?: string; status?: string } | undefined;
  const serviceAvailable = Boolean(persistentService?.installed && persistentService.launchdLoaded && persistentService.desktopRegistered && state?.updatedAt && Date.now() - Date.parse(state.updatedAt) < 30_000);
  return {
    ok: true, runtime: runtimeVersion, backend: config.backend, online: result.online, desktopSupervision: ["desktop-acp", "desktop-queue"].includes(config.backend), ready: result.ready ?? false,
    sessionId: result.sessionId ?? sessionId ?? persistentService?.sessionId, sessions, persistentService,
    workerCandidates: config.backend === "desktop-queue" && !bound ? listDesktopSessions(config.workbuddyConfigDir) : undefined,
    status: result.online ? "transport_online" : serviceAvailable ? (state?.status === "no_task" ? "persistent_service_idle" : "persistent_service_state") : "offline",
    message: serviceAvailable && !result.online ? (state?.status === "no_task" ? "The persistent service is running. No temporary listener is needed while idle; queued tasks wake enrolled native WorkBuddy chats automatically." : "The persistent service is running; inspect its per-workspace state for active work, blockers or uncertain submission before any retry.") : result.raw.msg,
    next: persistentService?.installed ? "Pass workspace to send_task to create/reuse its native worker and route automatically. Queued/installed does not prove execution." : "After choosing a model, pass a stable taskId, workspace and that model to send_task for admitted native setup. Login and native permissions remain in WorkBuddy.",
    // Identity of the answering process, not of whoever asked the question.
    observer: { pid: runtimeVersion.pid, startedAt: runtimeVersion.startedAt, codeHash: runtimeVersion.codeHash, packageVersion: runtimeVersion.packageVersion, dataRoot: path.dirname(config.dbFile), dbFile: path.resolve(config.dbFile) },
  };
}
