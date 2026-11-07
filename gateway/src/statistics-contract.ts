/**
 * The read-only export a consumer (B's recommendation view, D's automation)
 * may rely on.
 *
 * The document is versioned, states how fresh it is, and gives every figure a
 * coverage entry with a numerator and a denominator. A figure that nobody
 * measured is `unknown`; it is never presented as a complete count or as zero.
 */

export const STATISTICS_EXPORT_SCHEMA = "workbuddy-executor/statistics-export-1";
export const STATISTICS_EXPORT_CONTRACT = "statistics-export-contract-1";
export const STATISTICS_WINDOW_SEMANTICS = "task_created_at_utc_start_inclusive_end_exclusive";

export type CoverageStatus = "complete" | "partial" | "unknown";

/** What part of a figure is actually known, and why the rest is not. */
export interface CoverageEntry {
  /** Known part. `null` when even the numerator is unknown. */
  numerator: number | null;
  /** The whole the numerator belongs to. `null` when upstream does not publish it. */
  denominator: number | null;
  status: CoverageStatus;
  /** Stable code explaining `unknown`/`partial`; `null` when complete. */
  unknownReason: string | null;
}

export type FreshnessStatus = "fresh" | "stale" | "unknown";

export interface ExportFreshness {
  generatedAt: string;
  windowEnd: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  status: FreshnessStatus;
  reason: string;
}

export interface UsageGroupLike {
  unit: string;
  currency?: string | null;
  records?: number;
  measuredRecords?: number;
  amount?: number | null;
  [key: string]: unknown;
}

export interface OverviewLike {
  ok: boolean;
  schemaVersion: string;
  readOnly: true;
  snapshotOnly?: true;
  window: { from: string; to: string } | null;
  coverage: {
    tasksRead: number; tasksIncluded: number; tasksExcludedOutsideWindow: number;
    tasksWithoutEvents: number; tasksIncomplete: number; eventsRead: number;
    tasksTruncated: boolean; eventsTruncated: boolean;
  };
  totals: { calls?: unknown[]; usage?: UsageGroupLike[]; [key: string]: unknown };
  limitations: string[];
  claims?: { savings: null; superiority: null };
  [key: string]: unknown;
}

const ABSENT_REQUEST_COUNT = "upstream_does_not_publish_request_count";

function amountOf(groups: UsageGroupLike[], unit: string): UsageGroupLike | undefined {
  return groups.find(group => group.unit === unit);
}

/**
 * Coverage for one resource family. `denominator` stays `null` when nobody
 * publishes the total, which is what makes the status `unknown` rather than a
 * ratio of 1.
 */
export function coverageOf(numerator: number | null, denominator: number | null, unknownReason: string): CoverageEntry {
  if (denominator === null || numerator === null) {
    return { numerator, denominator, status: "unknown", unknownReason };
  }
  if (denominator === 0) return { numerator, denominator, status: "unknown", unknownReason };
  const status: CoverageStatus = numerator >= denominator ? "complete" : "partial";
  return { numerator, denominator, status, unknownReason: status === "partial" ? unknownReason : null };
}

/** Request/token/amount coverage, each stated separately. */
export function usageCoverage(groups: UsageGroupLike[]): { requests: CoverageEntry; tokens: CoverageEntry; amounts: CoverageEntry } {
  const requests = coverageOf(groups.length > 0 ? groups.length : 0, null, ABSENT_REQUEST_COUNT);
  const tokens = amountOf(groups, "tokens");
  const amounts = amountOf(groups, "credits") ?? amountOf(groups, "currency");
  return {
    requests,
    tokens: coverageOf(tokens ? tokens.records ?? 0 : 0, null, "token_count_not_published"),
    amounts: coverageOf(amounts ? amounts.records ?? 0 : 0, null, "price_not_published"),
  };
}

export function freshnessOf(generatedAt: Date, windowEnd: string | null, maxAgeSeconds = 900): ExportFreshness {
  if (!windowEnd || !Number.isFinite(Date.parse(windowEnd))) {
    return { generatedAt: generatedAt.toISOString(), windowEnd: null, ageSeconds: null, maxAgeSeconds, status: "unknown", reason: "window_end_unknown" };
  }
  const ageSeconds = Math.max(0, Math.round((generatedAt.getTime() - Date.parse(windowEnd)) / 1000));
  return {
    generatedAt: generatedAt.toISOString(), windowEnd, ageSeconds, maxAgeSeconds,
    status: ageSeconds <= maxAgeSeconds ? "fresh" : "stale",
    reason: ageSeconds <= maxAgeSeconds ? "window_ends_within_max_age" : "window_older_than_max_age",
  };
}

