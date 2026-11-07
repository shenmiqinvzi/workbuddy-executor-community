/**
 * Fixed-source capability model (C01).
 *
 * The resource centre reads three endpoints from a loopback workbuddy2api
 * instance. This module states, in one place, exactly what each endpoint can
 * and cannot publish, checks an observed payload against that statement, and
 * classifies freshness. It never turns an unknown value into a number: a
 * payload that does not carry a field is reported as missing, not as zero.
 */

import { loopbackOrigin } from "./local-statistics-client.js";

/** Binding note: the capability table is data, not prose. Bump on shape change. */
export const SOURCE_CAPABILITY_SCHEMA = "workbuddy-executor/source-capability-1";

export type ResourceSourceEndpoint = "usage_remaining" | "balance_summary" | "models";

export const RESOURCE_SOURCE_PATHS: Readonly<Record<ResourceSourceEndpoint, string>> = Object.freeze({
  usage_remaining: "/usage/remaining",
  balance_summary: "/v1/balance-summary",
  models: "/v1/models",
});

export interface SourceAuthField {
  /** Where the credential travels. Only headers are accepted. */
  readonly position: "header";
  readonly header: string;
  readonly scheme: "Bearer" | "X-Panel-Token" | null;
  readonly required: boolean;
}

export interface SourceCapability {
  readonly schemaVersion: typeof SOURCE_CAPABILITY_SCHEMA;
  readonly endpoint: ResourceSourceEndpoint;
  readonly path: string;
  readonly method: "GET";
  readonly auth: readonly SourceAuthField[];
  /** Whether the payload names a region realm, and which values are legal. */
  readonly realm: { readonly provided: boolean; readonly values: readonly string[] };
  /** The single unit this endpoint reports. Units are never mixed. */
  readonly unit: "tokens" | "credit" | "none";
  /** Fields that identify one reported row. */
  readonly rowIdentity: readonly string[];
  /** Field carrying the source's own timestamp, and its precision. */
  readonly sourceTime: { readonly field: string | null; readonly precision: "second" | "millisecond" | "none" };
  /** The gateway's own read clock; always present and always separate. */
  readonly readTime: "collector_clock";
  readonly balanceFields: readonly string[];
  readonly usageFields: readonly string[];
  readonly modelFields: readonly string[];
  readonly pagination: { readonly mode: "none"; readonly maxRows: number };
  readonly errors: readonly { readonly status: number; readonly code: string }[];
  /** No endpoint publishes a request identifier, so request routing stays unverified. */
  readonly requestIdField: string | null;
  /** Facts this endpoint genuinely does not carry. Not "waiting for a key". */
  readonly notProvided: readonly string[];
}

const SHARED_NOT_PROVIDED = [
  "per_request_identity",
  "per_task_usage",
  "prompt_and_completion_token_split",
  "request_latency",
  "price_or_currency_amount",
] as const;

const CAPABILITIES: Readonly<Record<ResourceSourceEndpoint, SourceCapability>> = deepFreeze<Record<ResourceSourceEndpoint, SourceCapability>>({
  usage_remaining: Object.freeze({
    schemaVersion: SOURCE_CAPABILITY_SCHEMA,
    endpoint: "usage_remaining",
    path: RESOURCE_SOURCE_PATHS.usage_remaining,
    method: "GET",
    auth: [
      { position: "header", header: "Authorization", scheme: "Bearer", required: true },
      { position: "header", header: "X-Panel-Token", scheme: "X-Panel-Token", required: false },
    ],
    realm: { provided: true, values: ["cn", "intl"] },
    unit: "tokens",
    rowIdentity: ["uid", "model"],
    sourceTime: { field: "generated_at", precision: "second" },
    readTime: "collector_clock",
    balanceFields: ["remaining", "used", "budget", "reset_at", "cooling"],
    usageFields: [],
    modelFields: ["model"],
    pagination: { mode: "none", maxRows: 2000 },
    errors: [
      { status: 401, code: "source_unauthorized" },
      { status: 403, code: "source_unauthorized" },
      { status: 404, code: "source_unsupported" },
      { status: 501, code: "source_unsupported" },
    ],
    requestIdField: null,
    notProvided: [...SHARED_NOT_PROVIDED, "account_level_total", "model_price"],
  } as const),
  balance_summary: Object.freeze({
    schemaVersion: SOURCE_CAPABILITY_SCHEMA,
    endpoint: "balance_summary",
    path: RESOURCE_SOURCE_PATHS.balance_summary,
    method: "GET",
    auth: [
      { position: "header", header: "Authorization", scheme: "Bearer", required: true },
      { position: "header", header: "X-Panel-Token", scheme: "X-Panel-Token", required: false },
    ],
    realm: { provided: true, values: ["cn", "intl"] },
    unit: "credit",
    rowIdentity: ["realm"],
    sourceTime: { field: "updated_at", precision: "second" },
    readTime: "collector_clock",
    balanceFields: ["balance", "accounts_enabled", "accounts_with_data", "updated_at"],
    usageFields: [],
    modelFields: [],
    pagination: { mode: "none", maxRows: 1 },
    errors: [
      { status: 401, code: "source_unauthorized" },
      { status: 403, code: "source_unauthorized" },
      { status: 404, code: "source_unsupported" },
      { status: 501, code: "source_unsupported" },
    ],
    requestIdField: null,
    notProvided: [...SHARED_NOT_PROVIDED, "per_account_breakdown", "credit_to_currency_rate"],
  } as const),
  models: Object.freeze({
    schemaVersion: SOURCE_CAPABILITY_SCHEMA,
    endpoint: "models",
    path: RESOURCE_SOURCE_PATHS.models,
    method: "GET",
    auth: [{ position: "header", header: "Authorization", scheme: "Bearer", required: true }],
    realm: { provided: false, values: [] },
    unit: "none",
    rowIdentity: ["id"],
    sourceTime: { field: null, precision: "none" },
    readTime: "collector_clock",
    balanceFields: [],
    usageFields: [],
    modelFields: ["id"],
    pagination: { mode: "none", maxRows: 500 },
    errors: [
      { status: 401, code: "source_unauthorized" },
      { status: 403, code: "source_unauthorized" },
      { status: 404, code: "source_unsupported" },
      { status: 501, code: "source_unsupported" },
    ],
    requestIdField: null,
    notProvided: ["model_price", "context_window", "reasoning_effort_support", "availability_window"],
  } as const),
});

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const inner of Object.values(value as unknown as Record<string, unknown>)) deepFreeze(inner, seen);
  }
  return value;
}

