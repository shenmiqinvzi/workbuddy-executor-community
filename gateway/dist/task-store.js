import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
        reviewed_at TEXT,
        revision TEXT
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
                revision: "TEXT", run_evidence_digest: "TEXT",
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
        // Persistent task events (T2): one logical event stream per task with a
        // monotonic eventId across attempts. source_ref carries the dedup key, so
        // replaying the same native event cannot allocate a second logical event.
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        attempt_id TEXT,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_ref TEXT,
        PRIMARY KEY (task_id, event_id),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS task_events_by_task ON task_events(task_id, event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS task_events_source_ref ON task_events(task_id, source_ref) WHERE source_ref IS NOT NULL;
    `);
    }
    close() { this.db.close(); }
    /**
     * Append one logical task event with a monotonic per-task eventId.
     *
     * When `sourceRef` is set and already stored for this task, the event is a
     * replay of something already recorded: nothing is inserted and the existing
     * event is returned (idempotent dedup, contract :150). Otherwise the eventId
     * is allocated as MAX(event_id)+1 for the task inside the current
     * transaction.
     */
    appendTaskEvent(event) {
        return this.transaction(() => this.appendTaskEventInTransaction(event));
    }
    /** Transaction-aware core of appendTaskEvent; caller must hold a transaction. */
    appendTaskEventInTransaction(event) {
        if (event.sourceRef) {
            const existing = this.db.prepare("SELECT * FROM task_events WHERE task_id = ? AND source_ref = ?").get(event.taskId, event.sourceRef);
            if (existing)
                return eventRowToEvent(existing);
        }
        if (event.eventId === undefined) {
            const row = this.db.prepare("SELECT COALESCE(MAX(event_id), 0) + 1 AS next FROM task_events WHERE task_id = ?").get(event.taskId);
            event.eventId = Number(row.next);
        }
        this.db.prepare(`INSERT INTO task_events (task_id, event_id, attempt_id, type, occurred_at, observed_at, actor, payload_json, source_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.taskId, event.eventId, event.attemptId ?? null, event.type, event.occurredAt, event.observedAt, event.actor, JSON.stringify(event.payload ?? {}), event.sourceRef ?? null);
        const stored = this.db.prepare("SELECT * FROM task_events WHERE task_id = ? AND event_id = ?").get(event.taskId, event.eventId);
        return eventRowToEvent(stored);
    }
    /**
     * Mirror per-attempt journal events into the persistent task event stream.
     *
     * Each journal event keeps its per-attempt sequence as the dedup key
     * (`attemptId:type:journal:seq`), so re-syncing the same native event never
     * produces a second logical event. Returns the events actually appended
     * (replays are omitted), in journal order.
     */
    mirrorJournalEvents(taskId, events, context) {
        // One immediate transaction for the whole batch: the existence probe and
        // the insert are serialized against other writers, so a concurrent mirror
        // of the same journal events cannot double-insert (the unique source_ref
        // index remains the last-resort guard).
        return this.transaction(() => {
            const appended = [];
            for (const event of events) {
                const nativeSeq = Number(event.seq);
                const sourceRef = `${context.attemptId}:${event.type}:journal:${nativeSeq}`;
                const existing = this.db.prepare("SELECT 1 AS one FROM task_events WHERE task_id = ? AND source_ref = ?").get(taskId, sourceRef);
                if (existing !== undefined)
                    continue; // replay of an already-mirrored native event
                const metadata = event.metadata ?? {};
                // Preserve the caller-visible content: journal metadata may carry text,
                // but native messages often carry content arrays (T2-R2). The per-event
                // contentText (resolved from THAT message) wins; the batch-level
                // context fallback exists only for callers that cannot resolve it, and
                // never re-attributes one message's text to another event.
                const text = typeof metadata.text === "string" && metadata.text.trim() ? metadata.text
                    : typeof event.contentText === "string" && event.contentText.trim() ? event.contentText
                        : context.contentText;
                appended.push(this.appendTaskEventInTransaction({
                    taskId, attemptId: context.attemptId, type: event.type,
                    occurredAt: event.createdAt, observedAt: context.observedAt ?? new Date().toISOString(),
                    actor: context.actor,
                    payload: { ...metadata, nativeEventSeq: nativeSeq, text: text ?? null },
                    sourceRef,
                }));
            }
            return appended;
        });
    }
    /**
     * Read the persistent event stream for a task, ascending by eventId.
     *
     * afterEventId is exclusive (0 = from the beginning); limit is bounded to
     * 200 per the events contract. Read-only: it writes nothing.
     *
     * nextEventId is the resumption cursor for THIS page (contract :27): the
     * last eventId actually returned, so a consumer paging with it can never
     * skip unread events. An empty page keeps the caller's afterEventId (the
     * stream simply has nothing more at that position), and an empty stream
     * yields 0. The stream-wide high-water mark is not a consumer cursor;
     * conflating the two silently skipped events between the last page and
     * the tail (T2-R6).
     */
    listTaskEvents(taskId, options = {}) {
        const after = Math.max(0, Math.floor(options.afterEventId ?? 0));
        const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 200);
        const rows = this.db.prepare(`SELECT * FROM task_events WHERE task_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?`)
            .all(taskId, after, limit);
        const events = rows.map(eventRowToEvent);
        // Resume from the last event this page actually delivered; a short or
        // empty page re-offers the caller's position.
        const last = events.length ? events[events.length - 1].eventId : after;
        return { events, nextEventId: last };
    }
    /** Whether the task has any persistent event with eventId > afterEventId. */
    hasTaskEventAfter(taskId, afterEventId) {
        const row = this.db.prepare("SELECT 1 AS one FROM task_events WHERE task_id = ? AND event_id > ? LIMIT 1").get(taskId, Math.max(0, Math.floor(afterEventId)));
        return row !== undefined;
    }
    createOrGet(task) {
        return this.transaction(() => {
            const existing = this.get(task.taskId);
            if (existing)
                return { task: existing, created: false };
            const now = task.createdAt ?? new Date().toISOString();
            // Every legitimate creation path must produce the initial revision and
            // task_received inside the same transaction (T2-R5); idempotent replays
            // (the row already exists) never rewrite either.
            const revision = task.revision ?? newRevisionToken();
            this.db.prepare(`INSERT INTO tasks (task_id, message_id, objective, workspace, state, created_at, updated_at, last_message_id, report_json, cancel_note,
        review_note, reviewed_at, constraints_json, acceptance_commands_json, session_id, runtime_source, attempt_id, attempt, last_event_seq, artifacts_json, evidence_json, blocking_reason, submission_hash, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(task.taskId, task.messageId, task.objective, task.workspace ?? null, task.state, now, now, task.lastMessageId ?? task.messageId, json(task.report), task.cancelNote ?? null, task.reviewNote ?? null, task.reviewedAt ?? null, json(task.constraints), json(task.acceptanceCommands), task.sessionId ?? null, task.runtimeSource ?? null, task.attemptId ?? null, task.attempt ?? null, task.lastEventSeq ?? null, json(task.artifacts), json(task.evidence), task.blockingReason ?? null, task.submissionHash ?? null, revision);
            const stored = this.get(task.taskId);
            this.saveAttempt(stored);
            this.appendTaskEventInTransaction({
                taskId: task.taskId, attemptId: null, type: "task_received",
                occurredAt: stored.updatedAt, observedAt: stored.updatedAt, actor: "codex",
                payload: { objective: stored.objective.length > 120 ? `${stored.objective.slice(0, 117)}...` : stored.objective, workspace: stored.workspace ?? null },
                sourceRef: null,
            });
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
            // Same T2-R5 invariant as createOrGet: the winning creator writes the
            // initial revision in the same transaction; conflicting/existing rows
            // are returned untouched.
            const revision = task.revision ?? newRevisionToken();
            const inserted = this.db.prepare(`INSERT INTO tasks (task_id, message_id, objective, workspace, state, created_at, updated_at, last_message_id, report_json, cancel_note,
        review_note, reviewed_at, constraints_json, acceptance_commands_json, session_id, runtime_source, attempt_id, attempt, last_event_seq, artifacts_json, evidence_json, blocking_reason, submission_hash, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO NOTHING`).run(task.taskId, task.messageId, objective, task.workspace ?? null, task.state, now, now, task.lastMessageId ?? task.messageId, json(task.report), task.cancelNote ?? null, task.reviewNote ?? null, task.reviewedAt ?? null, json(task.constraints), json(task.acceptanceCommands), task.sessionId ?? null, task.runtimeSource ?? null, task.attemptId ?? null, task.attempt ?? null, task.lastEventSeq ?? null, json(task.artifacts), json(task.evidence), task.blockingReason ?? null, task.submissionHash ?? null, revision);
            if (Number(inserted.changes) > 0) {
                const stored = this.get(task.taskId);
                this.saveAttempt(stored);
                this.appendTaskEventInTransaction({
                    taskId: task.taskId, attemptId: null, type: "task_received",
                    occurredAt: stored.updatedAt, observedAt: stored.updatedAt, actor: "codex",
                    payload: { objective: stored.objective.length > 120 ? `${stored.objective.slice(0, 117)}...` : stored.objective, workspace: stored.workspace ?? null },
                    sourceRef: null,
                });
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
            const attemptNumber = Math.max(current.attempt ?? 0, Number(history.last_attempt)) + 1;
            const updated = this.writeUpdate(current, {
                state: reservation.state ?? "queued", attemptId: reservation.attemptId, attempt: attemptNumber,
                messageId: reservation.messageId, lastMessageId: reservation.messageId,
                // Rework keeps the bound conversation; never silently discover another.
                sessionId: reservation.sessionId ?? current.sessionId ?? null,
                runtimeSource: reservation.runtimeSource ?? current.runtimeSource ?? null,
                acceptanceCommands: reservation.acceptanceCommands === undefined ? current.acceptanceCommands : [...new Set([...(current.acceptanceCommands ?? []), ...reservation.acceptanceCommands])],
                lastEventSeq: 0, artifacts: [], evidence: [], report: null,
                blockingReason: null, reviewNote: null, reviewedAt: null, cancelNote: null,
                // T2-R2: the new attempt's evidence starts empty. A previous round's
                // stop digest (stopped=true) must never suppress this round's
                // native_stop_confirmed.
                runEvidenceDigest: null,
            }, { suppressFactEvents: true });
            // The lifecycle event is written exactly once here (T2-R2): the
            // writeUpdate above resets per-attempt facts but must not also emit an
            // attempt_queued for the same reservation.
            this.appendTaskEventInTransaction({
                taskId, attemptId: reservation.attemptId,
                type: attemptNumber > 1 ? "rework_requested" : "attempt_queued",
                occurredAt: updated.updatedAt, observedAt: updated.updatedAt, actor: "codex",
                payload: { attempt: attemptNumber, attemptId: reservation.attemptId },
                sourceRef: null,
            });
            return updated;
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
    /**
     * Accept the reviewed attempt and close the task as one transaction
     * (T2-R4): the accepted state, review facts and the terminal task_closed
     * event commit together or not at all, so a crash between them can never
     * leave an accepted task without its closure event.
     */
    acceptAttempt(taskId, attemptId, patch, closedEvent, options = {}) {
        return this.transaction(() => {
            const current = this.get(taskId);
            if (!current)
                throw new Error(`Unknown task: ${taskId}`);
            if (current.attemptId !== attemptId)
                return { task: current, applied: false };
            if (options.expectedStates && !options.expectedStates.includes(current.state))
                return { task: current, applied: false };
            const task = this.writeUpdate(current, patch);
            this.appendTaskEventInTransaction({
                taskId, attemptId, type: closedEvent.type,
                occurredAt: closedEvent.occurredAt, observedAt: task.updatedAt, actor: closedEvent.actor,
                payload: closedEvent.payload, sourceRef: closedEvent.sourceRef,
            });
            return { task, applied: true };
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
    writeUpdate(current, patch, options = {}) {
        const merged = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: new Date().toISOString() };
        const before = taskFactSignature(current);
        const after = taskFactSignature(merged);
        const factChanged = before !== after;
        const revision = factChanged ? newRevisionToken() : merged.revision ?? null;
        this.db.prepare(`UPDATE tasks SET state = ?, message_id = ?, updated_at = ?, last_message_id = ?, report_json = ?, cancel_note = ?, review_note = ?, reviewed_at = ?,
      constraints_json = ?, acceptance_commands_json = ?, session_id = ?, runtime_source = ?, attempt_id = ?, attempt = ?, last_event_seq = ?, artifacts_json = ?, evidence_json = ?, blocking_reason = ?, revision = ?, run_evidence_digest = ? WHERE task_id = ?`).run(merged.state, merged.messageId, merged.updatedAt, merged.lastMessageId ?? null, json(merged.report), merged.cancelNote ?? null, merged.reviewNote ?? null, merged.reviewedAt ?? null, json(merged.constraints), json(merged.acceptanceCommands), merged.sessionId ?? null, merged.runtimeSource ?? null, merged.attemptId ?? null, merged.attempt ?? null, merged.lastEventSeq ?? null, json(merged.artifacts), json(merged.evidence), merged.blockingReason ?? null, revision, merged.runEvidenceDigest ?? null, current.taskId);
        const updated = this.get(current.taskId);
        if (factChanged && !options.suppressFactEvents) {
            // One event per changed fact (T2-R2): a single patch may legitimately
            // cross several lifecycle facts (e.g. a result message both claims the
            // session and delivers the report), so each fact transition is recorded
            // with its contract semantic instead of one best-guess type.
            for (const event of taskFactEvents(current, merged, patch, updated)) {
                this.appendTaskEventInTransaction({
                    taskId: current.taskId, attemptId: updated.attemptId ?? null,
                    type: event.type, occurredAt: updated.updatedAt, observedAt: updated.updatedAt,
                    actor: event.actor, payload: { patch: summarizeTaskPatch(patch), before, after }, sourceRef: null,
                });
            }
        }
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
function eventRowToEvent(row) {
    return {
        taskId: String(row.task_id), eventId: Number(row.event_id), attemptId: optionalText(row.attempt_id) ?? null,
        type: String(row.type), occurredAt: String(row.occurred_at), observedAt: String(row.observed_at),
        actor: String(row.actor), payload: parseJson(row.payload_json) ?? {},
        sourceRef: optionalText(row.source_ref) ?? null,
    };
}
/** Unguessable, non-time-derived revision token. */
function newRevisionToken() { return randomBytes(12).toString("base64url"); }
/**
 * Signature of the persisted facts that drive revision changes and fact
 * events: task-level state/identity plus attempt binding, report, review,
 * cancellation and blocking facts. Transient bookkeeping (lastMessageId,
 * lastEventSeq, updatedAt) is deliberately excluded so a pure sync poll does
 * not fabricate a fact change.
 *
 * T2-R1: the signature also covers the caller-facing acceptance conditions
 * (constraints, acceptanceCommands) — changing them changes what the operator
 * must verify — and the runEvidenceDigest of external run evidence (native
 * stop proof, report authentication), because that evidence changes the
 * view and the operator's next allowed action without touching a task row.
 */
function taskFactSignature(task) {
    return JSON.stringify([
        task.state, task.attemptId, task.attempt, task.sessionId ?? null, task.runtimeSource ?? null,
        task.messageId, json(task.report) ?? null, task.cancelNote ?? null, task.reviewNote ?? null,
        task.reviewedAt ?? null, json(task.artifacts) ?? null, json(task.evidence) ?? null, task.blockingReason ?? null,
        json(task.constraints) ?? null, json(task.acceptanceCommands) ?? null, task.runEvidenceDigest ?? null,
    ]);
}
/**
 * The semantic lifecycle events for one writeUpdate patch, derived from
 * per-fact before/after comparisons (T2-R2). Each changed fact maps to at
 * most one contract event; blocked→blocked rewrites and non-input blockers
 * do not fabricate input_requested.
 */
function taskFactEvents(before, after, patch, updated) {
    const events = [];
    // Native claim: the verified session/runtime binding changed. beginAttempt
    // resets these fields with suppressFactEvents, so reaching here means the
    // caller supplied a real native identity.
    if (patch.sessionId !== undefined && (before.sessionId ?? null) !== (after.sessionId ?? null) && after.sessionId) {
        events.push({ type: "native_claimed", actor: "workbuddy" });
    }
    else if (patch.runtimeSource !== undefined && (before.runtimeSource ?? null) !== (after.runtimeSource ?? null) && after.runtimeSource) {
        events.push({ type: "native_claimed", actor: "workbuddy" });
    }
    if (patch.report !== undefined && (before.report ?? null) !== (after.report ?? null)) {
        events.push({ type: "report_received", actor: "workbuddy" });
    }
    if (patch.cancelNote !== undefined && (before.cancelNote ?? null) !== (after.cancelNote ?? null)) {
        events.push({ type: "cancel_requested", actor: "codex" });
    }
    if (patch.reviewedAt !== undefined && (before.reviewedAt ?? null) !== (after.reviewedAt ?? null)) {
        events.push({ type: "review_recorded", actor: "codex" });
    }
    // Input requests: only an explicit worker input request (patch hint
    // inputRequested, set by the sync waiting_input / blockedReason paths) is
    // an input request. A blocked report without that hint is a worker failure
    // and keeps the plain state-change semantic (T2-R2); unblocking (reason
    // cleared) is input_resolved.
    if (patch.blockingReason !== undefined && (before.blockingReason ?? null) !== (after.blockingReason ?? null)) {
        if (patch.blockingReason !== null && patch.blockingReason !== undefined && patch.state === "blocked" && patch.inputRequested === true) {
            events.push({ type: "input_requested", actor: "workbuddy" });
        }
        else if (patch.blockingReason === null && before.blockingReason && before.state === "blocked") {
            events.push({ type: "input_resolved", actor: "gateway" });
        }
    }
    if (patch.state !== undefined && before.state !== after.state) {
        events.push({ type: "task_state_changed", actor: "gateway" });
    }
    return events.length ? events : [{ type: "task_updated", actor: "gateway" }];
}
/** Compact, bounded patch summary for event payloads. */
function summarizeTaskPatch(patch) {
    const summary = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            continue;
        if (value === null)
            summary[key] = null;
        else if (key === "report")
            summary[key] = { status: value.status ?? null, rawTextLength: value.rawText?.length ?? 0 };
        else if (Array.isArray(value))
            summary[key] = value.length;
        else if (typeof value === "string" && value.length > 120)
            summary[key] = `${value.slice(0, 117)}...`;
        else
            summary[key] = value;
    }
    return summary;
}
export function rowToTask(row) {
    return {
        taskId: String(row.task_id), messageId: String(row.message_id), objective: String(row.objective), workspace: optionalText(row.workspace), submissionHash: optionalText(row.submission_hash),
        state: String(row.state), createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastMessageId: optionalText(row.last_message_id),
        report: parseJson(row.report_json), cancelNote: optionalText(row.cancel_note), reviewNote: optionalText(row.review_note), reviewedAt: optionalText(row.reviewed_at),
        constraints: parseJson(row.constraints_json), acceptanceCommands: parseJson(row.acceptance_commands_json),
        sessionId: optionalText(row.session_id), runtimeSource: optionalText(row.runtime_source), attemptId: optionalText(row.attempt_id), attempt: optionalNumber(row.attempt),
        lastEventSeq: optionalNumber(row.last_event_seq), artifacts: parseJson(row.artifacts_json), evidence: parseJson(row.evidence_json), blockingReason: optionalText(row.blocking_reason),
        revision: optionalText(row.revision), runEvidenceDigest: optionalText(row.run_evidence_digest),
    };
}
//# sourceMappingURL=task-store.js.map