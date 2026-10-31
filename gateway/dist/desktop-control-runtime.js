import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AdmissionError, enforceModelPolicy } from "./collaboration.js";
import { contractExecution } from "./task-contract.js";
import { workspaceRelative } from "./workspace-protection.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { configuredDshCoordinator } from "./dsh-runtime.js";
import { runsDirectory } from "./run-journal.js";
import { assertDesktopDispatchDatabase, desktopJournal, desktopModelCatalog } from "./desktop-dispatch-runtime.js";
import { DesktopControlSession } from "./desktop-control.js";
import { DesktopControlJournal } from "./desktop-control-journal.js";
const gateway = fileURLToPath(new URL("..", import.meta.url));
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function enabled(config, env) {
    if (env.WORKBUDDY_DESKTOP_DISPATCH_ENABLED !== "1")
        throw new AdmissionError("CONTROL_NOT_ENABLED", "当前任务库只读，不能执行桌面操作。");
    assertDesktopDispatchDatabase(config);
}
export function desktopControlJournal(config, env = process.env) {
    return new DesktopControlJournal(path.join(path.dirname(desktopJournal(config, env).file), "controls.sqlite"));
}
function serviceFor(config, store, env) {
    const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config));
    return { coordinator, service: new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config), configuredDshCoordinator(store, runsDirectory(config), env)) };
}
export async function inspectDesktopControl(config, taskId, kind, env = process.env) {
    enabled(config, env);
    const store = new TaskStore(config.dbFile);
    try {
        const { service } = serviceFor(config, store, env), task = service.requireTask(taskId);
        if (!task.attemptId || !task.revision || !task.workspace)
            throw new AdmissionError("ACTION_UNAVAILABLE", "任务缺少当前轮次或项目记录。");
        const saved = store.getContract(taskId);
        if (saved.state !== "found")
            throw new AdmissionError("CONTRACT_INTEGRITY", "原始任务约定不可核验；历史记录保留只读。");
        const contract = saved.record.contract, execution = contractExecution(contract);
        if ((execution.executorId === "dsh") !== Boolean(store.dshBindings.forTask(taskId)))
            throw new AdmissionError("CONTRACT_INTEGRITY", "原执行来源记录不一致，无法操作。");
        const view = service.statusView(task);
        let rate = null;
        if (kind === "rework") {
            const catalog = await desktopModelCatalog(config, env), selected = catalog.models.find(model => hash(model.execution) === hash(execution));
            if (!selected || !catalog.dispatchEnabled)
                throw new AdmissionError("MODEL_UNVERIFIED", "原模型当前不可核验，请稍后重新查询。");
            enforceModelPolicy(catalog.policy, execution);
            if (execution.executorId === "workbuddy" && catalog.requiredFreeModel && execution.modelId !== catalog.requiredFreeModel)
                throw new AdmissionError("MODEL_POLICY_BLOCKED", "原模型与当前部署政策不符。");
            rate = selected.pricingVerified ? selected.credits : null;
            if ((catalog.policy.requireFree || execution.executorId === "workbuddy" && !!catalog.requiredFreeModel) && (!rate || !/^x0(?:\.0+)?(?: credits)?$/i.test(rate.trim())))
                throw new AdmissionError("MODEL_UNVERIFIED", "当前政策要求已核实的零费率。");
        }
        const reviews = kind === "accept" ? service.listReviews(taskId) : [];
        const allowedActions = [...view.allowedActions];
        if (task.state === "needs_review" && view.remoteStopped && task.report?.rawText.trim() && store.workspaceProtection.readView(taskId, task.attemptId).baseline === "present")
            allowedActions.push("review");
        return { taskId, attemptId: task.attemptId, revision: task.revision, title: contract.title, workspace: task.workspace,
            allowedActions, remoteStopped: view.remoteStopped, model: execution.modelId, rate, attempt: task.attempt ?? 0,
            executorId: execution.executorId, connectionId: execution.connectionId, providerId: execution.providerId, reasoningEffort: execution.reasoningEffort,
            attemptLimit: saved.record.effectiveMaxAttempts, currentReviewId: reviews.at(-1)?.reviewId ?? null, requirements: contract.requiredChecks };
    }
    finally {
        store.close();
    }
}
export function createDesktopControlSession(config, env = process.env) {
    const journal = desktopControlJournal(config, env);
    return new DesktopControlSession({ inspect: (taskId, kind) => inspectDesktopControl(config, taskId, kind, env), receipt: id => journal.receipt(id), forAttempt: (taskId, attemptId) => journal.forAttempt(taskId, attemptId), observe: async (taskId, attemptId) => {
            enabled(config, env);
            const store = new TaskStore(config.dbFile);
            try {
                const { service } = serviceFor(config, store, env);
                if (service.requireTask(taskId).attemptId !== attemptId)
                    throw new AdmissionError("STALE_ATTEMPT", "任务已进入其他轮次，请刷新。");
                const task = await service.sync(taskId);
                if (task.attemptId !== attemptId)
                    throw new AdmissionError("STALE_ATTEMPT", "任务已进入其他轮次，请刷新。");
                return { taskId, attemptId };
            }
            finally {
                store.close();
            }
        }, enqueue: async (draft) => {
            enabled(config, env);
            const receipt = journal.enqueue(draft);
            if (receipt.state !== "requested")
                return receipt;
            try {
                const child = spawn(process.execPath, [path.join(gateway, "scripts", "workbench-control-worker.mjs"), draft.requestId], { cwd: gateway, env: { ...env, WORKBUDDY_DB_FILE: config.dbFile, WORKBUDDY_RUNS_DIR: runsDirectory(config) }, shell: false, detached: true, windowsHide: true, stdio: "ignore" });
                await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
                child.unref();
            }
            catch {
                if (journal.claim(draft.requestId))
                    journal.finish(draft.requestId, "rejected", "WORKER_START_FAILED", "操作进程未启动；请刷新后重新核对。");
            }
            return journal.receipt(draft.requestId);
        } });
}
/** Optional factories are a trusted local test seam; the desktop worker never
 * receives them from a page, command line or serialized request. */
