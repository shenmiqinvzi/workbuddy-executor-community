/**
 * C04: trusted producers for tool/check call events.
 *
 * The statistics layer can only report calls that some component actually
 * observed. Before this module existed the whole repository carried the event
 * *types* (`tool_call_finished`, `local_check_finished`) but no producer, so
 * `totals.calls` was always empty and the metric layer had to fall back to
 * `event_stream_absent`. This file is that producer, and it is deliberately
 * narrow: it only accepts facts that a supervising process can measure.
 *
 * Observable boundaries (recorded here because the difference is the point):
 *
 *  - `local_check` / gateway: an independent check command runs through
 *    `runBounded()` inside the gateway. Start time, end time, exit code,
 *    cancellation, cleanup confirmation, supervisor failure and the byte
 *    length of the captured logs are all measured by the supervisor.
 *  - `local_check` / worker: the desktop worker runs the same bounded executor
 *    and returns a command record path plus exit code and cleanup flag. The
 *    gateway sees the record it already validates for `validationRecords`.
 *  - `mcp` / gateway: each gateway tool call has a request identity chosen by
 *    the caller. Outcome is known because the handler returned or threw.
 *  - `native` / renderer: the native desktop session keeps a per-call history
 *    (`tool_call` / `tool_call_update` with status pending/completed/failed/
 *    cancelled) but that history lives inside the WorkBuddy renderer. The
 *    gateway process never receives it, so this module refuses an unbridged
 *    observation instead of pretending the call was seen.
 *  - model-internal tool use: not observable at all. Not recorded, never zero.
 *
 * Every event carries a stable `callDigest` and a `sourceRef` that is derived
 * from the channel and the operation identity, so a replayed report folds onto
 * the original row instead of double counting, and a conflicting replay is
 * reported rather than silently overwriting the first observation.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { runBounded, type CommandSpec } from "./bounded-command.js";
import type { StoredTaskEvent } from "./task-store.js";

export const CALL_EVENT_SCHEMA = "workbuddy-executor/call-events-1";

export type CallChannel = "mcp" | "cli" | "native" | "local_check";
export const CALL_CHANNELS: readonly CallChannel[] = ["mcp", "cli", "native", "local_check"];

export type CallOutcome = "succeeded" | "failed" | "outcome_unknown";

/** Why a call did not succeed. `null` only for a confirmed success. */
export type CallFailureKind =
  | "nonzero_exit"
  | "timeout"
  | "cancelled"
  | "not_started"
  | "cleanup_unconfirmed"
  | "supervisor_failure"
  | "tool_error"
  | "tool_cancelled"
  | "no_terminal_status";

export type CallRole = "program" | "checker" | "worker" | "supervisor";
export const CALL_ROLES: readonly CallRole[] = ["program", "checker", "worker", "supervisor"];

/**
 * Which component produced the facts. Kept in the payload so a reader can tell
 * a real product entry from the surrogate entry used before the gateway entry
 * points are wired.
 */
export type CallProducer =
  | "gateway_review_command"
  | "worker_bounded_exec"
  | "gateway_mcp_tool"
  | "native_renderer_tool"
  | "surrogate_entry";

export type CallEventStatus = "inserted" | "replayed" | "conflict";

export type CallEventLimitCode =
  | "arguments_redacted"
  | "arguments_truncated"
  | "wire_bytes_unmeasured"
  | "combined_bytes_unmeasured"
  | "command_logs_missing"
  | "duration_unknown"
  | "native_status_pending"
  | "producer_is_surrogate";

export interface CallEventError extends Error {
  code: string;
  field: string;
}

