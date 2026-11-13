import crypto from "node:crypto";
import type { ExecutionSelection } from "./task-contract.js";

/**
 * Explainable recommendation for one collaboration task.
 *
 * This module is a *reader*: it never opens an executor, prepares a model,
 * creates a native attempt, writes a project or dispatches anything. It turns
 * the capability snapshot the desktop composer already has (catalog + read-only
 * resource and statistics documents) into one deterministic, auditable answer:
 * which decision, which exact selection, why, what was excluded and why, what
 * is missing, and which evidence it stands on.
 *
 * Two rules shape the whole file and are asserted by the tests:
 *  - an observation is not a promise: an online source is not dispatchable, a
 *    declared resource link is not verified routing, an unknown price is not
 *    free and an unknown remaining budget is not "sufficient";
 *  - advice is not authorization: the result always carries
 *    `authorization.state === "none"` and the caller must still review and
 *    confirm.
 */
export const RECOMMENDATION_SCHEMA = "workbuddy-executor/recommendation-1";
/** Bump when a rule changes meaning; the version travels with every answer. */
export const RECOMMENDATION_EXPLANATION_VERSION = 1;
export const PLAN_REFERENCE_SCHEMA = "workbuddy-executor/plan-resource-reference-1";
export const STATISTICS_SCHEMA = "workbuddy-executor/statistics-1";

export class RecommendationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RecommendationError"; }
}

export type RecommendationDecision = "direct" | "delegate" | "wait";

export interface RecommendationModel {
  execution: ExecutionSelection;
  credits: string | null;
  pricingVerified: boolean;
  blockedReason?: string | null;
}
export interface RecommendationSource {
  sourceId: string;
  executorId: string;
  connectionId: string;
  providerId: string;
  label: string;
  state: "online" | "disabled" | "unverified" | "unavailable" | "unknown";
  stateReason: string | null;
  dispatchable: boolean;
  models?: RecommendationModel[];
}
export interface RecommendationPolicy {
  version?: string | null;
  maxAttempts?: number;
  maxTimeoutSeconds?: number;
  requireFree?: boolean;
  selectionMode?: "allowlist" | "user_choice";
  allowed?: ExecutionSelection[];
}
export interface RecommendationCatalog {
  catalogId?: string;
  observedAt?: string;
  expiresAt?: string;
  models: RecommendationModel[];
  sources?: RecommendationSource[];
  policy?: RecommendationPolicy;
  dispatchEnabled?: boolean;
  requiredFreeModel?: string | null;
  requireZeroRate?: boolean;
  errors?: string[];
}

export interface RecommendationIntent {
  title?: string;
  objective?: string;
  allowedChanges?: string[];
  permittedMetadata?: string[];
  checks?: string[];
  maxAttempts?: number;
  timeoutSeconds?: number;
  sessionId?: string | null;
}

export interface RecommendationCandidate {
  selection: ExecutionSelection;
  sourceId: string;
  sourceLabel: string;
  sourceState: string;
  dispatchable: boolean;
  cost: { credits: string | null; pricingVerified: boolean; known: boolean; zero: boolean; label: string };
  resources: {
    status: "fresh" | "stale" | "unavailable" | "unverified_claim";
    reference: { schemaVersion: string; generatedAt: string | null; attribution: string | null; association: string | null; caveats: string[] } | null;
    quotaFreshness: "fresh" | "stale" | "unavailable" | null;
    quotaRemaining: number | null;
    creditBalance: string | null;
    routingVerified: false;
    limitations: string[];
  };
  reasons: { code: string; message: string }[];
  rank: { tier: number; rule: string };
}
export interface RecommendationExclusion { selection: ExecutionSelection; sourceLabel: string; code: string; message: string }
export interface RecommendationMissing { code: string; message: string; severity: "blocks" | "limits" }
export interface RecommendationHistory {
  status: "available" | "partial" | "unavailable";
  code: string;
  window: { from: string | null; to: string | null } | null;
  sampleSize: number | null;
  coverage: Record<string, number> | null;
  limitations: string[];
  claims: { savings: null; superiority: null };
}
export interface RecommendationDrift { codes: string[]; message: string; blockedForDispatch: boolean }

