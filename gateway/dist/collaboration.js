import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { collaborationTermsHash, contractExecution, validateSupportedTaskContract } from "./task-contract.js";
export class AdmissionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "AdmissionError";
    }
}
const token = () => randomBytes(18).toString("base64url");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value);
const equalSelection = (a, b) => a.executorId === b.executorId && a.connectionId === b.connectionId && a.providerId === b.providerId && a.modelId === b.modelId && a.reasoningEffort === b.reasoningEffort;
const fail = (code, message) => { throw new AdmissionError(code, message); };
export function defaultModelPolicy(maxAttempts = 3) {
    const policy = { maxAttempts, maxTimeoutSeconds: 86_400, requireFree: true,
        allowed: [{ executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "deepseek-v4.1-flash", reasoningEffort: null }] };
    return { version: `default-${digest(policy).slice(0, 24)}`, ...policy };
}
export function enforceModelPolicy(policy, execution) {
    if (policy.requireFree !== true)
        fail("COST_CONTROL_UNAVAILABLE", "This stage does not authorize paid models or promise a hard cost limit.");
    if (!policy.allowed.some(candidate => equalSelection(candidate, execution)))
        fail("MODEL_POLICY_BLOCKED", "The execution selection is outside the authorized model policy.");
}
export function verifySelectedModel(execution, observed, sessionId) {
    if (execution.executorId === "dsh" && (!observed || observed.providerId !== execution.providerId || observed.connectionId !== execution.connectionId || (observed.reasoningEffort ?? null) !== execution.reasoningEffort))
        fail("MODEL_UNVERIFIED", "The DSH source or reasoning selection differs.");
    const observedAt = Date.parse(observed?.observedAt ?? "");
    if (!observed || observed.sessionId !== sessionId || observed.level !== "selected" || observed.modelId !== execution.modelId || observed.selectedModel !== execution.modelId || typeof observed.credits !== "string" ||
        !/^x0(?:\.0+)?(?: credits)?$/i.test(observed.credits.trim()) || !Number.isFinite(observedAt) || observedAt < Date.now() - 30_000 || observedAt > Date.now() + 5000)
        fail("MODEL_UNVERIFIED", "A recent selected-model and exact zero-rate observation is required.");
}
/** Server-owned registry on the SAME SQLite connection as tasks and contracts.
 * No HTTP write routes or environment credentials are exposed by this module. */