export async function runDesktopControlWorker(config, requestId, env = process.env, hooks = {}) {
    enabled(config, env);
    const journal = desktopControlJournal(config, env), draft = journal.claim(requestId);
    if (!draft)
        return;
    let store, entered = false;
    try {
        if (!Number.isFinite(Date.parse(draft.expiresAt)) || Date.parse(draft.expiresAt) <= Date.now())
            throw new AdmissionError("DRAFT_EXPIRED", "确认时间已过，请重新核对。");
        const snapshot = await (hooks.inspect ?? inspectDesktopControl)(config, draft.taskId, draft.kind, env);
        if (Date.parse(draft.expiresAt) <= Date.now())
            throw new AdmissionError("DRAFT_EXPIRED", "确认时间已过，请重新核对。");
        if (snapshot.attemptId !== draft.attemptId)
            throw new AdmissionError("STALE_ATTEMPT", "任务已进入其他轮次。");
        if (snapshot.revision !== draft.revision)
            throw new AdmissionError("STALE_REVISION", "任务状态已变化。");
        if (!snapshot.allowedActions.includes(draft.kind))
            throw new AdmissionError("ACTION_UNAVAILABLE", "当前状态不允许此操作。");
        if (draft.kind === "rework" && ["model", "rate", "executorId", "connectionId", "providerId", "reasoningEffort"].some(key => snapshot[key] !== draft.parameters[key]))
            throw new AdmissionError("QUOTE_CHANGED", "原模型、来源或费率已变化。");
        if (draft.kind === "accept" && snapshot.currentReviewId !== draft.parameters.reviewId)
            throw new AdmissionError("REVIEW_REQUIRED", "审查记录已变化。");
        if (draft.kind === "review" && hash(snapshot.requirements) !== hash(draft.parameters.requirements))
            throw new AdmissionError("CONTRACT_INTEGRITY", "原验收要求已变化。");
        store = new TaskStore(config.dbFile);
        const { service } = (hooks.serviceFor ?? serviceFor)(config, store, env);
        entered = true;
        if (draft.kind === "cancel")
            await service.cancelCurrent({ taskId: draft.taskId, expectedRevision: draft.revision, expectedAttemptId: draft.attemptId, reason: "用户在桌面工作台请求停止" });
        else if (draft.kind === "rework") {
            const result = await service.continue({ taskId: draft.taskId, feedback: String(draft.parameters.feedback), ...(draft.parameters.executorId === "workbuddy" ? { model: String(draft.parameters.model) } : {}), operationId: draft.operationId, expectedRevision: draft.revision, expectedAttemptId: draft.attemptId });
            if (result.ok === false)
                throw Object.assign(new Error("Original rework outcome needs inspection."), { code: "OUTCOME_UNKNOWN" });
        }
        else if (draft.kind === "review") {
            let revision = draft.revision;
            const options = (suffix) => ({ taskId: draft.taskId, operationId: draft.operationId + suffix, expectedRevision: revision, expectedAttemptId: draft.attemptId });
            const commands = snapshot.requirements.filter(check => check.kind === "command");
            for (let index = 0; index < commands.length; index++) {
                const result = await service.runReviewCommand({ ...options(":command:" + index), checkId: commands[index].id });
                if (!result.ok)
                    throw new AdmissionError("OUTCOME_UNKNOWN", "独立命令的清理状态未确认。");
                revision = result.revision;
            }
            const batch = service.reviewChecks(options(":checks"));
            revision = batch.revision;
            const requested = draft.parameters.semanticChecks;
            if (!Array.isArray(requested))
                throw new AdmissionError("INVALID_REVIEW", "缺少原语义检查结果。");
            const expected = snapshot.requirements.filter(check => check.kind === "semantic").map(check => check.id).sort();
            const semantic = requested;
            if (JSON.stringify(semantic.map(check => check.checkId).sort()) !== JSON.stringify(expected) || semantic.some(check => !["passed", "failed", "unknown"].includes(check.status)))
                throw new AdmissionError("INVALID_REVIEW", "语义检查与原约定不符。");
            let evidenceId = null;
            if (semantic.length) {
                const files = draft.parameters.inspectionFiles;
                if (!Array.isArray(files) || !files.length)
                    throw new AdmissionError("INVALID_REVIEW", "独立语义审查需要实际检查的文件。");
                const absolute = files.map(file => { if (typeof file !== "string")
                    throw new AdmissionError("INVALID_REVIEW", "检查文件无效。"); return path.isAbsolute(file) ? file : path.join(snapshot.workspace, workspaceRelative(file)); });
                const inspection = service.recordInspection({ ...options(":inspection"), note: String(draft.parameters.feedback), files: absolute });
                evidenceId = inspection.evidenceId;
                revision = inspection.revision;
            }
            service.review({ ...options(":review"), machineCheckIds: batch.machineCheckIds, semanticChecks: semantic.map(check => ({ checkId: check.checkId, status: check.status, note: String(draft.parameters.feedback), evidenceRefs: [evidenceId] })), note: String(draft.parameters.feedback) });
        }
        else
            service.acceptReview({ taskId: draft.taskId, reviewId: String(draft.parameters.reviewId), operationId: draft.operationId, expectedRevision: draft.revision, expectedAttemptId: draft.attemptId });
        journal.finish(requestId, "succeeded", undefined, undefined);
    }
    catch (error) {
        const operation = store?.operations.get(draft.operationId);
        const code = error instanceof AdmissionError ? error.code : "CONTROL_FAILED";
        const children = draft.kind === "review" ? store?.operations.forTask(draft.taskId).filter(item => item.operationId.startsWith(draft.operationId + ":")) ?? [] : [];
        const rejectedReview = children.some(item => item.state === "rejected") && children.every(item => item.state === "rejected" || item.state === "succeeded");
        const safeRejection = !entered || ["STALE_ATTEMPT", "STALE_REVISION"].includes(code) || operation?.state === "rejected" || rejectedReview;
        journal.finish(requestId, safeRejection ? "rejected" : "outcome_unknown", safeRejection ? code : "OUTCOME_UNKNOWN", safeRejection ? (rejectedReview ? "审查未完成，已记录的检查会保留；请刷新后重新核对。" : "操作未通过当前状态核验，请刷新后重新核对。 ") : "原操作结果尚未明确，请查看原任务与回执，不要重复操作。");
    }
    finally {
        store?.close();
    }
}
//# sourceMappingURL=desktop-control-runtime.js.map