export interface Recommendation {
  schemaVersion: typeof RECOMMENDATION_SCHEMA;
  explanationVersion: number;
  readOnly: true;
  generatedAt: string;
  decision: RecommendationDecision;
  mode: "recommend";
  /** Advice only: the composer must still preview and confirm. */
  authorization: { state: "none"; requires: ("preview" | "confirmation")[] };
  /** A direct decision never creates an executor attempt — not even a placeholder. */
  attempt: null;
  nativeAttempt: "none";
  catalog: { catalogId: string | null; observedAt: string | null; expiresAt: string | null; fresh: boolean };
  policy: { version: string | null; requireFree: boolean; selectionMode: string | null; allowedCount: number; maxAttempts: number | null; maxTimeoutSeconds: number | null; dispatchEnabled: boolean };
  decisionReason: { code: string; message: string; codes: string[] };
  userSelection: { selection: ExecutionSelection; status: "available" | "unavailable"; code: string; message: string } | null;
  recommended: RecommendationCandidate | null;
  candidates: RecommendationCandidate[];
  excluded: RecommendationExclusion[];
  missing: RecommendationMissing[];
  history: RecommendationHistory;
  constraints: { freeOnly: boolean; hardCostCap: { status: "none" | "unsupported"; requested: string | null; message: string | null } };
  limitations: string[];
  notes: string[];
  digest: string;
  drift: RecommendationDrift | null;
}

const LIMIT = { candidates: 20, excluded: 40, missing: 12, notes: 8, list: 200, item: 400 } as const;

function fail(code: string, message: string): never { throw new RecommendationError(code, message); }

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REQUEST", `${what} is not an object.`);
  return value as Record<string, unknown>;
}
function optionalText(value: unknown, max: number, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) fail("INVALID_REQUEST", `${what} must be a string of at most ${max} characters.`);
  return value;
}
function textList(value: unknown, max: number, itemMax: number, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) fail("INVALID_REQUEST", `${what} must be a list of at most ${max} entries.`);
  return value.map(item => {
    if (typeof item !== "string" || !item.trim() || item.length > itemMax) fail("INVALID_REQUEST", `${what} contains an empty or oversized entry.`);
    return item.trim();
  });
}
function optionalNumber(value: unknown, min: number, max: number, what: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail("INVALID_REQUEST", `${what} must be an integer between ${min} and ${max}.`);
  return value as number;
}
function selectionOf(value: unknown, what: string): ExecutionSelection {
  const item = record(value, what);
  const executorId = item.executorId;
  if (executorId !== "workbuddy" && executorId !== "dsh") fail("INVALID_REQUEST", `${what}.executorId must be workbuddy or dsh.`);
  const field = (key: string, max: number) => {
    const raw = item[key];
    if (typeof raw !== "string" || !raw || raw.length > max) fail("INVALID_REQUEST", `${what}.${key} is required.`);
    return raw;
  };
  const effort = item.reasoningEffort;
  if (effort !== null && effort !== undefined && typeof effort !== "string") fail("INVALID_REQUEST", `${what}.reasoningEffort must be a string or null.`);
  return { executorId, connectionId: field("connectionId", 200), providerId: field("providerId", 200), modelId: field("modelId", 200), reasoningEffort: typeof effort === "string" ? effort.slice(0, 100) : null };
}
const sameSelection = (a: ExecutionSelection | null, b: ExecutionSelection | null) => !!a && !!b && a.executorId === b.executorId && a.connectionId === b.connectionId && a.providerId === b.providerId && a.modelId === b.modelId && (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null);
const sourceIdOf = (execution: Pick<ExecutionSelection, "executorId" | "connectionId" | "providerId">) => JSON.stringify([execution.executorId, execution.connectionId, execution.providerId]);
const selectionKey = (execution: ExecutionSelection) => [execution.executorId, execution.connectionId, execution.providerId, execution.modelId, execution.reasoningEffort ?? ""].join("\u0000");

/** Verified zero rate only: an unverified or unreadable rate is never free. */
const verifiedZero = (credits: string | null, pricingVerified: boolean) => pricingVerified && credits !== null && /^x0(?:\.0+)?(?: credits)?$/i.test(credits.trim());
const knownRate = (credits: string | null, pricingVerified: boolean) => pricingVerified && credits !== null;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}
const digestOf = (value: unknown) => crypto.createHash("sha256").update(canonical(value)).digest("hex");