export function sourceCapability(endpoint: ResourceSourceEndpoint): SourceCapability {
  const capability = CAPABILITIES[endpoint];
  if (!capability) throw new Error(`unknown_source_endpoint:${String(endpoint)}`);
  return capability;
}

export function listSourceCapabilities(): readonly SourceCapability[] {
  return [CAPABILITIES.usage_remaining, CAPABILITIES.balance_summary, CAPABILITIES.models];
}

/** Every fact no configured source publishes, stated once for the receipt. */
export function unprovidedFacts(): readonly string[] {
  const all = new Set<string>();
  for (const capability of listSourceCapabilities()) for (const fact of capability.notProvided) all.add(fact);
  return [...all].sort();
}

export interface SourceConfiguration {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly panelToken?: string | null;
}

export type SourceConfigurationCheck =
  | { readonly ok: true; readonly origin: string; readonly authenticated: boolean; readonly panelToken: boolean }
  | { readonly ok: false; readonly code: "source_unconfigured" | "invalid_source_url" | "source_credential_missing"; readonly field: string };

/**
 * Validates the fixed source before any request is attempted. A loopback
 * origin with no key is a configuration error, not a request that fails later.
 */
export function checkSourceConfiguration(configuration: Partial<SourceConfiguration>): SourceConfigurationCheck {
  const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl.trim() : "";
  if (baseUrl === "") return { ok: false, code: "source_unconfigured", field: "baseUrl" };
  let origin: string;
  try {
    origin = loopbackOrigin(baseUrl);
  } catch {
    return { ok: false, code: "invalid_source_url", field: "baseUrl" };
  }
  const apiKey = typeof configuration.apiKey === "string" ? configuration.apiKey.trim() : "";
  const panelToken = typeof configuration.panelToken === "string" ? configuration.panelToken.trim() : "";
  if (apiKey === "") return { ok: false, code: "source_credential_missing", field: "apiKey" };
  return { ok: true, origin, authenticated: true, panelToken: panelToken !== "" };
}

