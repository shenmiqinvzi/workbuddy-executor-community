import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AdmissionError, enforceModelPolicy } from "./collaboration.js";
import { validateSupportedTaskContract } from "./task-contract.js";
export function normalizedDesktopCatalog(source) {
    return { ...source, models: source.models.map(model => {
            const verified = model.pricingVerified && typeof model.credits === "string" && /^x\d+(?:\.\d+)?(?: credits)?$/i.test(model.credits.trim());
            return { ...model, credits: verified ? model.credits.trim() : null, pricingVerified: verified };
        }) };
}
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code, message) { throw new AdmissionError(code, message); }
const zero = (rate) => rate !== null && /^x0(?:\.0+)?(?: credits)?$/i.test(rate.trim());
export function desktopExact(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key)))
        fail("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
}
function text(value, max) {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
        fail("INVALID_REQUEST", "请填写有效的任务内容。");
    return value.trim();
}
function lines(value, max, itemMax) {
    if (!Array.isArray(value) || value.length > max)
        fail("INVALID_REQUEST", "任务条目超过允许数量。");
    return value.map(item => text(item, itemMax));
}
export function desktopWorkspace(directory) {
    if (!path.isAbsolute(directory))
        fail("WORKSPACE_CONFLICT", "请选择已有项目的绝对路径。");
    const realPath = fs.realpathSync.native(directory), stat = fs.statSync(realPath, { bigint: true });
    if (!stat.isDirectory())
        fail("WORKSPACE_CONFLICT", "项目路径必须是目录。");
    return { realPath, device: String(stat.dev), inode: String(stat.ino) };
}
function blocked(model, source) {
    try {
        enforceModelPolicy(source.policy, model.execution);
    }
    catch {
        return "当前部署的模型政策不允许此选择";
    }
    if (model.execution.executorId === "workbuddy" && source.requiredFreeModel && model.execution.modelId !== source.requiredFreeModel)
        return "当前 WorkBuddy 部署限定了其他精确模型";
    if ((source.policy.requireFree || model.execution.executorId === "workbuddy" && !!source.requiredFreeModel) && (!model.pricingVerified || !zero(model.credits)))
        return "当前部署要求已核实的零费率，此模型费用尚未满足要求";
    return null;
}
/** Drafts are memory-only. Reading choices or reviewing a proposal never opens
 * a writing executor store, prepares a model, registers a project or dispatches. */
