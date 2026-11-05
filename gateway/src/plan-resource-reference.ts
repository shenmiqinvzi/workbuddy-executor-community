import fs from "node:fs";
import type { ExecutionSelection } from "./task-contract.js";

/**
 * Read-only resource reference for one prepared task plan.
 *
 * An execution selection and a statistics connection live in different id
 * namespaces (`local-workbuddy` / a DSH host id versus the gateway's quota
 * source id). Nothing in the gateway maps one to the other today, so this
 * module only links them when a deployment publishes an explicit declaration.
 * A matching model name alone is never treated as a link.
 */
export const EXECUTION_LINKS_SCHEMA = "workbuddy-executor/execution-links-1";
export const PLAN_REFERENCE_SCHEMA = "workbuddy-executor/plan-resource-reference-1";

export interface ExecutionLink {
  executorId: "workbuddy" | "dsh";
  executionConnectionId: string;
  providerId: string;
  models: string[];
  realm: "cn" | "intl" | null;
  quotaConnectionId: string;
  creditConnectionId: string | null;
  declaredAt: string;
  note?: string;
}

export interface ExecutionLinkSource {
  status: "declared" | "absent" | "invalid";
  code: string | null;
  links: ExecutionLink[];
}

export interface PlanResourceExecution {
  executorId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string | null;
}

type QuotaDocument = ReturnType<typeof import("./quota-observation.js").readQuotaResources>;
type CreditDocument = ReturnType<typeof import("./credit-balance.js").readCreditBalances>;
type QuotaObservation = QuotaDocument["observations"][number];
type QuotaConnection = QuotaDocument["connections"][number];
type CreditBalance = CreditDocument["balances"][number];
type CreditConnection = CreditDocument["connections"][number];

export interface PlanResourceReference {
  schemaVersion: typeof PLAN_REFERENCE_SCHEMA;
  readOnly: true;
  generatedAt: string;
  execution: PlanResourceExecution;
  link: {
    status: ExecutionLinkSource["status"];
    source: "WORKBUDDY_RESOURCE_LINKS_FILE";
    code: string | null;
    declaredAt: string | null;
    realm: "cn" | "intl" | null;
    modelsCount: number;
  };
  association: { status: string; reason: string; candidates?: number };
  quota: {
    connectionId: string;
    scopeId: string;
    realm: "cn" | "intl";
    modelId: string;
    unit: "tokens";
    valueKind: string;
    availability: string;
    used: number | null;
    budget: number | null;
    remaining: number | null;
    resetAt: string | null;
    method: string;
    sourceObservedAt: string | null;
    collectedAt: string | null;
    expiresAt: string | null;
    freshness: "fresh" | "stale" | "unavailable";
    snapshotId: string | null;
    limitations: string[];
  } | null;
  otherQuotaSources: { connectionId: string }[];
  credit: {
    connectionId: string;
    scopeId: string;
    realm: string;
    unit: "credit";
    valueKind: "reported_cache";
    balance: number | null;
    accountsEnabled: number;
    accountsWithData: number;
    coverage: string;
    latestMemberObservedAt: string | null;
    collectedAt: string;
    cacheExpiresAt: string;
    cacheFreshness: string;
    balanceFreshness: string;
    limitations: string[];
  } | null;
  creditState: string | null;
  caveats: string[];
  routingVerified: false;
  attribution: "execution_link_declared" | "none";
}

const LINK_KEYS = ["executorId", "executionConnectionId", "providerId", "models", "realm", "quotaConnectionId", "creditConnectionId", "declaredAt"] as const;
const MAX_TEXT = 200;

function fail(code: string): never {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  throw error;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) fail(`links_entry_invalid:${field}`);
  return value;
}

function time(value: unknown, field: string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) fail(`links_entry_invalid:${field}`);
  return value as string;
}

