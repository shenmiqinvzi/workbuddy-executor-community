import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { AdmissionError, defaultModelPolicy } from "./collaboration.js";
import { listModels } from "./workspace-manager.js";
import { DshClient } from "./dsh-client.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { TaskApplicationService } from "./task-application-service.js";
import { configuredDshCoordinator } from "./dsh-runtime.js";
import { runsDirectory } from "./run-journal.js";
import { DesktopDispatchSession, desktopWorkspace, normalizedDesktopCatalog } from "./desktop-dispatch.js";
import { DesktopDispatchJournal } from "./desktop-dispatch-journal.js";
import { collaborationTermsHash } from "./task-contract.js";
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const gateway = fileURLToPath(new URL("..", import.meta.url));
export function assertDesktopDispatchDatabase(config) {
    const db = new DatabaseSync(config.dbFile, { readOnly: true });
    try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
        const columns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map(row => row.name));
        if (!columns.has("revision") || ["task_contracts", "collaboration_plans", "task_operations", "workspace_scope_baselines", "task_review_records"].some(name => !tables.has(name)))
            throw new AdmissionError("GATEWAY_UPGRADE_REQUIRED", "当前任务库尚未通过新版网关部署核验，不能从桌面入口迁移或派工。");
    }
    finally {
        db.close();
    }
}
function policy(config) {
    const db = new DatabaseSync(config.dbFile, { readOnly: true });
    try {
        if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='collaboration_policy'").get())
            return defaultModelPolicy(config.maxTaskAttempts ?? 3);
        const row = db.prepare("SELECT body_json,digest FROM collaboration_policy WHERE id=1").get();
        if (!row)
            return defaultModelPolicy(config.maxTaskAttempts ?? 3);
        const value = JSON.parse(String(row.body_json));
        if (sha(value) !== row.digest)
            throw new AdmissionError("CONTRACT_INTEGRITY", "当前模型政策无法核实。");
        return value;
    }
    finally {
        db.close();
    }
}
export async function desktopModelCatalog(config, env = process.env) {
    const source = { models: [], sessions: [], policy: policy(config), requiredFreeModel: env.WORKBUDDY_REQUIRED_FREE_MODEL?.trim() || null, dispatchEnabled: env.WORKBUDDY_DESKTOP_DISPATCH_ENABLED === "1", errors: [] };
    if (source.dispatchEnabled)
        try {
            assertDesktopDispatchDatabase(config);
        }
        catch {
            source.dispatchEnabled = false;
            source.errors.push("现有网关需先完成部署核验；当前仅可准备任务。");
        }
    const observations = await Promise.allSettled([
        (async () => {
            const result = await listModels(config);
            for (const model of result.models ?? [])
                if (typeof model.id === "string")
                    source.models.push({ execution: { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: model.id, reasoningEffort: null }, credits: typeof model.credits === "string" ? model.credits : null, pricingVerified: typeof model.credits === "string" });
        })(),
        (async () => {
            if (env.WORKBUDDY_DSH_ENABLED !== "1")
                return;
            const client = new DshClient(env.WORKBUDDY_DSH_REGISTRY_DIR, env.WORKBUDDY_DSH_HOST_ID), hostId = client.resolveHostId(env.WORKBUDDY_DSH_HOST_ID);
            const catalog = await client.models(hostId);
            for (const model of catalog.models)
                for (const effort of model.reasoningEfforts.length ? model.reasoningEfforts : [null])
                    source.models.push({ execution: { executorId: "dsh", connectionId: hostId, providerId: model.providerId, modelId: model.modelId, reasoningEffort: effort }, credits: catalog.pricingVerified ? model.credits : null, pricingVerified: catalog.pricingVerified && typeof model.credits === "string" });
            const { sessions } = await client.sessions(hostId);
            source.sessions = sessions.filter(s => typeof s.workspace === "string").map(s => ({ hostId, sessionId: s.sessionId, workspace: s.workspace, attached: s.attached === true, busy: s.busy !== false }));
        })(),
    ]);
    observations.forEach((result, index) => { if (result.status === "rejected")
        source.errors.push(index === 0 ? "无法读取 WorkBuddy 模型，请检查原应用连接后刷新。" : "无法读取已配置的 DSH 来源，不会自动换用其他来源。"); });
    return normalizedDesktopCatalog(source);
}
export function desktopJournal(config, env = process.env) {
    const configured = env.WORKBUDDY_DESKTOP_STATE_DIR;
    if (configured && !path.isAbsolute(configured))
        throw new AdmissionError("INVALID_CONFIGURATION", "桌面状态目录必须是绝对路径。");
    const root = configured ?? path.join(process.platform === "win32" ? process.env.LOCALAPPDATA ?? os.homedir() : path.join(os.homedir(), ".local", "state"), "WorkBuddyWorkbench", "dispatch");
    return new DesktopDispatchJournal(path.join(root, sha([gateway, config.dbFile, runsDirectory(config)]).slice(0, 24), "requests.sqlite"));
}
export function createDesktopDispatchSession(config, env = process.env) {
    const journal = desktopJournal(config, env);
    return new DesktopDispatchSession({ catalog: () => desktopModelCatalog(config, env), receipt: id => journal.receipt(id), latest: () => journal.latest(), observe: async (id) => {
            assertDesktopDispatchDatabase(config);
            const draft = journal.request(id);
            if (!draft || journal.receipt(id)?.state !== "submitted")
                throw new AdmissionError("OPERATION_PENDING", "请先核对原派工回执。");
            const store = new TaskStore(config.dbFile);
            try {
                const saved = store.getContract(draft.taskId);
                if (saved.state !== "found" || collaborationTermsHash(saved.record.contract) !== collaborationTermsHash(draft.contract))
                    throw new AdmissionError("CONTRACT_INTEGRITY", "当前记录与原派工约定不符。");
                const service = new TaskApplicationService(new TaskCoordinator(config, store, new WorkBuddyClient(config)), config.maxTaskAttempts ?? 3, runsDirectory(config), configuredDshCoordinator(store, runsDirectory(config), env));
                await service.sync(draft.taskId);
                return { taskId: draft.taskId, observedAt: new Date().toISOString() };
            }
            finally {
                store.close();
            }
        }, enqueue: async (draft) => {
            if (env.WORKBUDDY_DESKTOP_DISPATCH_ENABLED !== "1")
                throw new AdmissionError("DISPATCH_NOT_ENABLED", "当前安装尚未启用派工。");
            assertDesktopDispatchDatabase(config);
            const existing = journal.receipt(draft.draftId);
            if (existing)
                return existing;
            journal.enqueue(draft);
            try {
                const child = spawn(process.execPath, [path.join(gateway, "scripts", "workbench-dispatch-worker.mjs"), draft.draftId], { cwd: gateway, env: { ...env, WORKBUDDY_DB_FILE: config.dbFile, WORKBUDDY_RUNS_DIR: runsDirectory(config) }, shell: false, detached: true, windowsHide: true, stdio: "ignore" });
                await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
                child.unref();
            }
            catch {
                journal.finish(draft.draftId, "failed", "WORKER_START_FAILED", "派工进程未能启动；没有自动重试。请保留原任务与操作编号。");
            }
            return journal.receipt(draft.draftId);
        } });
}
/** Trusted worker composition after native confirmation. Existing backend
 * remains the sole owner of admission, preparation, execution and deadlines. */
