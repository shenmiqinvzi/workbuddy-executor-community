/**
 * Request attribution and the local usage ledger (L03 / D6-01).
 *
 * What this module owns:
 *   - The strict parser for the upstream usage envelope (a synthetic contract
 *     shared with the collection line L02). Only visible identifiers are
 *     accepted: executor, runtime source, connection, provider, model,
 *     reasoning effort, session, task, attempt, role, unit, scope, value kind
 *     and the two timestamps. Prompt text, file paths and account names are
 *     never accepted as billing labels.
 *   - `usage_records`, an append-only ledger keyed by the idempotent source key
 *     (source scope + native request id + unit). A duplicate is not counted
 *     twice; a late observation never rewrites the occurrence time; a
 *     re-stated value is reported as a conflict instead of silently replacing
 *     recorded consumption.
 *   - `attributeTaskUsage`, the pure attribution step. It only counts records
 *     that name this task; records from the same shared pool that belong to
 *     another client never become this task's consumption.
 *
 * What this module deliberately does not do:
 *   - It never calls a model, never queries an upstream source, and never
 *     derives amounts from balance differences, price quotes or HTTP request
 *     counts. A value that was not observed stays null, and an unavailable
 *     measurement never becomes zero.
 *   - It never merges different units or currencies into one total, and it
 *     never merges worker, planner, reviewer and checker consumption into a
 *     single per-task number.
 *   - It never reads a prompt, a workspace path or a credential. `sourceScope`
 *     is a connection/source identity, not a secret; credentials are refused
 *     by shape.
 *
 * Reading is separate from writing: `readUsageRecords` performs SELECTs only
 * and reports "ledger absent" instead of creating anything, so a read-only
 * consumer cannot migrate a database as a side effect.
 */

import { DatabaseSync } from "node:sqlite";

/** Version of the upstream envelope this build parses. */
export const UPSTREAM_USAGE_SCHEMA = "workbuddy-upstream-usage-1";

/** Version of the attribution result. */
export const USAGE_ATTRIBUTION_SCHEMA = "workbuddy-executor/usage-attribution-1";

export type UsageRole = "worker" | "planner" | "reviewer" | "checker";
export type UsageUnit = "tokens" | "credits" | "currency";
export type UsageValueKind = "reported" | "estimated" | "unavailable";
export type UsageScopeKind = "routed_pool" | "gateway_pool" | "unverified";
export type UsageAttributionLevel = "exact" | "connection_only" | "unavailable";

export const USAGE_ROLES: readonly UsageRole[] = ["worker", "planner", "reviewer", "checker"];
export const USAGE_UNITS: readonly UsageUnit[] = ["tokens", "credits", "currency"];
export const USAGE_VALUE_KINDS: readonly UsageValueKind[] = ["reported", "estimated", "unavailable"];
export const USAGE_SCOPE_KINDS: readonly UsageScopeKind[] = ["routed_pool", "gateway_pool", "unverified"];

/**
 * Stable limitation codes a usage record may carry.
 *
 * The set is closed on purpose: an unknown code means the upstream schema
 * drifted, and silently accepting it would hide a new accounting problem
 * behind a familiar-looking response.
 */
export const USAGE_LIMITATIONS = [
  "shared_pool",
  "pool_shared_by_multiple_clients",
  "task_attribution_inferred",
  "estimated_not_reported",
  "request_retried",
  "partial_stream",
  "price_unknown",
  "reasoning_time_unavailable",
  // Added with the C03 observation adapter: the upstream publishes a request id
  // but no amount, and an attempt binding can be genuinely absent.
  "no_measured_amount",
  "attempt_binding_incomplete",
] as const;

export type UsageLimitation = (typeof USAGE_LIMITATIONS)[number];

/** One upstream request's usage line. */
export interface UpstreamUsageRecord {
  /** Native request identity, unique inside its source scope. */
  requestId: string;
  /** The request this one retries, or null when it is an original attempt. */
  retryOf: string | null;
  /** 0 for an original request, 1..n for retries. */
  retryIndex: number;
  /** When the upstream request happened; never replaced by an observation. */
  occurredAt: string;
  /** When this build observed the line. */
  observedAt: string;
  executorId: string;
  runtimeSource: string | null;
  connectionId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
  sessionId: string | null;
  taskId: string | null;
  attemptId: string | null;
  role: UsageRole;
  unit: UsageUnit;
  /** ISO-4217 code; null unless unit is "currency". */
  currency: string | null;
  scopeKind: UsageScopeKind;
  /** Anonymous, stable pool identity. Never a credential or an account name. */
  scopeId: string | null;
  /** null exactly when valueKind is "unavailable". */
  value: number | null;
  valueKind: UsageValueKind;
  /** How the value was obtained, free-form but bounded; null when unknown. */
  method: string | null;
  limitations: UsageLimitation[];
}

/** A parsed envelope. `generatedAt` stays null when the source omitted it. */
export interface UpstreamUsageEnvelope {
  schemaVersion: typeof UPSTREAM_USAGE_SCHEMA;
  generatedAt: string | null;
  records: UpstreamUsageRecord[];
  limitations: UsageLimitation[];
}

export interface UpstreamUsageParseFailure {
  ok: false;
  code: "unsupported_schema" | "invalid_upstream_usage";
  /** Dotted path of the offending field, for example "records[3].occurredAt". */
  field: string;
  message: string;
}