function parseLink(input: unknown): ExecutionLink {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("links_entry_invalid:entry");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowed = [...LINK_KEYS, "note"].sort();
  if (keys.some(key => !allowed.includes(key))) fail("links_entry_invalid:unknown_key");
  for (const key of LINK_KEYS) if (!(key in record)) fail(`links_entry_invalid:missing:${key}`);
  if (record.executorId !== "workbuddy" && record.executorId !== "dsh") fail("links_entry_invalid:executorId");
  if (record.realm !== null && record.realm !== "cn" && record.realm !== "intl") fail("links_entry_invalid:realm");
  if (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > 50) fail("links_entry_invalid:models");
  const models = record.models.map(model => text(model, "models"));
  if (new Set(models).size !== models.length) fail("links_entry_invalid:models");
  if (record.creditConnectionId !== null) text(record.creditConnectionId, "creditConnectionId");
  if (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 500)) fail("links_entry_invalid:note");
  return {
    executorId: record.executorId,
    executionConnectionId: text(record.executionConnectionId, "executionConnectionId"),
    providerId: text(record.providerId, "providerId"),
    models,
    realm: record.realm as "cn" | "intl" | null,
    quotaConnectionId: text(record.quotaConnectionId, "quotaConnectionId"),
    creditConnectionId: record.creditConnectionId as string | null,
    declaredAt: time(record.declaredAt, "declaredAt"),
    ...(record.note === undefined ? {} : { note: record.note as string }),
  };
}

