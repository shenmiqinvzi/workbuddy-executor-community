import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AdmissionError } from "./collaboration.js";
import { operationDigest } from "./operation-admission.js";
import { runEvidenceDigestOf } from "./run-evidence.js";
import { hasNativeStopEvidence } from "./run-journal.js";
const unknownStates = ["reserved", "effect_started", "outcome_unknown"];
const fail = (code, message) => { throw new AdmissionError(code, message); };
/** Immutable decisions and local authorizations. Never inferred from caller-provided evidence. */
export class RecoveryStore {
    db;
    store;
    constructor(db, store) {
        this.db = db;
        this.store = store;
        db.exec(`CREATE TABLE IF NOT EXISTS operation_recoveries (
      operation_id TEXT PRIMARY KEY, target_operation_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, body_json TEXT NOT NULL,
      UNIQUE(target_operation_id,action));
      CREATE UNIQUE INDEX IF NOT EXISTS recovery_one_closure ON operation_recoveries(task_id) WHERE action='close';
      CREATE TABLE IF NOT EXISTS recovery_authorizations (
      authorization_id TEXT PRIMARY KEY, terms_digest TEXT NOT NULL, actor TEXT NOT NULL, confirmed_at TEXT NOT NULL, used_by TEXT);`);
    }
    decode(row) {
        if (!row)
            return null;
        try {
            const value = JSON.parse(String(row.body_json));
            if (value.operationId !== row.operation_id || value.targetOperationId !== row.target_operation_id || value.taskId !== row.task_id || value.action !== row.action || !["close", "reconcile"].includes(value.action) || !["queue_receipt", "dsh_receipt", "native_stopped", "not_dispatched"].includes(value.proof))
                throw Error();
            return value;
        }
        catch {
            return fail("CONTRACT_INTEGRITY", "Invalid recovery audit record; retain the original workflow.");
        }
    }
    get(operationId) { return this.decode(this.db.prepare("SELECT * FROM operation_recoveries WHERE operation_id=?").get(operationId)); }
    forOperation(target) { return this.decode(this.db.prepare("SELECT * FROM operation_recoveries WHERE target_operation_id=? ORDER BY rowid DESC LIMIT 1").get(target)); }
    closure(taskId) { return this.decode(this.db.prepare("SELECT * FROM operation_recoveries WHERE task_id=? AND action='close'").get(taskId)); }
    history(taskId) { return this.db.prepare("SELECT * FROM operation_recoveries WHERE task_id=? ORDER BY rowid").all(taskId).map(row => this.decode(row)); }
    assertOpen(taskId) { if (this.closure(taskId))
        fail("WORKFLOW_CLOSED", "Recovery permanently closed this original workflow."); }
    proof(operation, runsDir) {
        const task = this.store.get(operation.taskId), attemptId = task?.attemptId;
        const operations = this.store.operations.forTask(operation.taskId).filter(op => ["send", "rework", "queue"].includes(op.kind));
        let snapshot, request;
        const files = {};
        if (attemptId) {
            if (!/^run-[a-f0-9-]{36}$/.test(attemptId))
                return { reconcile: null, close: null, token: operationDigest({ invalidAttempt: attemptId }) };
            for (const name of ["state.json", "request.json", "claim.json", "wake.json", "model-ready.json", "cancel.json"]) {
                try {
                    files[name] = fs.readFileSync(path.join(runsDir, attemptId, name), "utf8");
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                    files[name] = null;
                }
            }
            try {
                snapshot = files["state.json"] ? JSON.parse(files["state.json"]) : undefined;
                request = files["request.json"] ? JSON.parse(files["request.json"]) : undefined;
            }
            catch { /* Partial evidence never authorizes recovery. */ }
        }
        const identity = !!snapshot && snapshot.taskId === task?.taskId && snapshot.attemptId === attemptId && !!task?.sessionId && snapshot.sessionId === task.sessionId;
        let reconcile = null, close = null;
        const dsh = this.store.dshBindings.forTask(operation.taskId);
        if (identity && operation.executor === "workbuddy" && snapshot.driver === "desktop-queue" && request) {
            const receipt = this.store.operations.get(`queue:${attemptId}`);
            const binding = receipt?.binding;
            // Compare the full original request, including prompt and immutable deadline.
            if (receipt?.taskId === task.taskId && receipt.attemptId === attemptId && binding && typeof binding.model === "string" && binding.model.trim() && request.sessionId === task.sessionId &&
                operationDigest({ ...binding, sessionId: request.sessionId }) === operationDigest(request) &&
                typeof snapshot.deadline === "string" && (binding.deadline === undefined || binding.deadline === snapshot.deadline))
                reconcile = "queue_receipt";
            if (reconcile && hasNativeStopEvidence(snapshot) && !["queued", "working"].includes(snapshot.status))
                close = "native_stopped";
        }
        if (identity && operation.executor === "dsh" && snapshot.driver === "dsh" && dsh?.attemptId === attemptId && dsh.sessionId === task.sessionId && snapshot.dsh?.hostId === dsh.hostId && snapshot.dsh.requestId === dsh.requestId) {
            if (dsh.dispatch === "accepted" || this.store.listTaskEvents(task.taskId, { limit: 1000 }).events.some(event => event.attemptId === attemptId && event.type === "native_request_observed" && event.actor === "dsh" && event.payload.requestId === dsh.requestId))
                reconcile = "dsh_receipt";
            if (!dsh.runOpen && (dsh.terminalSeq !== undefined || (dsh.dispatch === "rejected" && snapshot.dsh?.admissionRejected === true)) && hasNativeStopEvidence(snapshot))
                close = snapshot.nativeStopSource === "not_dispatched" ? "not_dispatched" : "native_stopped";
        }
        // A new phase-aware operation can be fenced before dispatch. Missing historical fields prove nothing.
        if (!attemptId && operations.length && operations.every(op => op.phaseVersion === 1 && !op.dispatchEnteredAt &&
            (!op.effectStartedAt || !!op.preparationCompletedAt)) && (!dsh || dsh.dispatch === "preparing"))
            close = "not_dispatched";
        let runEvidenceDigest;
        try {
            const cancellation = files["cancel.json"] ? JSON.parse(files["cancel.json"]) : undefined;
            if (cancellation !== undefined && (!cancellation || typeof cancellation !== "object" || Array.isArray(cancellation) || [cancellation.requestedAt, cancellation.reason].some(value => value != null && typeof value !== "string")))
                throw Error();
            if (snapshot && close)
                runEvidenceDigest = runEvidenceDigestOf(snapshot, cancellation);
        }
        catch {
            close = null;
        }
        return { reconcile, close, runEvidenceDigest, token: operationDigest({ files, dsh, operations: operations.map(op => ({ id: op.operationId, token: operationDigest(op) })) }) };
    }
    inspect(targetOperationId, runsDir) {
        return this.store.atomic(() => {
            const operation = this.store.operations.get(targetOperationId);
            if (!operation || !["send", "rework", "queue"].includes(operation.kind))
                return fail("OPERATION_NOT_FOUND", "The original execution operation was not found.");
            const task = this.store.get(operation.taskId), proof = this.proof(operation, runsDir);
            const history = this.history(operation.taskId);
            return { schemaVersion: "operation-recovery-1", operation, operationToken: operationDigest(operation),
                revision: task?.revision ?? null, attemptId: task?.attemptId ?? null, evidenceToken: operationDigest({ proof: proof.token, history }),
                runEvidenceDigest: proof.runEvidenceDigest ?? null,
                available: this.closure(operation.taskId) ? [] : [...(proof.reconcile && unknownStates.includes(operation.state) && !this.forOperation(targetOperationId) ? ["reconcile"] : []), ...(proof.close && task?.state !== "accepted" ? ["close"] : [])],
                proof: { reconcile: proof.reconcile, close: proof.close }, capacity: this.store.operations.occupant(), history,
                note: "Stored evidence only. An absent receipt, idle session or timeout never proves that native execution stopped." };
        });
    }
    validate(input, runsDir) {
        if (!input.operationId?.trim() || input.operationId.length > 512 || !input.reason?.trim() || input.reason.length > 4000 || !["reconcile", "close"].includes(input.action))
            fail("INVALID_RECOVERY", "Provide a stable recovery operationId, action and concrete bounded reason.");
        const view = this.inspect(input.targetOperationId, runsDir);
        if (view.operationToken !== input.expectedOperationToken)
            fail("STALE_OPERATION", "The original operation changed; inspect it again.");
        if (view.attemptId !== input.expectedAttemptId)
            fail("STALE_ATTEMPT", "The original attempt changed.");
        if (view.revision !== input.expectedRevision)
            fail("STALE_REVISION", "The original task changed.");
        if (view.evidenceToken !== input.expectedEvidenceToken)
            fail("EVIDENCE_STALE", "Original recovery evidence changed; inspect it again.");
        if (!view.available.includes(input.action))
            fail("RECOVERY_UNPROVEN", "The original durable facts do not prove this recovery is safe.");
        return view;
    }
    /** Trusted application seam, called only after an actual local human confirmation; never exposed as an HTTP/MCP tool. */
    authorize(input, runsDir, actor) {
        return this.store.atomic(() => {
            this.validate(input, runsDir);
            if (!actor.trim() || actor.length > 200)
                fail("AUTHORIZATION_REQUIRED", "A local human actor is required.");
            const id = randomUUID();
            this.db.prepare("INSERT INTO recovery_authorizations VALUES (?,?,?,?,NULL)").run(id, operationDigest(input), actor, new Date().toISOString());
            return id;
        });
    }
    resolve(input, runsDir, authorizationId) {
        return this.store.atomic(() => {
            const prior = this.get(input.operationId);
            if (prior) {
                if (prior.termsDigest !== operationDigest(input))
                    fail("OPERATION_CONFLICT", "This recovery operationId has different original parameters.");
                return prior;
            }
            if (this.store.operations.get(input.operationId))
                fail("OPERATION_CONFLICT", "This operationId already belongs to another action.");
            const authorization = this.db.prepare("SELECT * FROM recovery_authorizations WHERE authorization_id=?").get(authorizationId);
            const age = Date.now() - Date.parse(String(authorization?.confirmed_at));
            if (!authorization || authorization.terms_digest !== operationDigest(input) || authorization.used_by || !Number.isFinite(age) || age < 0 || age > 300000)
                return fail("AUTHORIZATION_REQUIRED", "A recent actual local confirmation must bind this exact recovery operation.");
            const view = this.validate(input, runsDir), original = view.operation;
            const proof = view.proof[input.action];
            const decision = { operationId: input.operationId, targetOperationId: original.operationId, taskId: original.taskId, attemptId: view.attemptId,
                action: input.action, proof: proof, actor: String(authorization.actor), confirmedAt: String(authorization.confirmed_at), decidedAt: new Date().toISOString(), reason: input.reason,
                termsDigest: operationDigest(input), evidenceToken: view.evidenceToken };
            if (input.action === "close") {
                const binding = this.store.dshBindings.forTask(original.taskId);
                if (binding?.runOpen) {
                    if (proof !== "not_dispatched" || binding.dispatch !== "preparing")
                        fail("STOP_UNCONFIRMED", "The original DSH request remains open.");
                    this.store.dshBindings.update({ ...binding, runOpen: false, dispatch: "rejected" });
                }
                if (this.store.get(original.taskId)) {
                    this.store.update(original.taskId, { state: "cancelled", ...(view.runEvidenceDigest ? { runEvidenceDigest: view.runEvidenceDigest } : {}), cancelNote: input.reason, blockingReason: "Closed by an independently authorized recovery decision; delivery was not accepted." });
                    this.store.appendTaskEvent({ taskId: original.taskId, attemptId: view.attemptId, type: "task_closed", occurredAt: decision.decidedAt, observedAt: decision.decidedAt,
                        actor: "recovery", payload: { recoveryOperationId: input.operationId, proof, accepted: false }, sourceRef: `recovery:${input.operationId}` });
                }
            }
            this.db.prepare("INSERT INTO operation_recoveries VALUES (?,?,?,?,?)").run(input.operationId, original.operationId, original.taskId, input.action, JSON.stringify(decision));
            this.db.prepare("UPDATE recovery_authorizations SET used_by=? WHERE authorization_id=?").run(input.operationId, authorizationId);
            if (input.action === "close")
                this.db.prepare("DELETE FROM workflow_capacity WHERE task_id=?").run(original.taskId);
            return decision;
        });
    }
}
//# sourceMappingURL=operation-recovery.js.map