export type UpstreamUsageParseResult = { ok: true; envelope: UpstreamUsageEnvelope } | UpstreamUsageParseFailure;

const ENVELOPE_KEYS = new Set(["schemaVersion", "generatedAt", "records", "limitations"]);
const RECORD_KEYS = new Set([
  "requestId", "retryOf", "retryIndex", "occurredAt", "observedAt",
  "executorId", "runtimeSource", "connectionId", "providerId", "modelId", "reasoningEffort", "sessionId",
  "taskId", "attemptId", "role", "unit", "currency", "scopeKind", "scopeId", "value", "valueKind", "method", "limitations",
]);

/** Envelope and record bounds; a bigger document is refused, not truncated. */
export const UPSTREAM_USAGE_LIMITS = Object.freeze({
  records: 10_000,
  identifierCharacters: 200,
  methodCharacters: 200,
  limitations: 16,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure(code: UpstreamUsageParseFailure["code"], field: string, message: string): UpstreamUsageParseFailure {
  return { ok: false, code, field, message };
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function nonEmptyText(value: unknown, max: number = UPSTREAM_USAGE_LIMITS.identifierCharacters): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n]/.test(value);
}

function optionalIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= UPSTREAM_USAGE_LIMITS.identifierCharacters && !/[\r\n]/.test(value));
}

function parseLimitations(value: unknown, field: string): UsageLimitation[] | UpstreamUsageParseFailure {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > UPSTREAM_USAGE_LIMITS.limitations) {
    return failure("invalid_upstream_usage", field, "limitations must be an array of at most 16 known codes.");
  }
  const codes: UsageLimitation[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !(USAGE_LIMITATIONS as readonly string[]).includes(item)) {
      return failure("invalid_upstream_usage", `${field}[${index}]`, "Unknown limitation code; the upstream schema is not the one this build parses.");
    }
    if (!codes.includes(item as UsageLimitation)) codes.push(item as UsageLimitation);
  }
  return codes;
}

function parseValue(unit: UsageUnit, valueKind: UsageValueKind, value: unknown, field: string): number | null | UpstreamUsageParseFailure {
  if (valueKind === "unavailable") {
    if (value !== null && value !== undefined) return failure("invalid_upstream_usage", field, "An unavailable measurement must not carry a numeric value; unknown never becomes zero.");
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return failure("invalid_upstream_usage", field, "A reported or estimated measurement needs a finite non-negative number.");
  }
  if (unit !== "currency" && !Number.isInteger(value)) {
    return failure("invalid_upstream_usage", field, "Token and credit measurements are whole numbers.");
  }
  return value;
}

function parseRecord(value: unknown, field: string): UpstreamUsageRecord | UpstreamUsageParseFailure {
  if (!isRecord(value)) return failure("invalid_upstream_usage", field, "Each usage record must be an object.");
  const unknown = Object.keys(value).find(key => !RECORD_KEYS.has(key));
  if (unknown) return failure("invalid_upstream_usage", `${field}.${unknown}`, "Unknown usage record field; this build refuses a schema it does not parse.");

  if (!nonEmptyText(value.requestId)) return failure("invalid_upstream_usage", `${field}.requestId`, "A usage record needs a native request id.");
  if (!(value.retryOf === null || value.retryOf === undefined || nonEmptyText(value.retryOf))) return failure("invalid_upstream_usage", `${field}.retryOf`, "retryOf must be null or the retried request id.");
  const retryOf = typeof value.retryOf === "string" ? value.retryOf : null;
  const retryIndex = value.retryIndex === undefined ? (retryOf ? 1 : 0) : value.retryIndex;
  if (typeof retryIndex !== "number" || !Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex > 1000) {
    return failure("invalid_upstream_usage", `${field}.retryIndex`, "retryIndex must be an integer from 0 to 1000.");
  }
  if (retryOf !== null && retryIndex < 1) return failure("invalid_upstream_usage", `${field}.retryIndex`, "A retry needs retryIndex of at least 1.");
  if (retryOf === value.requestId) return failure("invalid_upstream_usage", `${field}.retryOf`, "A request cannot retry itself.");

  if (!isIsoTimestamp(value.occurredAt)) return failure("invalid_upstream_usage", `${field}.occurredAt`, "occurredAt must be an ISO timestamp.");
  if (!isIsoTimestamp(value.observedAt)) return failure("invalid_upstream_usage", `${field}.observedAt`, "observedAt must be an ISO timestamp.");

  if (!nonEmptyText(value.executorId)) return failure("invalid_upstream_usage", `${field}.executorId`, "executorId is required.");
  for (const key of ["runtimeSource", "connectionId", "providerId", "modelId", "sessionId", "taskId", "attemptId"] as const) {
    if (!optionalIdentifier(value[key])) return failure("invalid_upstream_usage", `${field}.${key}`, `${key} must be null or a bounded identifier without line breaks.`);
  }
  if (!(value.reasoningEffort === null || value.reasoningEffort === undefined || nonEmptyText(value.reasoningEffort, 100))) {
    return failure("invalid_upstream_usage", `${field}.reasoningEffort`, "reasoningEffort must be null or a bounded label.");
  }
  if (!(value.method === null || value.method === undefined || nonEmptyText(value.method, UPSTREAM_USAGE_LIMITS.methodCharacters))) {
    return failure("invalid_upstream_usage", `${field}.method`, "method must be null or a bounded label.");
  }

  if (typeof value.role !== "string" || !(USAGE_ROLES as readonly string[]).includes(value.role)) {
    return failure("invalid_upstream_usage", `${field}.role`, "role must be worker, planner, reviewer or checker.");
  }
  if (typeof value.unit !== "string" || !(USAGE_UNITS as readonly string[]).includes(value.unit)) {
    return failure("invalid_upstream_usage", `${field}.unit`, "unit must be tokens, credits or currency.");
  }
  if (typeof value.valueKind !== "string" || !(USAGE_VALUE_KINDS as readonly string[]).includes(value.valueKind)) {
    return failure("invalid_upstream_usage", `${field}.valueKind`, "valueKind must be reported, estimated or unavailable.");
  }
  if (typeof value.scopeKind !== "string" || !(USAGE_SCOPE_KINDS as readonly string[]).includes(value.scopeKind)) {
    return failure("invalid_upstream_usage", `${field}.scopeKind`, "scopeKind must be routed_pool, gateway_pool or unverified.");
  }
  const unit = value.unit as UsageUnit;
  const currency = value.currency ?? null;
  if (unit === "currency") {
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return failure("invalid_upstream_usage", `${field}.currency`, "A currency measurement needs an ISO-4217 code.");
  } else if (currency !== null) {
    return failure("invalid_upstream_usage", `${field}.currency`, "Only currency measurements carry a currency; token and credit rows never do.");
  }

  const parsedValue = parseValue(unit, value.valueKind as UsageValueKind, value.value, `${field}.value`);
  if (parsedValue !== null && typeof parsedValue === "object") return parsedValue;

  const limitations = parseLimitations(value.limitations, `${field}.limitations`);
  if (!Array.isArray(limitations)) return limitations;

  return {
    requestId: value.requestId,
    retryOf,
    retryIndex,
    occurredAt: value.occurredAt as string,
    observedAt: value.observedAt as string,
    executorId: value.executorId,
    runtimeSource: typeof value.runtimeSource === "string" ? value.runtimeSource : null,
    connectionId: typeof value.connectionId === "string" ? value.connectionId : null,
    providerId: typeof value.providerId === "string" ? value.providerId : null,
    modelId: typeof value.modelId === "string" ? value.modelId : null,
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : null,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    taskId: typeof value.taskId === "string" ? value.taskId : null,
    attemptId: typeof value.attemptId === "string" ? value.attemptId : null,
    role: value.role as UsageRole,
    unit,
    currency: typeof currency === "string" ? currency : null,
    scopeKind: value.scopeKind as UsageScopeKind,
    scopeId: typeof value.scopeId === "string" ? value.scopeId : null,
    value: parsedValue,
    valueKind: value.valueKind as UsageValueKind,
    method: typeof value.method === "string" ? value.method : null,
    limitations,
  };
}

