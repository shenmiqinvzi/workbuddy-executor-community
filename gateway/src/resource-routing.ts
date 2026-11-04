import type { readQuotaResources } from "./quota-observation.js";
import type { readCreditBalances } from "./credit-balance.js";

/**
 * Routing evidence is its own versioned document.
 *
 * quota-1 and credit-balance-1 describe what the gateway observed about a
 * shared pool; neither payload carries a task identifier, a session, or a
 * provider selection. This document therefore states, per connection and per
 * pool scope, *which* pool a configured source reported and *how strong* that
 * statement is — and it never upgrades "a source reported this pool" into
 * "this task may spend it".
 */
export const ROUTING_EVIDENCE_SCHEMA = "workbuddy-executor/routing-evidence-1";

export type QuotaView = ReturnType<typeof readQuotaResources>;
export type CreditView = ReturnType<typeof readCreditBalances>;

/** Strength order: a stronger statement replaces a weaker one for one scope. */
export type EvidenceLevel = "observed" | "expired" | "unavailable" | "unobserved";

const RANK: Record<EvidenceLevel, number> = { observed: 3, expired: 2, unavailable: 1, unobserved: 0 };

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
  level: EvidenceLevel;
  connectionIds: string[];
  sourceObservedAt: string | null;
  expiresAt: string | null;
  /** token pools only. */
  availability?: "available" | "exhausted" | "unknown";
  /** credit pools only. */
  coverage?: "complete" | "partial" | "unavailable";
}

function connectionLevel(status: string, errorCode: string | null, freshness: string): EvidenceLevel {
  if (status === "not_observed") return "unobserved";
  if (errorCode || status === "unavailable") return "unavailable";
  if (freshness === "fresh") return "observed";
  return "expired";
}

/** An unexpected connection status is reported as a read failure, never
 *  silently folded into "not observed" or "observed". */
function connectionStatus(value: string): RoutingConnection["status"] {
  if (value === "observed" || value === "not_observed" || value === "unavailable") return value;
  throw new Error("routing_evidence_unknown_status");
}

function stronger(a: EvidenceLevel, b: EvidenceLevel): EvidenceLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Reads exactly the two saved resource views. It adds no probe, no upstream
 * call and no second copy of the resource arithmetic: every fact here is
 * derived from what the collectors already stored.
 */
export function buildRoutingEvidence(quota: QuotaView, credit: CreditView, now: Date = new Date()) {
  const connections: RoutingConnection[] = [];
  const mappings = new Map<string, RoutingMapping>();
  const quotaLevel = new Map<string, EvidenceLevel>();

  for (const connection of quota.connections) {
    const level = connectionLevel(connection.status, connection.errorCode, connection.freshness);
    quotaLevel.set(connection.connectionId, level);
    connections.push({
      connectionId: connection.connectionId, resource: "quota", status: connectionStatus(connection.status), errorCode: connection.errorCode,
      level, snapshotId: connection.snapshotId, sourceObservedAt: connection.sourceObservedAt,
      collectedAt: connection.collectedAt, expiresAt: connection.expiresAt,
    });
  }
  for (const connection of credit.connections) {
    const level = connectionLevel(connection.status, connection.errorCode, connection.cacheFreshness);
    connections.push({
      connectionId: connection.connectionId, resource: "credit", status: connectionStatus(connection.status), errorCode: connection.errorCode,
      level, snapshotId: connection.snapshotId, sourceObservedAt: null,
      collectedAt: connection.collectedAt, expiresAt: null,
    });
  }

  const upsert = (mapping: RoutingMapping) => {
    const key = `${mapping.scopeId}|${mapping.unit}|${mapping.modelId ?? ""}`;
    const prior = mappings.get(key);
    if (!prior) { mappings.set(key, mapping); return; }
    prior.level = stronger(prior.level, mapping.level);
    for (const id of mapping.connectionIds) if (!prior.connectionIds.includes(id)) prior.connectionIds.push(id);
    // A scope reported by several connections keeps the newest observation it has.
    if (mapping.sourceObservedAt && (!prior.sourceObservedAt || mapping.sourceObservedAt > prior.sourceObservedAt)) {
      prior.sourceObservedAt = mapping.sourceObservedAt;
      prior.expiresAt = mapping.expiresAt;
    }
  };

  for (const observation of quota.observations) {
    const level = observation.connectionIds.reduce<EvidenceLevel>(
      (best, id) => stronger(best, quotaLevel.get(id) ?? "unobserved"), "unobserved");
    upsert({
      scopeId: observation.scopeId, scopeKind: "gateway_pool", shared: true, realm: observation.realm,
      modelId: observation.modelId, unit: "tokens", level, connectionIds: [...observation.connectionIds],
      sourceObservedAt: observation.sourceObservedAt, expiresAt: null, availability: observation.availability,
    });
  }

  for (const balance of credit.balances) {
    const source = connections.find(item => item.connectionId === balance.connectionId && item.resource === "credit");
    const level: EvidenceLevel = source ? source.level : "unobserved";
    upsert({
      scopeId: balance.scopeId, scopeKind: "gateway_region_pool", shared: true, realm: balance.realm,
      modelId: null, unit: "credit", level, connectionIds: [...balance.connectionIds],
      sourceObservedAt: balance.latestMemberObservedAt, expiresAt: null, coverage: balance.coverage,
    });
  }

  const ordered = [...mappings.values()].sort((a, b) =>
    `${a.scopeId}|${a.unit}|${a.modelId ?? ""}`.localeCompare(`${b.scopeId}|${b.unit}|${b.modelId ?? ""}`));

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
    unresolved: UNRESOLVED_ROUTING.map(item => ({ ...item })),
    // An evidence entry is only as good as the snapshot it came from.
    invalidatesOn: ["connection_fingerprint_change", "snapshot_expiry", "source_error", "configuration_change"],
    limitations: ["routing_unverified", "shared_region_pool", "task_attribution_unavailable", "model_scope_unverified"],
  };
}
