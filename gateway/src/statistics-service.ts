/**
 * Read-only resource statistics (L03 / D6-01, D6-02, D6-05).
 *
 * This module turns stored facts into two read-only answers:
 *   - one task's MetricSummary, recomputable from that task's raw events;
 *   - a windowed overview over stored tasks, with its sample size and every
 *     caveat carried explicitly.
 *
 * Boundaries:
 *   - The store surface is structural and read-only: get, listAttempts,
 *     listTaskEvents, getContract, listTasksByCreatedCursor and
 *     reviews.list. Nothing here writes, migrates, syncs, dispatches, opens a
 *     file or calls a model.
 *   - No "now" is read: the same stored rows produce the same answer, which is
 *     what lets an export be recomputed and compared.
 *   - Usage comes only from an injected ledger reader. Without one, usage is
 *     null (never 0) and the summary names `usage_ledger_absent`.
 *   - The overview never claims savings or superiority: those numbers were not
 *     measured here, so they are null with named limitations.
 */

import type { StoredAttempt, StoredTask, StoredTaskEvent, TaskContractRead } from "./task-store.js";
import type { PersistedTaskContract } from "./task-contract.js";
import type { ReviewRecord } from "./task-reviews.js";
import { buildTaskMetricSummary } from "./task-metrics.js";
import type { TaskViewCallMetric, TaskViewMetricSummary } from "./task-view.js";
import type { TaskUsageAttribution, UsageAmountGroup, UsageAttributionLevel } from "./usage-attribution.js";

/** Version of the statistics envelope this build answers. */
export const STATISTICS_SCHEMA = "workbuddy-executor/statistics-1";
/** Event pages are read in contract-sized pages; the cap bounds one task's read. */
export const STATISTICS_EVENT_PAGE_LIMIT = 200;
export const STATISTICS_EVENT_PAGE_CAP = 50;
/** Tasks are listed in stable created_at ASC pages; the cap bounds one overview. */
export const STATISTICS_TASK_PAGE_CAP = 10;
export const STATISTICS_TASK_LIMIT_MAX = 100;

/** The exact read surface; anything else is not reachable from here. */
export interface StatisticsStore {
  get(taskId: string): StoredTask | undefined;
  listAttempts(taskId: string): StoredAttempt[];
  listTaskEvents(taskId: string, options?: { afterEventId?: number; limit?: number }): { events: StoredTaskEvent[]; nextEventId: number };
  getContract(taskId: string): TaskContractRead;
  listTasksByCreatedCursor(options: { limit: number; afterTaskId?: string }): { tasks: StoredTask[]; anchorFound: boolean };
  reviews: { list(taskId: string): ReviewRecord[] };
}

export interface StatisticsSources {
  store: StatisticsStore;
  /**
   * Attribution reader for one task. Omitted means "no ledger was read": the
   * usage fields stay null instead of being estimated from wall time or from
   * another task's spend.
   */
  usageFor?: (taskId: string, attemptIds: readonly string[]) => TaskUsageAttribution | null;
}

export type StatisticsFailureCode =
  | "invalid_task_id"
  | "invalid_window"
  | "task_not_found"
  | "contract_integrity"
  | "store_unavailable"
  | "event_stream_unreadable";

export interface StatisticsFailure {
  ok: false;
  readOnly: true;
  snapshotOnly: true;
  code: StatisticsFailureCode;
  taskId: string | null;
  field: string;
  message: string;
}

/** One task's statistics, with the facts its metrics were built from. */
export interface TaskStatistics {
  ok: true;
  readOnly: true;
  snapshotOnly: true;
  schemaVersion: typeof STATISTICS_SCHEMA;
  taskId: string;
  state: StoredTask["state"];
  createdAt: string;
  /** How many rows the metrics were computed from; lets a reader recompute. */
  sources: { attempts: number; events: number; reviews: number; eventsTruncated: boolean };
  /** The raw attribution the usage fields were read from, or null when none was read. */
  attribution: TaskUsageAttribution | null;
  metrics: TaskViewMetricSummary;
}

export type TaskStatisticsResult = TaskStatistics | StatisticsFailure;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isStatisticsTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function failure(code: StatisticsFailureCode, taskId: string | null, field: string, message: string): StatisticsFailure {
  return { ok: false, readOnly: true, snapshotOnly: true, code, taskId, field, message };
}