/**
 * Parse one upstream usage envelope.
 *
 * The parse is strict and total: unknown fields, unknown limitation codes,
 * mixed units, missing request ids, a retry that names itself, a duplicate
 * (requestId, unit) pair and an unavailable value carrying a number are all
 * refused with a field path. Nothing is dropped silently, because a silently
 * dropped row is consumption the statistics would under-report.
 */
export function parseUpstreamUsageEnvelope(value: unknown): UpstreamUsageParseResult {
  if (!isRecord(value)) return failure("invalid_upstream_usage", "$", "The usage envelope must be an object.");
  const unknown = Object.keys(value).find(key => !ENVELOPE_KEYS.has(key));
  if (unknown) return failure("invalid_upstream_usage", unknown, "Unknown envelope field; this build refuses a schema it does not parse.");
  if (value.schemaVersion !== UPSTREAM_USAGE_SCHEMA) {
    return failure("unsupported_schema", "schemaVersion", `This build parses ${UPSTREAM_USAGE_SCHEMA} only.`);
  }
  if (!(value.generatedAt === undefined || value.generatedAt === null || isIsoTimestamp(value.generatedAt))) {
    return failure("invalid_upstream_usage", "generatedAt", "generatedAt must be null or an ISO timestamp.");
  }
  if (!Array.isArray(value.records)) return failure("invalid_upstream_usage", "records", "records must be an array.");
  if (value.records.length > UPSTREAM_USAGE_LIMITS.records) {
    return failure("invalid_upstream_usage", "records", "The envelope carries more records than this build accepts; it is refused, not truncated.");
  }
  const limitations = parseLimitations(value.limitations, "limitations");
  if (!Array.isArray(limitations)) return limitations;

  const records: UpstreamUsageRecord[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.records.entries()) {
    const parsed = parseRecord(item, `records[${index}]`);
    if ("ok" in parsed) return parsed;
    const key = `${parsed.requestId}\u0000${parsed.unit}`;
    if (seen.has(key)) return failure("invalid_upstream_usage", `records[${index}].requestId`, "The same request and unit appear twice in one envelope.");
    seen.add(key);
    records.push(parsed);
  }
  return {
    ok: true,
    envelope: {
      schemaVersion: UPSTREAM_USAGE_SCHEMA,
      generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null,
      records,
      limitations,
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger (write path, owned by the collection line; read path stays separate)
// ---------------------------------------------------------------------------

export const USAGE_RECORDS_TABLE = "usage_records";

/** One stored ledger row: the upstream record plus its local key and arrival. */
export interface StoredUsageRecord extends UpstreamUsageRecord {
  sourceScope: string;
  /** Idempotency key: scope + native request id + unit. */
  sourceKey: string;
  /** When this build first stored the row. Not the occurrence time. */
  recordedAt: string;
}

export type UsageWriteOutcome =
  | { status: "inserted"; record: StoredUsageRecord }
  | { status: "duplicate"; record: StoredUsageRecord }
  | { status: "conflict"; reason: "value_conflict" | "occurred_at_conflict" | "unit_conflict"; record: StoredUsageRecord };

const USAGE_RECORD_COLUMNS = `source_key, source_scope, request_id, retry_of, retry_index, occurred_at, observed_at, recorded_at,
  executor_id, runtime_source, connection_id, provider_id, model_id, reasoning_effort, session_id, task_id, attempt_id,
  role, unit, currency, scope_kind, scope_id, value_real, value_kind, method, limitations_json`;

/** The additive DDL this module owns; no existing table is altered. */
export const USAGE_RECORDS_DDL = `CREATE TABLE IF NOT EXISTS ${USAGE_RECORDS_TABLE} (
  source_key TEXT PRIMARY KEY,
  source_scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  retry_of TEXT,
  retry_index INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  runtime_source TEXT,
  connection_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  reasoning_effort TEXT,
  session_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  role TEXT NOT NULL,
  unit TEXT NOT NULL,
  currency TEXT,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  value_real REAL,
  value_kind TEXT NOT NULL,
  method TEXT,
  limitations_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_records_by_task ON ${USAGE_RECORDS_TABLE}(task_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_records_by_request ON ${USAGE_RECORDS_TABLE}(source_scope, request_id);`;

/**
 * Validate a source scope.
 *
 * The scope names a source identity (for example a connection id or a hashed
 * pool id). It is stored in the ledger and shown in views, so an api key,
 * bearer token, password, private path or line break is refused by shape.
 */
export function usageSourceScopeProblem(scope: unknown): string | null {
  if (typeof scope !== "string" || scope.trim().length === 0) return "A source scope is required.";
  if (scope.length > UPSTREAM_USAGE_LIMITS.identifierCharacters) return "The source scope is longer than 200 characters.";
  if (/[\r\n\t]/.test(scope)) return "The source scope must not contain control characters.";
  if (/^(bearer|basic|token)\s/i.test(scope)) return "The source scope must not be a credential.";
  if (/^(sk|pk|api|key)[-_]/i.test(scope)) return "The source scope looks like a credential; store an anonymous scope id instead.";
  if (/^[a-zA-Z]:[\\/]/.test(scope) || scope.startsWith("\\\\") || scope.startsWith("/")) return "The source scope must not be a file path.";
  if (/[\\/]{1}/.test(scope) && /[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+/.test(scope)) return "The source scope must not be a path.";
  return null;
}

export function usageSourceKey(sourceScope: string, requestId: string, unit: UsageUnit): string {
  return `${sourceScope}\u0000${requestId}\u0000${unit}`;
}

/**
 * The append-only usage ledger.
 *
 * Writes are idempotent by `sourceKey`. A repeated row with the same value and
 * occurrence is a duplicate; a repeated row whose value or occurrence differs
 * is a conflict that keeps the stored row, so a later observation can never
 * rewrite what was already counted.
 */
export class UsageLedger {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {
    db.exec(USAGE_RECORDS_DDL);
  }

  /** Record one parsed usage line. */
  record(record: UpstreamUsageRecord, sourceScope: string): UsageWriteOutcome {
    const scopeProblem = usageSourceScopeProblem(sourceScope);
    if (scopeProblem) throw new Error(scopeProblem);
    const sourceKey = usageSourceKey(sourceScope, record.requestId, record.unit);
    const existing = this.find(sourceKey);
    if (existing) return classifyReplay(existing, record);
    try {
      this.db.prepare(`INSERT INTO ${USAGE_RECORDS_TABLE} (${USAGE_RECORD_COLUMNS}) VALUES (${Array(26).fill("?").join(",")})`).run(
        sourceKey, sourceScope, record.requestId, record.retryOf, record.retryIndex, record.occurredAt, record.observedAt, this.now(),
        record.executorId, record.runtimeSource, record.connectionId, record.providerId, record.modelId, record.reasoningEffort,
        record.sessionId, record.taskId, record.attemptId, record.role, record.unit, record.currency, record.scopeKind, record.scopeId,
        record.value, record.valueKind, record.method, JSON.stringify(record.limitations),
      );
    } catch (error) {
      // A concurrent writer can win between the probe and the insert; the
      // primary key decides, and the winner's row is classified like a replay.
      const concurrent = this.find(sourceKey);
      if (!concurrent) throw error;
      return classifyReplay(concurrent, record);
    }
    const stored = this.find(sourceKey);
    if (!stored) throw new Error("The usage row just written could not be read back.");
    return { status: "inserted", record: stored };
  }

  /** Record a whole parsed envelope; returns one outcome per line, in order. */
  recordEnvelope(envelope: UpstreamUsageEnvelope, sourceScope: string): UsageWriteOutcome[] {
    return envelope.records.map(record => this.record(record, sourceScope));
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${USAGE_RECORDS_TABLE}`).get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  private find(sourceKey: string): StoredUsageRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM ${USAGE_RECORDS_TABLE} WHERE source_key = ?`).get(sourceKey) as Record<string, unknown> | undefined;
    return row ? rowToUsageRecord(row) : undefined;
  }
}

function classifyReplay(stored: StoredUsageRecord, incoming: UpstreamUsageRecord): UsageWriteOutcome {
  if (stored.valueKind !== incoming.valueKind || stored.value !== incoming.value) return { status: "conflict", reason: "value_conflict", record: stored };
  if (stored.occurredAt !== incoming.occurredAt) return { status: "conflict", reason: "occurred_at_conflict", record: stored };
  // Same value, same occurrence, later observation: a late duplicate. The
  // stored row keeps its original observed_at, so replay never rewrites when
  // the fact was first seen.
  return { status: "duplicate", record: stored };
}

export interface UsageReadFilter {
  taskId?: string;
  /** Inclusive lower bound on occurredAt. */
  from?: string;
  /** Exclusive upper bound on occurredAt. */
  to?: string;
  limit?: number;
}

export type UsageReadResult =
  | { present: true; records: StoredUsageRecord[] }
  | { present: false; records: [] };

/**
 * Read ledger rows. SELECT-only: a database without the ledger reports
 * `present:false` instead of creating the table, so a read path never migrates.
 */
export function readUsageRecords(db: DatabaseSync, filter: UsageReadFilter = {}): UsageReadResult {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(USAGE_RECORDS_TABLE);
  if (!table) return { present: false, records: [] };
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];
  if (filter.taskId !== undefined) { clauses.push("task_id = ?"); parameters.push(filter.taskId); }
  if (filter.from !== undefined) { clauses.push("occurred_at >= ?"); parameters.push(filter.from); }
  if (filter.to !== undefined) { clauses.push("occurred_at < ?"); parameters.push(filter.to); }
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 10_000), 1), 10_000);
  const rows = db.prepare(`SELECT * FROM ${USAGE_RECORDS_TABLE}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY occurred_at ASC, request_id ASC, unit ASC LIMIT ?`).all(...parameters, limit) as Array<Record<string, unknown>>;
  return { present: true, records: rows.map(rowToUsageRecord) };
}