function readHistory(value: unknown): RecommendationHistory {
  // Nothing observed means no window either: an all-null window would read as "all time".
  const empty = { window: null as { from: string | null; to: string | null } | null, sampleSize: null, coverage: null as Record<string, number> | null, limitations: [] as string[], claims: { savings: null as null, superiority: null as null } };
  if (value === undefined || value === null) return { status: "unavailable", code: "statistics_not_read", ...empty };
  const doc = typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!doc || doc.schemaVersion !== STATISTICS_SCHEMA) return { status: "unavailable", code: "statistics_unreadable", ...empty };
  const coverage = doc.coverage && typeof doc.coverage === "object" ? doc.coverage as Record<string, unknown> : null;
  const number = (key: string) => typeof coverage?.[key] === "number" && Number.isFinite(coverage[key] as number) ? coverage[key] as number : null;
  const sampleSize = number("tasksIncluded");
  const windowRaw = doc.window && typeof doc.window === "object" ? doc.window as Record<string, unknown> : {};
  const window = { from: typeof windowRaw.from === "string" ? windowRaw.from : null, to: typeof windowRaw.to === "string" ? windowRaw.to : null };
  const limitations = Array.isArray(doc.limitations) ? doc.limitations.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  // Partial coverage is named, never rounded up into a complete picture.
  const partial = number("tasksTruncated") === null ? true
    : (number("tasksTruncated") ?? 0) > 0 || (number("eventsTruncated") ?? 0) > 0 || (number("tasksIncomplete") ?? 0) > 0 || (number("tasksWithoutEvents") ?? 0) > 0;
  const counts: Record<string, number> = {};
  for (const key of ["tasksRead", "tasksIncluded", "tasksExcludedOutsideWindow", "tasksWithoutEvents", "tasksIncomplete", "eventsRead", "tasksTruncated", "eventsTruncated"]) {
    const value = number(key);
    if (value !== null) counts[key] = value;
  }
  if (sampleSize === null) return { status: "unavailable", code: "statistics_without_sample", window: null, sampleSize: null, coverage: null, limitations, claims: { savings: null, superiority: null } };
  return { status: partial ? "partial" : "available", code: partial ? "statistics_partial_coverage" : "statistics_window_sample", window, sampleSize, coverage: counts, limitations, claims: { savings: null, superiority: null } };
}

interface ResourceView {
  status: "fresh" | "stale" | "unavailable" | "unverified_claim";
  reference: RecommendationCandidate["resources"]["reference"];
  quotaFreshness: "fresh" | "stale" | "unavailable" | null;
  quotaRemaining: number | null;
  creditBalance: string | null;
  limitations: string[];
}
const noneResources = (code: string): ResourceView => ({ status: "unavailable", reference: null, quotaFreshness: null, quotaRemaining: null, creditBalance: null, limitations: [code, "quota_unobserved", "routing_unverified"] });
/**
 * Resources belong to one execution. Picking the first document in the list
 * would show one model's quota beside another model's rate, so a document only
 * counts for the exact selection it names.
 */
function readResources(value: unknown, execution: ExecutionSelection): ResourceView {
  if (!Array.isArray(value) || !value.length) return noneResources("resource_reference_missing");
  const docs = value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && (item as Record<string, unknown>).schemaVersion === PLAN_REFERENCE_SCHEMA);
  if (!docs.length) return noneResources("resource_reference_unreadable");
  const doc = docs.find(item => {
    const named = item.execution;
    if (!named || typeof named !== "object") return false;
    const other = named as Record<string, unknown>;
    if (other.executorId !== execution.executorId || other.connectionId !== execution.connectionId || other.providerId !== execution.providerId || other.modelId !== execution.modelId) return false;
    return typeof other.reasoningEffort !== "string" || (execution.reasoningEffort !== null && other.reasoningEffort === execution.reasoningEffort);
  });
  if (!doc) return noneResources("resource_reference_other_model");
  const quota = doc.quota && typeof doc.quota === "object" ? doc.quota as Record<string, unknown> : null;
  const credit = doc.credit && typeof doc.credit === "object" ? doc.credit as Record<string, unknown> : null;
  const association = doc.association && typeof doc.association === "object" ? doc.association as Record<string, unknown> : {};
  const caveats = Array.isArray(doc.caveats) ? doc.caveats.filter((item): item is string => typeof item === "string") : [];
  const quotaFreshness = quota && (quota.freshness === "fresh" || quota.freshness === "stale" || quota.freshness === "unavailable") ? quota.freshness : null;
  const limitations = [...caveats];
  if (doc.routingVerified === true) {
    // A document claiming verified routing contradicts the frozen contract;
    // the claim is reported, never trusted.
    return { status: "unverified_claim", reference: { schemaVersion: PLAN_REFERENCE_SCHEMA, generatedAt: typeof doc.generatedAt === "string" ? doc.generatedAt : null, attribution: typeof doc.attribution === "string" ? doc.attribution : null, association: typeof association.status === "string" ? association.status : null, caveats }, quotaFreshness, quotaRemaining: null, creditBalance: null, limitations: [...limitations, "routing_claim_rejected", "routing_unverified"] };
  }
  const remaining = quota && typeof quota.remaining === "number" && Number.isFinite(quota.remaining) ? quota.remaining : null;
  const balance = credit && typeof credit.balance === "string" ? credit.balance : null;
  const status = quotaFreshness === "fresh" ? "fresh" : quotaFreshness === "stale" ? "stale" : "unavailable";
  if (status === "unavailable") limitations.push("quota_unobserved");
  if (!limitations.includes("routing_unverified")) limitations.push("routing_unverified");
  return { status, reference: { schemaVersion: PLAN_REFERENCE_SCHEMA, generatedAt: typeof doc.generatedAt === "string" ? doc.generatedAt : null, attribution: typeof doc.attribution === "string" ? doc.attribution : null, association: typeof association.status === "string" ? association.status : null, caveats }, quotaFreshness, quotaRemaining: remaining, creditBalance: balance, limitations };
}