export async function sendDesktopAgreement(service, draft) {
    if (sha(desktopWorkspace(draft.workspace.realPath)) !== sha(draft.workspace))
        throw new AdmissionError("WORKSPACE_CONFLICT", "项目目录身份已变化。");
    service.registerWorkspace(draft.contract.workspaceId, draft.workspace.realPath, path.basename(draft.workspace.realPath));
    const plan = service.createCollaborationPlan(draft.contract, { mode: "manual", reason: "User reviewed the exact task, scope, selection and rate in the native desktop confirmation.", ttlSeconds: 300, operationId: draft.operationId + ":plan" });
    const authorized = service.authorizeCollaborationPlan(plan.planId, plan.revision, "desktop-native-confirmation", { operationId: draft.operationId + ":authorize" });
    const contract = { ...draft.contract, collaboration: { planId: authorized.planId, expectedPlanRevision: authorized.revision } };
    return service.send({ taskId: draft.taskId, objective: contract.objective, workspace: draft.workspace.realPath, contract, ...(draft.sessionId ? { sessionId: draft.sessionId } : {}), operationId: draft.operationId, expectedRevision: null, expectedAttemptId: null });
}
export async function runDesktopDispatchWorker(config, requestId, env = process.env) {
    if (env.WORKBUDDY_DESKTOP_DISPATCH_ENABLED !== "1")
        throw new AdmissionError("DISPATCH_NOT_ENABLED", "Desktop dispatch is disabled.");
    assertDesktopDispatchDatabase(config);
    const journal = desktopJournal(config, env), draft = journal.claim(requestId);
    if (!draft)
        return;
    let store;
    try {
        if (Date.parse(draft.expiresAt) <= Date.now())
            throw new AdmissionError("DRAFT_EXPIRED", "Desktop agreement expired before dispatch.");
        const current = await desktopModelCatalog(config, env), model = current.models.find(m => sha(m.execution) === sha(draft.contract.execution));
        if (!current.dispatchEnabled || !model || current.policy.version !== draft.policyVersion || (model.pricingVerified ? model.credits : null) !== draft.quote.credits || model.pricingVerified !== draft.quote.pricingVerified)
            throw new AdmissionError("QUOTE_CHANGED", "The selected source or quote changed before dispatch.");
        if (Date.parse(draft.expiresAt) <= Date.now())
            throw new AdmissionError("DRAFT_EXPIRED", "Desktop agreement expired while refreshing its source.");
        store = new TaskStore(config.dbFile);
        const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config));
        const service = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config), configuredDshCoordinator(store, runsDirectory(config), env));
        const result = await sendDesktopAgreement(service, draft);
        if (!result.ok)
            throw new AdmissionError("DISPATCH_NOT_ACCEPTED", "The original backend did not accept this dispatch.");
        journal.finish(requestId, "submitted");
    }
    catch (error) {
        const operation = store?.operations.get(draft.operationId);
        const uncertain = !!operation && operation.state !== "rejected";
        journal.finish(requestId, uncertain ? "outcome_unknown" : "failed", error instanceof AdmissionError ? error.code : "DISPATCH_FAILED", uncertain ? "派工结果尚未明确。请查询原任务和原操作，不要重复派工。" : "派工未完成。请检查原任务与操作记录后处理，不会自动换模型或重试。");
    }
    finally {
        store?.close();
    }
}
//# sourceMappingURL=desktop-dispatch-runtime.js.map