/**
 * Read the ledger out of a database file with a read-only handle.
 *
 * The statistics endpoints receive a file path and nothing else, so this is
 * the only way they touch usage: a missing database or a missing table both
 * mean "not measured yet" and never create, migrate or lock anything.
 */
export function readUsageRecordsFromFile(file: string, filter: UsageReadFilter = {}): UsageReadResult {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return { present: false, records: [] };
  }
  try {
    return readUsageRecords(db, filter);
  } finally {
    db.close();
  }
}

function rowToUsageRecord(row: Record<string, unknown>): StoredUsageRecord {
  const limitations = JSON.parse(String(row.limitations_json)) as unknown;
  return {
    sourceKey: String(row.source_key),
    sourceScope: String(row.source_scope),
    recordedAt: String(row.recorded_at),
    requestId: String(row.request_id),
    retryOf: row.retry_of == null ? null : String(row.retry_of),
    retryIndex: Number(row.retry_index),
    occurredAt: String(row.occurred_at),
    observedAt: String(row.observed_at),
    executorId: String(row.executor_id),
    runtimeSource: row.runtime_source == null ? null : String(row.runtime_source),
    connectionId: row.connection_id == null ? null : String(row.connection_id),
    providerId: row.provider_id == null ? null : String(row.provider_id),
    modelId: row.model_id == null ? null : String(row.model_id),
    reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
    sessionId: row.session_id == null ? null : String(row.session_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    attemptId: row.attempt_id == null ? null : String(row.attempt_id),
    role: String(row.role) as UsageRole,
    unit: String(row.unit) as UsageUnit,
    currency: row.currency == null ? null : String(row.currency),
    scopeKind: String(row.scope_kind) as UsageScopeKind,
    scopeId: row.scope_id == null ? null : String(row.scope_id),
    value: row.value_real == null ? null : Number(row.value_real),
    valueKind: String(row.value_kind) as UsageValueKind,
    method: row.method == null ? null : String(row.method),
    limitations: Array.isArray(limitations) ? limitations as UsageLimitation[] : [],
  };
}

// ---------------------------------------------------------------------------
// Attribution (pure)
// ---------------------------------------------------------------------------

/** One request reference carried in the attribution result. */
export interface UsageRequestReference {
  requestId: string;
  role: UsageRole;
  unit: UsageUnit;
  occurredAt: string;
  observedAt: string;
  retryOf: string | null;
  retryIndex: number;
  valueKind: UsageValueKind;
  scopeKind: UsageScopeKind;
}

/** Per unit and currency totals. Units are never added together. */
export interface UsageAmountGroup {
  unit: UsageUnit;
  currency: string | null;
  records: number;
  measuredRecords: number;
  estimatedRecords: number;
  unavailableRecords: number;
  /** Sum of measured values, or null when nothing was measured. */
  amount: number | null;
}

export interface UsageRoleSplit {
  role: UsageRole;
  records: number;
  distinctRequests: number;
  retryRecords: number;
  groups: UsageAmountGroup[];
}

export interface UsageCoverage {
  records: number;
  measuredRecords: number;
  /** Records naming a task AND an attempt of this task. */
  attemptBoundRecords: number;
  /** measuredRecords / records, or null when there are no records. */
  ratio: number | null;
}

export interface TaskUsageAttribution {
  schemaVersion: typeof USAGE_ATTRIBUTION_SCHEMA;
  taskId: string;
  attribution: UsageAttributionLevel;
  coverage: UsageCoverage;
  /** Bounded, ordered request references that actually name this task. */
  requestRefs: UsageRequestReference[];
  byRole: UsageRoleSplit[];
  /** Per unit/currency totals across roles; still never mixed units. */
  totals: UsageAmountGroup[];
  limitations: string[];
}

export interface AttributeTaskUsageInput {
  taskId: string;
  records: readonly StoredUsageRecord[];
  /** Attempt ids that belong to this task, oldest first. */
  attemptIds: readonly string[];
  /** Maximum request references carried in the result (default 200). */
  maxRefs?: number;
}

const ROLE_ORDER: readonly UsageRole[] = USAGE_ROLES;
const UNIT_ORDER: readonly UsageUnit[] = USAGE_UNITS;

function roundAmount(unit: UsageUnit, value: number): number {
  return unit === "currency" ? Math.round(value * 1e6) / 1e6 : value;
}

function groupKey(unit: UsageUnit, currency: string | null): string {
  return `${unit}\u0000${currency ?? ""}`;
}

function groupRecords(records: readonly StoredUsageRecord[]): UsageAmountGroup[] {
  const groups = new Map<string, UsageAmountGroup>();
  for (const record of records) {
    const key = groupKey(record.unit, record.currency);
    const existing = groups.get(key) ?? {
      unit: record.unit, currency: record.currency, records: 0, measuredRecords: 0, estimatedRecords: 0, unavailableRecords: 0, amount: null,
    };
    existing.records += 1;
    if (record.valueKind === "unavailable" || record.value === null) existing.unavailableRecords += 1;
    else {
      existing.measuredRecords += 1;
      existing.amount = roundAmount(record.unit, (existing.amount ?? 0) + record.value);
    }
    if (record.valueKind === "estimated") existing.estimatedRecords += 1;
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => UNIT_ORDER.indexOf(a.unit) - UNIT_ORDER.indexOf(b.unit) || (a.currency ?? "").localeCompare(b.currency ?? ""));
}

/**
 * Attribute stored usage rows to one task.
 *
 * Only records whose `taskId` equals the requested task are counted. Rows from
 * the same shared pool that name another task (or no task) stay out, which is
 * what keeps another client's consumption from being billed here.
 *
 * `exact` requires every counted row to be reported (not estimated), bound to
 * this task and one of its attempts, and every retry parent to be present in
 * the same result. Anything less is `connection_only`; no measurable row at
 * all is `unavailable`. The failing condition is always named in limitations.
 */
export function attributeTaskUsage(input: AttributeTaskUsageInput): TaskUsageAttribution {
  const attemptIds = new Set(input.attemptIds);
  const own = input.records.filter(record => record.taskId === input.taskId);
  const limitations = new Set<string>();
  const byRole = new Map<UsageRole, StoredUsageRecord[]>();
  for (const role of ROLE_ORDER) byRole.set(role, []);
  for (const record of own) byRole.get(record.role)?.push(record);

  const requestIds = new Set(own.map(record => record.requestId));
  const measured = own.filter(record => record.valueKind !== "unavailable" && record.value !== null);
  const attemptBound = own.filter(record => record.attemptId !== null && attemptIds.has(record.attemptId));
  if (own.length > 0 && measured.length === 0) limitations.add("no_measured_amount");
  if (own.some(record => record.valueKind === "estimated")) limitations.add("usage_estimated");
  if (attemptBound.length < own.length) limitations.add("attempt_binding_incomplete");
  const retryParentMissing = own.some(record => record.retryOf !== null && !requestIds.has(record.retryOf));
  if (retryParentMissing) limitations.add("retry_parent_missing");
  // A pool-level or explicitly shared observation is not proof of what THIS
  // task consumed: another client's traffic lands in the same figure.
  const sharedPool = own.some(record => record.limitations.includes("shared_pool") || record.scopeKind !== "routed_pool");
  if (sharedPool) limitations.add("shared_pool_scope");
  if (own.some(record => record.limitations.includes("task_attribution_inferred"))) limitations.add("attribution_inferred");

  // "exact" needs a measured, reported figure per line, bound to the task's own
  // attempts, with every retry parent present, and a scope that isolates this
  // task. An estimate or a shared pool can support connection_only at best.
  const allReported = own.length > 0 && own.every(record => record.valueKind === "reported" && record.value !== null);
  let attribution: UsageAttributionLevel;
  if (own.length === 0 || measured.length === 0) attribution = "unavailable";
  else if (allReported && attemptBound.length === own.length && !retryParentMissing && !sharedPool) attribution = "exact";
  else attribution = "connection_only";

  const maxRefs = Math.min(Math.max(Math.floor(input.maxRefs ?? 200), 1), 1000);
  const requestRefs = [...own]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.requestId.localeCompare(b.requestId) || a.unit.localeCompare(b.unit))
    .slice(0, maxRefs)
    .map(record => ({
      requestId: record.requestId, role: record.role, unit: record.unit, occurredAt: record.occurredAt, observedAt: record.observedAt,
      retryOf: record.retryOf, retryIndex: record.retryIndex, valueKind: record.valueKind, scopeKind: record.scopeKind,
    }));
  if (own.length > requestRefs.length) limitations.add("request_references_truncated");

  return {
    schemaVersion: USAGE_ATTRIBUTION_SCHEMA,
    taskId: input.taskId,
    attribution,
    coverage: {
      records: own.length,
      measuredRecords: measured.length,
      attemptBoundRecords: attemptBound.length,
      ratio: own.length === 0 ? null : Math.round((measured.length / own.length) * 1e4) / 1e4,
    },
    requestRefs,
    byRole: ROLE_ORDER.map(role => {
      const records = byRole.get(role) ?? [];
      return {
        role,
        records: records.length,
        distinctRequests: new Set(records.map(record => record.requestId)).size,
        retryRecords: records.filter(record => record.retryOf !== null).length,
        groups: groupRecords(records),
      };
    }),
    totals: groupRecords(own),
    limitations: [...limitations].sort(),
  };
}