interface ParsedRequest {
  intent: { title: string; objective: string; allowedChanges: string[]; permittedMetadata: string[]; checks: string[]; maxAttempts: number | null; timeoutSeconds: number | null; sessionId: string | null };
  selection: ExecutionSelection | null;
  freeOnly: boolean;
  hardCostCap: string | null;
  statistics: unknown;
  resources: unknown;
  previous: { digest: string; catalogId: string | null; policyVersion: string | null; selection: ExecutionSelection | null } | null;
}
function parse(parameters: unknown): ParsedRequest {
  const root = record(parameters, "Recommendation request");
  const allowedKeys = ["intent", "constraints", "statistics", "resources", "previous"];
  if (Object.keys(root).some(key => !allowedKeys.includes(key))) fail("INVALID_REQUEST", "Recommendation request contains an unsupported field.");
  const intent = record(root.intent, "Recommendation intent");
  const constraintRaw = root.constraints === undefined ? {} : record(root.constraints, "Recommendation constraints");
  if (Object.keys(constraintRaw).some(key => !["selection", "freeOnly", "hardCostCap"].includes(key))) fail("INVALID_REQUEST", "Recommendation constraints contain an unsupported field.");
  const capRaw = constraintRaw.hardCostCap;
  let hardCostCap: string | null = null;
  if (capRaw !== undefined && capRaw !== null) {
    const cap = record(capRaw, "Hard cost cap");
    if (Object.keys(cap).some(key => !["credits"].includes(key))) fail("INVALID_REQUEST", "Hard cost cap contains an unsupported field.");
    hardCostCap = optionalText(cap.credits, 40, "Hard cost cap") ?? fail("INVALID_REQUEST", "Hard cost cap needs a credits value.");
  }
  if (constraintRaw.freeOnly !== undefined && typeof constraintRaw.freeOnly !== "boolean") fail("INVALID_REQUEST", "freeOnly must be a boolean.");
  const previousRaw = root.previous === undefined || root.previous === null ? null : record(root.previous, "Previous recommendation");
  return {
    intent: {
      title: optionalText(intent.title, 200, "Title")?.trim() ?? "",
      objective: optionalText(intent.objective, 8000, "Objective")?.trim() ?? "",
      allowedChanges: textList(intent.allowedChanges, LIMIT.list, LIMIT.item, "allowedChanges"),
      permittedMetadata: textList(intent.permittedMetadata, 50, LIMIT.item, "permittedMetadata"),
      checks: textList(intent.checks, LIMIT.list, LIMIT.item, "checks"),
      maxAttempts: optionalNumber(intent.maxAttempts, 1, 100, "maxAttempts"),
      timeoutSeconds: optionalNumber(intent.timeoutSeconds, 1, 86_400, "timeoutSeconds"),
      sessionId: optionalText(intent.sessionId, 200, "sessionId"),
    },
    selection: constraintRaw.selection === undefined || constraintRaw.selection === null ? null : selectionOf(constraintRaw.selection, "constraints.selection"),
    freeOnly: constraintRaw.freeOnly === true,
    hardCostCap,
    statistics: root.statistics,
    resources: root.resources,
    previous: previousRaw ? {
      digest: optionalText(previousRaw.digest, 128, "previous.digest") ?? fail("INVALID_REQUEST", "previous.digest is required."),
      catalogId: optionalText(previousRaw.catalogId, 200, "previous.catalogId"),
      policyVersion: optionalText(previousRaw.policyVersion, 200, "previous.policyVersion"),
      selection: previousRaw.selection === undefined || previousRaw.selection === null ? null : selectionOf(previousRaw.selection, "previous.selection"),
    } : null,
  };
}

