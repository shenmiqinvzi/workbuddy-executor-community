import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value) => /^[a-f0-9-]{36}$/.test(value);
/** Durable, task-bound desktop receipts. A claimed request is never reclaimed. */
export class DesktopControlJournal {
    file;
    constructor(file) {
        this.file = file;
        if (!path.isAbsolute(file))
            throw Error("Absolute desktop state path required.");
    }
    open(write) {
        if (!write && !fs.existsSync(this.file))
            return null;
        if (write)
            fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        let current = path.parse(this.file).root;
        for (const part of this.file.slice(current.length).split(path.sep)) {
            current = path.join(current, part);
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
                throw Error("Linked desktop state is not supported.");
        }
        const db = new DatabaseSync(this.file, { readOnly: !write });
        db.exec("PRAGMA busy_timeout=3000");
        if (write) {
            if (process.platform !== "win32")
                fs.chmodSync(this.file, 0o600);
            db.exec(`CREATE TABLE IF NOT EXISTS desktop_control_requests (
        request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL,
        digest TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
        code TEXT, message TEXT, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS desktop_control_active_attempt
        ON desktop_control_requests(task_id, attempt_id, kind) WHERE state <> 'rejected' AND kind <> 'review';
        CREATE UNIQUE INDEX IF NOT EXISTS desktop_control_review_revision
        ON desktop_control_requests(task_id, attempt_id, kind, revision) WHERE state <> 'rejected' AND kind = 'review';
        CREATE UNIQUE INDEX IF NOT EXISTS desktop_control_review_unresolved
        ON desktop_control_requests(task_id, attempt_id, kind) WHERE kind = 'review' AND state IN ('requested','started','outcome_unknown')`);
        }
        return db;
    }
    parse(row) {
        const draft = JSON.parse(String(row.body));
        if (digest(draft) !== row.digest || draft.requestId !== row.request_id || draft.operationId !== row.operation_id || draft.taskId !== row.task_id || draft.attemptId !== row.attempt_id || draft.revision !== row.revision || draft.kind !== row.kind || !["requested", "started", "succeeded", "rejected", "outcome_unknown"].includes(String(row.state)))
            throw Error("Desktop control receipt integrity failed.");
        const receipt = { requestId: draft.requestId, operationId: draft.operationId, taskId: draft.taskId, attemptId: draft.attemptId, revision: draft.revision, kind: draft.kind, state: String(row.state) };
        if (row.code) {
            receipt.code = String(row.code);
            receipt.message = String(row.message ?? "");
        }
        return { draft, receipt };
    }
    enqueue(draft) {
        if (!id(draft.requestId) || !draft.operationId || draft.operationId.length > 512 || !draft.taskId || !draft.attemptId || !draft.revision || !Number.isFinite(Date.parse(draft.expiresAt)) || !["cancel", "rework", "review", "accept"].includes(draft.kind))
            throw Error("Invalid desktop control identity.");
        const db = this.open(true);
        try {
            db.prepare("INSERT OR IGNORE INTO desktop_control_requests VALUES(?,?,?,?,?,?,?,?,'requested',NULL,NULL,?)").run(draft.requestId, draft.operationId, draft.taskId, draft.attemptId, draft.revision, draft.kind, digest(draft), JSON.stringify(draft), new Date().toISOString());
            const row = db.prepare("SELECT * FROM desktop_control_requests WHERE request_id=?").get(draft.requestId);
            if (!row)
                throw Object.assign(new Error("An original control request already exists for this task and attempt."), { code: "CONTROL_ALREADY_EXISTS" });
            const saved = this.parse(row);
            if (digest(saved.draft) !== digest(draft))
                throw Object.assign(new Error("Desktop control identity conflict."), { code: "CONTROL_CONFLICT" });
            return saved.receipt;
        }
        finally {
            db.close();
        }
    }
    claim(requestId) {
        if (!id(requestId))
            return null;
        const db = this.open(true);
        try {
            db.exec("BEGIN IMMEDIATE");
            const row = db.prepare("SELECT * FROM desktop_control_requests WHERE request_id=? AND state='requested'").get(requestId);
            if (!row) {
                db.exec("ROLLBACK");
                return null;
            }
            const { draft } = this.parse(row);
            db.prepare("UPDATE desktop_control_requests SET state='started',updated_at=? WHERE request_id=? AND state='requested'").run(new Date().toISOString(), requestId);
            db.exec("COMMIT");
            return draft;
        }
        catch (error) {
            try {
                db.exec("ROLLBACK");
            }
            catch { }
            throw error;
        }
        finally {
            db.close();
        }
    }
    finish(requestId, state, code, message) {
        const db = this.open(true);
        try {
            db.prepare("UPDATE desktop_control_requests SET state=?,code=?,message=?,updated_at=? WHERE request_id=? AND state='started'").run(state, code ?? null, message ?? null, new Date().toISOString(), requestId);
        }
        finally {
            db.close();
        }
    }
    receipt(requestId) {
        if (!id(requestId))
            return null;
        const db = this.open(false);
        if (!db)
            return null;
        try {
            const row = db.prepare("SELECT * FROM desktop_control_requests WHERE request_id=?").get(requestId);
            return row ? this.parse(row).receipt : null;
        }
        finally {
            db.close();
        }
    }
    forAttempt(taskId, attemptId) {
        const db = this.open(false);
        if (!db)
            return [];
        try {
            return db.prepare("SELECT * FROM desktop_control_requests WHERE task_id=? AND attempt_id=? ORDER BY rowid DESC").all(taskId, attemptId).map(row => this.parse(row).receipt);
        }
        finally {
            db.close();
        }
    }
}
//# sourceMappingURL=desktop-control-journal.js.map