import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AdmissionError } from "./collaboration.js";
import { hasNativeStopEvidence } from "./run-journal.js";
function fail(code, message) { throw new AdmissionError(code, message); }
/** Read the saved run record for one attempt. A malformed or missing file is
 * `null`, never a guess: a declaration cannot rest on evidence that is absent. */
export function readRunSnapshot(runsDir, attemptId) {
    if (!attemptId || !/^run-[a-f0-9-]{36}$/.test(attemptId))
        return null;
    try {
        const file = path.join(runsDir, attemptId, "state.json");
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    }
    catch {
        return null;
    }
}
export class NativeStopDeclarations {
    db;
    store;
    constructor(db, store) {
        this.db = db;
        this.store = store;
        db.exec(`CREATE TABLE IF NOT EXISTS native_stop_declarations (
      declaration_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision TEXT NOT NULL,
      body_json TEXT NOT NULL, declared_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_id));`);
    }
    decode(row) {
        if (!row)
            return null;
        try {
            const value = JSON.parse(String(row.body_json));
            if (value.schemaVersion !== "native-stop-declaration/1" || value.declarationId !== row.declaration_id || value.taskId !== row.task_id
                || value.attemptId !== row.attempt_id || value.revision !== row.revision || value.declaredAt !== row.declared_at)
                throw Error();
            return value;
        }
        catch {
            return fail("CONTRACT_INTEGRITY", "A stored native-stop declaration is inconsistent; retain the original workflow.");
        }
    }
    get(taskId, attemptId) {
        return this.decode(this.db.prepare("SELECT * FROM native_stop_declarations WHERE task_id=? AND attempt_id=?").get(taskId, attemptId));
    }
    forTask(taskId) {
        return this.db.prepare("SELECT * FROM native_stop_declarations WHERE task_id=? ORDER BY declared_at").all(taskId).map(row => this.decode(row));
    }
    /** Record the assertion. It changes no task state, no capacity and no run
     * journal; only a later, separately authorized recovery uses it. */
    declare(input) {
        return this.store.atomic(() => {
            const statement = input.statement.trim();
            if (statement.length < 10 || statement.length > 2000)
                fail("DECLARATION_INVALID", "Write 10-2000 characters describing how you checked that native execution stopped.");
            if (!input.actor.trim() || input.actor.length > 200)
                fail("AUTHORIZATION_REQUIRED", "A local human actor is required.");
            const task = this.store.get(input.taskId) ?? fail("TASK_NOT_FOUND", "The task was not found.");
            if (task.attemptId !== input.attemptId)
                fail("STALE_ATTEMPT", "The task attempt changed; reload before declaring.");
            if (task.revision !== input.revision)
                fail("STALE_REVISION", "The task record changed; reload before declaring.");
            if (task.state === "accepted")
                fail("TASK_ACCEPTED", "An accepted task needs no stop declaration.");
            const snapshot = input.snapshot;
            if (!snapshot)
                fail("NO_RUN_EVIDENCE", "There is no saved run record for this attempt; nothing to declare against.");
            if (hasNativeStopEvidence(snapshot))
                fail("NATIVE_EVIDENCE_PRESENT", "The run record already proves the native stop; no declaration is needed or accepted.");
            if (["queued", "working"].includes(String(snapshot.status)))
                fail("STILL_RUNNING", "The saved run record says it is still active; check the executor first.");
            const prior = this.get(input.taskId, input.attemptId);
            if (prior) {
                if (prior.statement !== statement || prior.actor !== input.actor)
                    fail("DECLARATION_CONFLICT", "A different declaration already exists for this attempt.");
                return prior;
            }
            const declaration = {
                schemaVersion: "native-stop-declaration/1",
                declarationId: randomUUID(), taskId: input.taskId, attemptId: input.attemptId, revision: input.revision,
                actor: input.actor, statement, declaredAt: new Date().toISOString(),
                basis: { taskState: String(task.state), nativeStoppedAt: null, runStatus: snapshot.status ?? null, reportDigest: snapshot.reportDigest ?? null },
            };
            this.db.prepare("INSERT INTO native_stop_declarations VALUES (?,?,?,?,?,?)").run(declaration.declarationId, declaration.taskId, declaration.attemptId, declaration.revision, JSON.stringify(declaration), declaration.declaredAt);
            this.store.appendTaskEvent({
                taskId: declaration.taskId, attemptId: declaration.attemptId, type: "native_stop_declared",
                occurredAt: declaration.declaredAt, observedAt: declaration.declaredAt, actor: "declared_user",
                payload: { declarationId: declaration.declarationId, statement, source: "human_declaration", nativeStoppedAt: null },
                sourceRef: `declaration:${declaration.declarationId}`,
            });
            return declaration;
        });
    }
}
//# sourceMappingURL=native-stop-declaration.js.map