/**
 * Attribute one task's usage straight from the ledger file.
 *
 * This is the whole wiring surface the statistics endpoints need: the caller
 * names the database file and the task's attempts, and the read happens on a
 * read-only handle. A ledger that does not exist yields `unavailable` with no
 * invented figure.
 */
export function attributeTaskUsageFromLedger(input: {
  file: string;
  taskId: string;
  attemptIds: readonly string[];
  maxRefs?: number;
}): TaskUsageAttribution {
  const read = readUsageRecordsFromFile(input.file, { taskId: input.taskId });
  return attributeTaskUsage({ taskId: input.taskId, records: read.records, attemptIds: input.attemptIds, maxRefs: input.maxRefs });
}

// ---------------------------------------------------------------------------
// Request observation adapter (C03: the trusted write path into the ledger)
// ---------------------------------------------------------------------------

/**
 * What the gateway itself observes when it starts one upstream request.
 *
 * Every field here is read from a real object the gateway holds at dispatch
 * time: the harness `prompt` reply (request id), the attempt binding (task,
 * attempt, session), the declared connection/model/reasoning choice, and the
 * dispatch clock. Nothing is parsed out of model prose.
 */
export const REQUEST_OBSERVATION_SCHEMA = "workbuddy-executor/request-observation-1";

