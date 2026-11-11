import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sqliteBusyTimeoutMs } from "./sqlite-busy.js";
import type { DesktopDraft, DesktopReceipt } from "./desktop-dispatch.js";

const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
export class DesktopDispatchJournal {
  constructor(readonly file: string) { if (!path.isAbsolute(file)) throw Error("Absolute desktop state path required."); }
  private open(write: boolean): DatabaseSync | null {
    if (!write && !fs.existsSync(this.file)) return null;
    if (write) fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let current = path.parse(this.file).root;
    for (const part of this.file.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error("Linked desktop state is not supported.");
    }
    const db = new DatabaseSync(this.file, { readOnly: !write });
    if (write) {
      if (process.platform !== "win32") fs.chmodSync(this.file, 0o600);
      db.exec(`PRAGMA busy_timeout=${sqliteBusyTimeoutMs()}; CREATE TABLE IF NOT EXISTS desktop_dispatch_requests (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, code TEXT, message TEXT, updated_at TEXT NOT NULL, owner_pid INTEGER, owner_started_at TEXT, claimed_at TEXT, heartbeat_at TEXT)`);
      /** A lease is additive evidence: older rows keep their row identity and
       * simply read as "no lease record" until a worker claims them again. */
      const columns = new Set((db.prepare("PRAGMA table_info(desktop_dispatch_requests)").all() as Array<Record<string, unknown>>).map(row => String(row.name)));
      for (const column of ["owner_pid", "owner_started_at", "claimed_at", "heartbeat_at"]) {
        if (!columns.has(column)) db.exec(`ALTER TABLE desktop_dispatch_requests ADD COLUMN ${column} ${column === "owner_pid" ? "INTEGER" : "TEXT"}`);
      }
    }
    return db;
  }
  enqueue(draft: DesktopDraft): DesktopReceipt {
    if (!validId(draft.draftId)) throw Error("Invalid desktop request identity.");
    const db = this.open(true)!;
    try {
      db.prepare("INSERT INTO desktop_dispatch_requests (request_id,task_id,operation_id,digest,body,state,code,message,updated_at) VALUES(?,?,?,?,?,'launch_requested',NULL,NULL,?) ON CONFLICT(request_id) DO NOTHING")
        .run(draft.draftId, draft.taskId, draft.operationId, digest(draft), JSON.stringify(draft), new Date().toISOString());
      const row = db.prepare("SELECT digest FROM desktop_dispatch_requests WHERE request_id=?").get(draft.draftId);
      if (row?.digest !== digest(draft)) throw Error("Desktop request identity conflict.");
    } finally { db.close(); }
    return this.receipt(draft.draftId)!;
  }
  claim(requestId: string, owner?: { pid: number; startedAt: string } | null): DesktopDraft | null {
    if (!validId(requestId)) return null;
    const db = this.open(true)!;
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT * FROM desktop_dispatch_requests WHERE request_id=? AND state='launch_requested'").get(requestId);
      if (!row) { db.exec("ROLLBACK"); return null; }
      const draft = JSON.parse(String(row.body)) as DesktopDraft;
      if (digest(draft) !== row.digest || draft.draftId !== requestId || draft.taskId !== row.task_id || draft.operationId !== row.operation_id) throw Error("Desktop request integrity failed.");
      const now = new Date().toISOString();
      db.prepare("UPDATE desktop_dispatch_requests SET state='dispatching',updated_at=?,claimed_at=?,heartbeat_at=?,owner_pid=?,owner_started_at=? WHERE request_id=?")
        .run(now,now,now,owner?.pid ?? null,owner?.startedAt ?? null,requestId);
      db.exec("COMMIT"); return draft;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    finally { db.close(); }
  }
  /** Only the exact owner may refresh a lease; a late heartbeat from a
   * superseded worker must never revive the row. */
  heartbeat(requestId: string, owner: { pid: number; startedAt: string }): boolean {
    if (!validId(requestId)) return false;
    const db = this.open(true)!;
    try {
      const result = db.prepare("UPDATE desktop_dispatch_requests SET heartbeat_at=? WHERE request_id=? AND state='dispatching' AND owner_pid=? AND owner_started_at=?")
        .run(new Date().toISOString(),requestId,owner.pid,owner.startedAt);
      return Number(result.changes) > 0;
    } finally { db.close(); }
  }
  lease(requestId: string): { state: string; ownerPid: number | null; ownerStartedAt: string | null; claimedAt: string | null; heartbeatAt: string | null } | null {
    if (!validId(requestId)) return null;
    const db = this.open(false); if (!db) return null;
    try {
      const row = db.prepare("SELECT * FROM desktop_dispatch_requests WHERE request_id=?").get(requestId); if (!row) return null;
      const text = (value: unknown) => value == null ? null : String(value);
      return { state: String(row.state), ownerPid: row.owner_pid == null ? null : Number(row.owner_pid), ownerStartedAt: text(row.owner_started_at), claimedAt: text(row.claimed_at), heartbeatAt: text(row.heartbeat_at) };
    } finally { db.close(); }
  }
  /** The read-side twin of lease(): one task owns at most one dispatch row
   * (task_id UNIQUE), so the newest row for the task is the dispatch lease
   * evidence. Read-only: a missing journal file returns null, never a write. */
  leaseByTask(taskId: string): { state: string; ownerPid: number | null; ownerStartedAt: string | null; claimedAt: string | null; heartbeatAt: string | null } | null {
    if (!taskId || taskId.length > 200) return null;
    const db = this.open(false); if (!db) return null;
    try {
      const row = db.prepare("SELECT * FROM desktop_dispatch_requests WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(taskId); if (!row) return null;
      const text = (value: unknown) => value == null ? null : String(value);
      return { state: String(row.state), ownerPid: row.owner_pid == null ? null : Number(row.owner_pid), ownerStartedAt: text(row.owner_started_at), claimedAt: text(row.claimed_at), heartbeatAt: text(row.heartbeat_at) };
    } finally { db.close(); }
  }
  finish(requestId: string, state: DesktopReceipt["state"], code?: string, message?: string) {
    const db = this.open(true)!;
    try { db.prepare("UPDATE desktop_dispatch_requests SET state=?,code=?,message=?,updated_at=? WHERE request_id=? AND state IN ('launch_requested','dispatching')").run(state,code??null,message??null,new Date().toISOString(),requestId); }
    finally { db.close(); }
  }
  receipt(requestId: string): DesktopReceipt | null {
    if (!validId(requestId)) return null;
    const db = this.open(false); if (!db) return null;
    try {
      const row = db.prepare("SELECT * FROM desktop_dispatch_requests WHERE request_id=?").get(requestId); if (!row) return null;
      const draft = JSON.parse(String(row.body)) as DesktopDraft;
      if (digest(draft) !== row.digest || draft.draftId !== requestId || draft.taskId !== row.task_id || draft.operationId !== row.operation_id) throw Error("Desktop receipt integrity failed.");
      return { requestId,taskId:String(row.task_id),operationId:String(row.operation_id),state:String(row.state) as DesktopReceipt["state"],...(row.code?{code:String(row.code),message:String(row.message)}:{}) };
    } finally { db.close(); }
  }
  request(requestId: string): DesktopDraft | null {
    if (!validId(requestId)) return null;
    const db = this.open(false); if (!db) return null;
    try {
      const row = db.prepare("SELECT * FROM desktop_dispatch_requests WHERE request_id=?").get(requestId); if (!row) return null;
      const draft = JSON.parse(String(row.body)) as DesktopDraft;
      if (digest(draft) !== row.digest || draft.draftId !== requestId || draft.taskId !== row.task_id || draft.operationId !== row.operation_id) throw Error("Desktop request integrity failed.");
      return draft;
    } finally { db.close(); }
  }
  latest(): DesktopReceipt | null {
    const db=this.open(false);if(!db)return null;
    let id:string|undefined;
    try { const row=db.prepare("SELECT request_id FROM desktop_dispatch_requests ORDER BY CASE WHEN state IN ('launch_requested','dispatching','outcome_unknown') THEN 0 ELSE 1 END,rowid DESC LIMIT 1").get();id=row?String(row.request_id):undefined; }
    finally {db.close();}
    return id?this.receipt(id):null;
  }
}
