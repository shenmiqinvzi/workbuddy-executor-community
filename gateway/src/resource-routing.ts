import type { readQuotaResources } from "./quota-observation.js";
import type { readCreditBalances } from "./credit-balance.js";
import { diagnoseResourceConnections, readResourceConnections, type ResourceConnectionDocument } from "./resource-connections.js";
import { buildRequestAttribution, type RequestAttributionGap } from "./resource-attribution.js";

/**
 * Routing evidence is its own versioned document.
 *
 * quota-1 and credit-balance-1 describe what the gateway observed about a
 * shared pool; neither payload carries a task identifier, a session, or a
 * provider selection. This document therefore states, per connection and per
 * pool scope, *which* pool a configured source reported and *how strong* that
 * statement is — and it never upgrades "a source reported this pool" into
 * "this task may spend it".
 *
 * Contract revision (still `routing-evidence-1`): a mapping's `level`,
 * `sourceObservedAt`, `expiresAt`, `availability`, `coverage` and
 * `memberFreshness` now always come from one traceable snapshot — the one the
 * aggregate view actually selected, named by `primaryConnectionId`. A level is
 * never borrowed from another reporter. `sources[]` lists every connection that
 * reported the same scope at its own level, so a difference stays visible
 * instead of being merged away.
 *
 * A missing source time is reported as `unavailable` with
 * `evidenceReason: "source_time_unknown"`; `expired` is reserved for a snapshot
 * that was positively proven stale (its stored expiry passed, or its collection
 * reported an error). The added fields are additive for consumers that only
 * read `level`.
 */
export const ROUTING_EVIDENCE_SCHEMA = "workbuddy-executor/routing-evidence-1";

export type QuotaView = ReturnType<typeof readQuotaResources>;
export type CreditView = ReturnType<typeof readCreditBalances>;

/** Strength order: a stronger statement replaces a weaker one for one scope. */
export type EvidenceLevel = "observed" | "expired" | "unavailable" | "unobserved";

/** Why a level was chosen. Distinguishes "proven old" from "time unknown". */
export type EvidenceReason =
  | "snapshot_fresh"
  | "snapshot_expired"
  | "source_time_unknown"
  | "source_error"
  | "source_unavailable"
  | "no_snapshot"
  | "source_missing"
  | "cache_fresh"
  | "cache_expired";

/** Things this document structurally cannot answer, whatever the data says. */
export const UNRESOLVED_ROUTING = [
  { code: "task_to_model", reason: "上游载荷只有账号×模型聚合，没有任务标识，无法把任务映射到模型。" },
  { code: "session_to_provider", reason: "没有 DSH host/session 与 provider 的对应字段，会话级选择无法核对。" },
  { code: "key_scope", reason: "载荷不声明 API Key 的权限范围，只能确认该密钥读通了这条统计链路。" },
  { code: "exclusive_reservation", reason: "共享池余额是可调度容量，不是已为本任务预留或独占的额度。" },
] as const;

export interface RoutingConnection {
  connectionId: string;
  resource: "quota" | "credit";
  status: "observed" | "not_observed" | "unavailable";
  errorCode: string | null;
  level: EvidenceLevel;
  reason: EvidenceReason;
  snapshotId: string | null;
  sourceObservedAt: string | null;
  collectedAt: string | null;
  expiresAt: string | null;
}

/** One reporter of a scope, kept at its own level. */
export interface RoutingSource {
  connectionId: string;
  level: EvidenceLevel;
  reason: EvidenceReason;
  snapshotId: string | null;
  sourceObservedAt: string | null;
  collectedAt: string | null;
  expiresAt: string | null;
}

export interface RoutingMapping {
  scopeId: string;
  scopeKind: "gateway_pool" | "gateway_region_pool";
  shared: true;
  realm: string;
  /** null for the credit pool: the payload carries no per-model dimension. */
  modelId: string | null;
  unit: "tokens" | "credit";
  /** The level of the snapshot selected below — never of another reporter. */
  level: EvidenceLevel;
  evidenceReason: EvidenceReason;
  /** The connection whose snapshot produced every other field of this mapping. */
  primaryConnectionId: string;
  connectionIds: string[];
  /** Every reporter of this scope, each at its own level. */
  sources: RoutingSource[];
  sourceObservedAt: string | null;
  expiresAt: string | null;
  /** token pools only. */
  availability?: "available" | "exhausted" | "unknown";
  /** credit pools only. */
  coverage?: "complete" | "partial" | "unavailable";
  /** credit pools only: member-data freshness, separate from the cache read. */
  memberFreshness?: "stale" | "unavailable";
  /**
   * Present only when the merged records disagreed about this scope. A reader
   * must not treat the single figure as if every reporter agreed on it.
   */
  conflict?: { codes: RoutingAmbiguityCode[]; unresolved: true };
}