/** Units this adapter may write. It never invents a price, so no currency row. */
export const REQUEST_OBSERVATION_UNITS: readonly UsageUnit[] = ["tokens", "credits"];

export type RequestObservationRejection =
  | { field: string; code: "unsupported_schema" | "invalid_observation" | "unit_not_observed" };

export interface RequestObservation {
  schemaVersion?: typeof REQUEST_OBSERVATION_SCHEMA;
  /** The upstream request id returned when the prompt was accepted. */
  requestId: string;
  taskId?: string | null;
  attemptId?: string | null;
  sessionId?: string | null;
  executorId: string;
  runtimeSource?: string | null;
  connectionId?: string | null;
  providerId?: string | null;
  /** Model the gateway actually selected, when a selection exists. */
  modelId?: string | null;
  reasoningEffort?: string | null;
  role: UsageRole;
  /** When the request was accepted by the upstream. */
  occurredAt: string;
  /** When the gateway recorded the observation; defaults to now. */
  observedAt?: string;
  retryOf?: string | null;
  retryIndex?: number;
  scopeKind: UsageScopeKind;
  scopeId?: string | null;
  /** Why no amount is attached; recorded on every row as its method. */
  method?: string | null;
}

export interface RequestObservationRows {
  schemaVersion: typeof REQUEST_OBSERVATION_SCHEMA;
  /** Rows are always `valueKind: "unavailable"` with `value: null`. */
  records: UpstreamUsageRecord[];
  limitations: UsageLimitation[];
  rejected: RequestObservationRejection[];
}

