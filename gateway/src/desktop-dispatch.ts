import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AdmissionError, enforceModelPolicy, type ModelPolicy } from "./collaboration.js";
import { validateSupportedTaskContract, type ExecutionSelection, type NormalizedTaskContractV2 } from "./task-contract.js";
import {
  DesktopProjectStore, desktopProjectId, matchDesktopProject, resolveDesktopProject, verifyDesktopProject,
  type DesktopProject, type DesktopProjectCandidate, type DesktopProjectIdentity, type DesktopProjectMatch,
} from "./desktop-projects.js";

export interface DesktopModel {
  key: string;
  execution: ExecutionSelection;
  credits: string | null;
  pricingVerified: boolean;
  blockedReason: string | null;
}
export interface DesktopSession { hostId: string; sessionId: string; workspace: string; attached: boolean; busy: boolean; availability?: "idle" | "busy" | "disconnected" | "unknown" }
export interface DesktopCatalogDiagnostic { source: "workbuddy" | "dsh"; code: string; message: string }
export interface DesktopCatalogSource {
  models: Omit<DesktopModel, "key" | "blockedReason">[];
  sessions: DesktopSession[];
  policy: ModelPolicy;
  requiredFreeModel: string | null;
  /** Absent means "the pin carries the legacy free-only rule" (requireZeroRate = !!requiredFreeModel). */
  requireZeroRate?: boolean;
  dispatchEnabled: boolean;
  errors: string[];
  diagnostics?: DesktopCatalogDiagnostic[];
}
/**
 * Catalog state is deliberately split. A source can be listed (online) while
 * this installation may not dispatch to it, and no catalog read can prove a
 * source is stoppable. Those three answers are never collapsed into one
 * "available" flag.
 */
export type DesktopSourceState = "online" | "disabled" | "unverified" | "unavailable" | "unknown";
export interface DesktopSourceView {
  sourceId: string;
  executorId: string;
  connectionId: string;
  providerId: string;
  label: string;
  state: DesktopSourceState;
  stateReason: string | null;
  dispatchable: boolean;
  stoppable: "unknown";
  models: DesktopModel[];
}
export interface DesktopCatalog extends DesktopCatalogSource {
  catalogId: string;
  observedAt: string;
  expiresAt: string;
  models: DesktopModel[];
  sources: DesktopSourceView[];
  /** Remembered identities; still "unverified" until the selection re-reads them. */
  projects: DesktopProjectCandidate[];
  projectIssues: string[];
}
export interface DesktopProjectSelection { workspace?: string; projectId?: string }
export interface DesktopDraft {
  draftId: string; digest: string; revision: number; taskId: string; operationId: string; expiresAt: string;
  projectId: string;
  workspace: { realPath: string; device: string; inode: string };
  contract: NormalizedTaskContractV2;
  sessionId: string | null;
  quote: { credits: string | null; pricingVerified: boolean; observedAt: string };
  policyVersion: string;
  /** Places where the objective and the declared scope disagree. They are
   * shown for the user to fix; they never widen the scope themselves. */
  warnings: DesktopDraftWarning[];
}
export interface DesktopDraftWarning { code: string; message: string }
export interface DesktopReceipt {
  requestId: string; taskId: string; operationId: string;
  state: "launch_requested" | "dispatching" | "submitted" | "failed" | "outcome_unknown";
  code?: string; message?: string;
  /** True only when nothing reached an executor and the same plan may be
   * corrected and checked again under the same task and operation identity. */
  retryable?: boolean;
}
export interface DesktopProjectRegistry {
  candidates(): DesktopProjectCandidate[];
  find(projectId: string): DesktopProject | null;
  remember(identity: DesktopProjectIdentity, hint?: string | null): DesktopProject;
  issues?(): string[];
}
export interface DesktopDispatchDependencies {
  catalog(): Promise<DesktopCatalogSource>;
  enqueue(draft: DesktopDraft): Promise<DesktopReceipt>;
  receipt(requestId: string): DesktopReceipt | null;
  latest?(): DesktopReceipt | null;
  observe?(requestId: string): Promise<{taskId: string; observedAt: string}>;
  /** Unset means the composer runs without a remembered project list. */
  projects?: DesktopProjectRegistry;
  now?: () => number;
}
export function normalizedDesktopCatalog(source: DesktopCatalogSource): DesktopCatalogSource {
  return { ...source, models: source.models.map(model => {
    const verified = model.pricingVerified && typeof model.credits === "string" && /^x\d+(?:\.\d+)?(?: credits)?$/i.test(model.credits.trim());
    return { ...model, credits: verified ? model.credits!.trim() : null, pricingVerified: verified };
  }) };
}
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string, message: string): never { throw new AdmissionError(code, message); }
const zero = (rate: string | null) => rate !== null && /^x0(?:\.0+)?(?: credits)?$/i.test(rate.trim());
export function desktopExact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
}
/** Revision patches may omit terms, but never invent new fields. */
function desktopKnown(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
}
/** Same shape as `desktopExact`, except that a listed-but-optional field may be
 * omitted by callers written before the field existed. */
