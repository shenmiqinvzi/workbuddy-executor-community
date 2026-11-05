/**
 * Task metric summary (L03 / D6-02).
 *
 * Builds the contract section 6 `MetricSummary` from stored facts only: the
 * task row, its attempt rows, the persistent event stream, the immutable review
 * records and (when a ledger read is supplied) the attributed usage result.
 *
 * Rules this module keeps:
 *   - Every number is either measured from a named fact or null. A missing
 *     measurement never becomes zero, and a duration is only computed when both
 *     endpoints exist and are ordered.
 *   - The event stream is the basis for calls, rework, interventions and
 *     recovery. When a task has no events at all (a legacy row written before
 *     the stream existed), those families are null with a named limitation
 *     instead of a fabricated zero.
 *   - Failed calls, checker errors, unknown checks, cancelled, blocked and
 *     accepted tasks stay separate counters; nothing is folded into one
 *     "problem" number.
 *   - Nothing here calls a model, reads a file, writes to the store or asks the
 *     coordinator to synchronise. The same input always yields the same output,
 *     which is what makes an export recomputable from the raw events.
 */

import type { StoredAttempt, StoredTask, StoredTaskEvent } from "./task-store.js";
import type { PersistedTaskContract, SupportedTaskContract } from "./task-contract.js";
import type { ReviewRecord } from "./task-reviews.js";
import type {
  TaskViewAcceptanceMetrics,
  TaskViewCallMetric,
  TaskViewInterventionMetrics,
  TaskViewMetricSummary,
  TaskViewRecoveryMetrics,
  TaskViewReworkMetrics,
  TaskViewTimingMetrics,
  TaskViewUsageMetrics,
} from "./task-view.js";
import type { TaskUsageAttribution, UsageAmountGroup } from "./usage-attribution.js";

/** Version of the metric summary this build produces. */
export const TASK_METRICS_SCHEMA = "workbuddy-executor/metrics-1";

export interface TaskMetricsInput {
  task: StoredTask;
  attempts: readonly StoredAttempt[];
  events: readonly StoredTaskEvent[];
  reviews: readonly ReviewRecord[];
  /**
   * The verified initial contract, or null.
   *
   * A contract that exists but failed verification must not be passed as null:
   * callers add the `contract_integrity` limitation and leave the required-check
   * counts null, because "no contract" and "a contract that cannot be trusted"
   * are different answers.
   */
  contract: PersistedTaskContract | null;
  /** null when no ledger was read; the usage fields are then null, not zero. */
  usage: TaskUsageAttribution | null;
  /** Extra limitations supplied by the caller (for example ledger absence). */
  limitations?: readonly string[];
}

const CALL_CHANNELS = ["mcp", "cli", "native", "local_check"] as const;
const CALL_OUTCOMES = ["succeeded", "failed", "outcome_unknown"] as const;
type CallChannel = (typeof CALL_CHANNELS)[number];
type CallOutcome = (typeof CALL_OUTCOMES)[number];

const CALL_EVENT_TYPES = new Set(["tool_call_finished", "local_check_finished"]);