function refuse(code: string, field: string, message: string): CallEventError {
  const error = new Error(message) as CallEventError;
  error.code = code;
  error.field = field;
  return error;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const MAX_ARGUMENTS = 24;
const MAX_ARGUMENT_CHARACTERS = 240;
const MAX_TOOL_NAME_CHARACTERS = 120;

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw refuse("invalid_identity", field, `${field} must be a stable identifier`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw refuse("invalid_time", field, `${field} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw refuse("invalid_time", field, `${field} must be a parseable ISO timestamp`);
  return new Date(parsed).toISOString();
}

function measured(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw refuse("invalid_measurement", field, `${field} must be a non-negative integer or absent`);
  return value;
}

/**
 * Credential-shaped text is masked before it can reach an event payload. The
 * production point is a log line or an argument vector, and both routinely
 * carry tokens, so this runs on every free-form string in an event.
 */
export function redactCallText(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const apply = (pattern: RegExp, replacement: string) => {
    return text.replace(pattern, match => {
      redactions += 1;
      return typeof replacement === "string" ? replacement : match;
    });
  };
  let redacted = apply(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***");
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => {
    redactions += 1;
    return "Bearer ***";
  });
  redacted = redacted.replace(/\b(token|api[-_]?key|password|passwd|secret|cookie|authorization)\b(\s*[=:]\s*)(\S+)/gi, (_match, name: string, separator: string) => {
    redactions += 1;
    return `${name}${separator}***`;
  });
  redacted = redacted.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, () => {
    redactions += 1;
    return "%USERPROFILE%";
  });
  redacted = redacted.replace(/(^|[\s"'])\/home\/[^/\s"']+/g, (_match, prefix: string) => {
    redactions += 1;
    return `${prefix}%HOME%`;
  });
  return { text: redacted, redactions };
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export interface CommandIdentity {
  taskId: string;
  attemptId: string | null;
  /** Stable per invocation: the gateway operation id, or the command record id. */
  operationId: string;
  role: CallRole;
  checkId?: string | null;
}

function normalizeIdentity(input: CommandIdentity): CommandIdentity {
  const taskId = identifier(input.taskId, "taskId");
  const operationId = identifier(input.operationId, "operationId");
  const attemptId = input.attemptId === null ? null : identifier(input.attemptId, "attemptId");
  if (!CALL_ROLES.includes(input.role)) throw refuse("invalid_identity", "role", `role must be one of ${CALL_ROLES.join("|")}`);
  const checkId = input.checkId === undefined || input.checkId === null ? null : identifier(input.checkId, "checkId");
  return { taskId, attemptId, operationId, role: input.role, checkId };
}

/**
 * Map a bounded-execution outcome onto the three call outcomes. A missing
 * cleanup confirmation is never a pass, and a command that never started is
 * not a failure of the command: it is an unknown observation.
 */
export function classifyCommandOutcome(input: {
  processStarted: boolean;
  cleanupConfirmed: boolean | null;
  exitCode: number | null;
  cancelled?: boolean;
}): { outcome: CallOutcome; failureKind: CallFailureKind | null } {
  if (!input.processStarted || input.exitCode === null) return { outcome: "outcome_unknown", failureKind: "not_started" };
  if (input.cleanupConfirmed !== true) return { outcome: "outcome_unknown", failureKind: "cleanup_unconfirmed" };
  if (input.cancelled === true || input.exitCode === 130) return { outcome: "outcome_unknown", failureKind: "cancelled" };
  if (input.exitCode === 124) return { outcome: "failed", failureKind: "timeout" };
  if (input.exitCode === 125) return { outcome: "failed", failureKind: "supervisor_failure" };
  if (input.exitCode === 0) return { outcome: "succeeded", failureKind: null };
  return { outcome: "failed", failureKind: "nonzero_exit" };
}

/**
 * Bytes actually written by the supervisor. A log that was never created stays
 * `null`; it is not folded into a zero, and `wire` is never measured here.
 */
export function measuredLogBytes(paths: { stdout?: string | null; stderr?: string | null }): {
  stdout: number | null;
  stderr: number | null;
  combined: number | null;
  wire: number | null;
  missingLogs: number;
} {
  const size = (value: string | null | undefined): number | null => {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
      const stat = fs.statSync(value);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  };
  const stdout = size(paths.stdout);
  const stderr = size(paths.stderr);
  let missingLogs = 0;
  if (stdout === null) missingLogs += 1;
  if (stderr === null) missingLogs += 1;
  const combined = stdout === null || stderr === null ? null : stdout + stderr;
  return { stdout, stderr, combined, wire: null, missingLogs };
}

export interface CallEventWrite {
  status: CallEventStatus;
  eventId: number;
  type: "tool_call_finished" | "local_check_finished";
  outcome: CallOutcome;
  failureKind: CallFailureKind | null;
  callDigest: string;
  sourceRef: string;
}

/** The only thing this producer needs from the store; `TaskStore` satisfies it. */
export interface CallEventSink {
  appendTaskEvent(event: Omit<StoredTaskEvent, "eventId"> & { eventId?: number }): StoredTaskEvent;
}

interface CallEventFacts extends CommandIdentity {
  channel: CallChannel;
  producer: CallProducer;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  processStarted: boolean;
  cleanupConfirmed: boolean | null;
  cancelled?: boolean;
  reason?: string | null;
  command?: CommandSpec | null;
  tool?: { name: string; requestId?: string | null; sessionId?: string | null; status?: string | null } | null;
  bytes?: { stdout?: number | null; stderr?: number | null; combined?: number | null; wire?: number | null };
  /** Only set by the surrogate entry, which is not a product entry point. */
  surrogate?: boolean;
  /** The product entry this surrogate stands in for. */
  realEntry?: string | null;
  limitations?: readonly CallEventLimitCode[];
  now?: Date;
}

function normalizeCommand(spec: CommandSpec | null | undefined): {
  block: Record<string, unknown> | null;
  limitations: CallEventLimitCode[];
  redactions: number;
} {
  if (!spec) return { block: null, limitations: [], redactions: 0 };
  const limitations: CallEventLimitCode[] = [];
  let redactions = 0;
  let truncated = false;
  const args: string[] = [];
  for (const argument of spec.args.slice(0, MAX_ARGUMENTS)) {
    const redacted = redactCallText(argument);
    redactions += redacted.redactions;
    if (redacted.text.length > MAX_ARGUMENT_CHARACTERS) {
      truncated = true;
      args.push(`${redacted.text.slice(0, MAX_ARGUMENT_CHARACTERS)}…`);
    } else {
      args.push(redacted.text);
    }
  }
  if (spec.args.length > MAX_ARGUMENTS) truncated = true;
  if (truncated) limitations.push("arguments_truncated");
  if (redactions > 0) limitations.push("arguments_redacted");
  return {
    block: {
      executable: redactCallText(spec.executable).text,
      args,
      cwd: redactCallText(spec.cwd).text,
      timeoutSeconds: spec.timeoutSeconds,
      inputs: (spec.inputs ?? []).map(input => redactCallText(input).text),
      specDigest: digest([spec.executable, ...spec.args, spec.cwd].join("\u0000")),
    },
    limitations,
    redactions,
  };
}

/**
 * Record one finished call. Identity, timing and outcome are validated before
 * anything reaches the store; the store's `sourceRef` index makes the write
 * idempotent per operation.
 */
export function recordCallEvent(sink: CallEventSink, facts: CallEventFacts): CallEventWrite {
  const identity = normalizeIdentity(facts);
  if (!CALL_CHANNELS.includes(facts.channel)) throw refuse("invalid_channel", "channel", `channel must be one of ${CALL_CHANNELS.join("|")}`);
  const startedAt = timestamp(facts.startedAt, "startedAt");
  const endedAt = facts.endedAt === null ? null : timestamp(facts.endedAt, "endedAt");
  if (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) throw refuse("invalid_time", "endedAt", "endedAt must not precede startedAt");
  const observedAt = (facts.now ?? new Date()).toISOString();
  if (facts.exitCode !== null && !Number.isSafeInteger(facts.exitCode)) throw refuse("invalid_measurement", "exitCode", "exitCode must be an integer or null");
  const exitCode = facts.exitCode;

  // A tool call is classified from its terminal status; a command is
  // classified from the process facts. Mixing them would let an exit code
  // stand in for a status nobody observed.
  const classification = facts.tool
    ? classifyToolOutcome(facts.tool.status ?? null)
    : classifyCommandOutcome({ processStarted: facts.processStarted, cleanupConfirmed: facts.cleanupConfirmed, exitCode, cancelled: facts.cancelled });
  const { outcome, failureKind } = classification;

  const reason = facts.reason === null || facts.reason === undefined ? null : redactCallText(facts.reason);
  const command = normalizeCommand(facts.command ?? null);
  const limitations = new Set<CallEventLimitCode>(command.limitations);
  for (const code of facts.limitations ?? []) limitations.add(code);
  if (facts.surrogate === true) limitations.add("producer_is_surrogate");
  const bytes = {
    stdout: measured(facts.bytes?.stdout, "bytes.stdout"),
    stderr: measured(facts.bytes?.stderr, "bytes.stderr"),
    combined: measured(facts.bytes?.combined, "bytes.combined"),
    wire: measured(facts.bytes?.wire, "bytes.wire"),
  };
  if (bytes.wire === null) limitations.add("wire_bytes_unmeasured");
  if (bytes.combined === null) limitations.add("combined_bytes_unmeasured");
  if (endedAt === null) limitations.add("duration_unknown");

  const type = facts.channel === "local_check" ? "local_check_finished" : "tool_call_finished";
  const sourceRef = `call:v1:${facts.channel}:${identity.operationId}`;
  const tool = facts.tool
    ? {
      name: redactCallText(facts.tool.name.slice(0, MAX_TOOL_NAME_CHARACTERS)).text,
      requestId: facts.tool.requestId ?? null,
      sessionId: facts.tool.sessionId ?? null,
      status: facts.tool.status ?? null,
    }
    : null;
  const callDigest = digest(JSON.stringify({
    schema: CALL_EVENT_SCHEMA,
    channel: facts.channel,
    operationId: identity.operationId,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    role: identity.role,
    producer: facts.producer,
    startedAt,
    endedAt,
    exitCode,
    outcome,
    failureKind,
    specDigest: command.block?.specDigest ?? null,
    toolName: tool?.name ?? null,
    status: tool?.status ?? null,
  }));

  const recorded = sink.appendTaskEvent({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    type,
    occurredAt: startedAt,
    observedAt,
    actor: identity.role,
    payload: {
      schema: CALL_EVENT_SCHEMA,
      channel: facts.channel,
      producer: facts.producer,
      role: identity.role,
      operationId: identity.operationId,
      checkId: identity.checkId ?? null,
      outcome,
      failureKind,
      exitCode,
      processStarted: facts.processStarted,
      cleanupConfirmed: facts.cleanupConfirmed,
      cancelled: facts.cancelled === true,
      reason: reason === null ? null : reason.text.slice(0, 400),
      startedAt,
      endedAt,
      durationMs: endedAt === null ? null : Date.parse(endedAt) - Date.parse(startedAt),
      command: command.block,
      tool,
      bytes,
      limitations: [...limitations].sort(),
      redactions: command.redactions + (reason?.redactions ?? 0),
      surrogate: facts.surrogate === true,
      realEntry: facts.realEntry ?? null,
      callDigest,
    },
    sourceRef,
  });

  const storedDigest = typeof recorded.payload?.callDigest === "string" ? recorded.payload.callDigest : null;
  // The store keeps the first row for a `sourceRef`. A matching digest with a
  // different observation time is therefore a replay, not a second call.
  const status: CallEventStatus = storedDigest !== callDigest
    ? "conflict"
    : recorded.observedAt === observedAt ? "inserted" : "replayed";
  return {
    status,
    eventId: recorded.eventId,
    type,
    outcome,
    failureKind,
    callDigest,
    sourceRef,
  };
}

function classifyToolOutcome(explicitStatus: string | null): { outcome: CallOutcome; failureKind: CallFailureKind | null } {
  switch (explicitStatus) {
    case "completed":
      return { outcome: "succeeded", failureKind: null };
    case "failed":
      return { outcome: "failed", failureKind: "tool_error" };
    case "cancelled":
      return { outcome: "outcome_unknown", failureKind: "tool_cancelled" };
    case "pending":
      return { outcome: "outcome_unknown", failureKind: "no_terminal_status" };
    default:
      return { outcome: "outcome_unknown", failureKind: "no_terminal_status" };
  }
}

export interface BoundedCommandResultLike {
  executable?: string;
  args?: readonly string[];
  cwd?: string;
  timeoutSeconds?: number;
  inputs?: readonly string[];
  startedAt: string;
  endedAt: string;
  durationMs?: number;
  exitCode: number | null;
  reason?: string;
  cleanupConfirmed: boolean | null;
  processStarted: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * Turn one bounded-execution result into an event. This is the function the
 * gateway check command path and the worker `exec` path both call; the caller
 * decides the channel and producer, because only it knows which boundary it is.
 */
export function recordBoundedCommand(
  sink: CallEventSink,
  input: {
    identity: CommandIdentity;
    result: BoundedCommandResultLike;
    spec?: CommandSpec | null;
    channel?: CallChannel;
    producer: CallProducer;
    cancelled?: boolean;
    surrogate?: boolean;
    realEntry?: string | null;
    now?: Date;
  },
): CallEventWrite {
  const logs = measuredLogBytes({ stdout: input.result.stdout ?? null, stderr: input.result.stderr ?? null });
  return recordCallEvent(sink, {
    ...input.identity,
    channel: input.channel ?? "local_check",
    producer: input.producer,
    startedAt: input.result.startedAt,
    endedAt: input.result.endedAt,
    exitCode: input.result.exitCode,
    processStarted: input.result.processStarted,
    cleanupConfirmed: input.result.cleanupConfirmed,
    cancelled: input.cancelled === true || input.result.reason === "cancelled",
    reason: input.result.reason ?? null,
    command: input.spec ?? null,
    bytes: { stdout: logs.stdout, stderr: logs.stderr, combined: logs.combined, wire: null },
    limitations: logs.missingLogs > 0 ? ["command_logs_missing"] : [],
    surrogate: input.surrogate === true,
    realEntry: input.realEntry ?? null,
    now: input.now,
  });
}

/**
 * Surrogate entry used until the gateway's own check-command lifecycle calls
 * this module. It is the same isolation as the product path (bounded executor,
 * isolated runs directory, absolute executable and cwd) but it is *not* the
 * product entry, and every event it writes says so in `producer` and
 * `limitations`.
 */
export async function runSurrogateCheckCommand(input: {
  sink: CallEventSink;
  runsDir: string;
  identity: CommandIdentity;
  spec: CommandSpec;
  cancelFile?: string;
  reportBy?: string;
  now?: Date;
}): Promise<{
  write: CallEventWrite;
  exitCode: number | null;
  processStarted: boolean;
  cleanupConfirmed: boolean | null;
}> {
  const identity = normalizeIdentity(input.identity);
  if (typeof input.runsDir !== "string" || input.runsDir.length === 0) throw refuse("invalid_identity", "runsDir", "runsDir must be a directory");
  const result = await runBounded(input.spec, input.runsDir, { cancelFile: input.cancelFile, reportBy: input.reportBy });
  const write = recordBoundedCommand(input.sink, {
    identity,
    result: {
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      exitCode: result.exitCode,
      reason: result.reason,
      cleanupConfirmed: result.cleanupConfirmed,
      processStarted: result.processStarted,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    spec: input.spec,
    producer: "surrogate_entry",
    surrogate: true,
    realEntry: "workbuddy_run_review_command",
    now: input.now,
  });
  return { write, exitCode: result.exitCode, processStarted: result.processStarted, cleanupConfirmed: result.cleanupConfirmed };
}

/**
 * Gateway tool calls (the MCP surface). The caller supplies a stable call id,
 * because the transport does not invent one.
 */
export function recordGatewayToolCall(
  sink: CallEventSink,
  input: {
    taskId: string;
    attemptId: string | null;
    callId: string;
    role: CallRole;
    toolName: string;
    startedAt: string;
    endedAt: string | null;
    status: "completed" | "failed" | "cancelled" | "pending";
    reason?: string | null;
    now?: Date;
  },
): CallEventWrite {
  return recordCallEvent(sink, {
    taskId: input.taskId,
    attemptId: input.attemptId,
    operationId: input.callId,
    role: input.role,
    channel: "mcp",
    producer: "gateway_mcp_tool",
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    exitCode: null,
    processStarted: true,
    cleanupConfirmed: null,
    reason: input.reason ?? null,
    tool: { name: input.toolName, requestId: input.callId, sessionId: null, status: input.status },
    now: input.now,
  });
}

export interface NativeToolObservation {
  taskId: string;
  attemptId: string | null;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Renderer status: pending | completed | failed | cancelled. */
  status: string;
  startedAt: string;
  endedAt: string | null;
  requestId?: string | null;
  /** Set by the bridge that carried the renderer observation into the gateway. */
  bridge: "renderer_event_history";
  bridgedAt: string;
}

/**
 * Native tool calls are only visible inside the WorkBuddy renderer. This
 * function exists so that the day a bridge carries the observation across, the
 * event shape and the dedupe key are already decided. Until then it refuses,
 * because an unbridged "observation" would be an invented one.
 */
export function recordNativeToolObservation(sink: CallEventSink, observation: NativeToolObservation): CallEventWrite {
  if (observation.bridge !== "renderer_event_history" || typeof observation.bridgedAt !== "string" || Number.isNaN(Date.parse(observation.bridgedAt))) {
    throw refuse("native_unbridged", "bridge", "native tool observations require a renderer bridge that records bridgedAt");
  }
  const sessionId = identifier(observation.sessionId, "sessionId");
  return recordCallEvent(sink, {
    taskId: observation.taskId,
    attemptId: observation.attemptId,
    operationId: observation.toolCallId,
    role: "supervisor",
    channel: "native",
    producer: "native_renderer_tool",
    startedAt: observation.startedAt,
    endedAt: observation.endedAt,
    exitCode: null,
    processStarted: true,
    cleanupConfirmed: null,
    tool: { name: observation.toolName, requestId: observation.requestId ?? null, sessionId, status: observation.status },
    limitations: observation.status === "pending" ? ["native_status_pending"] : [],
  });
}

/** Read back only the call events, for verification and for the receipt. */
export function readCallEvents(
  store: { listTaskEvents(taskId: string, options: { afterEventId?: number; limit: number }): { events: readonly StoredTaskEvent[]; nextEventId: number } },
  taskId: string,
): StoredTaskEvent[] {
  const events: StoredTaskEvent[] = [];
  let afterEventId: number | undefined;
  for (;;) {
    const page = store.listTaskEvents(taskId, { afterEventId, limit: 200 });
    for (const event of page.events) {
      if (event.type === "tool_call_finished" || event.type === "local_check_finished") events.push(event);
    }
    if (page.events.length === 0 || page.nextEventId === afterEventId) return events;
    afterEventId = page.nextEventId;
  }
}

export interface CallEventTally {
  channel: CallChannel;
  outcome: CallOutcome;
  count: number;
}

/** Count what was produced, per channel and outcome, straight from events. */
export function tallyCallEvents(events: readonly StoredTaskEvent[]): CallEventTally[] {
  const counts = new Map<string, CallEventTally>();
  for (const event of events) {
    const payload = event.payload ?? {};
    const channel = typeof payload.channel === "string" && (CALL_CHANNELS as readonly string[]).includes(payload.channel)
      ? (payload.channel as CallChannel)
      : "local_check";
    const outcome = payload.outcome === "succeeded" || payload.outcome === "failed" ? payload.outcome : "outcome_unknown";
    const key = `${channel}\u0000${outcome}`;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { channel, outcome, count: 1 });
  }
  return [...counts.values()].sort((a, b) => {
    const channelOrder = CALL_CHANNELS.indexOf(a.channel) - CALL_CHANNELS.indexOf(b.channel);
    return channelOrder !== 0 ? channelOrder : a.outcome.localeCompare(b.outcome);
  });
}