/** Read the whole event stream in bounded pages; a stalled cursor is a failure, not a loop. */
function readEventStream(store: StatisticsStore, taskId: string, pageCap: number): { events: StoredTaskEvent[]; truncated: boolean } {
  const events: StoredTaskEvent[] = [];
  let after = 0;
  for (let page = 0; page < pageCap; page += 1) {
    const result = store.listTaskEvents(taskId, { afterEventId: after, limit: STATISTICS_EVENT_PAGE_LIMIT });
    if (result.events.length === 0) return { events, truncated: false };
    events.push(...result.events);
    const last = result.events[result.events.length - 1]!.eventId;
    if (!Number.isFinite(last) || last <= after) return { events, truncated: true };
    after = last;
  }
  return { events, truncated: true };
}

/**
 * Read one task's statistics.
 *
 * A contract that exists but no longer verifies is reported as its own failure:
 * required-check counts would otherwise look like "this task has no contract"
 * and silently drop every acceptance denominator.
 */
export function readTaskStatistics(sources: StatisticsSources, taskId: string, options: { eventPageCap?: number } = {}): TaskStatisticsResult {
  // The same shape the HTTP entry accepts: an identifier, never a path
  // fragment. Checking it here too keeps a caller that bypasses the transport
  // from turning this read into a lookup for something path-shaped.
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 200 || /[\/\\\u0000-\u001f]/.test(taskId)) {
    return failure("invalid_task_id", taskId, "taskId", "The task id must be 1-200 characters and must not contain a path separator.");
  }
  let task: StoredTask | undefined;
  try {
    task = sources.store.get(taskId);
  } catch {
    return failure("store_unavailable", taskId, "store.get", "Reading the task record failed; this is not reported as a missing task.");
  }
  if (!task) return failure("task_not_found", taskId, "taskId", "No stored task has this id; statistics are never fabricated for one.");

  let contract: PersistedTaskContract | null;
  try {
    const read = sources.store.getContract(taskId);
    if (read.state === "integrity_failure") {
      return failure("contract_integrity", taskId, `contract.${read.integrity.problem}`, `The stored contract failed integrity: ${read.integrity.detail}.`);
    }
    contract = read.state === "found" ? read.record : null;
  } catch {
    return failure("store_unavailable", taskId, "store.getContract", "Reading the task contract failed; this is not reported as a task without one.");
  }

  let attempts: StoredAttempt[];
  let reviews: ReviewRecord[];
  try {
    attempts = sources.store.listAttempts(taskId);
    reviews = sources.store.reviews.list(taskId);
  } catch {
    return failure("store_unavailable", taskId, "store.attempts", "Reading the attempt or review records failed.");
  }

  let stream: { events: StoredTaskEvent[]; truncated: boolean };
  try {
    stream = readEventStream(sources.store, taskId, options.eventPageCap ?? STATISTICS_EVENT_PAGE_CAP);
  } catch {
    return failure("event_stream_unreadable", taskId, "store.listTaskEvents", "Reading the event stream failed; this is not reported as an empty stream.");
  }

  const attemptIds = attempts.map(attempt => attempt.attemptId);
  let usage: TaskUsageAttribution | null = null;
  if (sources.usageFor) {
    try {
      usage = sources.usageFor(taskId, attemptIds);
    } catch {
      usage = null;
    }
  }

  const metrics = buildTaskMetricSummary({
    task, attempts, events: stream.events, reviews, contract, usage,
    limitations: stream.truncated ? ["event_stream_truncated"] : [],
  });

  return {
    ok: true,
    readOnly: true,
    snapshotOnly: true,
    schemaVersion: STATISTICS_SCHEMA,
    taskId: task.taskId,
    state: task.state,
    createdAt: task.createdAt,
    sources: { attempts: attempts.length, events: stream.events.length, reviews: reviews.length, eventsTruncated: stream.truncated },
    attribution: usage,
    metrics,
  };
}

/* ------------------------------------------------------------------ *
 * Windowed overview
 * ------------------------------------------------------------------ */

export interface StatisticsWindow {
  /** Inclusive lower bound on task createdAt, or null for "no lower bound". */
  from: string | null;
  /** Inclusive upper bound on task createdAt, or null for "no upper bound". */
  to: string | null;
}

export interface StatisticsQuery {
  window: StatisticsWindow;
  /** Upper bound on the tasks included in the overview. */
  limit: number;
}

