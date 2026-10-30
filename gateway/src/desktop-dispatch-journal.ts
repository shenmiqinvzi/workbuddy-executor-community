import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
      db.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS desktop_dispatch_requests (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, code TEXT, message TEXT, updated_at TEXT NOT NULL)");
    }
    return db;
  }
  enqueue(draft: DesktopDraft): DesktopReceipt {
    if (!validId(draft.draftId)) throw Error("Invalid desktop request identity.");
    const db = this.open(true)!;
    try {
      db.prepare("INSERT INTO desktop_dispatch_requests VALUES(?,?,?,?,?,'launch_requested',NULL,NULL,?) ON CONFLICT(request_id) DO NOTHING")
        .run(draft.draftId, draft.taskId, draft.operationId, digest(draft), JSON.stringify(draft), new Date().toISOString());
      const row = db.prepare("SELECT digest FROM desktop_dispatch_requests WHERE request_id=?").get(draft.draftId);
      if (row?.digest !== digest(draft)) throw Error("Desktop request identity conflict.");
    } finally { db.close(); }
    return this.receipt(draft.draftId)!;
  }
  claim(requestId: string): DesktopDraft | null {
    if (!validId(requestId)) return null;
    const db = this.open(true)!;
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT * FROM desktop_dispatch_requests WHERE request_id=? AND state='launch_requested'").get(requestId);
      if (!row) { db.exec("ROLLBACK"); return null; }
      const draft = JSON.parse(String(row.body)) as DesktopDraft;
      if (digest(draft) !== row.digest || draft.draftId !== requestId || draft.taskId !== row.task_id || draft.operationId !== row.operation_id) throw Error("Desktop request integrity failed.");
      db.prepare("UPDATE desktop_dispatch_requests SET state='dispatching',updated_at=? WHERE request_id=?").run(new Date().toISOString(),requestId);
      db.exec("COMMIT"); return draft;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    finally { db.close(); }
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