export class CollaborationRegistry {
    db;
    constructor(db) {
        this.db = db;
        db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_workspaces (id TEXT PRIMARY KEY, body_json TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_policy (id INTEGER PRIMARY KEY CHECK(id=1), body_json TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_plans (
        plan_id TEXT PRIMARY KEY, revision TEXT NOT NULL, body_json TEXT NOT NULL, digest TEXT NOT NULL,
        authorized_at TEXT, authorization_source TEXT, consumed_by TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS task_admissions (task_id TEXT PRIMARY KEY, body_json TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_attempt_admissions (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body_json TEXT NOT NULL, digest TEXT NOT NULL);
    `);
    }
    registerWorkspace(id, directory, displayName) {
        if (!validId(id) || !displayName?.trim() || displayName.length > 120 || !path.isAbsolute(directory))
            fail("WORKSPACE_CONFLICT", "Register an explicit workspace identifier, name and absolute directory.");
        const realPath = fs.realpathSync.native(directory);
        const stat = fs.statSync(realPath, { bigint: true });
        if (!stat.isDirectory())
            fail("WORKSPACE_CONFLICT", "The registered workspace must be a directory.");
        const record = { id, displayName, realPath, device: String(stat.dev), inode: String(stat.ino) };
        this.db.prepare("INSERT INTO collaboration_workspaces VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(id, JSON.stringify(record), digest(record));
        const existing = this.getWorkspace(id);
        if (existing.realPath !== realPath || existing.device !== record.device || existing.inode !== record.inode)
            fail("WORKSPACE_CONFLICT", "This workspace identifier already belongs to another directory identity.");
        return existing;
    }
    getWorkspace(id) {
        const row = this.db.prepare("SELECT body_json, digest FROM collaboration_workspaces WHERE id=?").get(id);
        if (!row)
            return fail("WORKSPACE_CONFLICT", "The workspace is not registered.");
        const workspace = this.read(row);
        if (workspace.id !== id || !path.isAbsolute(workspace.realPath))
            fail("WORKSPACE_CONFLICT", "The workspace registration is inconsistent.");
        const real = fs.realpathSync.native(workspace.realPath);
        const stat = fs.statSync(real, { bigint: true });
        if (real !== workspace.realPath || !stat.isDirectory() || String(stat.dev) !== workspace.device || String(stat.ino) !== workspace.inode)
            fail("WORKSPACE_CONFLICT", "The registered workspace directory identity changed.");
        return workspace;
    }
    currentPolicy(fallback) {
        const row = this.db.prepare("SELECT body_json,digest FROM collaboration_policy WHERE id=1").get();
        return row ? this.read(row) : structuredClone(fallback);
    }
    /** Trusted configuration operation; not a client approval field. */
    setPolicy(input) {
        if (input.requireFree !== true)
            fail("COST_CONTROL_UNAVAILABLE", "Paid execution requires a later, verified cost-control implementation.");
        if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100 || !Number.isInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds < 1 || input.maxTimeoutSeconds > 86_400 || !Array.isArray(input.allowed) || input.allowed.length > 100)
            fail("MODEL_POLICY_BLOCKED", "Invalid server model policy.");
        for (const selection of input.allowed) {
            if (!["workbuddy", "dsh"].includes(selection.executorId) || ![selection.connectionId, selection.providerId, selection.modelId].every(validId) || (selection.reasoningEffort !== null && !validId(selection.reasoningEffort)))
                fail("MODEL_POLICY_BLOCKED", "Invalid model selection in server policy.");
        }
        const policy = { ...structuredClone(input), version: `policy-${token()}` };
        this.db.prepare("INSERT INTO collaboration_policy VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,digest=excluded.digest").run(JSON.stringify(policy), digest(policy));
        return policy;
    }
    createPlan(submitted, policy, options) {
        const validated = validateSupportedTaskContract(submitted);
        if (!validated.ok || !("execution" in validated.contract))
            fail("PLAN_STALE", "A valid vnext-2 proposal is required.");
        if (options.mode !== "manual" && options.mode !== "recommend")
            fail("PLAN_CONFIRMATION_REQUIRED", "Automatic scheduling is not enabled in this stage.");
        const contract = validated.ok ? validated.contract : fail("PLAN_STALE", "Invalid proposal.");
        enforceModelPolicy(policy, contractExecution(contract));
        this.getWorkspace(contract.workspaceId);
        const ttl = options.ttlSeconds ?? 1800;
        if (!options.reason?.trim() || options.reason.length > 2000 || !Number.isInteger(ttl) || ttl < 1 || ttl > 86400)
            fail("PLAN_STALE", "A bounded plan lifetime and decision reason are required.");
        const createdAt = new Date().toISOString();
        const plan = { planId: `plan-${token()}`, revision: token(), mode: options.mode, decision: "delegate", reason: options.reason,
            termsHash: collaborationTermsHash(contract), policyVersion: policy.version, createdAt, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
            authorizedAt: null, authorizationSource: null, consumedBy: null, proposal: contract };
        this.db.prepare("INSERT INTO collaboration_plans (plan_id,revision,body_json,digest) VALUES (?,?,?,?)").run(plan.planId, plan.revision, JSON.stringify(plan), digest(plan));
        return structuredClone(plan);
    }
    getPlan(planId) {
        const row = this.db.prepare("SELECT * FROM collaboration_plans WHERE plan_id=?").get(planId);
        if (!row)
            return fail("PLAN_STALE", "The collaboration plan does not exist.");
        const plan = this.read(row);
        if (plan.planId !== planId || plan.revision !== row.revision || collaborationTermsHash(plan.proposal) !== plan.termsHash)
            fail("PLAN_STALE", "The collaboration plan failed integrity verification.");
        return { ...plan, authorizedAt: row.authorized_at, authorizationSource: row.authorization_source, consumedBy: row.consumed_by };
    }
    /** Called only by a trusted application action after actual user authorization. */
    authorizePlan(planId, revision, policy, authorizationSource) {
        const plan = this.getPlan(planId);
        this.checkPlan(plan, revision, policy);
        if (!authorizationSource?.trim() || authorizationSource.length > 100)
            fail("PLAN_CONFIRMATION_REQUIRED", "A trusted authorization source is required.");
        this.db.prepare("UPDATE collaboration_plans SET authorized_at=COALESCE(authorized_at,?),authorization_source=COALESCE(authorization_source,?) WHERE plan_id=? AND revision=?")
            .run(new Date().toISOString(), authorizationSource, planId, revision);
        return this.getPlan(planId);
    }
    prepare(contract, contractHash, policy, executor = "workbuddy") {
        const workspace = this.getWorkspace(contract.workspaceId);
        const execution = contractExecution(contract);
        enforceModelPolicy(policy, execution);
        if (contract.timeoutSeconds > policy.maxTimeoutSeconds)
            fail("DEADLINE_EXCEEDED", "The requested duration exceeds the server policy.");
        if (execution.executorId !== executor)
            fail("EXECUTOR_UNAVAILABLE", "This adapter does not execute the selected executor.");
        if (executor === "workbuddy" && (execution.connectionId !== "local-workbuddy" || execution.providerId !== "workbuddy-native" || execution.reasoningEffort !== null))
            fail("EXECUTOR_CAPABILITY_MISSING", "This WorkBuddy adapter cannot verify the requested source or reasoning effort.");
        let planId = null, planRevision = null;
        if ("collaboration" in contract) {
            const plan = this.getPlan(contract.collaboration.planId);
            this.checkPlan(plan, contract.collaboration.expectedPlanRevision, policy);
            if (!plan.authorizedAt)
                fail("PLAN_CONFIRMATION_REQUIRED", "The collaboration plan requires actual authorization.");
            if (plan.termsHash !== collaborationTermsHash(contract) || (plan.consumedBy !== null && plan.consumedBy !== contract.taskId))
                fail("PLAN_STALE", "The plan terms or task binding differ.");
            planId = plan.planId;
            planRevision = plan.revision;
        }
        return { workspace, execution, policy: structuredClone(policy), contractHash, planId, planRevision };
    }
    /** Must run inside the task/contract creation transaction; rechecks policy and plan. */
    saveTaskAdmission(taskId, contract, contractHash, policy, executor = "workbuddy") {
        const admission = this.prepare(contract, contractHash, policy, executor);
        if (admission.planId) {
            const result = this.db.prepare("UPDATE collaboration_plans SET consumed_by=? WHERE plan_id=? AND (consumed_by IS NULL OR consumed_by=?)").run(taskId, admission.planId, taskId);
            if (Number(result.changes) !== 1)
                fail("PLAN_STALE", "The plan was already bound to another task.");
        }
        this.db.prepare("INSERT INTO task_admissions VALUES (?,?,?)").run(taskId, JSON.stringify(admission), digest(admission));
        return admission;
    }
    getTaskAdmission(taskId) {
        const row = this.db.prepare("SELECT body_json,digest FROM task_admissions WHERE task_id=?").get(taskId);
        return row ? this.read(row) : null;
    }
    saveAttempt(record) {
        this.db.prepare("INSERT INTO task_attempt_admissions VALUES (?,?,?,?)").run(record.attemptId, record.taskId, JSON.stringify(record), digest(record));
    }
    getAttempt(attemptId) {
        const row = this.db.prepare("SELECT body_json,digest FROM task_attempt_admissions WHERE attempt_id=?").get(attemptId);
        return row ? this.read(row) : null;
    }
    checkPlan(plan, revision, policy) {
        if (plan.revision !== revision || Date.parse(plan.expiresAt) <= Date.now())
            fail("PLAN_STALE", "The collaboration plan is outdated or expired.");
        if (plan.policyVersion !== policy.version)
            fail("POLICY_CHANGED", "The model policy changed after this plan was created.");
    }
    read(row) {
        try {
            const value = JSON.parse(String(row.body_json));
            if (digest(value) !== row.digest)
                throw Error("digest");
            return value;
        }
        catch {
            return fail("CONTRACT_INTEGRITY", "A collaboration record failed integrity verification.");
        }
    }
}
//# sourceMappingURL=collaboration.js.map