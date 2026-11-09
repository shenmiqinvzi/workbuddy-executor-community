import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Three answers, not two (F-WORKER-2). "absent" is a negative finding backed by
 * a readable registry; "unverifiable" means the registry could not answer at
 * all (missing file, unreadable or corrupted database, failed query). Callers
 * may treat unverifiable as "not registered" only where the consequence is a
 * refusal; nothing may be created on the strength of it.
 */
export type DesktopSessionState = "registered" | "absent" | "unverifiable";

export interface DesktopSessionEvidence {
  registered: boolean;
  state: DesktopSessionState;
  isPlayground?: boolean;
  cwd?: string;
  reason?: string;
}

export function listDesktopSessions(configDir: string, limit = 20): Array<{sessionId: string; workspace?: string}> {
  let database: DatabaseSync | undefined;
  try {
    const filename = path.join(configDir, "workbuddy.db");
    if (!fs.existsSync(filename)) return [];
    database = new DatabaseSync(filename, { readOnly: true });
    return database.prepare("SELECT id, cwd FROM sessions WHERE deleted_at IS NULL ORDER BY rowid DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 100)).map((row) => ({ sessionId: String(row.id), workspace: typeof row.cwd === "string" ? row.cwd : undefined }));
  } catch { return []; }
  finally { database?.close(); }
}

/** Read native desktop registration; never create or repair WorkBuddy database rows. */
export function readDesktopSession(configDir: string, sessionId: string): DesktopSessionEvidence {
  const filename = path.join(configDir, "workbuddy.db");
  // A missing registry is not evidence of absence: the configured directory may
  // itself be wrong, and a session created there would be a second one.
  if (!fs.existsSync(filename)) return { registered: false, state: "unverifiable", reason: "WorkBuddy desktop history database was not found" };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    const row = database.prepare("SELECT cwd, is_playground, deleted_at FROM sessions WHERE id = ?").get(sessionId);
    if (!row || row.deleted_at !== null) return { registered: false, state: "absent", reason: "The session is not registered in WorkBuddy desktop history" };
    return { registered: true, state: "registered", isPlayground: Number(row.is_playground) === 1, cwd: typeof row.cwd === "string" ? row.cwd : undefined };
  } catch {
    return { registered: false, state: "unverifiable", reason: "WorkBuddy desktop history could not be verified; this version may use an incompatible schema" };
  } finally { database?.close(); }
}

export async function waitForDesktopSession(configDir: string, sessionId: string, timeoutMs = 5_000): Promise<DesktopSessionEvidence> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const evidence = readDesktopSession(configDir, sessionId);
    if (evidence.registered || Date.now() >= deadline) return evidence;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}
