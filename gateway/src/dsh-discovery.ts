import os from "node:os";
import path from "node:path";
import { DshClient, discoverDshSessions } from "./dsh-client.js";

// Read-only executor discovery shared by the CLI (dsh-inspect.ts) and the MCP
// tool surface. Nothing here opens a TaskStore, touches a lease, activates a
// native session or sends a model request. Host summaries deliberately drop
// socketPath and token: a caller needs to know which bridge it may address and
// whether that process is alive, not the credential that addresses it.
export const DSH_DISCOVERY_SCHEMA_VERSION = "workbuddy-executor/dsh-discovery-1";

export interface DshHostSummary { hostId: string; profile: string | null; version: string | null }

export type DshExecutorReason = "adapter_disabled" | "native_bridge_not_registered" | "ready";

export interface DshExecutorSummary {
  adapter: "enabled" | "disabled";
  reason: DshExecutorReason;
  hosts: DshHostSummary[];
  defaultHostId: string | null;
}

type HostReader = Pick<DshClient, "hosts">;

/** Live bridge processes only. Dead registrations stay invisible so a stale
 * file cannot be mistaken for an executor that can take work. */
export function summarizeDshHosts(client: HostReader = new DshClient()): DshHostSummary[] {
  const seen = new Set<string>();
  const summaries: DshHostSummary[] = [];
  for (const host of client.hosts()) {
    if (host.processAlive === false || seen.has(host.hostId)) continue;
    seen.add(host.hostId);
    summaries.push({ hostId: host.hostId, profile: host.profile ?? null, version: host.version ?? null });
  }
  return summaries.sort((left, right) => left.hostId.localeCompare(right.hostId));
}

/** Adapter state as the tool surface reports it. `adapter_disabled` means the
 * gateway was started without WORKBUDDY_DSH_ENABLED=1, so a DSH dispatch would
 * be refused with EXECUTOR_UNAVAILABLE no matter which session is named. */
export function dshExecutorSummary(env: NodeJS.ProcessEnv = process.env, client?: HostReader): DshExecutorSummary {
  if (env.WORKBUDDY_DSH_ENABLED !== "1") return { adapter: "disabled", reason: "adapter_disabled", hosts: [], defaultHostId: null };
  let hosts: DshHostSummary[] = [];
  try { hosts = summarizeDshHosts(client); }
  catch { hosts = []; }
  const requested = env.WORKBUDDY_DSH_HOST_ID?.trim() || null;
  // An explicitly configured host never falls back to a different live bridge:
  // dispatching to the wrong Harness would be worse than reporting no default.
  const defaultHostId = requested ? (hosts.some(host => host.hostId === requested) ? requested : null) : hosts.length === 1 ? hosts[0]!.hostId : null;
  return { adapter: "enabled", reason: hosts.length ? "ready" : "native_bridge_not_registered", hosts, defaultHostId };
}

/** Registry view for one workspace. `missing` and `unreadable` are separate
 * reasons on purpose: only one of them means "start a session here". */
export function dshSessionsFor(directory: string, sessionId?: string, registryFile = path.join(os.homedir(), ".dsh", "storages", "dsh-codex-workflow", "coord.sqlite")) {
  return discoverDshSessions(directory, sessionId, registryFile);
}
