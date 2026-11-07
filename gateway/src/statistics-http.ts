/**
 * Read-only statistics HTTP adapter (L03).
 *
 * This module owns the two statistics paths and their exact status mapping. The
 * transport in workbench-http.ts only needs to hand them the pathname and query,
 * so wiring is two lines and no second store is constructed:
 *
 *   const statistics = handleStatisticsRequest(sources, pathname, url.search);
 *   if (statistics) { this.send(response, statistics.status, statistics.body); return; }
 *
 * Routing rules:
 *   - GET /workbench/v1/statistics
 *       Windowed overview. `from`, `to` are UTC ISO bounds on task createdAt;
 *       `limit` bounds the returned rows (1-100). No task state is written.
 *   - GET /workbench/v1/statistics/tasks/:taskId
 *       One task's MetricSummary, recomputable from its raw event stream.
 *
 * The task id is never turned into a path: it must be a stored identifier of
 * 1-200 characters with no separator, so this endpoint cannot become a file
 * reader. Unknown sub-paths and extra segments answer 404 from the caller, not a
 * permissive match here.
 */

import type { TaskUsageAttribution } from "./usage-attribution.js";
import { buildStatisticsExport } from "./statistics-contract.js";
import {
  readStatisticsOverview,
  readTaskStatistics,
  parseStatisticsQuery,
  STATISTICS_SCHEMA,
  type StatisticsSources,
  type StatisticsStore,
} from "./statistics-service.js";

export const STATISTICS_PREFIX = "/workbench/v1/statistics";
export const STATISTICS_EXPORT_PATH = `${STATISTICS_PREFIX}/export`;

export interface StatisticsRouteResponse {
  status: number;
  body: unknown;
}

/** Build the two read sources; the store is the one the service already owns. */
export function statisticsSources(store: StatisticsStore, usageFor?: (taskId: string, attemptIds: readonly string[]) => TaskUsageAttribution | null): StatisticsSources {
  return usageFor ? { store, usageFor } : { store };
}

function errorBody(code: string, message: string, taskId: string | null = null): StatisticsRouteResponse {
  // statusFor keys on the internal lower-case code; the envelope carries the
  // published upper-case code. Deriving the status from the envelope spelling
  // silently turned every 400/404/503 into 500.
  const normalized = code.toLowerCase();
  return {
    status: statusFor(normalized),
    body: { error: { code: normalized.toUpperCase(), message, retryable: false, taskId, attemptId: null, operationId: null }, view: null },
  };
}

function statusFor(code: string): number {
  switch (code) {
    case "invalid_task_id":
    case "invalid_window":
    case "invalid_limit":
    case "invalid_query":
      return 400;
    case "task_not_found":
    case "not_found":
      return 404;
    case "contract_integrity":
    case "store_unavailable":
    case "event_stream_unreadable":
      return 503;
    default:
      return 500;
  }
}

/** A stored task id is an identifier, never a path fragment. */
export function isStatisticsTaskId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\/\\\u0000-\u001f]/.test(value);
}

/**
 * Handle one statistics path, or return null for any other path.
 *
 * The caller performs the loopback/Host/Origin checks and the GET-only rule
 * before calling this; this function performs no I/O of its own.
 */
export function handleStatisticsRequest(sources: StatisticsSources, pathname: string, search: string): StatisticsRouteResponse | null {
  if (pathname !== STATISTICS_PREFIX && !pathname.startsWith(`${STATISTICS_PREFIX}/`)) return null;

  if (pathname === STATISTICS_PREFIX) {
    const parsed = parseStatisticsQuery(search);
    if (!parsed.ok) return errorBody(parsed.code.toUpperCase(), parsed.message);
    const overview = readStatisticsOverview(sources, parsed.query);
    if (!overview.ok) return errorBody(overview.code.toUpperCase(), overview.message);
    return { status: 200, body: { ...overview, schemaVersion: STATISTICS_SCHEMA } };
  }

  if (pathname === STATISTICS_EXPORT_PATH) {
    // Same window query as the overview, so a consumer can recompute the export
    // from the page it already fetched. Read-only and snapshot-only: nothing is
    // written, no source is contacted.
    const parsed = parseStatisticsQuery(search);
    if (!parsed.ok) return errorBody(parsed.code.toUpperCase(), parsed.message);
    const overview = readStatisticsOverview(sources, parsed.query);
    if (!overview.ok) return errorBody(overview.code.toUpperCase(), overview.message);
    return { status: 200, body: buildStatisticsExport(overview, { generatedAt: new Date() }) };
  }

  const match = /^\/workbench\/v1\/statistics\/tasks\/([^/]+)$/.exec(pathname);
  if (!match) return errorBody("NOT_FOUND", "No such statistics endpoint.");
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1]!);
  } catch {
    return errorBody("INVALID_TASK_ID", "The encoded task identifier is malformed.");
  }
  if (!isStatisticsTaskId(taskId)) return errorBody("INVALID_TASK_ID", "The task id must be 1-200 characters and must not contain a path separator.");
  const result = readTaskStatistics(sources, taskId);
  if (!result.ok) return errorBody(result.code.toUpperCase(), result.message, result.taskId);
  return { status: 200, body: { ...result, schemaVersion: STATISTICS_SCHEMA } };
}