function desktopFields(value: unknown, allowed: string[], required: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail("INVALID_REQUEST", "请填写有效的任务内容。");
  return value.trim();
}
function lines(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length > max) fail("INVALID_REQUEST", "任务条目超过允许数量。");
  return value.map(item => text(item, itemMax));
}
/** The verbs that usually mean "this task will change files". Matching one does
 * not authorize anything: it only tells the user their scope looks empty. */
const WRITE_INTENT = /(修改|新建|创建|新增|添加|删除|重命名|移动|重构|写入|改写|生成|实现|修复|更新|替换)/;
const PATH_TOKEN = /[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-/]*\.[A-Za-z0-9]{1,8}/g;
/** True when a path mentioned in the prose is inside the declared scope. */
function coveredByScope(target: string, allowed: string[]): boolean {
  const path = target.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  return allowed.some(item => {
    const rule = item.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
    if (!rule) return false;
    if (rule.endsWith("/**")) return path === rule.slice(0, -3) || path.startsWith(rule.slice(0, -2));
    return path === rule;
  });
}
/**
 * Points where the objective and the structured scope disagree. The prose is
 * never read as authorization (F-CONTRACT-1): these warnings ask the user to
 * fix the scope, and the dispatch stays exactly as narrow as it was declared.
 */