/**
 * A direct decision is a judgement about shape, never about importance: a
 * read-only or small exact-file change with few checks and one attempt is
 * something the coordinator already handles without an executor attempt.
 */
function directReasons(intent: ParsedRequest["intent"]): { eligible: boolean; reasons: { code: string; message: string }[]; blocked: string | null } {
  const reasons: { code: string; message: string }[] = [];
  const scope = [...intent.allowedChanges, ...intent.permittedMetadata];
  if (!intent.objective || intent.objective.length < 10) return { eligible: false, reasons, blocked: "objective_missing" };
  const glob = scope.filter(entry => entry.includes("*"));
  if (scope.length > 3) return { eligible: false, reasons, blocked: "scope_too_wide" };
  if (glob.length) return { eligible: false, reasons, blocked: "scope_contains_glob" };
  if (intent.checks.length > 3) return { eligible: false, reasons, blocked: "checks_too_many" };
  if (intent.maxAttempts !== null && intent.maxAttempts > 1) return { eligible: false, reasons, blocked: "attempts_more_than_one" };
  reasons.push(scope.length === 0
    ? { code: "direct_read_only", message: "任务为只读，不授予文件写权限。" }
    : { code: "direct_exact_files", message: `只修改 ${scope.length} 个精确路径，没有目录通配。` });
  if (intent.checks.length <= 3) reasons.push({ code: "direct_few_checks", message: `独立验收条目 ${intent.checks.length} 项，可在同一轮完成核对。` });
  reasons.push({ code: "direct_single_attempt", message: "约定为单轮执行，不需要执行器重试。" });
  return { eligible: true, reasons, blocked: null };
}

/**
 * The single entry point: pure, synchronous and deterministic for one intent +
 * one capability snapshot + one clock reading. `catalog` is exactly what the
 * composer received from `catalog`; nothing else is read here, and the caller
 * passes the clock so a replay and a review can be compared exactly.
 */
