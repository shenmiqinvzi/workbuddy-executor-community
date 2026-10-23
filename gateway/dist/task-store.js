import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { persistedTaskContract, validateTaskContract, verifyPersistedContract } from "./task-contract.js";
export class TaskStore {
    file;
    db;
    constructor(file) {
        this.file = file;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(file);
        // Preserve existing parent-folder permissions; the database itself holds
        // private task prompts and must be owner-only, including after migration.
        // Windows uses inherited NTFS ACLs. POSIX chmod there changes DOS file
        // attributes and can fail even when this database is readable/writable.
        // Opening a status client must never change an existing Windows ACL.
        if (process.platform !== "win32")
            fs.chmodSync(file, 0o600);
        this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        workspace TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_id TEXT,
        report_json TEXT,
        cancel_note TEXT,
        review_note TEXT,
        reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        msg_type TEXT,
        created_at TEXT,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (task_id, attempt_id, message_id),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS task_attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS task_attempts_by_task ON task_attempts(task_id, attempt);
      CREATE TABLE IF NOT EXISTS task_contracts (
        task_id TEXT PRIMARY KEY,
        agreement_version TEXT NOT NULL,
        contract_hash TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        requested_max_attempts INTEGER NOT NULL,
        policy_max_attempts INTEGER NOT NULL,
        effective_max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
    `);
        // Preserve old task history; extend pre-review-loop databases in place.
        this.transaction(() => {
            const columns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
            for (const [name, type] of Object.entries({
                review_note: "TEXT", reviewed_at: "TEXT", constraints_json: "TEXT", acceptance_commands_json: "TEXT",
                session_id: "TEXT", runtime_source: "TEXT", attempt_id: "TEXT", attempt: "INTEGER", last_event_seq: "INTEGER",
                artifacts_json: "TEXT", evidence_json: "TEXT", blocking_reason: "TEXT", submission_hash: "TEXT",
            })) {
                if (!columns.has(name))
                    this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
            }
            const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all();
            if (!messageColumns.some((column) => column.name === "attempt_id")) {
                this.db.exec(`
          ALTER TABLE messages RENAME TO legacy_messages;
          CREATE TABLE messages (
            task_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL DEFAULT '',
            message_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            msg_type TEXT,
            created_at TEXT,
            raw_json TEXT NOT NULL,
            PRIMARY KEY(task_id, attempt_id, message_id),
            FOREIGN KEY(task_id) REFERENCES tasks(task_id)
          );
          INSERT INTO messages (task_id, message_id, role, content_json, msg_type, created_at, raw_json)
            SELECT task_id, message_id, role, content_json, msg_type, created_at, raw_json FROM legacy_messages ORDER BY rowid;
          DROP TABLE legacy_messages;
        `);
            }
        });
    }
    close() { this.db.close(); }
    createOrGet(task) {
        return this.transaction(() => {
            const existing = this.get(task.taskId);
            if (existing)
                return { task: existing, created: false };
            const now = task.createdAt ?? new Date().toISOString();
            this.db.prepare(`INSERT INTO tasks (task_id, message_id, objective, workspace, state, created_at, updated_at, last_message_id, report_json, cancel_note,
        review_note, reviewed_at, constraints_json, acceptance_commands_json, session_id, runtime_source, attempt_id, attempt, last_event_seq, artifacts_json, evidence_json, blocking_reason, submission_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(task.taskId, task.messageId, task.objective, task.workspace ?? null, task.state, now, now, task.lastMessageId ?? task.messageId, json(task.report), task.cancelNote ?? null, task.reviewNote ?? null, task.reviewedAt ?? null, json(task.constraints), json(task.acceptanceCommands), task.sessionId ?? null, task.runtimeSource ?? null, task.attemptId ?? null, task.attempt ?? null, task.lastEventSeq ?? null, json(task.artifacts), json(task.evidence), task.blockingReason ?? null, task.submissionHash ?? null);
            const stored = this.get(task.taskId);
            this.saveAttempt(stored);
            return { task: stored, created: true };
        });
    }
    get(taskId) {
        const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        return row ? rowToTask(row) : undefined;
    }
    /**
     * Read the stored contract for a task.
     *
     * A plain read: it initializes nothing, migrates nothing, repairs nothing and
     * never backfills a contract for a task that has none. A row that parses but
     * no longer verifies is reported as an integrity failure, which is not the
     * same answer as "this task has no contract".
     */
    getContract(taskId) {
        const row = this.db.prepare("SELECT * FROM task_contracts WHERE task_id = ?").get(taskId);
        if (!row)
            return { state: "absent" };
        let parsed;
        try {
            parsed = JSON.parse(String(row.contract_json));
        }
        catch {
            return { state: "integrity_failure", integrity: { problem: "shape", detail: "the stored contract is not valid JSON" } };
        }
        const verified = verifyPersistedContract({
            taskId: String(row.task_id),
            agreementVersion: String(row.agreement_version),
            contractHash: String(row.contract_hash),
            schemaVersion: String(row.schema_version),
            contract: parsed,
            requestedMaxAttempts: Number(row.requested_max_attempts),
            policyMaxAttempts: Number(row.policy_max_attempts),
            effectiveMaxAttempts: Number(row.effective_max_attempts),
            createdAt: String(row.created_at),
        });
        if (!verified.ok)
            return { state: "integrity_failure", integrity: verified.integrity };
        return { state: "found", record: verified.record };
    }
    /**
     * Create a task and its initial contract as one unit.
     *
     * The submitted contract is validated and normalized here, and the digest is
     * computed from that normalized content, so a caller cannot pass a digest
     * that does not describe what is being stored. Idempotency is then decided by
     * comparing computed digests, never by a caller-supplied value.
     *
     * The task row, the attempt snapshot and the contract are written inside a
     * single transaction, so a failure leaves neither half behind. Idempotency is
     * decided by the primary key rather than by a prior read: the insert either
     * wins or conflicts, and only the winner writes a contract. Two connections
     * racing on one task id therefore cannot both create it, and no nested
     * transaction is needed.
     */
    createTaskWithContract(task, submitted, policy) {
        // Validation happens before the transaction opens, so a rejected contract
        // cannot leave a partial write behind.
        const validated = validateTaskContract(submitted);
        if (!validated.ok)
            return { status: "rejected", rejection: validated.rejection };
        const contract = validated.contract;
        const contractHash = validated.contractHash;
        if (contract.taskId !== task.taskId) {
            return { status: "rejected", rejection: { code: "task_mismatch", field: "taskId", message: "The contract belongs to another task." } };
        }
        // The objective is one fact recorded in two places; it may be omitted (it is
        // then derived from the contract) but it may not contradict it.
        if (task.objective !== undefined && task.objective !== contract.objective) {
            return { status: "rejected", rejection: { code: "objective_mismatch", field: "objective", message: "The task objective and the contract objective must be the same fact." } };
        }
        const objective = contract.objective;
        return this.transaction(() => {
            const now = task.createdAt ?? new Date().toISOString();
            const inserted = this.db.prepare(`INSERT INTO tasks (task_id, message_id, objective, workspace, state, created_at, updated_at, last_message_id, report_json, cancel_note,
        review_note, reviewed_at, constraints_json, acceptance_commands_json, session_id, runtime_source, attempt_id, attempt, last_event_seq, artifacts_json, evidence_json, blocking_reason, submission_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO NOTHING`).run(task.taskId, task.messageId, objective, task.workspace ?? null, task.state, now, now, task.lastMessageId ?? task.messageId, json(task.report), task.cancelNote ?? null, task.reviewNote ?? null, task.reviewedAt ?? null, json(task.constraints), json(task.acceptanceCommands), task.sessionId ?? null, task.runtimeSource ?? null, task.attemptId ?? null, task.attempt ?? null, task.lastEventSeq ?? null, json(task.artifacts), json(task.evidence), task.blockingReason ?? null, task.submissionHash ?? null);
            if (Number(inserted.changes) > 0) {
                const stored = this.get(task.taskId);
                this.saveAttempt(stored);
                const record = persistedTaskContract(contract, contractHash, now, policy);
                this.db.prepare(`INSERT INTO task_contracts (task_id, agreement_version, contract_hash, schema_version, contract_json,
          requested_max_attempts, policy_max_attempts, effective_max_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.taskId, record.agreementVersion, record.contractHash, record.schemaVersion, JSON.stringify(record.contract), record.requestedMaxAttempts, record.policyMaxAttempts, record.effectiveMaxAttempts, record.createdAt);
                const written = this.getContract(task.taskId);
                if (written.state !== "found")
                    throw new Error("The contract just written did not verify");
                return { status: "created", task: stored, record: written.record };
            }
            const existing = this.get(task.taskId);
            const read = this.getContract(task.taskId);
            if (read.state === "absent")
                return { status: "task_without_contract", task: existing };
            // A stored contract that no longer verifies must not be compared by its
            // recorded digest and then reported as "the same terms".
            if (read.state === "integrity_failure") {
                return { status: "rejected", rejection: { code: "invalid_value", field: "contractHash", message: `The stored contract failed integrity: ${read.integrity.problem}.` } };
            }
            if (read.record.contractHash !== contractHash)
                return { status: "conflict", task: existing, record: read.record };
            return { status: "existing_same", task: existing, record: read.record };
        });
    }
    listTasks(options = {}) {
        const states = options.states ?? (options.state ? [options.state] : []);
        const rows = this.db.prepare(`SELECT * FROM tasks ${states.length ? `WHERE state IN (${states.map(() => "?").join(",")})` : ""}
      ORDER BY updated_at DESC, task_id ASC LIMIT ? OFFSET ?`).all(...states, boundedLimit(options.limit ?? 100), Math.max(0, Math.floor(options.offset ?? 0)));
        return rows.map(rowToTask);
    }
    /**
     * Stage read path for the stable list contract: `created_at` ascending with
     * `task_id` as the tiebreaker, bounded by a keyset cursor instead of an
     * offset, so concurrent updates cannot shift rows between pages.
     *
     * This deliberately does not replace listTasks: the existing MCP list keeps
     * its updated_at DESC + offset behaviour unchanged, and callers must not
     * silently switch between the two orders. createdAt is compared as stored
     * text; every writer in this build stores Date.toISOString() values, so the
     * byte order is the chronological order.
     *
     * Read-only: it writes nothing, never repairs stored timestamps and never
     * touches the filesystem.
     */
    listTasksByCreatedCursor(options) {
        const bounded = Math.min(Math.max(Math.floor(options.limit), 1), 500);
        if (options.afterTaskId === undefined) {
            const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC, task_id ASC LIMIT ?").all(bounded);
            return { tasks: rows.map(rowToTask), anchorFound: true };
        }
        const anchor = this.db.prepare("SELECT created_at FROM tasks WHERE task_id = ?").get(options.afterTaskId);
        if (!anchor)
            return { tasks: [], anchorFound: false };
        const rows = this.db.prepare(`SELECT * FROM tasks WHERE created_at > ? OR (created_at = ? AND task_id > ?)
      ORDER BY created_at ASC, task_id ASC LIMIT ?`).all(anchor.created_at, anchor.created_at, options.afterTaskId, bounded);
        return { tasks: rows.map(rowToTask), anchorFound: true };
    }
    /**
     * Whether at least one task sorts strictly after the cursor row.
     *
     * The read is one indexed lookup, so the list entry can promise "there is
     * another page" only when one really exists; a full final page then ends
     * with nextAfterTaskId null instead of a cursor the client must try once
     * and learn was empty.
     */
    hasTaskAfterCursor(afterTaskId) {
        const anchor = this.db.prepare("SELECT created_at FROM tasks WHERE task_id = ?").get(afterTaskId);
        if (!anchor)
            return false;
        const row = this.db.prepare(`SELECT 1 AS one FROM tasks WHERE created_at > ? OR (created_at = ? AND task_id > ?) LIMIT 1`)
            .get(anchor.created_at, anchor.created_at, afterTaskId);
        return row !== undefined;
    }
    /** Reserve before spawning a worker, atomically across MCP processes. */
    beginAttempt(taskId, reservation) {
        if (!reservation.attemptId || !reservation.messageId)
            throw new Error("Attempt and message identity are required");
        return this.transaction(() => {
            const current = this.get(taskId);
            if (!current)
                throw new Error(`Unknown task: ${taskId}`);
            if (current.state === "working" || (current.state === "queued" && current.attemptId)) {
                throw new Error(`Task ${taskId} already has an active attempt`);
            }
            if (this.db.prepare("SELECT attempt_id FROM task_attempts WHERE attempt_id = ?").get(reservation.attemptId)) {
                throw new Error(`Attempt identity already exists: ${reservation.attemptId}`);
            }
            const history = this.db.prepare("SELECT COALESCE(MAX(attempt), 0) AS last_attempt FROM task_attempts WHERE task_id = ?").get(taskId);
            return this.writeUpdate(current, {
                state: reservation.state ?? "queued", attemptId: reservation.attemptId, attempt: Math.max(current.attempt ?? 0, Number(history.last_attempt)) + 1,
                messageId: reservation.messageId, lastMessageId: reservation.messageId,
                // Rework keeps the bound conversation; never silently discover another.
                sessionId: reservation.sessionId ?? current.sessionId ?? null,
                runtimeSource: reservation.runtimeSource ?? current.runtimeSource ?? null,
                acceptanceCommands: reservation.acceptanceCommands === undefined ? current.acceptanceCommands : [...new Set([...(current.acceptanceCommands ?? []), ...reservation.acceptanceCommands])],
                lastEventSeq: 0, artifacts: [], evidence: [], report: null,
                blockingReason: null, reviewNote: null, reviewedAt: null, cancelNote: null,
            });
        });
    }
    update(taskId, patch) {
        return this.transaction(() => {
            const current = this.get(taskId);
            if (!current)
                throw new Error(`Unknown task: ${taskId}`);
            return this.writeUpdate(current, patch);
        });
    }
    /** A late old worker cannot overwrite a newer rework attempt. */
    updateAttempt(taskId, attemptId, patch, options = {}) {
        return this.transaction(() => {
            const current = this.get(taskId);
            if (!current)
                throw new Error(`Unknown task: ${taskId}`);
            if (current.attemptId !== attemptId)
                return { task: current, applied: false };
            if (options.expectedStates && !options.expectedStates.includes(current.state))
                return { task: current, applied: false };
            if (options.preserveTerminal !== false && (current.state === "accepted" || current.state === "cancelled") && patch.state !== undefined && patch.state !== current.state) {
                return { task: current, applied: false };
            }
            if (patch.lastEventSeq != null && patch.lastEventSeq < (current.lastEventSeq ?? 0))
                return { task: current, applied: false };
            return { task: this.writeUpdate(current, patch), applied: true };
        });
    }
    listAttempts(taskId) {
        const rows = this.db.prepare("SELECT snapshot_json FROM task_attempts WHERE task_id = ? ORDER BY attempt ASC").all(taskId);
        return rows.map((row) => JSON.parse(row.snapshot_json));
    }
    addMessages(taskId, messages) {
        const current = this.get(taskId);
        if (!current)
            throw new Error(`Unknown task: ${taskId}`);
        const statement = this.db.prepare(`INSERT OR IGNORE INTO messages (task_id, attempt_id, message_id, role, content_json, msg_type, created_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        return this.transaction(() => {
            let inserted = 0;
            for (const message of messages) {
                const attemptId = typeof message.metadata?.attemptId === "string" ? message.metadata.attemptId : current.attemptId ?? "";
                const result = statement.run(taskId, attemptId, message.message_id, message.role, JSON.stringify(message.content ?? []), message.msg_type ?? null, message.created_at ?? null, JSON.stringify(message));
                if (Number(result.changes) > 0)
                    inserted += 1;
            }
            return inserted;
        });
    }
    /** Read recent events for the current attempt, with history explicitly selectable. */
    listMessages(taskId, limit = 100, attemptId) {
        const selectedAttempt = attemptId ?? this.get(taskId)?.attemptId ?? "";
        const rows = this.db.prepare(`SELECT raw_json FROM (
      SELECT rowid AS message_order, raw_json FROM messages WHERE task_id = ? AND attempt_id = ? ORDER BY rowid DESC LIMIT ?
    ) ORDER BY message_order ASC`).all(taskId, selectedAttempt, boundedLimit(limit));
        return rows.map((row) => JSON.parse(row.raw_json));
    }
    writeUpdate(current, patch) {
        const merged = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: new Date().toISOString() };
        this.db.prepare(`UPDATE tasks SET state = ?, message_id = ?, updated_at = ?, last_message_id = ?, report_json = ?, cancel_note = ?, review_note = ?, reviewed_at = ?,
      constraints_json = ?, acceptance_commands_json = ?, session_id = ?, runtime_source = ?, attempt_id = ?, attempt = ?, last_event_seq = ?, artifacts_json = ?, evidence_json = ?, blocking_reason = ? WHERE task_id = ?`).run(merged.state, merged.messageId, merged.updatedAt, merged.lastMessageId ?? null, json(merged.report), merged.cancelNote ?? null, merged.reviewNote ?? null, merged.reviewedAt ?? null, json(merged.constraints), json(merged.acceptanceCommands), merged.sessionId ?? null, merged.runtimeSource ?? null, merged.attemptId ?? null, merged.attempt ?? null, merged.lastEventSeq ?? null, json(merged.artifacts), json(merged.evidence), merged.blockingReason ?? null, current.taskId);
        const updated = this.get(current.taskId);
        this.saveAttempt(updated);
        return updated;
    }
    saveAttempt(task) {
        if (!task.attemptId)
            return;
        const prior = this.db.prepare("SELECT snapshot_json FROM task_attempts WHERE attempt_id = ?").get(task.attemptId);
        const priorAttempt = prior ? JSON.parse(prior.snapshot_json) : undefined;
        if (priorAttempt && priorAttempt.taskId !== task.taskId)
            throw new Error("Attempt identity belongs to another task");
        const snapshot = {
            taskId: task.taskId, attemptId: task.attemptId, attempt: task.attempt ?? 1, messageId: task.messageId,
            sessionId: task.sessionId, runtimeSource: task.runtimeSource, state: task.state, lastEventSeq: task.lastEventSeq ?? 0,
            artifacts: task.artifacts ?? [], evidence: task.evidence ?? [], report: task.report,
            blockingReason: task.blockingReason, reviewNote: task.reviewNote, reviewedAt: task.reviewedAt, cancelNote: task.cancelNote,
            createdAt: priorAttempt?.createdAt ?? task.updatedAt, updatedAt: task.updatedAt,
        };
        this.db.prepare(`INSERT INTO task_attempts (attempt_id, task_id, attempt, snapshot_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`).run(task.attemptId, task.taskId, snapshot.attempt, JSON.stringify(snapshot));
    }
    transaction(operation) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
}
function json(value) { return value == null ? null : JSON.stringify(value); }
function boundedLimit(value) { return Math.min(Math.max(Math.floor(value), 1), 500); }
function optionalText(value) { return value == null ? undefined : String(value); }
function optionalNumber(value) { return value == null ? undefined : Number(value); }
function parseJson(value) { return value == null ? undefined : JSON.parse(String(value)); }
export function rowToTask(row) {
    return {
        taskId: String(row.task_id), messageId: String(row.message_id), objective: String(row.objective), workspace: optionalText(row.workspace), submissionHash: optionalText(row.submission_hash),
        state: String(row.state), createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastMessageId: optionalText(row.last_message_id),
        report: parseJson(row.report_json), cancelNote: optionalText(row.cancel_note), reviewNote: optionalText(row.review_note), reviewedAt: optionalText(row.reviewed_at),
        constraints: parseJson(row.constraints_json), acceptanceCommands: parseJson(row.acceptance_commands_json),
        sessionId: optionalText(row.session_id), runtimeSource: optionalText(row.runtime_source), attemptId: optionalText(row.attempt_id), attempt: optionalNumber(row.attempt),
        lastEventSeq: optionalNumber(row.last_event_seq), artifacts: parseJson(row.artifacts_json), evidence: parseJson(row.evidence_json), blockingReason: optionalText(row.blocking_reason),
    };
}
//# sourceMappingURL=task-store.js.map