export interface PayloadConformance {
  readonly endpoint: ResourceSourceEndpoint;
  readonly conformance: "complete" | "partial" | "invalid";
  readonly rowsRead: number;
  readonly rowsRejected: number;
  /** Required fields the payload does not carry. Never silently defaulted. */
  readonly missingFields: readonly string[];
  readonly rejectedReasons: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsOf(payload: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  return null;
}

/**
 * Compares an observed payload with the capability statement. A payload that
 * omits `generated_at` is `partial` (the source time is unknown, the read time
 * still stands); a payload with no usable rows is `invalid`.
 */
export function checkPayloadConformance(endpoint: ResourceSourceEndpoint, payload: unknown): PayloadConformance {
  const capability = sourceCapability(endpoint);
  const missingFields: string[] = [];
  const rejectedReasons: string[] = [];
  if (!isRecord(payload)) {
    return { endpoint, conformance: "invalid", rowsRead: 0, rowsRejected: 0, missingFields: ["<object>"], rejectedReasons: ["payload_not_an_object"] };
  }
  if (capability.sourceTime.field !== null && !(capability.sourceTime.field in payload)) missingFields.push(capability.sourceTime.field);
  if (capability.realm.provided && !("realm" in payload)) {
    const rows = rowsOf(payload) ?? [];
    if (rows.some(row => !isRecord(row) || typeof row.realm !== "string")) missingFields.push("realm");
  }
  if (endpoint === "usage_remaining" && !Array.isArray(payload.rows)) missingFields.push("rows");
  if (endpoint === "balance_summary") {
    for (const field of ["unit", "balance"]) if (!(field in payload)) missingFields.push(field);
    if ("unit" in payload && payload.unit !== "credit") rejectedReasons.push("unit_mismatch:balance_summary_reports_credit");
  }
  if (endpoint === "models" && !Array.isArray(payload.data)) missingFields.push("data");

  const rows = rowsOf(payload) ?? [];
  let rowsRead = 0;
  let rowsRejected = 0;
  if (rows.length > capability.pagination.maxRows) {
    rejectedReasons.push(`rows_exceed_cap:${capability.pagination.maxRows}`);
    return { endpoint, conformance: "invalid", rowsRead: 0, rowsRejected: rows.length, missingFields, rejectedReasons };
  }
  for (const row of rows) {
    if (!isRecord(row)) {
      rowsRejected += 1;
      rejectedReasons.push("row_not_an_object");
      continue;
    }
    const absent = capability.rowIdentity.filter(key => typeof row[key] !== "string" || (row[key] as string).trim() === "");
    if (absent.length > 0) {
      rowsRejected += 1;
      rejectedReasons.push(`row_identity_missing:${absent.join("+")}`);
      continue;
    }
    if (endpoint === "usage_remaining") {
      if (typeof row.model !== "string" || row.model.trim() === "") {
        rowsRejected += 1;
        rejectedReasons.push("row_model_missing");
        continue;
      }
      if (capability.realm.values.length > 0 && !capability.realm.values.includes(String(row.realm))) {
        rowsRejected += 1;
        rejectedReasons.push("row_realm_unknown");
        continue;
      }
      if (typeof row.cooling !== "boolean") {
        rowsRejected += 1;
        rejectedReasons.push("row_cooling_not_boolean");
        continue;
      }
    }
    rowsRead += 1;
  }
  if (rows.length > 0 && rowsRead === 0) {
    return { endpoint, conformance: "invalid", rowsRead: 0, rowsRejected, missingFields, rejectedReasons };
  }
  // An endpoint whose whole payload is a row list cannot be "partial" when the
  // list is absent: there is nothing to show, and nothing may be invented.
  if (rows.length === 0 && (endpoint === "usage_remaining" || endpoint === "models")) {
    if (!rejectedReasons.includes("rows_container_missing")) rejectedReasons.push("rows_container_missing");
    return { endpoint, conformance: "invalid", rowsRead: 0, rowsRejected, missingFields, rejectedReasons };
  }
  const conformance = missingFields.length === 0 && rowsRejected === 0 ? "complete" : "partial";
  return { endpoint, conformance, rowsRead, rowsRejected, missingFields, rejectedReasons };
}

export interface SourceFreshness {
  readonly status: "fresh" | "stale" | "unavailable";
  readonly ageSeconds: number | null;
  readonly sourceSkewSeconds: number | null;
  readonly reason: "within_max_age" | "max_age_exceeded" | "not_collected" | "source_time_missing";
}

/**
 * Old-but-usable data is reported as stale and still served; it is never
 * presented as fresh and never replaced by zeros.
 */
export function sourceFreshness(input: {
  readonly collectedAt: string | null;
  readonly sourceObservedAt: string | null;
  readonly maxAgeMs: number;
  readonly now: Date;
}): SourceFreshness {
  if (input.collectedAt === null) return { status: "unavailable", ageSeconds: null, sourceSkewSeconds: null, reason: "not_collected" };
  const collected = Date.parse(input.collectedAt);
  if (!Number.isFinite(collected)) return { status: "unavailable", ageSeconds: null, sourceSkewSeconds: null, reason: "not_collected" };
  const ageMs = Math.max(0, input.now.getTime() - collected);
  const sourceMs = input.sourceObservedAt === null ? null : Date.parse(input.sourceObservedAt);
  const sourceSkewSeconds = sourceMs === null || !Number.isFinite(sourceMs) ? null : Math.round((sourceMs - collected) / 1000);
  if (ageMs > input.maxAgeMs) {
    return { status: "stale", ageSeconds: Math.round(ageMs / 1000), sourceSkewSeconds, reason: "max_age_exceeded" };
  }
  return {
    status: "fresh",
    ageSeconds: Math.round(ageMs / 1000),
    sourceSkewSeconds,
    reason: sourceSkewSeconds === null ? "source_time_missing" : "within_max_age",
  };
}