function scopeWarnings(objective: string, allowed: string[]): DesktopDraftWarning[] {
  const warnings: DesktopDraftWarning[] = [];
  if (!allowed.length && WRITE_INTENT.test(objective)) {
    warnings.push({ code: "scope_not_declared", message: "目标看起来要改动文件，但允许修改范围为空：派工后按只读执行，越界改动会被拒绝。如果确实要改文件，请在下方的范围里显式填写精确路径或 目录/**。" });
  }
  const seen = new Set<string>();
  for (const raw of objective.match(PATH_TOKEN) ?? []) {
    if (warnings.length >= 6) break;
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (coveredByScope(raw, allowed)) continue;
    warnings.push({ code: "scope_path_not_covered", message: `目标提到 ${raw}，但它不在允许修改范围里；正文提到路径不会获得写权限。需要改动时请把该路径加入范围。` });
  }
  return warnings;
}
export function desktopWorkspace(directory: string) {
  if (!path.isAbsolute(directory)) fail("WORKSPACE_CONFLICT", "请选择已有项目的绝对路径。");
  const realPath = fs.realpathSync.native(directory), stat = fs.statSync(realPath, { bigint: true });
  if (!stat.isDirectory()) fail("WORKSPACE_CONFLICT", "项目路径必须是目录。");
  return { realPath, device: String(stat.dev), inode: String(stat.ino) };
}
function blocked(model: Omit<DesktopModel, "key" | "blockedReason">, source: DesktopCatalogSource): string | null {
  try { enforceModelPolicy(source.policy, model.execution); }
  catch { return "当前部署的模型政策不允许此选择"; }
  const requireZeroRate = source.requireZeroRate ?? !!source.requiredFreeModel;
  if (model.execution.executorId === "workbuddy" && source.requiredFreeModel && model.execution.modelId !== source.requiredFreeModel) return "当前 WorkBuddy 部署限定了其他精确模型";
  if ((source.policy.requireFree || model.execution.executorId === "workbuddy" && requireZeroRate) && (!model.pricingVerified || !zero(model.credits))) return "当前部署要求已核实的零费率，此模型费用尚未满足要求";
  return null;
}
const sourceOf = (execution: ExecutionSelection) => JSON.stringify([execution.executorId, execution.connectionId, execution.providerId]);
const sourceLabel = (execution: Pick<ExecutionSelection, "executorId" | "connectionId" | "providerId">) => execution.executorId === "workbuddy" ? "WorkBuddy · 本机原生来源" : `DSH · ${execution.providerId} · ${execution.connectionId}`;
const diagnosticState = (code: string): DesktopSourceState =>
  code === "source_disabled" ? "disabled"
    : ["host_ambiguous", "host_missing", "registry_unverified", "source_unverified"].includes(code) ? "unverified"
      : ["source_unavailable", "catalog_unavailable", "sessions_unavailable", "catalog_too_large"].includes(code) ? "unavailable"
        : "unknown";
/** Group the flattened catalog into per-source rows, keeping failure reasons per source. */
function sourceViews(source: DesktopCatalogSource, models: DesktopModel[]): DesktopSourceView[] {
  const groups = new Map<string, DesktopModel[]>();
  for (const model of models) { const key = sourceOf(model.execution); groups.set(key, [...(groups.get(key) ?? []), model]); }
  const views: DesktopSourceView[] = [...groups].map(([sourceId, list]) => {
    const execution = list[0]!.execution;
    return { sourceId, executorId: execution.executorId, connectionId: execution.connectionId, providerId: execution.providerId, label: sourceLabel(execution),
      state: "online" as DesktopSourceState, stateReason: null, dispatchable: source.dispatchEnabled && list.some(model => !model.blockedReason), stoppable: "unknown" as const, models: list };
  });
  for (const diagnostic of source.diagnostics ?? []) {
    const covered = views.some(view => view.executorId === diagnostic.source);
    const state = diagnosticState(diagnostic.code);
    if (covered) {
      for (const view of views.filter(item => item.executorId === diagnostic.source)) {
        view.state = state === "online" ? "unknown" : state;
        view.stateReason = diagnostic.message;
        view.dispatchable = false;
      }
      continue;
    }
    views.push({ sourceId: "diagnostic-" + diagnostic.source, executorId: diagnostic.source, connectionId: "", providerId: "", label: diagnostic.source === "workbuddy" ? "WorkBuddy · 本机原生来源" : "DSH · 未核验来源",
      state, stateReason: diagnostic.message, dispatchable: false, stoppable: "unknown", models: [] });
  }
  return views;
}

/** Drafts are memory-only. Reading choices or reviewing a proposal never opens
 * a writing executor store, prepares a model, registers a project or dispatches. */