export type StatisticsQueryResult =
  | { ok: true; query: StatisticsQuery }
  | { ok: false; code: "invalid_window" | "invalid_limit" | "invalid_query"; field: string; message: string };

/**
 * Parse `from`, `to` and `limit` from a query string.
 *
 * Timestamps must be UTC ISO with `Z`: a local-time string would silently mean
 * a different instant on another machine, so it is refused rather than guessed.
 * `from > to` is an error, not an empty window.
 */
export function parseStatisticsQuery(search: string): StatisticsQueryResult {
  const params = new URLSearchParams(search);
  const allowed = new Set(["from", "to", "limit"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) return { ok: false, code: "invalid_query", field: key, message: "Unknown statistics parameter." };
  }
  const from = params.get("from");
  const to = params.get("to");
  if (from !== null && !isStatisticsTimestamp(from)) return { ok: false, code: "invalid_window", field: "from", message: "from must be a UTC ISO timestamp ending in Z." };
  if (to !== null && !isStatisticsTimestamp(to)) return { ok: false, code: "invalid_window", field: "to", message: "to must be a UTC ISO timestamp ending in Z." };
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) {
    return { ok: false, code: "invalid_window", field: "from", message: "from must not be later than to." };
  }
  const rawLimit = params.get("limit");
  let limit = 20;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) return { ok: false, code: "invalid_limit", field: "limit", message: "limit must be a decimal integer from 1 to 100." };
    limit = Number.parseInt(rawLimit, 10);
    if (limit < 1 || limit > STATISTICS_TASK_LIMIT_MAX) return { ok: false, code: "invalid_limit", field: "limit", message: "limit must be from 1 to 100." };
  }
  return { ok: true, query: { window: { from, to }, limit } };
}

export interface StatisticsCoverage {
  /** Tasks whose rows were read (before window filtering). */
  tasksRead: number;
  tasksIncluded: number;
  tasksExcludedOutsideWindow: number;
  /** Included tasks with no persistent event at all (legacy rows). */
  tasksWithoutEvents: number;
  /** Included tasks whose summary is not complete. */
  tasksIncomplete: number;
  eventsRead: number;
  /** true when the task page cap stopped the read short of the whole store. */
  tasksTruncated: boolean;
  /** true when any task's event stream hit its page cap. */
  eventsTruncated: boolean;
}

export interface StatisticsTotals {
  taskStates: Record<string, number>;
  calls: TaskViewCallMetric[];
  acceptance: {
    tasksWithContract: number;
    accepted: number;
    reviewCount: number;
    requiredCheckTotal: number;
    requiredCheckPassed: number;
    requiredCheckUnknown: number;
    requiredCheckCheckerError: number;
  };
  rework: { rounds: number; tasksWithRework: number; reasons: Record<string, number> };
  recovery: { events: number; recoveredTasks: number };
  interventions: { episodes: number; requested: number; resolved: number; rejected: number; expired: number };
  /** Usage amounts stay separated by unit and currency; they are never added across units. */
  usage: UsageAmountGroup[];
  attribution: { exact: number; connection_only: number; unavailable: number };
}

export interface StatisticsRow {
  taskId: string;
  state: StoredTask["state"];
  createdAt: string;
  complete: boolean;
  calls: TaskViewCallMetric[];
  acceptance: TaskViewMetricSummary["acceptance"];
  rework: TaskViewMetricSummary["rework"];
  recovery: TaskViewMetricSummary["recovery"];
  interventions: TaskViewMetricSummary["interventions"];
  usage: TaskViewMetricSummary["usage"];
  /** The attribution level behind `usage`; null when no attribution was read. */
  attribution: UsageAttributionLevel | null;
  limitations: string[];
}

export interface StatisticsOverview {
  ok: true;
  readOnly: true;
  snapshotOnly: true;
  schemaVersion: typeof STATISTICS_SCHEMA;
  window: StatisticsWindow;
  coverage: StatisticsCoverage;
  totals: StatisticsTotals;
  rows: StatisticsRow[];
  limitations: string[];
  limitationCounts: Record<string, number>;
  /**
   * Claims this resource does not make. Both stay null until a controlled
   * comparison with a stated sample exists; an unmeasured saving is not zero.
   */
  claims: { savings: null; superiority: null };
}