function millis(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Seconds between two instants; null unless both exist and the end is later. */
function secondsBetween(from: number | null, to: number | null): number | null {
  if (from === null || to === null || to < from) return null;
  return Math.round(((to - from) / 1000) * 1000) / 1000;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function firstEvent(events: readonly StoredTaskEvent[], type: string): StoredTaskEvent | undefined {
  return events.find(event => event.type === type);
}

function eventsOf(events: readonly StoredTaskEvent[], type: string): StoredTaskEvent[] {
  return events.filter(event => event.type === type);
}

/**
 * Timing durations.
 *
 * queueSeconds    first attempt reservation - task creation.
 * inputWaitSeconds  sum of matched input_requested -> input_resolved pairs.
 * reportToStopSeconds  report_received -> native_stop_confirmed.
 * stopToAcceptanceSeconds  native_stop_confirmed -> acceptance decision.
 * observationLagSeconds  the worst observed_at - occurred_at in the stream.
 * wallElapsedSeconds  createdAt -> closedAt (reviewedAt when accepted, else
 *   the terminal decision event), never derived from updatedAt.
 */
function timingMetrics(task: StoredTask, attempts: readonly StoredAttempt[], events: readonly StoredTaskEvent[], changes: Set<string>): TaskViewTimingMetrics {
  const created = millis(task.createdAt);
  const firstAttempt = attempts[0];
  const queued = millis(firstAttempt?.createdAt) ?? millis(firstEvent(events, "attempt_queued")?.occurredAt);
  const report = millis(firstEvent(events, "report_received")?.occurredAt);
  const stopped = millis(firstEvent(events, "native_stop_confirmed")?.occurredAt);

  const closedAt = task.state === "accepted"
    ? millis(task.reviewedAt)
    : millis(firstEvent(events, "task_closed")?.occurredAt);
  if (task.state === "accepted" && closedAt === null) changes.add("acceptance_time_unavailable");

  let inputWait = 0;
  let unmatched = 0;
  const pending: StoredTaskEvent[] = [];
  for (const event of events) {
    if (event.type === "input_requested") pending.push(event);
    else if (event.type === "input_resolved") {
      const index = pending.findIndex(candidate => (text(candidate.payload.episodeId) ?? text(candidate.payload.episode) ?? null) === (text(event.payload.episodeId) ?? text(event.payload.episode) ?? null)
        ? true
        : pending.length > 0 && event.type === "input_resolved");
      const match = index >= 0 ? pending.splice(index, 1)[0] : undefined;
      if (!match) { unmatched += 1; continue; }
      const start = millis(match.occurredAt), end = millis(event.occurredAt);
      if (start === null || end === null || end < start) { unmatched += 1; continue; }
      inputWait += (end - start) / 1000;
    }
  }
  if (pending.length > 0 || unmatched > 0) changes.add("input_pairs_incomplete");

  let worstLag: number | null = null;
  let skew = 0;
  for (const event of events) {
    const occurred = millis(event.occurredAt), observed = millis(event.observedAt);
    if (occurred === null || observed === null) { changes.add("event_time_invalid"); continue; }
    if (observed < occurred) { skew += 1; continue; }
    const lag = (observed - occurred) / 1000;
    worstLag = worstLag === null ? lag : Math.max(worstLag, lag);
  }
  if (skew > 0) changes.add("observation_time_skew");

  return {
    wallElapsedSeconds: secondsBetween(created, closedAt),
    queueSeconds: secondsBetween(created, queued),
    inputWaitSeconds: events.length === 0 ? null : Math.round(inputWait * 1000) / 1000,
    reportToStopSeconds: secondsBetween(report, stopped),
    stopToAcceptanceSeconds: secondsBetween(stopped, closedAt),
    observationLagSeconds: worstLag === null ? null : Math.round(worstLag * 1000) / 1000,
  };
}

/** Read one optional non-negative byte count from a call event payload. */
function byteField(payload: Record<string, unknown>, name: string): number | null {
  const bytes = payload.bytes;
  const nested = bytes && typeof bytes === "object" && !Array.isArray(bytes) ? (bytes as Record<string, unknown>)[name] : undefined;
  const flat = payload[`${name}Bytes`];
  return count(nested) ?? count(flat);
}

/**
 * Calls grouped by channel and outcome.
 *
 * Byte layers (stdout, stderr, combined, wire) are summed separately and never
 * added into one "total transfer" number; a layer with no measurement in a
 * group stays null rather than becoming 0.
 */
function callMetrics(events: readonly StoredTaskEvent[], changes: Set<string>): TaskViewCallMetric[] {
  const groups = new Map<string, TaskViewCallMetric>();
  let invalid = 0;
  for (const event of events) {
    if (!CALL_EVENT_TYPES.has(event.type)) continue;
    const channel: CallChannel = event.type === "local_check_finished"
      ? "local_check"
      : (CALL_CHANNELS as readonly string[]).includes(String(event.payload.channel)) ? event.payload.channel as CallChannel : (invalid += 1, "mcp");
    const outcomeValue = event.payload.outcome;
    const outcome: CallOutcome = (CALL_OUTCOMES as readonly string[]).includes(String(outcomeValue))
      ? outcomeValue as CallOutcome
      : (changes.add("call_outcome_unknown"), "outcome_unknown");
    if (event.type === "tool_call_finished" && !(CALL_CHANNELS as readonly string[]).includes(String(event.payload.channel))) {
      changes.add("call_channel_unknown");
    }
    const key = `${channel}\u0000${outcome}`;
    const existing = groups.get(key) ?? {
      channel, outcome, count: 0, stdoutBytes: null, stderrBytes: null, combinedBytes: null, wireBytes: null,
    };
    existing.count += 1;
    for (const layer of ["stdout", "stderr", "combined", "wire"] as const) {
      const value = byteField(event.payload, layer);
      if (value === null) continue;
      const field = `${layer}Bytes` as const;
      existing[field] = (existing[field] ?? 0) + value;
    }
    groups.set(key, existing);
  }
  if (invalid > 0) changes.add("call_channel_unrecognised");
  return [...groups.values()].sort((a, b) =>
    CALL_CHANNELS.indexOf(a.channel) - CALL_CHANNELS.indexOf(b.channel) || CALL_OUTCOMES.indexOf(a.outcome) - CALL_OUTCOMES.indexOf(b.outcome));
}

/**
 * Acceptance facts.
 *
 * Required checks come from the immutable contract. The statuses come from the
 * newest review recorded for the current attempt; a required check with no
 * status in that review counts as unknown (not passed) and is named in the
 * limitations. `not_applicable` is not a pass.
 */
function acceptanceMetrics(
  task: StoredTask,
  reviews: readonly ReviewRecord[],
  contract: PersistedTaskContract | null,
  changes: Set<string>,
): TaskViewAcceptanceMetrics {
  const current = reviews.filter(review => !task.attemptId || review.attemptId === task.attemptId);
  const reviewCount = reviews.length;
  const latest = current.at(-1);
  const required: SupportedTaskContract["requiredChecks"] | null = contract ? contract.contract.requiredChecks : null;
  if (!required) changes.add("required_checks_unavailable");

  let passed = 0, unknown = 0, checkerError = 0, unrecorded = 0, failed = 0, notApplicable = 0;
  if (required) {
    const statuses = new Map<string, string>();
    for (const check of latest?.checks ?? []) statuses.set(check.checkId, check.status);
    for (const requirement of required) {
      const status = statuses.get(requirement.id);
      if (status === undefined) { unknown += 1; unrecorded += 1; continue; }
      if (status === "passed") passed += 1;
      else if (status === "checker_error") checkerError += 1;
      else if (status === "failed") failed += 1;
      else if (status === "not_applicable") notApplicable += 1;
      else unknown += 1;
    }
    if (unrecorded > 0) changes.add("required_checks_partially_recorded");
    if (failed > 0) changes.add("required_checks_failed");
    if (notApplicable > 0) changes.add("required_checks_not_applicable");
  }

  return {
    reviewCount,
    acceptedAt: task.state === "accepted" ? task.reviewedAt ?? null : null,
    requiredCheckTotal: required ? required.length : null,
    requiredCheckPassed: required ? passed : null,
    requiredCheckUnknown: required ? unknown : null,
    requiredCheckCheckerError: required ? checkerError : null,
  };
}

/** Rework: only rounds actually sent, with a reason that came from the record. */
function reworkMetrics(task: StoredTask, events: readonly StoredTaskEvent[], changes: Set<string>): TaskViewReworkMetrics {
  if (events.length === 0) {
    if ((task.attempt ?? 0) > 1) changes.add("rework_events_missing");
    return { rounds: null, reasons: [], workerSelfCorrectionRounds: null };
  }
  const requests = eventsOf(events, "rework_requested");
  const attempts = new Set(requests.map(event => event.attemptId ?? `event:${event.eventId}`));
  const reasons = new Set<TaskViewReworkMetrics["reasons"][number]>();
  let selfCorrection: number | null = null;
  for (const event of requests) {
    const reason = text(event.payload.reason);
    reasons.add(reason === "worker_content" || reason === "worker_scope" || reason === "reviewer_error" ? reason : "unknown");
    if (event.payload.selfCorrection === true) selfCorrection = (selfCorrection ?? 0) + 1;
  }
  return {
    rounds: attempts.size,
    reasons: [...reasons].sort(),
    workerSelfCorrectionRounds: selfCorrection,
  };
}

/** Recovery counters, kept apart from rework (a rejected continuation is not a rework round). */
function recoveryMetrics(events: readonly StoredTaskEvent[], changes: Set<string>): TaskViewRecoveryMetrics {
  if (events.length === 0) return { events: null, recoveredTasks: null };
  const recoveries = eventsOf(events, "recovery_recorded");
  if (recoveries.length === 0) {
    // The stream exists, so "no recovery event" is a measured zero.
    return { events: 0, recoveredTasks: 0 };
  }
  if (recoveries.some(event => text(event.payload.taskId) === null)) changes.add("recovery_task_unbound");
  return { events: recoveries.length, recoveredTasks: 1 };
}

/**
 * Manual interventions, deduplicated by episode.
 *
 * One request and one reply are one episode, not two. Without an episode id the
 * pair is matched inside the same attempt in order; an unmatched request still
 * counts as requested and is named in the limitations.
 */
function interventionMetrics(events: readonly StoredTaskEvent[], changes: Set<string>): TaskViewInterventionMetrics {
  if (events.length === 0) return { episodes: null, requested: null, resolved: null, rejected: null, expired: null };
  const requests = eventsOf(events, "input_requested");
  const resolutions = eventsOf(events, "input_resolved");
  const episodeOf = (event: StoredTaskEvent) => text(event.payload.episodeId) ?? text(event.payload.episode) ?? `${event.attemptId ?? "attempt"}:${event.eventId}`;
  const episodes = new Set(requests.map(episodeOf));
  const resolvedEpisodes = new Set<string>();
  let rejected = 0, expired = 0;
  const pending = [...requests];
  for (const resolution of resolutions) {
    const explicit = text(resolution.payload.episodeId) ?? text(resolution.payload.episode);
    let index = explicit === null ? -1 : pending.findIndex(candidate => episodeOf(candidate) === explicit);
    if (index < 0 && pending.length > 0) index = 0;
    const match = index >= 0 ? pending.splice(index, 1)[0] : undefined;
    const episode = explicit ?? (match ? episodeOf(match) : null);
    if (episode === null) { changes.add("intervention_unmatched_resolution"); continue; }
    resolvedEpisodes.add(episode);
    const decision = text(resolution.payload.decision);
    if (decision === "rejected") rejected += 1;
    else if (decision === "expired") expired += 1;
  }
  if (pending.length > 0) changes.add("intervention_unresolved");
  return {
    episodes: episodes.size,
    requested: requests.length,
    resolved: resolvedEpisodes.size,
    rejected,
    expired,
  };
}

function amountOf(groups: readonly UsageAmountGroup[], unit: "tokens" | "credits"): number | null {
  const matching = groups.filter(group => group.unit === unit);
  if (matching.length !== 1) return null;
  return matching[0]?.amount ?? null;
}

/** Usage metrics from an attribution result; catalog rate labels are not invented here. */
function usageMetrics(usage: TaskUsageAttribution | null, changes: Set<string>): TaskViewUsageMetrics {
  changes.add("catalog_rate_label_unavailable");
  if (!usage) {
    changes.add("usage_ledger_absent");
    return { catalogRateLabel: null, actualCredits: null, tokens: null, activeReasoningSeconds: null };
  }
  if (usage.attribution !== "exact") changes.add(`usage_attribution_${usage.attribution}`);
  for (const limitation of usage.limitations) changes.add(`usage_${limitation}`);
  if (usage.totals.length === 0) changes.add("usage_rows_absent");
  // Active reasoning time is a duration, not a token or credit amount; this
  // build records no such measurement, so it stays null instead of being
  // inferred from wall time.
  changes.add("active_reasoning_time_unavailable");
  return {
    catalogRateLabel: null,
    actualCredits: amountOf(usage.totals, "credits"),
    tokens: amountOf(usage.totals, "tokens"),
    activeReasoningSeconds: null,
  };
}

/**
 * Build one metric summary.
 *
 * `complete` is true only when every family was measured with no limitation
 * left: a summary with any null or any caveat is deliberately not "complete",
 * so a partial export cannot read as a finished account.
 */
export function buildTaskMetricSummary(input: TaskMetricsInput): TaskViewMetricSummary {
  const changes = new Set<string>(input.limitations ?? []);
  const timing = timingMetrics(input.task, input.attempts, input.events, changes);
  const calls = callMetrics(input.events, changes);
  const acceptance = acceptanceMetrics(input.task, input.reviews, input.contract, changes);
  const rework = reworkMetrics(input.task, input.events, changes);
  const recovery = recoveryMetrics(input.events, changes);
  const interventions = interventionMetrics(input.events, changes);
  const usage = usageMetrics(input.usage, changes);
  if (input.events.length === 0) changes.add("event_stream_absent");

  const limitations = [...changes].sort();
  const complete = limitations.length === 0
    && timing.wallElapsedSeconds !== null
    && calls.length > 0
    && acceptance.requiredCheckTotal !== null
    && rework.rounds !== null
    && recovery.events !== null
    && interventions.episodes !== null
    && usage.tokens !== null;

  return {
    schemaVersion: TASK_METRICS_SCHEMA,
    taskId: input.task.taskId,
    complete,
    timing,
    calls,
    acceptance,
    rework,
    recovery,
    interventions,
    usage,
    limitations,
  };
}