export class DesktopDispatchSession {
  private readonly catalogs = new Map<string, DesktopCatalog>();
  private readonly drafts = new Map<string, DesktopDraft>();
  private readonly superseded = new Map<string, Set<string>>();
  private readonly commits = new Map<string, Promise<DesktopReceipt>>();
  private readonly inFlight = new Set<string>();
  /** One dispatch per agreed plan: a second task with the same terms is refused. */
  private readonly consumedPlans = new Map<string, { draftId: string; taskId: string }>();
  /**
   * Preparation failures that never reached an executor. They are definite, so
   * the plan claim is released and the same task identity can be corrected and
   * checked again; an uncertain outcome is never recorded here.
   */
  private readonly failures = new Map<string, { taskId: string; operationId: string; code: string; message: string; at: number }>();
  private readonly now: () => number;
  constructor(private readonly dependencies: DesktopDispatchDependencies) { this.now = dependencies.now ?? Date.now; }
  async catalog(): Promise<DesktopCatalog> {
    const source = normalizedDesktopCatalog(await this.dependencies.catalog());
    if (source.models.length > 1000 || source.sessions.length > 200) fail("CATALOG_TOO_LARGE", "模型或会话目录过大，请检查来源配置。");
    const observedAt = new Date(this.now()).toISOString();
    const models: DesktopModel[] = source.models.map(model => ({ ...structuredClone(model), credits: model.pricingVerified ? model.credits : null, key: hash(model.execution), blockedReason: blocked(model, source) }));
    const catalog: DesktopCatalog = { ...structuredClone(source), catalogId: crypto.randomUUID(), observedAt, expiresAt: new Date(this.now() + 300_000).toISOString(), models,
      sources: sourceViews(source, models),
      projects: this.dependencies.projects?.candidates() ?? [],
      projectIssues: this.dependencies.projects?.issues?.() ?? [] };
    if (this.catalogs.size >= 4) this.catalogs.delete(this.catalogs.keys().next().value!);
    this.catalogs.set(catalog.catalogId, catalog);
    return structuredClone(catalog);
  }
  /**
   * `preview` prepares one agreement. Passing `draftId` + `digest` revises that
   * agreement instead of creating a second one: the task identity is kept, the
   * revision advances, the old digest stops reviewing and the deadline is not
   * extended. Switching model or source is not a revision — it needs a fresh
   * preview so the new quote is read and confirmed again.
   */
  preview(input: unknown): DesktopDraft {
    const required = ["catalogId", "modelKey", "workspace", "title", "objective", "allowedChanges", "permittedMetadata", "checks", "maxAttempts", "timeoutSeconds", "sessionId"];
    const allowed = [...required, "projectId"];
    if (input && typeof input === "object" && ("draftId" in input || "digest" in input)) {
      desktopFields(input, [...allowed, "draftId", "digest"], [...required, "draftId", "digest"]);
      const record = input as Record<string, unknown>, patch: Record<string, unknown> = {};
      for (const key of allowed) if (Object.hasOwn(record, key)) patch[key] = record[key];
      return this.revise(record.draftId, record.digest, patch);
    }
    desktopFields(input, allowed, required);
    return this.create(input);
  }
  revise(draftId: unknown, digest: unknown, patch: unknown): DesktopDraft {
    const identity = { draftId: text(draftId, 100), digest: text(digest, 128) };
    desktopKnown(patch, ["catalogId", "modelKey", "workspace", "projectId", "title", "objective", "allowedChanges", "permittedMetadata", "checks", "maxAttempts", "timeoutSeconds", "sessionId"]);
    const original = this.drafts.get(identity.draftId);
    if (!original) fail("DRAFT_CHANGED", "任务约定已失效，请重新核对。");
    if (this.superseded.get(identity.draftId)?.has(identity.digest) || original.digest !== identity.digest) fail("DRAFT_CHANGED", "该版本的任务约定已被新版本取代，请核对当前版本。");
    if (Date.parse(original.expiresAt) <= this.now()) fail("DRAFT_EXPIRED", "确认时间已过，请重新生成任务约定。");
    if (this.inFlight.has(identity.draftId) || this.commits.has(identity.draftId)) fail("DRAFT_CONSUMED", "该任务约定已提交派工，不能再修改。");
    if (patch.modelKey !== undefined && patch.modelKey !== hash(original.contract.execution)) fail("MODEL_SWITCH_REQUIRES_PREVIEW", "更换模型或档位需要重新读取目录并重新核对费用，不能在原方案上直接替换。");
    // A project is selected exactly one way: the remembered identity wins over
    // the remembered path whenever both are offered.
    const projectId = typeof patch.projectId === "string" ? patch.projectId : null;
    const workspace = projectId ? null : typeof patch.workspace === "string" ? patch.workspace : original.workspace.realPath;
    const merged: Record<string, unknown> = {
      catalogId: patch.catalogId ?? this.catalogFor(original.contract.execution, original.policyVersion)?.catalogId,
      modelKey: hash(original.contract.execution),
      workspace, projectId,
      title: patch.title ?? original.contract.title, objective: patch.objective ?? original.contract.objective,
      allowedChanges: patch.allowedChanges ?? [...original.contract.scope.allowedChanges],
      permittedMetadata: patch.permittedMetadata ?? [...original.contract.scope.permittedMetadata],
      checks: patch.checks ?? original.contract.requiredChecks.map(check => check.definition),
      maxAttempts: patch.maxAttempts ?? original.contract.maxAttempts, timeoutSeconds: patch.timeoutSeconds ?? original.contract.timeoutSeconds,
      sessionId: Object.hasOwn(patch, "sessionId") ? patch.sessionId : original.sessionId,
    };
    if (merged.catalogId === undefined) fail("CATALOG_EXPIRED", "原模型目录已过期，请刷新后重新核对。");
    const value = this.build(merged, { taskId: original.taskId, operationId: original.operationId, revision: original.revision + 1, expiresAt: original.expiresAt });
    this.supersede(identity.draftId, identity.digest);
    this.drafts.set(value.draftId, value);
    // A corrected revision replaces the earlier preparation failure: the user
    // is looking at terms that were never handed to an executor.
    this.failures.delete(identity.draftId);
    return structuredClone(value);
  }
  private create(input: Record<string, unknown>): DesktopDraft {
    const value = this.build(input, { taskId: "desktop-" + crypto.randomUUID(), operationId: "desktop-send-" + crypto.randomUUID(), revision: 1 });
    if (this.drafts.size >= 16) {
      const oldest = [...this.drafts.keys()].find(id => !this.inFlight.has(id));
      if (!oldest) fail("DRAFT_LIMIT", "请先等待原确认请求返回。");
      this.drafts.delete(oldest); this.commits.delete(oldest); this.superseded.delete(oldest); this.failures.delete(oldest);
    }
    this.drafts.set(value.draftId, value);
    return structuredClone(value);
  }
  private build(input: Record<string, unknown>, identity: { taskId: string; operationId: string; revision: number; expiresAt?: string }): DesktopDraft {
    const catalog = this.catalogs.get(text(input.catalogId, 100));
    if (!catalog || Date.parse(catalog.expiresAt) <= this.now()) fail("CATALOG_EXPIRED", "模型目录已过期，请刷新后重新选择。");
    const model = catalog.models.find(candidate => candidate.key === input.modelKey);
    if (!model) fail("MODEL_SELECTION_REQUIRED", "请选择来源、精确模型和推理档位；原档位已不在当前目录中时需要重新选择。");
    if (model.blockedReason) fail("MODEL_POLICY_BLOCKED", model.blockedReason);
    const project = this.selectProject(input);
    this.checkSession(catalog, model.execution, project.realPath, this.sessionId(input));
    if (!Number.isInteger(input.maxAttempts) || Number(input.maxAttempts) < 1 || Number(input.maxAttempts) > catalog.policy.maxAttempts || !Number.isInteger(input.timeoutSeconds) || Number(input.timeoutSeconds) < 1 || Number(input.timeoutSeconds) > catalog.policy.maxTimeoutSeconds) fail("BUDGET_EXCEEDED", "轮次或执行时限超过当前部署的上限。");
    const checks = lines(input.checks, 20, 2000);
    if (!checks.length) fail("INVALID_REQUEST", "请至少填写一项独立验收要求。");
    const valid = validateSupportedTaskContract({ schemaVersion: "workbuddy-executor/vnext-2", taskId: identity.taskId, workspaceId: "desktop-" + hash(project.realPath).slice(0,32), title: text(input.title, 200), objective: text(input.objective, 8000),
      execution: model.execution, collaboration: { planId: "pending", expectedPlanRevision: "pending" }, timeoutSeconds: input.timeoutSeconds, maxAttempts: input.maxAttempts,
      scope: { allowedChanges: lines(input.allowedChanges, 100, 500), permittedMetadata: lines(input.permittedMetadata, 100, 500) }, requiredChecks: checks.map((definition,index) => ({ id: "check-" + (index+1), kind: "semantic", definition })) });
    if (!valid.ok || !("execution" in valid.contract)) fail("INVALID_CONTRACT", "任务约定未通过校验，请检查允许修改范围和验收条目。");
    // Remembering the identity is local bookkeeping only; the next selection
    // still re-reads the directory before anything is dispatched.
    try { this.dependencies.projects?.remember(project, typeof input.workspace === "string" ? input.workspace : null); } catch { /* the registry is a cache, never the identity */ }
    const value = { draftId: crypto.randomUUID(), taskId: identity.taskId, operationId: identity.operationId, revision: identity.revision, expiresAt: identity.expiresAt ?? catalog.expiresAt,
      projectId: desktopProjectId(project), workspace: project, contract: valid.contract as NormalizedTaskContractV2, sessionId: this.sessionId(input),
      quote: { credits: model.credits, pricingVerified: model.pricingVerified, observedAt: catalog.observedAt }, policyVersion: catalog.policy.version,
      warnings: scopeWarnings((valid.contract as NormalizedTaskContractV2).objective, (valid.contract as NormalizedTaskContractV2).scope.allowedChanges) };
    return { ...value, digest: hash(value) };
  }
  private sessionId(input: Record<string, unknown>): string | null { return input.sessionId === null || input.sessionId === undefined ? null : text(input.sessionId, 512); }
  private selectProject(input: Record<string, unknown>): DesktopProjectIdentity {
    const byId = typeof input.projectId === "string", byPath = typeof input.workspace === "string";
    if (byId === byPath) fail("PROJECT_SELECTION_REQUIRED", "请选择一个已登记项目，或填写项目文件夹的绝对路径。");
    if (byId) {
      const project = this.dependencies.projects?.find(text(input.projectId, 100));
      if (!project) fail("PROJECT_NOT_REGISTERED", "该项目登记已不可用，请重新选择文件夹。");
      const verified = verifyDesktopProject(project);
      if (!verified.ok) fail(verified.code, verified.message);
      return verified.identity;
    }
    const resolution = resolveDesktopProject(input.workspace);
    if (!resolution.ok) fail(resolution.code, resolution.message);
    return resolution.identity;
  }
  private catalogFor(execution: ExecutionSelection, policyVersion: string): DesktopCatalog | null {
    const key = hash(execution);
    for (const catalog of [...this.catalogs.values()].reverse()) {
      if (catalog.policy.version !== policyVersion) continue;
      if (catalog.models.some(model => model.key === key)) return catalog;
    }
    return null;
  }
  private supersede(draftId: string, digest: string) {
    const set = this.superseded.get(draftId) ?? new Set<string>();
    set.add(digest); this.superseded.set(draftId, set);
  }
  review(draftId: string, digest: string): DesktopDraft {
    const draft = this.drafts.get(draftId);
    if (!draft || this.superseded.get(draftId)?.has(digest)) fail("DRAFT_CHANGED", "任务约定已失效，请核对当前版本后重新确认。");
    if (draft.digest !== digest) fail("DRAFT_CHANGED", "任务约定已失效，请核对当前版本后重新确认。");
    if (Date.parse(draft.expiresAt) <= this.now()) fail("DRAFT_EXPIRED", "确认时间已过，请重新生成任务约定。");
    return structuredClone(draft);
  }
  /** Only the trusted native confirmation handler invokes this operation. */
  commit(draftId: string, digest: string): Promise<DesktopReceipt> {
    const original = this.drafts.get(draftId);
    if (!original || original.digest !== digest) return Promise.reject(new AdmissionError("DRAFT_CHANGED", "任务约定已失效。"));
    if (this.commits.has(draftId)) return this.commits.get(draftId)!;
    const reviewed = this.review(draftId, digest);
    const planKey = this.planKey(reviewed);
    const consumed = this.consumedPlans.get(planKey);
    if (consumed && consumed.draftId !== draftId) return Promise.reject(new AdmissionError("PLAN_ALREADY_CONSUMED", `同一份任务约定已在任务 ${consumed.taskId} 上派工，不能换一个任务身份重复提交。请修改任务内容后重新核对。`));
    // Claimed before the first asynchronous observation can complete, so two
    // confirmations of the same plan cannot both reach an executor.
    this.consumedPlans.set(planKey, { draftId, taskId: original.taskId });
    const operation = this.commitOnce(reviewed, planKey);
    // Any unknown outcome remains bound to this original identity; it is never auto-retried.
    this.commits.set(draftId, operation);
    this.inFlight.add(draftId); void operation.then(() => this.inFlight.delete(draftId), () => this.inFlight.delete(draftId));
    return operation;
  }
  /**
   * The plan identity is the agreement without its task identity: the same
   * project, model, scope, checks, budget, rate and policy may be dispatched
   * once. Two task ids over one agreement are the same plan.
   */
  private planKey(draft: DesktopDraft): string {
    // The same directory reached by path or by remembered identity is the same
    // project (workspaceId already encodes it), and a re-read of the same rate
    // is the same cost term: neither may be used to slip a second dispatch in.
    const { taskId, ...rest } = draft.contract;
    return hash({ contract: rest, sessionId: draft.sessionId, credits: draft.quote.credits, pricingVerified: draft.quote.pricingVerified, policyVersion: draft.policyVersion });
  }
  /**
   * Everything is re-read before the hand-off, and only the hand-off itself can
   * be uncertain. A refusal here means no executor was asked, so the identity
   * stays usable: the failure is reported against this exact task and operation
   * and the plan claim is released for a corrected revision.
   */
  private async commitOnce(draft: DesktopDraft, planKey: string): Promise<DesktopReceipt> {
    try {
      await this.preflight(draft);
    } catch (error) {
      const code = error instanceof AdmissionError ? error.code : "DISPATCH_PREPARATION_FAILED";
      const message = error instanceof Error && error.message ? error.message : "派工准备没有完成，请修正后重新核对。";
      this.failures.set(draft.draftId, { taskId: draft.taskId, operationId: draft.operationId, code, message, at: this.now() });
      if (this.consumedPlans.get(planKey)?.draftId === draft.draftId) this.consumedPlans.delete(planKey);
      this.commits.delete(draft.draftId);
      throw error;
    }
    const receipt = await this.dependencies.enqueue(draft);
    // A prepared dispatch supersedes earlier preparation failures.
    this.failures.clear();
    return receipt;
  }
  private async preflight(draft: DesktopDraft): Promise<void> {
    const current = normalizedDesktopCatalog(await this.dependencies.catalog());
    if (!current.dispatchEnabled) fail("DISPATCH_NOT_ENABLED", "当前安装仅支持查看。派工能力需先完成网关部署核验。");
    const model = current.models.find(candidate => hash(candidate.execution) === hash(draft.contract.execution));
    if (!model || blocked(model, current)) fail("MODEL_UNVERIFIED", "所选模型或档位已不可用，或被当前政策阻止，请重新核对。");
    if (current.policy.version !== draft.policyVersion || (model.pricingVerified ? model.credits : null) !== draft.quote.credits || model.pricingVerified !== draft.quote.pricingVerified) fail("QUOTE_CHANGED", "模型政策或费率已变化，请重新核对并确认。");
    if (hash(desktopWorkspace(draft.workspace.realPath)) !== hash(draft.workspace)) fail("WORKSPACE_CONFLICT", "项目目录的身份已变化，请重新选择。");
    this.checkSession(current, draft.contract.execution, draft.workspace.realPath, draft.sessionId);
    if (Date.parse(draft.expiresAt) <= this.now()) fail("DRAFT_EXPIRED", "确认时间已过，请重新生成任务约定。");
  }
  receipt(requestId: string): DesktopReceipt | null {
    const receipt=this.dependencies.receipt(requestId);if(receipt)return receipt;
    const draft=this.drafts.get(requestId);
    if(draft&&this.inFlight.has(requestId))return{requestId,taskId:draft.taskId,operationId:draft.operationId,state:"outcome_unknown",message:"原确认请求仍在处理中。请保留同一编号查询，不要重新派工。"};
    const failure=this.failures.get(requestId);
    return failure?{requestId,taskId:failure.taskId,operationId:failure.operationId,state:"failed",code:failure.code,message:failure.message,retryable:true}:null;
  }
  latest(): DesktopReceipt | null {
    const pending=[...this.inFlight][0]; if(pending)return this.receipt(pending);
    const failed=[...this.failures.keys()].at(-1); if(failed)return this.receipt(failed);
    return this.dependencies.latest?.()??null;
  }
  observe(requestId: string) {
    if (!this.dependencies.observe || this.receipt(requestId)?.state !== "submitted") fail("OPERATION_PENDING", "原派工请求尚未明确，请先查询原回执，不能重派或接管。");
    return this.dependencies.observe(requestId);
  }
  private checkSession(source: DesktopCatalogSource, execution: ExecutionSelection, workspace: string, sessionId: string | null) {
    if (execution.executorId === "workbuddy") { if (sessionId !== null) fail("INVALID_REQUEST", "WorkBuddy 使用本任务独立的执行身份，无需指定 DSH 会话。"); return; }
    const sameHost = source.sessions.filter(s => s.hostId === execution.connectionId);
    const candidates = sameHost.filter(s => s.sessionId === sessionId);
    if (!sessionId) fail("SESSION_REQUIRED", sameHost.length ? "请选择一个属于当前项目、已连接且空闲的 DSH 原会话。" : "没有可用于这个项目的 DSH 会话，请在原应用打开项目后刷新。");
    if (candidates.length === 0) fail("SESSION_REQUIRED", "所选会话已不在目录中，请刷新后重新选择。");
    if (candidates.length > 1) fail("SESSION_REQUIRED", "该会话身份不唯一，无法确认是哪一次原生对话，请先关闭重复会话。");
    const candidate = candidates[0]!;
    const state = candidate.availability ?? (!candidate.attached ? "disconnected" : candidate.busy ? "busy" : "idle");
    if (state === "disconnected") fail("SESSION_REQUIRED", "所选会话未连接，请先在原应用恢复连接。");
    if (state === "busy") fail("SESSION_REQUIRED", "所选会话正在执行其他任务，当前不可用。");
    if (state === "unknown") fail("SESSION_REQUIRED", "无法确认所选会话的状态，请刷新后重新选择。");
    let candidateWorkspace:string;
    try { candidateWorkspace=desktopWorkspace(candidate.workspace).realPath; }
    catch { return fail("SESSION_REQUIRED", "无法核验该会话所属的项目，请检查原会话后刷新。"); }
    if (candidateWorkspace !== workspace) fail("SESSION_REQUIRED", "该会话不属于当前项目，请选择匹配的原会话。");
  }
}

/** Default bounded registry for the desktop host. */
export function desktopProjectRegistry(file: string | null, limit = 20): DesktopProjectStore {
  return new DesktopProjectStore({ file, limit });
}
export type { DesktopProject, DesktopProjectCandidate, DesktopProjectIdentity, DesktopProjectMatch };