export class DesktopDispatchSession {
    dependencies;
    catalogs = new Map();
    drafts = new Map();
    commits = new Map();
    inFlight = new Set();
    now;
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.now = dependencies.now ?? Date.now;
    }
    async catalog() {
        const source = normalizedDesktopCatalog(await this.dependencies.catalog());
        if (source.models.length > 1000 || source.sessions.length > 200)
            fail("CATALOG_TOO_LARGE", "模型或会话目录过大，请检查来源配置。");
        const observedAt = new Date(this.now()).toISOString();
        const catalog = { ...structuredClone(source), catalogId: crypto.randomUUID(), observedAt, expiresAt: new Date(this.now() + 300_000).toISOString(),
            models: source.models.map(model => ({ ...structuredClone(model), credits: model.pricingVerified ? model.credits : null, key: hash(model.execution), blockedReason: blocked(model, source) })) };
        if (this.catalogs.size >= 4)
            this.catalogs.delete(this.catalogs.keys().next().value);
        this.catalogs.set(catalog.catalogId, catalog);
        return structuredClone(catalog);
    }
    preview(input) {
        desktopExact(input, ["catalogId", "modelKey", "workspace", "title", "objective", "allowedChanges", "permittedMetadata", "checks", "maxAttempts", "timeoutSeconds", "sessionId"]);
        const catalog = this.catalogs.get(text(input.catalogId, 100));
        if (!catalog || Date.parse(catalog.expiresAt) <= this.now())
            fail("CATALOG_EXPIRED", "模型目录已过期，请刷新后重新选择。");
        const model = catalog.models.find(candidate => candidate.key === input.modelKey);
        if (!model)
            fail("MODEL_SELECTION_REQUIRED", "请选择来源、精确模型和推理档位。");
        if (model.blockedReason)
            fail("MODEL_POLICY_BLOCKED", model.blockedReason);
        const workspace = desktopWorkspace(text(input.workspace, 2000));
        const sessionId = input.sessionId === null ? null : text(input.sessionId, 512);
        this.checkSession(catalog, model.execution, workspace.realPath, sessionId);
        if (!Number.isInteger(input.maxAttempts) || Number(input.maxAttempts) < 1 || Number(input.maxAttempts) > catalog.policy.maxAttempts || !Number.isInteger(input.timeoutSeconds) || Number(input.timeoutSeconds) < 1 || Number(input.timeoutSeconds) > catalog.policy.maxTimeoutSeconds)
            fail("BUDGET_EXCEEDED", "轮次或执行时限超过当前部署的上限。");
        const checks = lines(input.checks, 20, 2000);
        if (!checks.length)
            fail("INVALID_REQUEST", "请至少填写一项独立验收要求。");
        const taskId = "desktop-" + crypto.randomUUID();
        const valid = validateSupportedTaskContract({ schemaVersion: "workbuddy-executor/vnext-2", taskId, workspaceId: "desktop-" + hash(workspace.realPath).slice(0, 32), title: text(input.title, 200), objective: text(input.objective, 8000),
            execution: model.execution, collaboration: { planId: "pending", expectedPlanRevision: "pending" }, timeoutSeconds: input.timeoutSeconds, maxAttempts: input.maxAttempts,
            scope: { allowedChanges: lines(input.allowedChanges, 100, 500), permittedMetadata: lines(input.permittedMetadata, 100, 500) }, requiredChecks: checks.map((definition, index) => ({ id: "check-" + (index + 1), kind: "semantic", definition })) });
        if (!valid.ok || !("execution" in valid.contract))
            fail("INVALID_CONTRACT", "任务约定未通过校验，请检查允许修改范围和验收条目。");
        if (this.drafts.size >= 16) {
            const oldest = [...this.drafts.keys()].find(id => !this.inFlight.has(id));
            if (!oldest)
                fail("DRAFT_LIMIT", "请先等待原确认请求返回。");
            this.drafts.delete(oldest);
            this.commits.delete(oldest);
        }
        const value = { draftId: crypto.randomUUID(), taskId, operationId: "desktop-send-" + crypto.randomUUID(), expiresAt: catalog.expiresAt, workspace, contract: valid.contract,
            sessionId, quote: { credits: model.credits, pricingVerified: model.pricingVerified, observedAt: catalog.observedAt }, policyVersion: catalog.policy.version };
        const draft = { ...value, digest: hash(value) };
        this.drafts.set(draft.draftId, draft);
        return structuredClone(draft);
    }
    review(draftId, digest) {
        const draft = this.drafts.get(draftId);
        if (!draft || draft.digest !== digest)
            fail("DRAFT_CHANGED", "任务约定已失效，请重新核对。");
        if (Date.parse(draft.expiresAt) <= this.now())
            fail("DRAFT_EXPIRED", "确认时间已过，请重新生成任务约定。");
        return structuredClone(draft);
    }
    /** Only the trusted native confirmation handler invokes this operation. */
    commit(draftId, digest) {
        const original = this.drafts.get(draftId);
        if (!original || original.digest !== digest)
            return Promise.reject(new AdmissionError("DRAFT_CHANGED", "任务约定已失效。"));
        if (this.commits.has(draftId))
            return this.commits.get(draftId);
        const operation = this.commitOnce(this.review(draftId, digest));
        // Set before the first asynchronous observation can complete. Any unknown
        // outcome remains bound to this original identity; it is never auto-retried.
        this.commits.set(draftId, operation);
        this.inFlight.add(draftId);
        void operation.then(() => this.inFlight.delete(draftId), () => this.inFlight.delete(draftId));
        return operation;
    }
    async commitOnce(draft) {
        const current = normalizedDesktopCatalog(await this.dependencies.catalog());
        if (!current.dispatchEnabled)
            fail("DISPATCH_NOT_ENABLED", "当前安装仅支持查看。派工能力需先完成网关部署核验。");
        const model = current.models.find(candidate => hash(candidate.execution) === hash(draft.contract.execution));
        if (!model || blocked(model, current))
            fail("MODEL_UNVERIFIED", "所选模型已不可用或被当前政策阻止，请重新核对。");
        if (current.policy.version !== draft.policyVersion || (model.pricingVerified ? model.credits : null) !== draft.quote.credits || model.pricingVerified !== draft.quote.pricingVerified)
            fail("QUOTE_CHANGED", "模型政策或费率已变化，请重新核对并确认。");
        if (hash(desktopWorkspace(draft.workspace.realPath)) !== hash(draft.workspace))
            fail("WORKSPACE_CONFLICT", "项目目录的身份已变化，请重新选择。");
        this.checkSession(current, draft.contract.execution, draft.workspace.realPath, draft.sessionId);
        if (Date.parse(draft.expiresAt) <= this.now())
            fail("DRAFT_EXPIRED", "确认时间已过，请重新生成任务约定。");
        return this.dependencies.enqueue(draft);
    }
    receipt(requestId) {
        const receipt = this.dependencies.receipt(requestId);
        if (receipt)
            return receipt;
        const draft = this.drafts.get(requestId);
        return draft && this.inFlight.has(requestId) ? { requestId, taskId: draft.taskId, operationId: draft.operationId, state: "outcome_unknown", message: "原确认请求仍在处理中。请保留同一编号查询，不要重新派工。" } : null;
    }
    latest() { const pending = [...this.inFlight][0]; return pending ? this.receipt(pending) : this.dependencies.latest?.() ?? null; }
    observe(requestId) {
        if (!this.dependencies.observe || this.receipt(requestId)?.state !== "submitted")
            fail("OPERATION_PENDING", "原派工请求尚未明确，请先查询原回执，不能重派或接管。");
        return this.dependencies.observe(requestId);
    }
    checkSession(source, execution, workspace, sessionId) {
        if (execution.executorId === "workbuddy") {
            if (sessionId !== null)
                fail("INVALID_REQUEST", "WorkBuddy 使用本任务独立的执行身份，无需指定 DSH 会话。");
            return;
        }
        const selected = source.sessions.find(s => s.hostId === execution.connectionId && s.sessionId === sessionId);
        if (!selected || !selected.attached || selected.busy || desktopWorkspace(selected.workspace).realPath !== workspace)
            fail("SESSION_REQUIRED", "请选择属于当前项目、已连接且空闲的 DSH 原会话。");
    }
}
//# sourceMappingURL=desktop-dispatch.js.map