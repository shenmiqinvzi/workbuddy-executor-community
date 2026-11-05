/**
 * Request-level attribution: a stated capability gap, not a guess.
 *
 * The upstream hub answers `/usage/remaining` with an account × model aggregate
 * and `/v1/balance-summary` with one balance per account. Neither payload has a
 * request identifier, a task identifier, a session, a role, a unit marker or a
 * usage level, so no code path here can name the request a token came from.
 *
 * Three things follow, and this module makes them explicit instead of leaving
 * them implied in prose:
 *  1. the document says `unavailable` with a machine-readable reason;
 *  2. every attribute a downstream statistics service would want is `null`,
 *     never `0`, `"unknown"` or a value borrowed from another level;
 *  3. the work needed to make it available is a concrete to-do list for the
 *     line that owns a real authorised integration.
 *
 * Statistics consumers may call `normalizeAttributionUsage` with whatever their
 * own record carries: a missing field stays null, a unit outside the gateway's
 * vocabulary is rejected rather than converted, and no amount is ever summed
 * across units.
 */
export const REQUEST_ATTRIBUTION_SCHEMA = "workbuddy-executor/request-attribution-1";

/** Units the gateway can report without converting anything. */
export const ATTRIBUTION_UNITS = ["tokens", "credit"] as const;
/** Levels a usage figure can belong to; a figure never moves between them. */
export const ATTRIBUTION_LEVELS = ["request", "task", "session", "pool"] as const;

export type AttributionUnit = (typeof ATTRIBUTION_UNITS)[number];
export type AttributionLevel = (typeof ATTRIBUTION_LEVELS)[number];

export interface AttributionUsage {
  schemaVersion: typeof REQUEST_ATTRIBUTION_SCHEMA;
  requestId: string | null;
  taskId: string | null;
  sessionId: string | null;
  role: string | null;
  unit: AttributionUnit | null;
  usageLevel: AttributionLevel | null;
  /** The amount in `unit`, or null; null is never rendered as zero. */
  value: number | null;
  /** Fields that were present but refused, with the reason. */
  rejected: { field: string; code: string }[];
}

const bounded = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n]/.test(value);

/**
 * Normalises one optional usage record for a statistics consumer. Every absent
 * field stays null; an invalid unit or level is rejected instead of coerced, so
 * a caller cannot end up adding tokens to credits.
 */
export function normalizeAttributionUsage(input: unknown): AttributionUsage {
  const usage: AttributionUsage = {
    schemaVersion: REQUEST_ATTRIBUTION_SCHEMA, requestId: null, taskId: null, sessionId: null,
    role: null, unit: null, usageLevel: null, value: null, rejected: [],
  };
  if (input === undefined || input === null) return usage;
  if (typeof input !== "object" || Array.isArray(input)) {
    usage.rejected.push({ field: "record", code: "record_not_object" });
    return usage;
  }
  const record = input as Record<string, unknown>;
  const text = (key: "requestId" | "taskId" | "sessionId" | "role") => {
    const value = record[key];
    if (value === undefined || value === null) return;
    if (bounded(value)) usage[key] = value;
    else usage.rejected.push({ field: key, code: "field_invalid" });
  };
  for (const key of ["requestId", "taskId", "sessionId", "role"] as const) text(key);

  const unit = record.unit;
  if (unit !== undefined && unit !== null) {
    if (typeof unit === "string" && (ATTRIBUTION_UNITS as readonly string[]).includes(unit)) usage.unit = unit as AttributionUnit;
    else usage.rejected.push({ field: "unit", code: "unit_unsupported" });
  }
  const level = record.usageLevel;
  if (level !== undefined && level !== null) {
    if (typeof level === "string" && (ATTRIBUTION_LEVELS as readonly string[]).includes(level)) usage.usageLevel = level as AttributionLevel;
    else usage.rejected.push({ field: "usageLevel", code: "usage_level_unsupported" });
  }
  const value = record.value;
  if (value !== undefined && value !== null) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage.value = value;
    else usage.rejected.push({ field: "value", code: "value_invalid" });
  }
  // An amount without a unit, or a unit without an amount, stays incomplete:
  // neither side is filled in from the other.
  if (usage.unit === null && usage.value !== null) { usage.value = null; usage.rejected.push({ field: "value", code: "unit_missing" }); }
  return usage;
}

export interface RequestAttributionGap {
  schemaVersion: typeof REQUEST_ATTRIBUTION_SCHEMA;
  readOnly: true;
  capability: "request_level_attribution";
  status: "unavailable";
  reason: "upstream_payload_lacks_request_identity";
  /** What the two upstream payloads actually contain. */
  observedPayload: { tokenFields: string[]; creditFields: string[] };
  /** Every request-shaped attribute, left absent rather than invented. */
  fields: { requestId: null; role: null; unit: null; usageLevel: null };
  /** Optional links: null means "not derivable", not "no usage". */
  optionalLinks: { taskId: null; sessionId: null; providerId: null; modelIdForRequest: null };
  /** What the gateway can say, and what it therefore cannot. */
  knownAt: { connection: true; pool: true; modelAggregate: true; task: false; session: false; request: false };
  doesNotProve: string[];
  /** Ready-made hand-off for the real-integration line. */
  integrationTodo: string[];
  limitations: string[];
}

/**
 * The gap document. Static by design: it describes the contract, so it does not
 * vary with whatever happened to be cached in one read.
 */
export function buildRequestAttribution(): RequestAttributionGap {
  return {
    schemaVersion: REQUEST_ATTRIBUTION_SCHEMA,
    readOnly: true,
    capability: "request_level_attribution",
    status: "unavailable",
    reason: "upstream_payload_lacks_request_identity",
    observedPayload: {
      // Named as field lists, never with a key that reads like a credential.
      tokenFields: ["account", "model", "used", "budget", "reset_at", "generated_at"],
      creditFields: ["account", "realm", "balance", "accounts_enabled", "accounts_with_data", "observed_at"],
    },
    fields: { requestId: null, role: null, unit: null, usageLevel: null },
    optionalLinks: { taskId: null, sessionId: null, providerId: null, modelIdForRequest: null },
    knownAt: { connection: true, pool: true, modelAggregate: true, task: false, session: false, request: false },
    doesNotProve: [
      "that one task, session or request caused a stored token or credit figure",
      "that a plan's declared model is the model an upstream call used",
      "that a shared pool balance is reserved for, or spendable by, one execution",
      "that the account behind an API key is the only account in the pool",
    ],
    integrationTodo: [
      "Persist one request identifier per upstream call in the hub, and return it on the usage rows that call produced.",
      "Carry task and session identifiers from the executor dispatch into the hub ledger so a usage row can name them.",
      "Return the provider and upstream model id actually used, not only the executor's declared model.",
      "Tag every amount with its unit (tokens, credit) in a separate field; never publish a mixed total.",
      "Tag every amount with its usage level (request, task, session, pool) so aggregates cannot be re-read as request usage.",
      "Publish the source-side observation time per row, not only the gateway collection time.",
      "Add a read-only cursor endpoint for history so a consumer can page request rows without a write path.",
      "Keep the existing `attribution` marker (`connection_only`) until the fields above exist, so old readers degrade loudly.",
      "Keep panel-token rotation (7-day TTL, reset on restart) observable, because a gap in history must not look like zero usage.",
      "Re-run this acceptance with authorised keys in a real window: real keys, real pool, no synthetic rows.",
    ],
    limitations: ["request_attribution_unavailable", "task_to_model_unverified", "unit_mixing_forbidden", "no_estimate_substituted"],
  };
}
