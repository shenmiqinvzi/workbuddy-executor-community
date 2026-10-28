import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AdmissionError } from "./collaboration.js";
import { operationDigest } from "./operation-admission.js";
import { RunJournal, hasNativeStopEvidence } from "./run-journal.js";
import { readTaskProjection } from "./task-view-reader.js";
import { readValidationEvidence, verifyValidationEvidence } from "./worker-result.js";
import { runBounded } from "./bounded-command.js";
const fail = (code, message) => { throw new AdmissionError(code, message); };
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const text = (value, max = 4000) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const statuses = ["passed", "failed", "unknown", "not_applicable", "checker_error"];
const exact = (value, keys) => { if (Object.keys(value).some(key => !keys.includes(key)))
    fail("INVALID_REVIEW", "Unknown review fields, including actor overrides, are refused."); };
/** One shared trust boundary for both executors. No model calls or implicit sync. */
export class TaskReviews {
    db;
    store;
    constructor(db, store) {
        this.db = db;
        this.store = store;
        db.exec(`CREATE TABLE IF NOT EXISTS task_review_records (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_review_records_task ON task_review_records(task_id,kind);
      CREATE TRIGGER IF NOT EXISTS task_review_no_update BEFORE UPDATE ON task_review_records BEGIN SELECT RAISE(ABORT,'immutable review record'); END;
      CREATE TRIGGER IF NOT EXISTS task_review_no_delete BEFORE DELETE ON task_review_records BEGIN SELECT RAISE(ABORT,'immutable review record'); END;`);
    }
    save(key, taskId, kind, value) {
        this.db.prepare("INSERT INTO task_review_records VALUES(?,?,?,?,?)").run(key, taskId, kind, operationDigest(value), JSON.stringify(value));
    }
    read(key, taskId, kind) {
        const row = this.db.prepare("SELECT * FROM task_review_records WHERE id=? AND task_id=? AND kind=?").get(key, taskId, kind);
        if (!row)
            return fail("REVIEW_EVIDENCE_UNKNOWN", "The referenced record does not belong to this task or evidence kind.");
        try {
            const value = JSON.parse(String(row.body));
            if (operationDigest(value) !== row.digest)
                throw Error();
            return value;
        }
        catch {
            return fail("REVIEW_INTEGRITY", "An immutable review record failed integrity verification.");
        }
    }
    list(taskId) {
        return this.db.prepare("SELECT id FROM task_review_records WHERE task_id=? AND kind='review' ORDER BY rowid").all(taskId).map(row => this.read(String(row.id), taskId, "review"));
    }
    get(taskId, reviewId) { return this.read(reviewId, taskId, "review"); }
    /** Advice from stored facts only. Actual accept always rechecks external evidence. */
    storedAcceptanceReady(task) {
        const review = this.list(task.taskId).at(-1);
        if (!review || review.attemptId !== task.attemptId || review.committedRevision !== task.revision)
            return false;
        return ["$provenance", "$scope", ...this.terms(task).checks.map(check => check.id)].every(checkId => {
            const checks = review.checks.filter(check => check.checkId === checkId);
            return checks.length === 1 && checks[0].status === "passed" && checks[0].actor !== "worker";
        });
    }
    task(taskId) {
        const task = this.store.get(taskId);
        if (!task?.attemptId || !task.revision || !task.sessionId || !task.workspace)
            return fail("REVIEW_REQUIRED", "A durable current task, attempt, session and workspace are required.");
        if (task.state !== "needs_review" || task.cancelNote)
            return fail("REVIEW_REQUIRED", "Only an uncancelled needs_review attempt may be reviewed or accepted.");
        return task;
    }
    terms(task) {
        const saved = this.store.getContract(task.taskId);
        if (saved.state === "integrity_failure")
            return fail("CONTRACT_INTEGRITY", "The original agreement failed verification.");
        if (saved.state === "found")
            return { agreement: { hash: saved.record.contractHash, version: saved.record.agreementVersion }, checks: saved.record.contract.requiredChecks };
        if (!task.submissionHash)
            return fail("REVIEW_REQUIRED", "History without original submission evidence cannot be upgraded to T6.");
        return { agreement: { hash: task.submissionHash, version: null }, checks: (task.acceptanceCommands ?? []).map((definition, index) => ({ id: `legacy-command-${index + 1}`, kind: "command", definition })) };
    }
    binding(task, runsDir) {
        const scope = this.store.workspaceProtection.readView(task.taskId, task.attemptId);
        if (scope.baseline !== "present")
            return fail("SCOPE_BASELINE_MISSING", "A dispatch-time baseline is required; history is never backfilled.");
        const journal = new RunJournal(runsDir, task.attemptId), snapshot = journal.snapshot();
        const projection = readTaskProjection({ store: this.store, runsDir }, task.taskId);
        if (!projection.ok || projection.row.revision !== task.revision || projection.projection.facts?.report.state !== "authenticated" ||
            !snapshot || snapshot.taskId !== task.taskId || snapshot.attemptId !== task.attemptId || snapshot.sessionId !== task.sessionId || snapshot.runtimeSource !== task.runtimeSource ||
            !task.report?.rawText.trim() || snapshot.text !== task.report.rawText)
            return fail("CONTRACT_INTEGRITY", "The current authenticated report, revision and execution identity must agree.");
        if (!hasNativeStopEvidence(snapshot) || snapshot.waitingInput || snapshot.status !== "needs_review")
            return fail("STOP_UNCONFIRMED", "The original native execution must have explicit stop evidence.");
        if (task.runtimeSource === "dsh") {
            const native = this.store.dshBindings.forTask(task.taskId);
            if (!native || native.runOpen || native.attemptId !== task.attemptId || native.requestId !== snapshot.dsh?.requestId || native.hostId !== snapshot.dsh?.hostId || native.sessionId !== task.sessionId)
                return fail("STOP_UNCONFIRMED", "The original DSH request is still busy or its source differs.");
        }
        else if (task.runtimeSource !== "desktop_queue" || snapshot.driver !== "desktop-queue")
            return fail("REVIEW_REQUIRED", "T6 requires authenticated desktop-queue or DSH provenance; unsupported historical sources remain unchanged.");
        // Every authenticated citation retains T4/T5 validation, even when the
        // agreement has no named command requirement. A review cannot weaken it.
        verifyValidationEvidence(this.config(runsDir), task.attemptId, snapshot.validationRecords ?? []);
        const citedOutputs = {};
        for (const record of snapshot.validationRecords ?? []) {
            const command = JSON.parse(fs.readFileSync(record.path, "utf8"));
            for (const file of [command.stdout, command.stderr])
                if (typeof file === "string") {
                    if (path.dirname(file) !== path.dirname(record.path))
                        return fail("REVIEW_EVIDENCE_INVALID", "Cited command output belongs to another directory.");
                    citedOutputs[file] = this.fileHash(file);
                }
        }
        const agreement = this.terms(task).agreement;
        const evidenceDigest = operationDigest({ snapshot: { ...snapshot, updatedAt: null }, citedOutputs, request: this.fileHash(path.join(journal.dir, "request.json")), events: this.optionalHash(path.join(journal.dir, "events.jsonl")), cancellation: this.optionalHash(path.join(journal.dir, "cancel.json")) });
        return { agreement, scopeDigest: scope.check?.inventoryDigest ?? null, evidenceDigest,
            digest: operationDigest({ taskId: task.taskId, attemptId: task.attemptId, attempt: task.attempt, sessionId: task.sessionId, source: task.runtimeSource,
                objective: task.objective, constraints: task.constraints, acceptanceCommands: task.acceptanceCommands, submission: task.submissionHash, agreement,
                admission: this.store.collaboration.getTaskAdmission(task.taskId), attemptBinding: this.store.collaboration.getAttempt(task.attemptId),
                independentCommands: this.db.prepare("SELECT id,digest FROM task_review_records WHERE task_id=? AND kind='command' ORDER BY rowid").all(task.taskId).map(row => ({ id: String(row.id), digest: String(row.digest) })),
                native: task.runtimeSource === "dsh" ? this.store.dshBindings.forTask(task.taskId) : null,
                report: task.report, artifacts: task.artifacts, baseline: scope.baselineDigest, scope: scope.check, evidenceDigest }) };
    }
    fileHash(file) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink > 1 || stat.size > 32 * 1024 * 1024)
            return fail("REVIEW_EVIDENCE_INVALID", "Evidence must be a bounded regular unlinked file.");
        return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
    optionalHash(file) { try {
        return this.fileHash(file);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    } }
    config(runsDir) { return { dbFile: this.store.file, runsDir }; }
    check(checkId, kind, task, status, evidenceRefs, inputHashes, note) {
        return { id: id("check"), checkId, kind, status, attemptId: task.attemptId, actor: "program", evidenceRefs, inputHashes: Object.values(inputHashes), fileHashes: inputHashes, note, checkedAt: new Date().toISOString(), checkerVersion: "t6-1" };
    }
    /** Explicit write: collect existing authenticated command records and re-use T5 inventory. */
    checks(input, runsDir) {
        exact(input, ["taskId", "operationId", "expectedRevision", "expectedAttemptId"]);
        return this.store.operations.local("review_checks", input.taskId, { runsDir }, input, () => {
            let task = this.task(input.taskId);
            const scope = this.store.workspaceProtection.review(task.taskId, task.attemptId);
            task = this.task(task.taskId);
            const binding = this.binding(task, runsDir);
            const checks = [this.check("$provenance", "provenance", task, "passed", ["authenticated_report", "native_stop"], { evidence: binding.evidenceDigest }, "Authenticated current report and explicit native stop verified"),
                this.check("$scope", "scope", task, scope.status, ["workspace_inventory"], { baseline: scope.baselineDigest, inventory: scope.inventoryDigest ?? "unknown" }, scope.error ?? "T5 inventory and original user changes")];
            for (const required of this.terms(task).checks.filter(check => check.kind === "command")) {
                const records = [];
                for (const row of this.db.prepare("SELECT id FROM task_review_records WHERE task_id=? AND kind='command' ORDER BY rowid DESC").all(task.taskId)) {
                    const record = this.read(String(row.id), task.taskId, "command");
                    if (record.attemptId === task.attemptId && record.checkId === required.id)
                        records.push(record);
                }
                // Authenticated worker citations are verified as report evidence in
                // binding(), but are never promoted to independent program checks.
                // Only commands actually run and registered by this service qualify.
                let result = this.check(required.id, "command", task, "unknown", [], {}, "No verified command record matches the original check definition");
                for (const record of records) {
                    try {
                        if (record.inventoryDigest && record.inventoryDigest !== scope.inventoryDigest)
                            return fail("REVIEW_STALE", "The independent command inventory is no longer current.");
                        if (record.status && record.status !== "passed") {
                            if (this.fileHash(record.path) !== record.sha256)
                                return fail("REVIEW_STALE", "Independent command evidence changed.");
                            result = this.check(required.id, "command", task, record.status, [record.path], { [record.path]: record.sha256 }, "Independent checker outcome; no worker failure or budget change inferred");
                            break;
                        }
                        verifyValidationEvidence(this.config(runsDir), task.attemptId, [record]);
                        const command = JSON.parse(fs.readFileSync(record.path, "utf8"));
                        if (!this.matches(required.definition, command))
                            continue;
                        if (!Object.keys(command.after ?? {}).length)
                            return fail("REVIEW_EVIDENCE_INVALID", "A command must fingerprint its actual inputs.");
                        for (const output of [command.stdout, command.stderr])
                            if (typeof output !== "string" || path.dirname(output) !== path.dirname(record.path))
                                return fail("REVIEW_EVIDENCE_INVALID", "Command output does not belong to the command directory.");
                        const hashes = { ...command.after, [record.path]: record.sha256, [command.stdout]: this.fileHash(command.stdout), [command.stderr]: this.fileHash(command.stderr) };
                        result = this.check(required.id, "command", task, "passed", [record.path], hashes, "Original command, source hashes, output and cleanup verified");
                        break;
                    }
                    catch {
                        result = this.check(required.id, "command", task, "checker_error", [record.path], {}, "Command evidence verification failed; no worker failure was inferred");
                    }
                }
                checks.push(result);
            }
            const batch = { id: id("machine"), taskId: task.taskId, attemptId: task.attemptId, runsDir, binding, checks };
            this.save(batch.id, task.taskId, "machine", batch);
            this.changed(task, "program_checks_recorded", { machineCheckIds: [batch.id] }, "program");
            return { machineCheckIds: [batch.id], checks, revision: this.store.get(task.taskId).revision };
        });
    }
    matches(definition, command) {
        try {
            const spec = JSON.parse(definition);
            return operationDigest(spec) === operationDigest({ executable: command.executable, args: command.args, cwd: command.cwd, timeoutSeconds: command.timeoutSeconds, ...(command.inputs ? { inputs: command.inputs } : {}) });
        }
        catch {
            return false;
        } // Free text cannot prove executable/argument boundaries.
    }
    /** Explicit isolated verification; executes only the exact JSON CommandSpec in the original agreement. */
    async runCommand(input, runsDir) {
        exact(input, ["taskId", "operationId", "expectedRevision", "expectedAttemptId", "checkId"]);
        if (!input.operationId || input.expectedRevision === undefined || input.expectedAttemptId === undefined)
            return fail("OPERATION_PRECONDITION_REQUIRED", "A review command requires explicit operation preconditions.");
        const executor = this.store.dshBindings.forTask(input.taskId) ? "dsh" : "workbuddy";
        return this.store.operations.run("review_command", input.taskId, executor, { checkId: input.checkId, runsDir }, input, null, async (operation) => {
            const task = this.task(input.taskId), check = this.terms(task).checks.find(check => check.id === input.checkId && check.kind === "command");
            if (!check)
                return fail("INVALID_REVIEW", "The command must be an original required command check.");
            this.binding(task, runsDir);
            let spec;
            try {
                spec = JSON.parse(check.definition);
                exact(spec, ["executable", "args", "cwd", "timeoutSeconds", "inputs"]);
            }
            catch {
                return fail("COMMAND_SPEC_REQUIRED", "Independent execution requires an exact JSON CommandSpec in the original agreement; free text is never executed.");
            }
            this.store.workspaceProtection.authorizePath(task.taskId, task.attemptId, spec.cwd, "read");
            if (!Array.isArray(spec.inputs) || !spec.inputs.length)
                return fail("COMMAND_SPEC_REQUIRED", "Explicit command inputs are required.");
            for (const file of spec.inputs)
                this.store.workspaceProtection.authorizePath(task.taskId, task.attemptId, path.resolve(spec.cwd, file), "read");
            const guard = this.store.workspaceProtection.guard(task.taskId);
            this.store.operations.reviewCommandBoundary(operation.operationId);
            const result = await runBounded(spec, path.join(runsDir, task.attemptId, "commands"));
            this.store.operations.assertTaskVersion(operation);
            this.store.workspaceProtection.assertGuard(guard);
            const status = !result.cleanupConfirmed ? "checker_error" : result.exitCode === 0 ? "passed" : "failed";
            const verified = status === "passed" ? readValidationEvidence(this.config(runsDir), task.attemptId, [result.record])[0] : { path: result.record, sha256: this.fileHash(result.record) };
            const record = { id: id("command"), taskId: task.taskId, attemptId: task.attemptId, checkId: check.id,
                inventoryDigest: crypto.createHash("sha256").update(JSON.stringify(guard.inventory)).digest("hex"), status, ...verified };
            this.store.atomic(() => { this.store.operations.assertTaskVersion(operation); this.save(record.id, task.taskId, "command", record); this.changed(task, "independent_command_recorded", { evidenceId: record.id, status }, "program"); });
            return { ok: result.cleanupConfirmed, evidenceId: record.id, status, exitCode: result.exitCode, cleanupConfirmed: result.cleanupConfirmed, reason: result.reason, revision: this.store.get(task.taskId).revision };
        });
    }
    inspect(input, runsDir) {
        exact(input, ["taskId", "operationId", "expectedRevision", "expectedAttemptId", "note", "files"]);
        return this.store.operations.local("review_inspection", input.taskId, { note: input.note, files: input.files, runsDir }, input, () => {
            const task = this.task(input.taskId), binding = this.binding(task, runsDir);
            if (!text(input.note) || !Array.isArray(input.files) || !input.files.length || input.files.length > 100)
                return fail("INVALID_REVIEW", "Record a concrete independent inspection and 1-100 files.");
            const files = {};
            for (const file of input.files) {
                if (!path.isAbsolute(file))
                    return fail("INVALID_REVIEW", "Inspection files must be absolute.");
                this.store.workspaceProtection.authorizePath(task.taskId, task.attemptId, file, "read");
                files[file] = this.fileHash(file);
            }
            const inspection = { id: id("inspection"), taskId: task.taskId, attemptId: task.attemptId, bindingDigest: binding.digest, note: input.note, files, actor: "independent_reviewer", channel: "trusted_local_coordinator" };
            this.save(inspection.id, task.taskId, "inspection", inspection);
            this.changed(task, "independent_inspection_recorded", { evidenceId: inspection.id }, "independent_reviewer");
            return { evidenceId: inspection.id, revision: this.store.get(task.taskId).revision };
        });
    }
    review(input, runsDir) {
        exact(input, ["taskId", "operationId", "expectedRevision", "expectedAttemptId", "machineCheckIds", "semanticChecks", "note", "supersedesReviewId"]);
        const { taskId, operationId, expectedRevision, expectedAttemptId, ...parameters } = input;
        return this.store.operations.local("review", taskId, { ...parameters, runsDir }, input, () => {
            const task = this.task(taskId), binding = this.binding(task, runsDir);
            if (!text(input.note) || !Array.isArray(input.machineCheckIds) || input.machineCheckIds.length !== 1 || !Array.isArray(input.semanticChecks) || input.semanticChecks.length > 100)
                return fail("INVALID_REVIEW", "Reference one complete program check batch and bounded semantic checks.");
            const batch = this.read(input.machineCheckIds[0], taskId, "machine");
            if (batch.attemptId !== task.attemptId || batch.runsDir !== runsDir || batch.binding.digest !== binding.digest)
                return fail("REVIEW_STALE", "Program checks belong to different source, attempt or evidence.");
            this.verifyHashes(batch.checks);
            const required = this.terms(task).checks, seen = new Set();
            const checks = [...batch.checks];
            for (const semantic of input.semanticChecks) {
                exact(semantic, ["checkId", "status", "note", "evidenceRefs"]);
                if (!required.some(check => check.id === semantic.checkId && check.kind === "semantic") || seen.has(semantic.checkId) || !statuses.includes(semantic.status) || !text(semantic.note) || !Array.isArray(semantic.evidenceRefs) || !semantic.evidenceRefs.length || semantic.evidenceRefs.length > 100)
                    return fail("INVALID_REVIEW", "Semantic checks must uniquely name original semantic requirements and real independent inspections.");
                seen.add(semantic.checkId);
                const hashes = {};
                for (const ref of semantic.evidenceRefs) {
                    const inspection = this.read(ref, taskId, "inspection");
                    if (inspection.attemptId !== task.attemptId || inspection.bindingDigest !== binding.digest)
                        return fail("REVIEW_STALE", "The inspection belongs to different source or evidence.");
                    Object.assign(hashes, inspection.files);
                }
                checks.push({ ...this.check(semantic.checkId, "semantic", task, semantic.status, semantic.evidenceRefs, hashes, semantic.note), actor: "independent_reviewer" });
            }
            this.verifyHashes(checks);
            if (input.supersedesReviewId) {
                const previous = this.get(taskId, input.supersedesReviewId);
                if (previous.attemptId !== task.attemptId)
                    return fail("STALE_ATTEMPT", "A correction must reference the same attempt; rework history is never erased.");
            }
            const reviewId = id("review"), committedRevision = crypto.randomBytes(18).toString("base64url");
            const record = { reviewId, taskId, attemptId: task.attemptId, basisRevision: task.revision, committedRevision,
                bindingDigest: binding.digest, agreement: binding.agreement, runtimeSource: task.runtimeSource, sessionId: task.sessionId, machineCheckIds: [...input.machineCheckIds], checks,
                note: input.note, createdAt: new Date().toISOString(), reviewer: { actor: "independent_reviewer", channel: "trusted_local_coordinator" },
                supersedesReviewId: input.supersedesReviewId ?? null, correction: input.supersedesReviewId ? "reviewer_error" : null };
            this.save(reviewId, taskId, "review", record);
            this.changed(task, "independent_review_recorded", { reviewId, supersedesReviewId: record.supersedesReviewId, correction: record.correction }, "independent_reviewer", committedRevision);
            return { reviewId, revision: committedRevision, review: record };
        });
    }
    verifyHashes(checks) {
        for (const check of checks)
            for (const [file, hash] of Object.entries(check.fileHashes)) {
                if (!path.isAbsolute(file))
                    continue; // named program digests are not file paths
                if (this.fileHash(file) !== hash)
                    return fail("REVIEW_STALE", "A checked source, artifact or evidence file changed.");
            }
    }
    /** Called again by the storage acceptance gate under the same BEGIN IMMEDIATE. */
    assertAcceptance(task, reviewId, expectedRevision) {
        if (!reviewId)
            return fail("REVIEW_REQUIRED", "A current immutable reviewId is required; legacy acceptance cannot bypass T6.");
        const record = this.get(task.taskId, reviewId), current = this.task(task.taskId);
        if (record.attemptId !== current.attemptId || record.committedRevision !== current.revision || expectedRevision !== current.revision)
            return fail("REVIEW_STALE", "Review or operation revision/attempt is no longer current.");
        const batch = this.read(record.machineCheckIds[0], task.taskId, "machine"), binding = this.binding(current, batch.runsDir);
        if (binding.digest !== record.bindingDigest || operationDigest(binding.agreement) !== operationDigest(record.agreement))
            return fail("REVIEW_STALE", "Current agreement, execution, source or report evidence differs from the review.");
        this.store.workspaceProtection.assertAcceptance(task.taskId, task.attemptId);
        this.verifyHashes(record.checks);
        for (const checkId of ["$provenance", "$scope", ...this.terms(current).checks.map(check => check.id)]) {
            const checks = record.checks.filter(check => check.checkId === checkId);
            if (checks.length !== 1 || checks[0].status !== "passed" || checks[0].actor === "worker")
                return fail("CHECKS_REQUIRED", "Every original required check must pass independently; unknown, failed, checker_error and not_applicable cannot accept.");
        }
        return record;
    }
    accept(input) {
        exact(input, ["taskId", "operationId", "expectedRevision", "expectedAttemptId", "reviewId"]);
        return this.store.operations.local("accept", input.taskId, { reviewId: input.reviewId }, input, () => {
            const task = this.task(input.taskId), review = this.assertAcceptance(task, input.reviewId, input.expectedRevision);
            const at = new Date().toISOString();
            const accepted = this.store.acceptAttempt(task.taskId, task.attemptId, { state: "accepted", reviewNote: review.note, reviewedAt: at, evidence: [review.reviewId] }, { type: "task_closed", occurredAt: at, actor: "independent_reviewer", payload: { closedAs: "accepted", reviewId: review.reviewId }, sourceRef: `${task.attemptId}:task_closed` }, { expectedStates: ["needs_review"], reviewId: review.reviewId, expectedRevision: input.expectedRevision });
            if (!accepted.applied)
                return fail("STALE_ATTEMPT", "The reviewed attempt changed before acceptance.");
            return { task: accepted.task, reviewId: review.reviewId };
        });
    }
    changed(task, type, payload, actor, revision = crypto.randomBytes(18).toString("base64url")) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE tasks SET revision=?,updated_at=? WHERE task_id=?").run(revision, now, task.taskId);
        this.store.appendTaskEvent({ taskId: task.taskId, attemptId: task.attemptId, type, occurredAt: now, observedAt: now, actor, payload, sourceRef: null });
    }
}
//# sourceMappingURL=task-reviews.js.map