export type StatisticsOverviewResult = StatisticsOverview | StatisticsFailure;

function mergeCalls(target: Map<string, TaskViewCallMetric>, calls: readonly TaskViewCallMetric[]): void {
  for (const call of calls) {
    const key = `${call.channel}\u0000${call.outcome}`;
    const existing = target.get(key) ?? {
      channel: call.channel, outcome: call.outcome, count: 0,
      stdoutBytes: null, stderrBytes: null, combinedBytes: null, wireBytes: null,
    };
    existing.count += call.count;
    for (const field of ["stdoutBytes", "stderrBytes", "combinedBytes", "wireBytes"] as const) {
      const value = call[field];
      if (value === null) continue;
      existing[field] = (existing[field] ?? 0) + value;
    }
    target.set(key, existing);
  }
}

function mergeUsage(target: Map<string, UsageAmountGroup>, groups: readonly UsageAmountGroup[]): void {
  for (const group of groups) {
    const key = `${group.unit}\u0000${group.currency ?? ""}`;
    const existing = target.get(key) ?? {
      unit: group.unit, currency: group.currency, records: 0,
      measuredRecords: 0, estimatedRecords: 0, unavailableRecords: 0, amount: null,
    };
    existing.records += group.records;
    existing.measuredRecords += group.measuredRecords;
    existing.estimatedRecords += group.estimatedRecords;
    existing.unavailableRecords += group.unavailableRecords;
    if (group.amount !== null) existing.amount = (existing.amount ?? 0) + group.amount;
    target.set(key, existing);
  }
}

function withinWindow(createdAt: string, window: StatisticsWindow): boolean {
  if (window.from !== null && createdAt < window.from) return false;
  if (window.to !== null && createdAt > window.to) return false;
  return true;
}

/**
 * Build the windowed overview.
 *
 * Ordering is the store's stable created_at ASC + task_id ASC. The overview
 * reads at most `STATISTICS_TASK_PAGE_CAP` pages of 500 and reports the
 * truncation instead of pretending the store ended.
 */