export function recommendTask(parameters: unknown, catalog: unknown, now: number): Recommendation {
  if (typeof now !== "number" || !Number.isFinite(now)) fail("INVALID_REQUEST", "recommendTask needs an explicit clock reading.");
  const request = parse(parameters);
  const raw = record(catalog, "Capability catalog");
  const models = Array.isArray(raw.models) ? raw.models : fail("CATALOG_UNREADABLE", "The catalog carries no model list.");
  const policyRaw = raw.policy && typeof raw.policy === "object" ? raw.policy as Record<string, unknown> : {};
  const sources = Array.isArray(raw.sources) ? raw.sources as RecommendationSource[] : [];
  const sourceById = new Map(sources.map(source => [source.sourceId, source]));
  const dispatchEnabled = raw.dispatchEnabled === true;
  const catalogId = typeof raw.catalogId === "string" ? raw.catalogId : null;
  const observedAt = typeof raw.observedAt === "string" ? raw.observedAt : null;
  const expiresAt = typeof raw.expiresAt === "string" ? raw.expiresAt : null;
  const fresh = expiresAt !== null && Number.isFinite(Date.parse(expiresAt)) ? Date.parse(expiresAt) > now : false;
  const policyVersion = typeof policyRaw.version === "string" ? policyRaw.version : null;
  const policy = {
    version: policyVersion,
    requireFree: policyRaw.requireFree === true,
    selectionMode: typeof policyRaw.selectionMode === "string" ? policyRaw.selectionMode : null,
    allowedCount: Array.isArray(policyRaw.allowed) ? policyRaw.allowed.length : 0,
    maxAttempts: typeof policyRaw.maxAttempts === "number" ? policyRaw.maxAttempts : null,
    maxTimeoutSeconds: typeof policyRaw.maxTimeoutSeconds === "number" ? policyRaw.maxTimeoutSeconds : null,
    dispatchEnabled,
  };
  const history = readHistory(request.statistics);
  const missing: RecommendationMissing[] = [];
  const addMissing = (code: string, message: string, severity: "blocks" | "limits" = "limits") => { if (!missing.some(item => item.code === code) && missing.length < LIMIT.missing) missing.push({ code, message, severity }); };
  const limitations: string[] = ["recommendation_only", "no_model_call", "no_attempt_created", "routing_unverified"];
  const notes: string[] = [];

  if (history.status === "unavailable") addMissing("no_statistics_sample", "没有可用的历史统计样本；不据此推断质量、节省或优劣。");
  else if (history.status === "partial") addMissing("statistics_partial_coverage", "历史样本只覆盖一部分任务；样本量与时间窗见下，不构成质量结论。");

  const evaluate = (model: RecommendationModel): { candidate: RecommendationCandidate | null; exclusion: RecommendationExclusion | null } => {
    const execution = selectionOf(model.execution, "catalog model");
    const sourceId = sourceIdOf(execution);
    const source = sourceById.get(sourceId) ?? null;
    const state = source?.state ?? "unknown";
    const dispatchable = source ? source.dispatchable === true : false;
    const label = source?.label ?? `${execution.executorId} · ${execution.connectionId} · ${execution.providerId}`;
    const exclude = (code: string, message: string) => ({ candidate: null, exclusion: { selection: execution, sourceLabel: label, code, message } });
    // A catalog read proves listing and policy, not reachability or dispatch.
    if (model.blockedReason) return exclude("policy_blocked", model.blockedReason);
    if (policy.requireFree && !verifiedZero(model.credits, model.pricingVerified)) return exclude("policy_requires_free", "当前部署政策要求已核实的零费率。");
    if (state !== "online") return exclude("source_not_online", source?.stateReason || `来源状态为 ${state}；在线不等于可执行。`);
    if (!dispatchable) return exclude("source_not_dispatchable", "来源已列出但当前不可派工；在线不等于可执行。");
    if (!dispatchEnabled) return exclude("dispatch_not_enabled", "当前安装仅准备任务，尚未启用派工。");
    if (!fresh) return exclude("catalog_expired", "能力快照已过期，请刷新来源与费率后重新评估。");
    const zero = verifiedZero(model.credits, model.pricingVerified);
    const known = knownRate(model.credits, model.pricingVerified);
    if (request.freeOnly && !zero) return exclude("free_only_not_verified", known ? "所选策略只接受已核实的零费率；此候选为付费模型。" : "所选策略只接受已核实的零费率；此候选费用未知，不能当作免费。");
    const resources = readResources(request.resources, execution);
    const reasons: { code: string; message: string }[] = [];
    if (zero) reasons.push({ code: "cost_verified_zero", message: "费率为已核实的零。" });
    else if (known) reasons.push({ code: "cost_observed", message: `观察费率 ${model.credits}；这是读取时的信息，不是总费用。` });
    else reasons.push({ code: "cost_unknown", message: "费用未知，可能计费；不作为免费或硬上限。" });
    if (resources.status === "fresh") reasons.push({ code: "quota_reference_fresh", message: "有新鲜的资源引用（只读快照，路由未核验）。" });
    if (resources.status === "stale") reasons.push({ code: "resource_reference_stale", message: "资源引用已过期，读数不作为当前余量。" });
    if (resources.status === "unavailable") reasons.push({ code: "resource_reference_missing", message: "没有可用的资源引用；余量未知，不当作充足。" });
    if (execution.executorId === "dsh" && !request.intent.sessionId) reasons.push({ code: "session_required", message: "DSH 派工需要本项目中已连接且空闲的会话。" });
    const tier = zero ? (resources.status === "fresh" ? 1 : 2) : known ? (resources.status === "fresh" ? 3 : 4) : 5;
    return {
      candidate: {
        selection: execution, sourceId, sourceLabel: label, sourceState: state, dispatchable: true,
        cost: { credits: model.credits, pricingVerified: model.pricingVerified, known, zero, label: known ? (zero ? "已核实零费率" : `观察费率 ${model.credits}`) : "费用未知，可能计费" },
        resources: { status: resources.status, reference: resources.reference, quotaFreshness: resources.quotaFreshness, quotaRemaining: resources.quotaRemaining, creditBalance: resources.creditBalance, routingVerified: false, limitations: resources.limitations },
        reasons, rank: { tier, rule: "tier_then_lexicographic" },
      },
      exclusion: null,
    };
  };

  const offered: RecommendationCandidate[] = [], excluded: RecommendationExclusion[] = [];
  let unreadable = 0;
  for (const model of models as RecommendationModel[]) {
    try {
      const outcome = evaluate(model);
      if (outcome.candidate) offered.push(outcome.candidate);
      else if (outcome.exclusion && excluded.length < LIMIT.excluded) excluded.push(outcome.exclusion);
    } catch (error) {
      // One malformed catalog row must not hide the rest of the catalog; it is
      // counted and reported instead of silently disappearing.
      if (!(error instanceof RecommendationError)) throw error;
      unreadable++;
    }
  }
  if (unreadable) addMissing("catalog_entry_unreadable", `能力快照中有 ${unreadable} 条模型条目无法解读，已跳过；它们没有参与推荐。`);
  offered.sort((a, b) => (a.rank.tier - b.rank.tier) || (selectionKey(a.selection) < selectionKey(b.selection) ? -1 : selectionKey(a.selection) > selectionKey(b.selection) ? 1 : 0));

  const cap = request.hardCostCap;
  const constraints: Recommendation["constraints"] = {
    freeOnly: request.freeOnly,
    hardCostCap: cap === null ? { status: "none", requested: null, message: null } : { status: "unsupported", requested: cap, message: "网关没有可核验的支出预留，观察费率不能当作硬费用上限；需要硬上限时不能按本次建议派工。" },
  };
  if (cap !== null) { addMissing("hard_cost_cap_unsupported", "无法保证硬费用上限；该要求本身不被接受。", "blocks"); limitations.push("hard_cost_cap_not_guaranteed"); }

  const direct = directReasons(request.intent);
  let decision: RecommendationDecision = "delegate";
  let decisionReason: Recommendation["decisionReason"] = { code: "delegate_best_available", message: "按当前政策与能力快照筛出的首个候选。", codes: [] };
  let recommended: RecommendationCandidate | null = null;
  let userSelection: Recommendation["userSelection"] = null;

  if (cap !== null) {
    decision = "wait"; recommended = null;
    decisionReason = { code: "hard_cost_cap_unsupported", message: constraints.hardCostCap.message ?? "", codes: ["hard_cost_cap_unsupported"] };
  } else if (request.selection) {
    const chosen = offered.find(item => sameSelection(item.selection, request.selection)) ?? null;
    const rejected = excluded.find(item => sameSelection(item.selection, request.selection)) ?? null;
    if (chosen) {
      userSelection = { selection: chosen.selection, status: "available", code: "user_selection_available", message: "用户显式指定，优先于推荐顺序。" };
      recommended = chosen; decision = "delegate";
      decisionReason = { code: "user_selection_wins", message: "用户显式指定的选择可用，按该选择准备；不替换、不合并。", codes: ["user_selection_available"] };
      // An explicit choice outranks a direct suggestion: the user asked for an executor.
    } else {
      const code = rejected?.code ?? "selection_not_in_catalog";
      userSelection = { selection: request.selection, status: "unavailable", code, message: rejected?.message ?? "所选执行不在当前能力快照中；需要刷新来源后重新选择。" };
      decision = "wait"; recommended = null;
      decisionReason = { code: "user_selection_unavailable", message: `${userSelection.message} 不会自动改用其他来源。`, codes: [code] };
      addMissing("user_selection_unavailable", "用户指定的选择当前不可用；等待用户重新选择或恢复来源。", "blocks");
    }
  } else if (direct.eligible) {
    decision = "direct"; recommended = null;
    decisionReason = { code: "direct_small_change", message: "小改可由协调者按既有授权直接处理，不创建原生轮次，也不占用执行器。", codes: direct.reasons.map(reason => reason.code) };
  } else if (!offered.length) {
    decision = "wait";
    decisionReason = { code: "no_candidate", message: "按当前政策与能力快照没有可用候选；不会放宽政策或改选未核验来源。", codes: excluded.slice(0, 4).map(item => item.code) };
    addMissing("no_candidate", "没有满足政策与费用约束的候选；请检查来源、政策或费用条件。", "blocks");
  } else {
    recommended = offered[0]!;
    decision = "delegate";
    decisionReason = { code: offered.length > 1 ? "delegate_ranked_candidates" : "delegate_single_candidate", message: offered.length > 1 ? `共 ${offered.length} 个候选，按档位与字典序确定首个；这是政策顺序，不是质量或价格排名。` : "只有一个可用候选。", codes: [recommended.reasons[0]?.code ?? "candidate"] };
    if (offered.length > 1) notes.push("多候选：排序是确定的政策顺序（零费率/已观测费率/未知费用，其次字典序），不是质量排名；未测量质量时不给分数。");
    if (!recommended.cost.known) addMissing("pricing_unknown", "首个候选的费用未知，可能计费；未知不等于免费，也不是上限。");
  }
  if (direct.blocked && !request.selection && !cap && !offered.length) addMissing("direct_not_applicable", `未按直接处理：${direct.blocked}。`);

  if (request.intent.checks.length === 0) addMissing("checks_missing", "尚未填写独立验收要求，核对时会被拒绝。");
  if (history.status !== "unavailable" && history.sampleSize === 0) notes.push("统计窗口内没有任何任务样本；零样本不能证明质量或耗费。");
  notes.push("推荐只描述当前能力快照；确认前会重新核验目录、政策、费率、资源快照与绑定关系。");
  if (!fresh) addMissing("catalog_expired", "能力快照已过期；刷新后重新评估，不会自动换用其他来源。", "blocks");

  const base = {
    schemaVersion: RECOMMENDATION_SCHEMA, explanationVersion: RECOMMENDATION_EXPLANATION_VERSION, mode: "recommend" as const,
    decision, catalog: { catalogId, observedAt, expiresAt, fresh }, policy, decisionReason,
    constraints, intent: request.intent, recommendedSelection: recommended?.selection ?? null,
    candidates: offered.map(item => ({ selection: item.selection, tier: item.rank.tier, cost: item.cost, resources: { status: item.resources.status, quotaFreshness: item.resources.quotaFreshness }, reasons: item.reasons.map(reason => reason.code) })),
    excluded: excluded.map(item => ({ selection: item.selection, code: item.code })),
    missing: missing.map(item => item.code),
    history: { status: history.status, sampleSize: history.sampleSize, window: history.window, counts: history.coverage },
  };
  // The digest proves the terms a person confirms, not the explanatory envelope.
  // It used to cover every candidate with its resource freshness and the usage
  // history, so two reads of identical terms hashed differently whenever a quota
  // clock ticked, and the confirmation reported drift for an agreement nobody
  // changed. Timestamps, candidate order and history still travel in the payload.
  const digest = digestOf({
    schemaVersion: RECOMMENDATION_SCHEMA, explanationVersion: RECOMMENDATION_EXPLANATION_VERSION,
    catalogId, fresh, policyVersion, decision, recommendedSelection: recommended?.selection ?? null,
    offeredSelections: offered.map(item => item.selection), excludedSelections: excluded.map(item => item.selection),
    intent: request.intent, constraints,
  });

  let drift: RecommendationDrift | null = null;
  if (request.previous) {
    const codes: string[] = [];
    if (request.previous.digest !== digest) {
      if (request.previous.catalogId !== catalogId) codes.push("catalog_changed");
      if (request.previous.policyVersion !== policyVersion) codes.push("policy_changed");
      if (request.previous.selection && !sameSelection(request.previous.selection, recommended?.selection ?? null)) codes.push("selection_changed");
      if (!fresh) codes.push("snapshot_expired");
      if (!codes.length) codes.push("snapshot_changed");
    }
    drift = { codes, message: codes.length ? "能力快照、政策或选择已变化；请重新核对并生成新的任务版本，不会自动改用其他来源。" : "与上次评估一致。", blockedForDispatch: codes.length > 0 };
  }

  return {
    schemaVersion: RECOMMENDATION_SCHEMA, explanationVersion: RECOMMENDATION_EXPLANATION_VERSION, readOnly: true,
    generatedAt: new Date(now).toISOString(), decision, mode: "recommend",
    authorization: { state: "none", requires: ["preview", "confirmation"] },
    attempt: null, nativeAttempt: "none",
    catalog: { catalogId, observedAt, expiresAt, fresh }, policy, decisionReason, userSelection,
    recommended, candidates: offered.slice(0, LIMIT.candidates), excluded, missing,
    history, constraints,
    limitations: [...new Set(limitations)].slice(0, 10),
    notes: notes.slice(0, LIMIT.notes),
    digest, drift,
  };
}