/**
 * Ways a scope can be reported by more than one record without those records
 * agreeing. None of them may be resolved by taking the first array element.
 */
export type RoutingAmbiguityCode =
  | "multiple_connections"
  | "level_disagreement"
  | "availability_disagreement"
  | "source_time_disagreement"
  | "realm_conflict"
  | "unit_conflict";

export interface RoutingAmbiguity {
  code: RoutingAmbiguityCode;
  scopeId: string;
  unit: "tokens" | "credit";
  modelId: string | null;
  /** Every connection implicated in the disagreement, sorted. */
  connectionIds: string[];
  detail: string;
}

interface Evaluated {
  level: EvidenceLevel;
  reason: EvidenceReason;
}

/**
 * A quota snapshot's level. `unavailable` covers both "the last refresh failed"
 * and "a snapshot exists but its source time was never recorded"; only the
 * reason tells them apart, and neither is reported as a proven expiry.
 */
function evaluateQuota(connection: {
  status: string;
  errorCode: string | null;
  freshness: string;
  snapshotId: string | null;
  sourceObservedAt: string | null;
}): Evaluated {
  if (connection.errorCode) return { level: "unavailable", reason: "source_error" };
  if (connection.status === "unavailable") return { level: "unavailable", reason: "source_unavailable" };
  if (connection.status === "not_observed" || !connection.snapshotId) return { level: "unobserved", reason: "no_snapshot" };
  if (!connection.sourceObservedAt) return { level: "unavailable", reason: "source_time_unknown" };
  if (connection.freshness === "fresh") return { level: "observed", reason: "snapshot_fresh" };
  return { level: "expired", reason: "snapshot_expired" };
}

/** A credit snapshot's level is its cache read; member freshness stays separate. */
function evaluateCredit(connection: {
  status: string;
  errorCode: string | null;
  cacheFreshness: string;
  snapshotId: string | null;
}): Evaluated {
  if (connection.errorCode) return { level: "unavailable", reason: "source_error" };
  if (connection.status === "unavailable") return { level: "unavailable", reason: "source_unavailable" };
  if (connection.status === "not_observed" || !connection.snapshotId) return { level: "unobserved", reason: "no_snapshot" };
  if (connection.cacheFreshness === "fresh") return { level: "observed", reason: "cache_fresh" };
  return { level: "expired", reason: "cache_expired" };
}

/** An unexpected connection status is reported as a read failure, never
 *  silently folded into "not observed" or "observed". */
function connectionStatus(value: string): RoutingConnection["status"] {
  if (value === "observed" || value === "not_observed" || value === "unavailable") return value;
  throw new Error("routing_evidence_unknown_status");
}

const keyOf = (resource: "quota" | "credit", connectionId: string) => `${resource}:${connectionId}`;

/** A per-connection reading that the merged quota row keeps alongside itself. */
interface QuotaReadingLike {
  connectionId: string; realm: string;
  availability: "available" | "exhausted" | "unknown";
  sourceObservedAt: string | null;
}
function readingsOf(observation: unknown): QuotaReadingLike[] {
  const value = (observation as { readings?: unknown }).readings;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is QuotaReadingLike =>
    Boolean(item) && typeof item === "object" && typeof (item as QuotaReadingLike).connectionId === "string");
}

function sourceOf(entry: RoutingConnection | undefined, connectionId: string): RoutingSource {
  if (!entry) {
    return { connectionId, level: "unobserved", reason: "source_missing", snapshotId: null, sourceObservedAt: null, collectedAt: null, expiresAt: null };
  }
  return {
    connectionId: entry.connectionId, level: entry.level, reason: entry.reason, snapshotId: entry.snapshotId,
    sourceObservedAt: entry.sourceObservedAt, collectedAt: entry.collectedAt, expiresAt: entry.expiresAt,
  };
}

/**
 * Inputs that are not part of the stored resource views.
 *
 * They are optional so a caller that only has the two documents keeps the exact
 * behaviour it had; when omitted, the declaration file named by the environment
 * is read (the same read-path precedent as the execution-link file) and the
 * request-attribution gap is stated from the contract.
 */
export interface RoutingEvidenceContext {
  connections?: ResourceConnectionDocument;
  attribution?: RequestAttributionGap;
}

