import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DeepSeekClient, type DeepSeekTransport, type DeepSeekSession } from "./deepseek-client.js";
import type { ExecutionSelection } from "./task-contract.js";

export type DshSelection = Pick<ExecutionSelection, "providerId" | "modelId" | "reasoningEffort">;
export interface DshSession extends DeepSeekSession { selectedModel: DshSelection | null }
export interface DshCatalog { models: Array<{ providerId: string; modelId: string; reasoningEfforts: string[]; credits: string | null }>; pricingVerified: boolean }
export interface DshTransport extends DeepSeekTransport {
  models(hostId: string): Promise<DshCatalog>;
  selectModel(input: DshSelection & { hostId: string; sessionId: string }): Promise<DshSession>;
  session(input: { hostId: string; sessionId: string }): Promise<DshSession>;
  prompt(input: { hostId: string; sessionId: string; requestId: string; text: string; expectedSelection?: DshSelection }): Promise<{ requestId: string; accepted: boolean; turnId?: string }>;
}
export class DshClient extends DeepSeekClient implements DshTransport {
  models(hostId: string) { return this.rpc<DshCatalog>("models", {}, hostId); }
  selectModel({ hostId, ...input }: DshSelection & { hostId: string; sessionId: string }) { return this.rpc<DshSession>("select_model", input, hostId); }
  override session({ hostId, ...input }: { hostId: string; sessionId: string }) { return this.rpc<DshSession>("session", input, hostId); }
  override prompt({ hostId, ...input }: Parameters<DshTransport["prompt"]>[0]) { return this.rpc<{ requestId: string; accepted: boolean; turnId?: string }>("prompt", input, hostId); }
}

/** Read-only CLI discovery. No BridgeStore.init(), lease renewal, native
 * session activation or credentials are involved. Missing and unreadable differ. */
export function discoverDshSessions(directory: string, sessionId?: string, registryFile = path.join(os.homedir(), ".dsh", "storages", "dsh-codex-workflow", "coord.sqlite")) {
  if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error("Use an existing absolute project directory");
  const canonical = (value: string) => {
    const resolved = fs.realpathSync.native(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const queriedDirectory = fs.realpathSync.native(directory);
  if (!fs.existsSync(registryFile)) return { queriedDirectory, registry: "missing" as const, reason: "registry_missing" as const, candidates: [] };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(registryFile, { readOnly: true });
    const rows = db.prepare("SELECT session_id,cwd FROM live_sessions WHERE lease_until>? ORDER BY session_id").all(Date.now());
    const candidates = rows.flatMap(row => {
      try { return typeof row.cwd === "string" && canonical(row.cwd) === canonical(directory) ? [{ sessionId: String(row.session_id), workspace: queriedDirectory }] : []; }
      catch { return []; }
    });
    const selected = sessionId ? candidates.find(candidate => candidate.sessionId === sessionId) : candidates.length === 1 ? candidates[0] : undefined;
    return { queriedDirectory, registry: "available" as const, reason: selected ? "matched" as const : sessionId ? "session_not_matched" as const : candidates.length ? "ambiguous" as const : "no_matching_live_session" as const, candidates, selected };
  } catch { return { queriedDirectory, registry: "unreadable" as const, reason: "registry_unreadable" as const, candidates: [] }; }
  finally { db?.close(); }
}