export interface StatisticsExport {
  schemaVersion: string;
  contractVersion: string;
  readOnly: true;
  snapshotOnly: true;
  generatedAt: string;
  sourceSchema: string;
  window: { from: string; to: string } | null;
  windowSemantics: string;
  freshness: ExportFreshness;
  coverage: {
    tasks: CoverageEntry;
    events: CoverageEntry;
    requests: CoverageEntry;
    tokens: CoverageEntry;
    amounts: CoverageEntry;
  };
  totals: OverviewLike["totals"];
  limitations: string[];
  claims: { savings: null; superiority: null };
  /** What a consumer may and may not conclude from this document. */
  consumerRules: string[];
}

/**
 * Wrap an overview read into the export a different line may consume.
 *
 * Nothing here writes: the export is derived from one read, carries its own
 * version and freshness, and repeats the source's limitations instead of
 * summarizing them away.
 */
export function buildStatisticsExport(overview: OverviewLike, options: { generatedAt: Date; maxAgeSeconds?: number }): StatisticsExport {
  if (!overview.ok) throw new Error("statistics_export_requires_ok_overview");
  const groups = overview.totals.usage ?? [];
  const usage = usageCoverage(groups);
  const tasks: CoverageEntry = overview.coverage.tasksTruncated
    ? { numerator: overview.coverage.tasksRead, denominator: null, status: "unknown", unknownReason: "task_list_truncated" }
    : { numerator: overview.coverage.tasksRead, denominator: overview.coverage.tasksRead, status: "complete", unknownReason: null };
  const events: CoverageEntry = overview.coverage.eventsTruncated
    ? { numerator: overview.coverage.eventsRead, denominator: null, status: "unknown", unknownReason: "event_stream_truncated" }
    : overview.coverage.tasksWithoutEvents > 0
      ? { numerator: overview.coverage.tasksIncluded - overview.coverage.tasksWithoutEvents, denominator: overview.coverage.tasksIncluded, status: "partial", unknownReason: "tasks_without_event_stream" }
      : { numerator: overview.coverage.eventsRead, denominator: overview.coverage.eventsRead, status: "complete", unknownReason: null };

  return {
    schemaVersion: STATISTICS_EXPORT_SCHEMA,
    contractVersion: STATISTICS_EXPORT_CONTRACT,
    readOnly: true,
    snapshotOnly: true,
    generatedAt: options.generatedAt.toISOString(),
    sourceSchema: overview.schemaVersion,
    window: overview.window,
    windowSemantics: STATISTICS_WINDOW_SEMANTICS,
    freshness: freshnessOf(options.generatedAt, overview.window?.to ?? null, options.maxAgeSeconds ?? 900),
    coverage: { tasks, events, requests: usage.requests, tokens: usage.tokens, amounts: usage.amounts },
    totals: overview.totals,
    limitations: [...overview.limitations],
    claims: { savings: null, superiority: null },
    consumerRules: [
      "read only: this document never triggers a model request, a collection or a task write",
      "a figure with coverage.status != complete is a floor, not a total",
      "coverage.requests.denominator is null because upstream publishes no request count; that is unknown, not 100%",
      "tokens and amounts are separate units and are never added together",
      "routing is not proven by this document: see routing evidence layers for the verified flag",
      "claims.savings and claims.superiority stay null until a comparison is measured",
    ],
  };
}

/** The contract a consumer reads before it parses anything. */
export function describeStatisticsExportContract() {
  return {
    schemaVersion: STATISTICS_EXPORT_SCHEMA,
    contractVersion: STATISTICS_EXPORT_CONTRACT,
    windowSemantics: STATISTICS_WINDOW_SEMANTICS,
    required: ["schemaVersion", "contractVersion", "readOnly", "snapshotOnly", "generatedAt", "window", "freshness", "coverage", "totals", "limitations", "claims"],
    coverageKeys: ["tasks", "events", "requests", "tokens", "amounts"],
    maybeUnknown: ["coverage.*.numerator", "coverage.*.denominator", "totals.usage", "claims.savings", "claims.superiority", "window"],
    neverZeroFilled: ["tokens", "amounts", "calls", "requests"],
    freshness: { statuses: ["fresh", "stale", "unknown"], defaultMaxAgeSeconds: 900 },
  } as const;
}