const OBSERVATION_METHOD = "harness_does_not_report_usage";

/**
 * Turn one observed request into ledger rows that cannot overclaim.
 *
 * The upstream harness publishes a request id but never a token, credit or
 * currency amount, so each row says `unavailable` with `value: null`. Writing
 * `0` here would be read downstream as "this request cost nothing", which is a
 * different claim from "this build cannot see the cost".
 */
export function buildRequestObservationRows(observation: RequestObservation, now: Date = new Date()): RequestObservationRows {
  const rejected: RequestObservationRejection[] = [];
  const limitations = new Set<UsageLimitation>(["no_measured_amount", "task_attribution_inferred"]);
  if (observation.schemaVersion !== undefined && observation.schemaVersion !== REQUEST_OBSERVATION_SCHEMA) {
    rejected.push({ field: "schemaVersion", code: "unsupported_schema" });
    return { schemaVersion: REQUEST_OBSERVATION_SCHEMA, records: [], limitations: [...limitations], rejected };
  }
  if (observation.scopeKind === "gateway_pool") limitations.add("shared_pool");
  if (observation.retryOf !== null && observation.retryOf !== undefined) limitations.add("request_retried");
  if (observation.attemptId === null || observation.attemptId === undefined) limitations.add("attempt_binding_incomplete");

  const rows: UpstreamUsageRecord[] = [];
  for (const unit of REQUEST_OBSERVATION_UNITS) {
    rows.push({
      requestId: observation.requestId,
      retryOf: observation.retryOf ?? null,
      retryIndex: observation.retryIndex ?? (observation.retryOf ? 1 : 0),
      occurredAt: observation.occurredAt,
      observedAt: observation.observedAt ?? now.toISOString(),
      executorId: observation.executorId,
      runtimeSource: observation.runtimeSource ?? null,
      connectionId: observation.connectionId ?? null,
      providerId: observation.providerId ?? null,
      modelId: observation.modelId ?? null,
      reasoningEffort: observation.reasoningEffort ?? null,
      sessionId: observation.sessionId ?? null,
      taskId: observation.taskId ?? null,
      attemptId: observation.attemptId ?? null,
      role: observation.role,
      unit,
      currency: null,
      scopeKind: observation.scopeKind,
      scopeId: observation.scopeId ?? null,
      value: null,
      valueKind: "unavailable",
      method: observation.method ?? OBSERVATION_METHOD,
      limitations: [...limitations].sort(),
    });
  }
  return { schemaVersion: REQUEST_OBSERVATION_SCHEMA, records: rows, limitations: [...limitations].sort(), rejected };
}