/** Reads the deployment's declared execution-to-statistics links. Never writes. */
export function readExecutionLinks(env: NodeJS.ProcessEnv = process.env): ExecutionLinkSource {
  const file = env.WORKBUDDY_RESOURCE_LINKS_FILE;
  if (!file || file.length === 0) return { status: "absent", code: null, links: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "links_file_missing" : "links_file_unreadable";
    return { status: "invalid", code, links: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", code: "links_file_invalid_json", links: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "invalid", code: "links_schema_mismatch", links: [] };
  const document = parsed as Record<string, unknown>;
  if (document.schemaVersion !== EXECUTION_LINKS_SCHEMA || !Array.isArray(document.links)) return { status: "invalid", code: "links_schema_mismatch", links: [] };
  if (Object.keys(document).some(key => key !== "schemaVersion" && key !== "links")) return { status: "invalid", code: "links_schema_mismatch", links: [] };
  if (document.links.length > 32) return { status: "invalid", code: "links_entry_invalid:too_many", links: [] };
  const links: ExecutionLink[] = [];
  for (const entry of document.links) {
    try {
      links.push(parseLink(entry));
    } catch (error) {
      return { status: "invalid", code: (error as Error & { code?: string }).code ?? "links_entry_invalid", links: [] };
    }
  }
  const seen = new Set<string>();
  for (const link of links) {
    const key = `${link.executorId}\u0000${link.executionConnectionId}\u0000${link.providerId}\u0000${link.quotaConnectionId}`;
    if (seen.has(key)) return { status: "invalid", code: "links_entry_invalid:duplicate", links: [] };
    seen.add(key);
  }
  return { status: "declared", code: null, links };
}

/**
 * Every declaration that covers this exact execution selection. The reader
 * must see the whole set: the duplicate check keys on the statistics
 * connection too, so one selection can legitimately be declared twice, and
 * picking the first entry would make the answer depend on array order.
 */
function findLinks(links: ExecutionLink[], execution: PlanResourceExecution): ExecutionLink[] {
  return links.filter(link => link.executorId === execution.executorId
    && link.executionConnectionId === execution.connectionId
    && link.providerId === execution.providerId
    && link.models.includes(execution.modelId));
}

function quotaConnection(document: QuotaDocument, id: string): QuotaConnection | undefined {
  return document.connections.find(connection => connection.connectionId === id);
}

/**
 * Rows that the given statistics connection owns for this model, optionally
 * narrowed to the declared region. One connection can own several rows for one
 * model when the same pool is observed in more than one region, so the caller
 * decides what an unindexed set means instead of reading the first entry.
 */
function scopedObservations(document: QuotaDocument, connectionId: string, execution: PlanResourceExecution, realm: "cn" | "intl" | null): QuotaObservation[] {
  return document.observations.filter(observation => observation.modelId === execution.modelId
    && observation.connectionId === connectionId
    && (realm === null || observation.realm === realm));
}

/**
 * Combines a saved execution selection with saved resource snapshots.
 * Every number, timestamp and level comes from a single observation or balance
 * row; the other connections of a shared pool are only listed as sources.
 */
export function buildPlanResourceReference(input: {
  execution: PlanResourceExecution;
  links: ExecutionLinkSource;
  quota: QuotaDocument;
  credit: CreditDocument;
  now: string;
}): PlanResourceReference {
  const { execution, links, quota, credit, now } = input;
  const candidateLinks = findLinks(links.links, execution);
  const link = candidateLinks.length === 1 ? (candidateLinks[0] ?? null) : null;
  const base = {
    schemaVersion: PLAN_REFERENCE_SCHEMA as typeof PLAN_REFERENCE_SCHEMA,
    readOnly: true as const,
    generatedAt: now,
    execution: {
      executorId: execution.executorId,
      connectionId: execution.connectionId,
      providerId: execution.providerId,
      modelId: execution.modelId,
      reasoningEffort: execution.reasoningEffort,
    },
    caveats: [
      "resource_reference_only",
      "not_task_usage",
      "not_a_spend_limit",
      "routing_unverified",
    ],
  };
  // More than one declaration covers this exact execution selection. The
  // selection carries no evidence that would order them, so no entry is
  // "the" source: report the conflict and withhold every read rather than let
  // the file's array order decide which balance a plan is shown.
  if (candidateLinks.length > 1) {
    return {
      ...base,
      link: { status: links.status, source: "WORKBUDDY_RESOURCE_LINKS_FILE", code: null, declaredAt: null, realm: null, modelsCount: 0 },
      association: { status: "linked_ambiguous", reason: "multiple_declared_links", candidates: candidateLinks.length },
      quota: null,
      otherQuotaSources: [],
      credit: null,
      creditState: "ambiguous",
      routingVerified: false,
      attribution: "none",
    };
  }
  if (!link) {
    return {
      ...base,
      link: { status: links.status, source: "WORKBUDDY_RESOURCE_LINKS_FILE", code: links.code, declaredAt: null, realm: null, modelsCount: 0 },
      association: { status: links.status === "invalid" ? "link_invalid" : "unlinked", reason: links.status === "invalid" ? (links.code ?? "links_invalid") : "no_declared_link" },
      quota: null,
      otherQuotaSources: [],
      credit: null,
      creditState: null,
      routingVerified: false,
      attribution: "none",
    };
  }
  const linkInfo = { status: links.status, source: "WORKBUDDY_RESOURCE_LINKS_FILE" as const, code: null, declaredAt: link.declaredAt, realm: link.realm, modelsCount: link.models.length };
  const connection = quotaConnection(quota, link.quotaConnectionId);
  // Rows this connection owns for this model, before and after the region
  // filter. A declared region constrains the evidence; it never relabels it,
  // and rows from two regions are never merged into one reading.
  const modelRows = scopedObservations(quota, link.quotaConnectionId, execution, null);
  const rows = link.realm === null ? modelRows : modelRows.filter(row => row.realm === link.realm);
  if (rows.length > 1) {
    // One declaration but several undistinguishable rows, because the
    // declaration leaves the region open. Preferring one would invent an order.
    return {
      ...base,
      link: linkInfo,
      association: { status: "linked_ambiguous", reason: "ambiguous_quota_observation", candidates: 1 },
      quota: null,
      otherQuotaSources: [],
      credit: null,
      creditState: "ambiguous",
      routingVerified: false,
      attribution: "none",
    };
  }
  const observation = rows.length === 1 ? (rows[0] ?? null) : null;
  // The connection does report this model, but not in the declared region.
  const regionMismatch = observation === null && link.realm !== null && modelRows.length > 0;
  // The aggregated view keeps one row per pool/model and names the connection
  // that supplied it. When another connection won that row this plan's source
  // is still a reporter, but its own numbers are not separately available —
  // borrow them from the winner would mix evidence from two snapshots. The
  // declared region applies here too, so a row from another region is never
  // offered as this plan's aggregate.
  const reportedElsewhere = observation ? undefined : quota.observations.find(item => item.modelId === execution.modelId
    && item.connectionIds.includes(link.quotaConnectionId)
    && (link.realm === null || item.realm === link.realm));
  let status = "linked";
  let reason = "declared_link";
  let quotaBlock: PlanResourceReference["quota"] = null;
  if (!connection) {
    status = "linked_not_configured";
    reason = "quota_source_missing";
  } else if (regionMismatch) {
    status = "linked_realm_mismatch";
    reason = "observation_realm_mismatch";
  } else if (reportedElsewhere) {
    status = "linked_rows_elsewhere";
    reason = "aggregate_owned_by_other_source";
  } else if (!observation) {
    status = connection.status === "observed" ? "linked_not_observed" : "linked_no_snapshot";
    reason = connection.status === "observed" ? "no_observation_for_model" : (connection.errorCode ?? `connection_${connection.status}`);
  } else {
    quotaBlock = {
      connectionId: observation.connectionId,
      scopeId: observation.scopeId,
      realm: observation.realm as "cn" | "intl",
      modelId: observation.modelId,
      unit: "tokens",
      valueKind: observation.valueKind,
      availability: observation.availability,
      used: observation.used,
      budget: observation.budget,
      remaining: observation.remaining,
      resetAt: observation.resetAt,
      method: observation.method,
      sourceObservedAt: observation.sourceObservedAt,
      collectedAt: observation.collectedAt,
      expiresAt: connection.expiresAt,
      freshness: connection.freshness as "fresh" | "stale" | "unavailable",
      snapshotId: observation.snapshotId,
      limitations: observation.limitations,
    };
  }
  // A shared pool can be reported by several connections. Only the connection
  // that owns this row supplies values; the others stay listed as sources.
  const otherQuotaSources = observation
    ? observation.connectionIds.filter(id => id !== observation.connectionId).map(connectionId => ({ connectionId }))
    : reportedElsewhere ? [{ connectionId: reportedElsewhere.connectionId }] : [];
  let creditBlock: PlanResourceReference["credit"] = null;
  let creditState: string | null = link.creditConnectionId ? "not_configured" : null;
  if (link.creditConnectionId) {
    const creditConnection: CreditConnection | undefined = credit.connections.find(item => item.connectionId === link.creditConnectionId);
    // The declared region constrains credit exactly as it constrains quota. A
    // balance reported for another region is not this plan's credit; it is
    // withheld rather than shown, relabelled or merged with anything.
    const connectionBalances: CreditBalance[] = credit.balances.filter(item => item.connectionId === link.creditConnectionId);
    const scopedBalances = link.realm === null ? connectionBalances : connectionBalances.filter(item => item.realm === link.realm);
    const balance: CreditBalance | undefined = scopedBalances[0];
    if (connectionBalances.length > 0 && scopedBalances.length === 0) {
      creditState = "realm_mismatch";
    } else if (balance) {
      creditState = "available";
      creditBlock = {
        connectionId: balance.connectionId,
        scopeId: balance.scopeId,
        realm: balance.realm,
        unit: "credit",
        valueKind: "reported_cache",
        balance: balance.balance,
        accountsEnabled: balance.accountsEnabled,
        accountsWithData: balance.accountsWithData,
        coverage: balance.coverage,
        latestMemberObservedAt: balance.latestMemberObservedAt,
        collectedAt: balance.collectedAt,
        cacheExpiresAt: balance.cacheExpiresAt,
        cacheFreshness: (creditConnection?.cacheFreshness ?? "unavailable") as "fresh" | "stale" | "unavailable",
        balanceFreshness: balance.balanceFreshness,
        limitations: balance.limitations,
      };
    } else if (creditConnection) {
      creditState = creditConnection.status === "observed" ? "not_observed" : "no_snapshot";
    }
  }
  return {
    ...base,
    link: linkInfo,
    association: { status, reason },
    quota: quotaBlock,
    otherQuotaSources,
    credit: creditBlock,
    creditState,
    routingVerified: false,
    attribution: "execution_link_declared",
  };
}

export function planExecutionFrom(selection: ExecutionSelection): PlanResourceExecution {
  return {
    executorId: selection.executorId,
    connectionId: selection.connectionId,
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort,
  };
}