/**
 * Reads exactly the two saved resource views. It adds no probe, no upstream
 * call and no second copy of the resource arithmetic: every fact here is
 * derived from what the collectors already stored.
 */
export function buildRoutingEvidence(quota: QuotaView, credit: CreditView, now: Date = new Date(), context: RoutingEvidenceContext = {}) {
  const connections: RoutingConnection[] = [];
  const byKey = new Map<string, RoutingConnection>();
  const mappings = new Map<string, RoutingMapping>();
  /** The cache expiry of the same credit snapshot, when it is traceable. */
  const creditExpiry = new Map<string, string>();
  for (const balance of credit.balances) creditExpiry.set(balance.connectionId, balance.cacheExpiresAt);

  for (const connection of quota.connections) {
    const evaluated = evaluateQuota(connection);
    const entry: RoutingConnection = {
      connectionId: connection.connectionId, resource: "quota", status: connectionStatus(connection.status), errorCode: connection.errorCode,
      level: evaluated.level, reason: evaluated.reason, snapshotId: connection.snapshotId,
      sourceObservedAt: connection.sourceObservedAt, collectedAt: connection.collectedAt, expiresAt: connection.expiresAt,
    };
    connections.push(entry);
    byKey.set(keyOf("quota", connection.connectionId), entry);
  }
  for (const connection of credit.connections) {
    const evaluated = evaluateCredit(connection);
    const entry: RoutingConnection = {
      connectionId: connection.connectionId, resource: "credit", status: connectionStatus(connection.status), errorCode: connection.errorCode,
      level: evaluated.level, reason: evaluated.reason, snapshotId: connection.snapshotId,
      sourceObservedAt: null, collectedAt: connection.collectedAt, expiresAt: creditExpiry.get(connection.connectionId) ?? null,
    };
    connections.push(entry);
    byKey.set(keyOf("credit", connection.connectionId), entry);
  }

  /**
   * One scope is one primary snapshot. A second record for the same key (which
   * a narrowed read can produce) never changes the level or the numbers: it
   * only adds its connection to the reporter list, so no field is imported from
   * a source other than the one named by `primaryConnectionId`.
   *
   * Merging is not agreeing. When the merged records disagree (another
   * connection reports the same scope, a different level, availability or
   * source time) the disagreement is recorded instead of being resolved by
   * whichever array element happened to come first.
   */
  const ambiguities: RoutingAmbiguity[] = [];
  const noted = new Set<string>();
  const note = (code: RoutingAmbiguityCode, mapping: { scopeId: string; unit: "tokens" | "credit"; modelId: string | null }, detail: string, connectionIds: string[]) => {
    const dedupe = `${code}|${mapping.scopeId}|${mapping.unit}|${mapping.modelId ?? ""}`;
    const prior = ambiguities.find(item => `${item.code}|${item.scopeId}|${item.unit}|${item.modelId ?? ""}` === dedupe);
    if (prior) {
      for (const id of connectionIds) if (!prior.connectionIds.includes(id)) prior.connectionIds.push(id);
      prior.connectionIds.sort();
      return;
    }
    noted.add(dedupe);
    ambiguities.push({
      code, scopeId: mapping.scopeId, unit: mapping.unit, modelId: mapping.modelId ?? null,
      connectionIds: [...new Set(connectionIds)].sort(), detail,
    });
  };
  const upsert = (mapping: RoutingMapping) => {
    const key = `${mapping.scopeId}|${mapping.unit}|${mapping.modelId ?? ""}`;
    const prior = mappings.get(key);
    if (!prior) { mappings.set(key, mapping); return; }
    const before = { level: prior.level, availability: prior.availability, sourceObservedAt: prior.sourceObservedAt };
    for (const source of mapping.sources) {
      if (!prior.connectionIds.includes(source.connectionId)) prior.connectionIds.push(source.connectionId);
      if (!prior.sources.some(item => item.connectionId === source.connectionId)) prior.sources.push(source);
    }
    if (mapping.primaryConnectionId !== prior.primaryConnectionId) {
      note("multiple_connections", prior,
        "the same scope is reported by more than one connection; the figure is a pool merge, not one source",
        [...prior.connectionIds]);
    }
    if (mapping.level !== prior.level) {
      note("level_disagreement", prior, `merged records disagree on the evidence level (${before.level} vs ${mapping.level})`,
        prior.connectionIds);
    }
    if (mapping.availability !== undefined && prior.availability !== undefined && mapping.availability !== prior.availability) {
      // Two sources disagreeing on exhaustion is not "available": it is unknown.
      note("availability_disagreement", prior,
        `merged records disagree on availability (${before.availability} vs ${mapping.availability})`, prior.connectionIds);
      prior.availability = "unknown";
    }
    if (mapping.sourceObservedAt !== null && prior.sourceObservedAt !== null && mapping.sourceObservedAt !== prior.sourceObservedAt) {
      note("source_time_disagreement", prior,
        `merged records disagree on the source time (${before.sourceObservedAt} vs ${mapping.sourceObservedAt})`, prior.connectionIds);
    }
    if (mapping.realm !== prior.realm) {
      // One scope id with two realms is two pools in reality; the merged row
      // keeps the first realm but must not present itself as one region.
      note("realm_conflict", prior, `merged records disagree on the realm (${prior.realm} vs ${mapping.realm})`, prior.connectionIds);
    }
  };

  for (const observation of quota.observations) {
    const primary = byKey.get(keyOf("quota", observation.connectionId));
    const evaluated: Evaluated = primary ? { level: primary.level, reason: primary.reason } : { level: "unobserved", reason: "source_missing" };
    // The expiry only travels with the snapshot it belongs to.
    const expiresAt = primary && primary.snapshotId === observation.snapshotId ? primary.expiresAt : null;
    // The merged row carries every connection's own reading. When those
    // readings disagree the disagreement is stated here; the merged figure is
    // not allowed to stand in for an agreement that never happened.
    const readings = readingsOf(observation);
    const availability = observation.availability;
    if (readings.length > 1) {
      const identity: { scopeId: string; unit: "tokens" | "credit"; modelId: string | null } = { scopeId: observation.scopeId, unit: "tokens", modelId: observation.modelId };
      const ids = readings.map(item => item.connectionId);
      note("multiple_connections", identity,
        "the same scope is reported by more than one connection; the figure is a pool merge, not one source", ids);
      const availabilities = [...new Set(readings.map(item => item.availability))].sort();
      if (availabilities.length > 1) {
        // The merged figure stays the reading of one named source (it is never
        // blended), and every reading stays attached to its own connection, so
        // the disagreement is visible without inventing a shared state.
        note("availability_disagreement", identity,
          `the same scope is reported as ${availabilities.join(" vs ")}; each reading stays with its own source`, ids);
      }
      const realms = [...new Set(readings.map(item => item.realm))].sort();
      if (realms.length > 1) {
        note("realm_conflict", identity, `the same scope is reported for more than one realm (${realms.join(", ")})`, ids);
      }
      const times = [...new Set(readings.map(item => item.sourceObservedAt ?? "no_source_time"))].sort();
      if (times.length > 1) {
        note("source_time_disagreement", identity,
          `the merged readings were observed at different times (${times.join(", ")}); the newest is not the truth for the others`, ids);
      }
    }
    upsert({
      scopeId: observation.scopeId, scopeKind: "gateway_pool", shared: true, realm: observation.realm,
      modelId: observation.modelId, unit: "tokens", level: evaluated.level, evidenceReason: evaluated.reason,
      primaryConnectionId: observation.connectionId, connectionIds: [...observation.connectionIds],
      sources: observation.connectionIds.map(id => sourceOf(byKey.get(keyOf("quota", id)), id)),
      sourceObservedAt: observation.sourceObservedAt, expiresAt, availability,
    });
  }

  for (const balance of credit.balances) {
    const primary = byKey.get(keyOf("credit", balance.connectionId));
    const evaluated: Evaluated = primary ? { level: primary.level, reason: primary.reason } : { level: "unobserved", reason: "source_missing" };
    upsert({
      scopeId: balance.scopeId, scopeKind: "gateway_region_pool", shared: true, realm: balance.realm,
      modelId: null, unit: "credit", level: evaluated.level, evidenceReason: evaluated.reason,
      primaryConnectionId: balance.connectionId, connectionIds: [...balance.connectionIds],
      sources: balance.connectionIds.map(id => sourceOf(byKey.get(keyOf("credit", id)), id)),
      // The member timestamp is what the balance came from; the cache expiry is
      // when this read stops being current. Neither is extended by `generatedAt`.
      sourceObservedAt: balance.latestMemberObservedAt, expiresAt: balance.cacheExpiresAt,
      coverage: balance.coverage,
      // The view only ever produces these two values; the narrowing keeps the
      // document's contract explicit instead of widening to string.
      memberFreshness: balance.balanceFreshness === "stale" ? "stale" : "unavailable",
    });
  }

  const ordered = [...mappings.values()].sort((a, b) =>
    `${a.scopeId}|${a.unit}|${a.modelId ?? ""}`.localeCompare(`${b.scopeId}|${b.unit}|${b.modelId ?? ""}`));

  // A scope id names exactly one pool. If the same id arrives with two realms,
  // or in both units, the identity itself is ambiguous: no single figure below
  // is the whole truth, and units are never added together.
  const byScope = new Map<string, RoutingMapping[]>();
  for (const mapping of ordered) {
    const list = byScope.get(mapping.scopeId) ?? [];
    list.push(mapping);
    byScope.set(mapping.scopeId, list);
  }
  for (const list of byScope.values()) {
    const first = list[0]!;
    const realms = [...new Set(list.map(item => item.realm))].sort();
    const units = [...new Set(list.map(item => item.unit))].sort();
    if (realms.length > 1) {
      note("realm_conflict", first, `the same scope id is reported for more than one realm (${realms.join(", ")})`,
        list.flatMap(item => item.connectionIds));
    }
    if (units.length > 1) {
      note("unit_conflict", first,
        `the same scope id is reported in more than one unit (${units.join(", ")}); units are never added together`,
        list.flatMap(item => item.connectionIds));
    }
  }
  const orderedAmbiguities = ambiguities.sort((a, b) =>
    `${a.scopeId}|${a.unit}|${a.modelId ?? ""}|${a.code}`.localeCompare(`${b.scopeId}|${b.unit}|${b.modelId ?? ""}|${b.code}`));
  for (const mapping of ordered) {
    const codes = [...new Set(orderedAmbiguities
      // A scope-level disagreement (two realms or two units under one id)
      // applies to every row of that scope; a model-level one only to its own
      // row.
      .filter(item => item.scopeId === mapping.scopeId
        && (item.modelId === mapping.modelId || item.code === "unit_conflict" || item.code === "realm_conflict"))
      .map(item => item.code))].sort();
    if (codes.length > 0) mapping.conflict = { codes, unresolved: true };
  }

  const registry = context.connections ?? readResourceConnections(process.env);
  const attribution = context.attribution ?? buildRequestAttribution();
  const diagnostics = diagnoseResourceConnections(registry, quota, credit);

  return {
    schemaVersion: ROUTING_EVIDENCE_SCHEMA,
    readOnly: true as const,
    snapshotOnly: true as const,
    generatedAt: now.toISOString(),
    // No payload on this path proves which model a task ran on, so the
    // document says so once, at the top, instead of leaving it implied.
    routingVerified: false as const,
    basis: "gateway_observation_only" as const,
    connections,
    mappings: ordered,
    // Disagreements between merged records, stated once instead of being
    // resolved by whichever array element came first.
    ambiguities: orderedAmbiguities,
    unresolved: UNRESOLVED_ROUTING.map(item => ({ ...item })),
    // An evidence entry is only as good as the snapshot it came from.
    invalidatesOn: ["connection_fingerprint_change", "snapshot_expiry", "source_error", "configuration_change"],
    limitations: orderedAmbiguities.length === 0
      ? ["routing_unverified", "shared_region_pool", "task_attribution_unavailable", "model_scope_unverified"]
      : ["routing_unverified", "shared_region_pool", "task_attribution_unavailable", "model_scope_unverified", "routing_ambiguous"],
    // Three statements that stay apart: what was configured, what an execution
    // declared, and what an upstream call actually did. Only the first two can
    // be read here, and neither one is evidence for the third.
    layers: {
      configuration: {
        code: "connection_pool_model" as const, source: "WORKBUDDY_RESOURCE_CONNECTIONS_FILE" as const,
        status: registry.status, verified: false as const, level: "gateway_observation_only" as const,
      },
      executionSelection: {
        code: "execution_selection_declaration" as const, source: "WORKBUDDY_RESOURCE_LINKS_FILE" as const,
        verified: false as const, level: "declaration_only" as const,
      },
      requestRouting: {
        code: "actual_request_routing" as const, source: "upstream_usage_payload" as const,
        verified: false as const, level: "unavailable" as const, reason: "upstream_payload_lacks_request_identity" as const,
      },
    },
    // The declaration itself, so a reader can tell "not declared" from
    // "declared but not observed" without a second request.
    connectionRegistry: {
      schemaVersion: registry.schemaVersion, status: registry.status, source: registry.source, declaredVia: registry.declaredVia,
      connections: registry.connections, conflicts: registry.conflicts, fileDiagnostics: registry.fileDiagnostics,
      restrictions: registry.restrictions, limitations: registry.limitations,
    },
    connectionDiagnostics: diagnostics,
    requestAttribution: attribution,
  };
}