export function readStatisticsOverview(sources: StatisticsSources, query: StatisticsQuery): StatisticsOverviewResult {
  const collected: StoredTask[] = [];
  let tasksTruncated = false;
  let afterTaskId: string | undefined;
  try {
    for (let page = 0; page < STATISTICS_TASK_PAGE_CAP; page += 1) {
      const result = sources.store.listTasksByCreatedCursor({ limit: 500, ...(afterTaskId ? { afterTaskId } : {}) });
      if (!result.anchorFound) { tasksTruncated = true; break; }
      collected.push(...result.tasks);
      if (result.tasks.length < 500) break;
      afterTaskId = result.tasks[result.tasks.length - 1]!.taskId;
      if (page === STATISTICS_TASK_PAGE_CAP - 1) tasksTruncated = true;
    }
  } catch {
    return failure("store_unavailable", null, "store.listTasksByCreatedCursor", "Reading the task list failed; this is not reported as an empty overview.");
  }

  const calls = new Map<string, TaskViewCallMetric>();
  const usageGroups = new Map<string, UsageAmountGroup & { records: number }>();
  const reasons: Record<string, number> = {};
  const taskStates: Record<string, number> = {};
  const limitationCounts: Record<string, number> = {};
  const totals: StatisticsTotals = {
    taskStates,
    calls: [],
    acceptance: { tasksWithContract: 0, accepted: 0, reviewCount: 0, requiredCheckTotal: 0, requiredCheckPassed: 0, requiredCheckUnknown: 0, requiredCheckCheckerError: 0 },
    rework: { rounds: 0, tasksWithRework: 0, reasons },
    recovery: { events: 0, recoveredTasks: 0 },
    interventions: { episodes: 0, requested: 0, resolved: 0, rejected: 0, expired: 0 },
    usage: [],
    attribution: { exact: 0, connection_only: 0, unavailable: 0 },
  };
  const rows: StatisticsRow[] = [];
  let included = 0, excluded = 0, withoutEvents = 0, incomplete = 0, eventsRead = 0, eventsTruncated = false;

  for (const task of collected) {
    taskStates[task.state] = (taskStates[task.state] ?? 0) + 1;
    if (!withinWindow(task.createdAt, query.window)) { excluded += 1; continue; }
    const result = readTaskStatistics(sources, task.taskId);
    if (!result.ok) {
      // A per-task failure keeps the window honest: it is counted as incomplete
      // and named, never dropped from the denominator.
      included += 1;
      incomplete += 1;
      limitationCounts[`task_unreadable:${result.code}`] = (limitationCounts[`task_unreadable:${result.code}`] ?? 0) + 1;
      continue;
    }
    included += 1;
    eventsRead += result.sources.events;
    if (result.sources.eventsTruncated) eventsTruncated = true;
    if (result.sources.events === 0) withoutEvents += 1;
    if (!result.metrics.complete) incomplete += 1;
    if (rows.length < query.limit) {
      rows.push({
        taskId: result.taskId, state: result.state, createdAt: result.createdAt, complete: result.metrics.complete,
        calls: result.metrics.calls, acceptance: result.metrics.acceptance, rework: result.metrics.rework,
        recovery: result.metrics.recovery, interventions: result.metrics.interventions,
        usage: result.metrics.usage, attribution: result.attribution?.attribution ?? null, limitations: result.metrics.limitations,
      });
    }
    mergeCalls(calls, result.metrics.calls);
    for (const limitation of result.metrics.limitations) limitationCounts[limitation] = (limitationCounts[limitation] ?? 0) + 1;

    const acceptance = result.metrics.acceptance;
    if (acceptance.requiredCheckTotal !== null) {
      totals.acceptance.tasksWithContract += 1;
      totals.acceptance.requiredCheckTotal += acceptance.requiredCheckTotal;
      totals.acceptance.requiredCheckPassed += acceptance.requiredCheckPassed ?? 0;
      totals.acceptance.requiredCheckUnknown += acceptance.requiredCheckUnknown ?? 0;
      totals.acceptance.requiredCheckCheckerError += acceptance.requiredCheckCheckerError ?? 0;
    }
    if (acceptance.acceptedAt !== null) totals.acceptance.accepted += 1;
    totals.acceptance.reviewCount += acceptance.reviewCount ?? 0;

    if (result.metrics.rework.rounds !== null) {
      totals.rework.rounds += result.metrics.rework.rounds;
      if (result.metrics.rework.rounds > 0) totals.rework.tasksWithRework += 1;
      for (const reason of result.metrics.rework.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    if (result.metrics.recovery.events !== null) totals.recovery.events += result.metrics.recovery.events;
    if (result.metrics.recovery.recoveredTasks !== null) totals.recovery.recoveredTasks += result.metrics.recovery.recoveredTasks;
    for (const field of ["episodes", "requested", "resolved", "rejected", "expired"] as const) {
      const value = result.metrics.interventions[field];
      if (value !== null) totals.interventions[field] += value;
    }
    // Usage: only what the attribution reader actually returned. A null
    // attribution is counted as unavailable, never as a zero amount, and the
    // per-unit groups keep currency apart.
    if (result.attribution) {
      totals.attribution[result.attribution.attribution] += 1;
      mergeUsage(usageGroups, result.attribution.totals);
    } else {
      totals.attribution.unavailable += 1;
    }
  }

  const limitations = new Set(Object.keys(limitationCounts));
  if (!sources.usageFor) limitations.add("usage_ledger_absent");
  if (withoutEvents > 0) limitations.add("tasks_without_event_stream");
  if (tasksTruncated) limitations.add("task_list_truncated");
  if (eventsTruncated) limitations.add("event_stream_truncated");
  if (incomplete > 0) limitations.add("partial_coverage");
  // D6-05: an unmeasured saving is not a zero saving.
  limitations.add("savings_not_measured");
  limitations.add("superiority_not_measured");

  return {
    ok: true,
    readOnly: true,
    snapshotOnly: true,
    schemaVersion: STATISTICS_SCHEMA,
    window: query.window,
    coverage: {
      tasksRead: collected.length,
      tasksIncluded: included,
      tasksExcludedOutsideWindow: excluded,
      tasksWithoutEvents: withoutEvents,
      tasksIncomplete: incomplete,
      eventsRead,
      tasksTruncated,
      eventsTruncated,
    },
    totals: { ...totals, calls: [...calls.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.outcome.localeCompare(b.outcome)), usage: [...usageGroups.values()] },
    rows,
    limitations: [...limitations].sort(),
    limitationCounts,
    claims: { savings: null, superiority: null },
  };
}