export interface RequestObservationWrite {
  requestId: string;
  writeout: UsageWriteOutcome[];
}

/**
 * Validate every row through the strict parser before it can reach the ledger,
 * then write it. A row that fails validation is reported, never repaired.
 */
export function recordRequestObservation(
  ledger: UsageLedger,
  observation: RequestObservation,
  sourceScope: string,
  now: Date = new Date(),
): { ok: boolean; outcomes: UsageWriteOutcome[]; rejected: RequestObservationRejection[] } {
  const built = buildRequestObservationRows(observation, now);
  if (built.rejected.length > 0) return { ok: false, outcomes: [], rejected: built.rejected };
  const outcomes: UsageWriteOutcome[] = [];
  for (const [index, row] of built.records.entries()) {
    const parsed = parseUpstreamUsageEnvelope({
      schemaVersion: UPSTREAM_USAGE_SCHEMA,
      generatedAt: null,
      records: [row],
      limitations: [],
    });
    if (!parsed.ok) {
      return { ok: false, outcomes, rejected: [{ field: `records[${index}].${parsed.field}`, code: "invalid_observation" }] };
    }
    const [record] = parsed.envelope.records;
    if (!record) return { ok: false, outcomes, rejected: [{ field: `records[${index}]`, code: "invalid_observation" }] };
    outcomes.push(ledger.record(record, sourceScope));
  }
  return { ok: true, outcomes, rejected: [] };
}

/**
 * A request the gateway observed but could not bind to a task.
 *
 * The ledger keeps the row (it is real consumption) and this summary names why
 * it will never appear under a task: silently dropping it would make task
 * totals look complete.
 */
export type UnallocatedReason = "no_task" | "no_attempt" | "task_mismatch";

export interface UnallocatedSummary {
  records: number;
  byReason: Record<UnallocatedReason, number>;
  /** Requests, not rows: one request can produce several unit rows. */
  requests: number;
}

export function summarizeUnallocated(records: readonly UpstreamUsageRecord[], taskId: string): UnallocatedSummary {
  const requests = new Set<string>();
  const byReason: Record<UnallocatedReason, number> = { no_task: 0, no_attempt: 0, task_mismatch: 0 };
  let counted = 0;
  for (const record of records) {
    if (record.taskId === taskId) continue;
    counted += 1;
    requests.add(`${record.requestId}\u0000${record.occurredAt}`);
    if (record.taskId === null) byReason.no_task += 1;
    else byReason.task_mismatch += 1;
    if (record.attemptId === null) byReason.no_attempt += 1;
  }
  return { records: counted, byReason, requests: requests.size };
}

export interface RequestCoverage {
  status: "complete" | "partial" | "unknown";
  /** Numerator: requests this gateway observed for the scope. */
  observedRequests: number;
  /** Of those, how many carry both a task and an attempt binding. */
  attributedRequests: number;
  /** Denominator, only when the upstream publishes a request count. */
  totalRequests: number | null;
  /** null while `totalRequests` is null: an unknown denominator is not 100%. */
  ratio: number | null;
  unknownReason: "upstream_does_not_publish_request_count" | null;
  limitations: string[];
}

/**
 * Coverage with an explicit denominator.
 *
 * The harness replies with one request id per prompt and no count of the
 * requests the account made elsewhere, so `totalRequests` stays null and the
 * status stays `unknown`. A caller that passes a count gets a real ratio and
 * the numerator/denominator it was computed from.
 */
export function summarizeRequestCoverage(input: {
  observedRequests: number;
  attributedRequests: number;
  totalRequests?: number | null;
}): RequestCoverage {
  const observed = Math.max(0, Math.floor(input.observedRequests));
  const attributed = Math.max(0, Math.floor(input.attributedRequests));
  const total = input.totalRequests === undefined || input.totalRequests === null ? null : Math.floor(input.totalRequests);
  const limitations = ["attribution_scope_is_gateway_observation"];
  if (total === null) {
    return {
      status: "unknown",
      observedRequests: observed,
      attributedRequests: attributed,
      totalRequests: null,
      ratio: null,
      unknownReason: "upstream_does_not_publish_request_count",
      limitations: [...limitations, "denominator_unknown"],
    };
  }
  if (total < observed) {
    return {
      status: "unknown",
      observedRequests: observed,
      attributedRequests: attributed,
      totalRequests: total,
      ratio: null,
      unknownReason: "upstream_does_not_publish_request_count",
      limitations: [...limitations, "denominator_smaller_than_numerator"],
    };
  }
  const ratio = total === 0 ? null : observed / total;
  const status = total === 0 ? "unknown" : observed === total && attributed === total ? "complete" : "partial";
  return { status, observedRequests: observed, attributedRequests: attributed, totalRequests: total, ratio, unknownReason: null, limitations };
}
