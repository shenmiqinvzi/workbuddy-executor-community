import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DeepSeekClient } from "./deepseek-client.js";
export class DshClient extends DeepSeekClient {
    models(hostId) { return this.rpc("models", {}, hostId); }
    selectModel({ hostId, ...input }) { return this.rpc("select_model", input, hostId); }
    session({ hostId, ...input }) { return this.rpc("session", input, hostId); }
    prompt({ hostId, ...input }) { return this.rpc("prompt", input, hostId); }
}
/** Read-only CLI discovery. No BridgeStore.init(), lease renewal, native
 * session activation or credentials are involved. Missing and unreadable differ. */
export function discoverDshSessions(directory, sessionId, registryFile = path.join(os.homedir(), ".dsh", "storages", "dsh-codex-workflow", "coord.sqlite")) {
    if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory())
        throw new Error("Use an existing absolute project directory");
    const canonical = (value) => {
        const resolved = fs.realpathSync.native(value).replace(/[\\/]+$/, "");
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const queriedDirectory = fs.realpathSync.native(directory);
    if (!fs.existsSync(registryFile))
        return { queriedDirectory, registry: "missing", reason: "registry_missing", candidates: [] };
    let db;
    try {
        db = new DatabaseSync(registryFile, { readOnly: true });
        const rows = db.prepare("SELECT session_id,cwd FROM live_sessions WHERE lease_until>? ORDER BY session_id").all(Date.now());
        const candidates = rows.flatMap(row => {
            try {
                return typeof row.cwd === "string" && canonical(row.cwd) === canonical(directory) ? [{ sessionId: String(row.session_id), workspace: queriedDirectory }] : [];
            }
            catch {
                return [];
            }
        });
        const selected = sessionId ? candidates.find(candidate => candidate.sessionId === sessionId) : candidates.length === 1 ? candidates[0] : undefined;
        return { queriedDirectory, registry: "available", reason: selected ? "matched" : sessionId ? "session_not_matched" : candidates.length ? "ambiguous" : "no_matching_live_session", candidates, selected };
    }
    catch {
        return { queriedDirectory, registry: "unreadable", reason: "registry_unreadable", candidates: [] };
    }
    finally {
        db?.close();
    }
}
//# sourceMappingURL=dsh-client.js.map