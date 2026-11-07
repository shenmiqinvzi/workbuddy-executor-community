import crypto from "node:crypto";
import type { StoredTaskEvent } from "./task-store.js";
import {
  CALL_ROLES,
  redactCallText,
  type CallEventSink,
  type CallEventError,
  type CallOutcome,
  type CallFailureKind,
  type CallRole,
} from "./statistics-call-events.js";

/**
 * `tool_call_finished` production from the DSH Harness event stream.
 *
 * This module only turns facts the Harness actually published (`tool/call` and
 * `tool/result` entries with a real `seq`) into call facts. It never derives a
 * call from a busy flag, a poll count, a model narrative or a timeline guess:
 * the WorkBuddy native executor exposes none of those as call identity, so it
 * produces no `tool_call_finished` at all (see docs/forward/C_LINE_RECEIPT.md).
 */

export const HARNESS_CALL_SCHEMA = "workbuddy-executor/harness-call-events-1";
export const HARNESS_CALL_PRODUCER = "dsh_harness_events";
export const HARNESS_CALL_SOURCE_PREFIX = "tool-call";

/** Harness raw event types that carry a discrete tool call or its result. */
export const HARNESS_CALL_RAW_TYPES = ["tool/call", "tool/result"] as const;

export type HarnessToolStatus = "completed" | "failed" | "cancelled" | "pending";

export type HarnessLimitCode =
  | "harness_bytes_unmeasured"
  | "duration_unknown"
  | "native_status_pending"
  | "call_start_missing"
  | "call_result_duplicate"
  | "call_id_missing"
  | "timestamp_unparseable";

export interface HarnessEventLike {
  seq: number;
  rawType?: string | null;
  type?: string | null;
  timestamp?: string | null;
  name?: string | null;
  callId?: string | null;
  isError?: boolean | null;
  requestId?: string | null;
  turnId?: string | null;
}

export interface HarnessCallFact {
  callId: string;
  name: string;
  /** `seq` of the `tool/call` entry, when one was observed. */
  callSeq: number | null;
  /** `seq` of the terminal entry; the dedupe key rides on this. */
  terminalSeq: number;
  startedAt: string | null;
  endedAt: string | null;
  status: HarnessToolStatus;
  isError: boolean | null;
  requestId: string | null;
  turnId: string | null;
}

export interface HarnessPairing {
  facts: HarnessCallFact[];
  /** Calls whose result never arrived; only reported as facts when `final`. */
  unpaired: { callId: string; callSeq: number; name: string }[];
  /** Events that are neither a tool call nor a result. */
  ignored: number;
  /** Events that look like a call but carry no usable identity. */
  unidentified: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const MAX_TOOL_NAME_CHARACTERS = 120;

function refuse(code: string, field: string, message: string): CallEventError {
  const error = new Error(message) as CallEventError;
  error.code = code;
  error.field = field;
  return error;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw refuse("invalid_identity", field, `${field} must be a stable identifier`);
  }
  return value;
}

function isoOrNull(value: string | null | undefined): { value: string | null; ok: boolean } {
  if (typeof value !== "string" || value.length === 0) return { value: null, ok: false };
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return { value: null, ok: false };
  return { value: new Date(parsed).toISOString(), ok: true };
}

function rawTypeOf(event: HarnessEventLike): string | null {
  if (typeof event.rawType === "string" && event.rawType.length > 0) return event.rawType;
  if (typeof event.type === "string" && event.type.startsWith("tool/")) return event.type;
  return null;
}

/**
 * Pair `tool/call` with `tool/result` by `callId`, per attempt, in stream order.
 *
 * An unpaired call is not a finished call. It only becomes a fact when the
 * caller says the stream is final for this attempt, and then it is recorded as
 * `outcome_unknown` — never as a success and never as a failure.
 */
export function pairHarnessToolCalls(events: readonly HarnessEventLike[], options: { final: boolean }): HarnessPairing {
  const facts: HarnessCallFact[] = [];
  const pending = new Map<string, HarnessCallFact>();
  const unpaired: HarnessPairing["unpaired"] = [];
  let ignored = 0;
  let unidentified = 0;

  for (const event of events) {
    const rawType = rawTypeOf(event);
    if (rawType === null || !(HARNESS_CALL_RAW_TYPES as readonly string[]).includes(rawType)) {
      ignored += 1;
      continue;
    }
    if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq < 0) {
      unidentified += 1;
      continue;
    }
    const callId = typeof event.callId === "string" && event.callId.length > 0 ? event.callId : null;
    if (callId === null) {
      unidentified += 1;
      continue;
    }
    const timestamp = isoOrNull(event.timestamp);
    if (rawType === "tool/call") {
      const fact: HarnessCallFact = {
        callId,
        name: typeof event.name === "string" && event.name.length > 0 ? event.name : "unknown",
        callSeq: event.seq,
        terminalSeq: event.seq,
        startedAt: timestamp.value,
        endedAt: null,
        status: "pending",
        isError: null,
        requestId: typeof event.requestId === "string" ? event.requestId : null,
        turnId: typeof event.turnId === "string" ? event.turnId : null,
      };
      // A repeated `tool/call` for the same id keeps the first identity: the
      // Harness may replay a page, and a second start is the same call.
      if (!pending.has(callId)) pending.set(callId, fact);
      continue;
    }
    // tool/result
    const open = pending.get(callId) ?? null;
    const status: HarnessToolStatus = event.isError === true ? "failed" : event.isError === false ? "completed" : "pending";
    const fact: HarnessCallFact = {
      callId,
      name: open?.name ?? (typeof event.name === "string" && event.name.length > 0 ? event.name : "unknown"),
      callSeq: open?.callSeq ?? null,
      terminalSeq: event.seq,
      startedAt: open?.startedAt ?? null,
      endedAt: timestamp.value,
      status,
      isError: typeof event.isError === "boolean" ? event.isError : null,
      requestId: open?.requestId ?? (typeof event.requestId === "string" ? event.requestId : null),
      turnId: open?.turnId ?? (typeof event.turnId === "string" ? event.turnId : null),
    };
    if (open) pending.delete(callId);
    facts.push(fact);
  }

  for (const fact of pending.values()) {
    if (options.final) {
      facts.push({ ...fact, status: "pending", isError: null });
    } else {
      unpaired.push({ callId: fact.callId, callSeq: fact.callSeq ?? fact.terminalSeq, name: fact.name });
    }
  }
  facts.sort((a, b) => a.terminalSeq - b.terminalSeq);
  return { facts, unpaired, ignored, unidentified };
}

export function classifyHarnessToolStatus(status: HarnessToolStatus): { outcome: CallOutcome; failureKind: CallFailureKind | null } {
  if (status === "completed") return { outcome: "succeeded", failureKind: null };
  if (status === "failed") return { outcome: "failed", failureKind: "tool_error" };
  if (status === "cancelled") return { outcome: "outcome_unknown", failureKind: "tool_cancelled" };
  return { outcome: "outcome_unknown", failureKind: "no_terminal_status" };
}

/** Stable dedupe key required by docs/CALL_EVENT_CONTRACT.md §4. */
export function harnessCallSourceRef(input: { executorId: string; attemptId: string | null; terminalSeq: number }): string {
  return `${HARNESS_CALL_SOURCE_PREFIX}:${input.executorId}:${input.attemptId ?? "unattached"}:${input.terminalSeq}`;
}

export interface HarnessCallIdentity {
  taskId: string;
  attemptId: string | null;
  /** Executor that owns the Harness session, e.g. `dsh`. */
  executorId: string;
  /** Who ran the call: a worker turn by default. */
  role?: CallRole;
}

export interface HarnessCallWrite {
  callId: string;
  status: "inserted" | "replayed" | "conflict";
  eventId: number;
  outcome: CallOutcome;
  failureKind: CallFailureKind | null;
  sourceRef: string;
  callDigest: string;
}

export interface RecordHarnessToolCallsInput {
  identity: HarnessCallIdentity;
  events: readonly HarnessEventLike[];
  /** Set true only when no further events can arrive for this attempt. */
  final: boolean;
  now?: Date;
}

export interface RecordHarnessToolCallsResult {
  writes: HarnessCallWrite[];
  unpaired: HarnessPairing["unpaired"];
  ignored: number;
  unidentified: number;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Write one `tool_call_finished` per observed Harness tool call.
 *
 * The event carries no byte counts: the Harness event stream does not publish
 * them, so `bytes` stays absent and the limitation says so instead of writing
 * a zero the consumer would read as a measurement.
 */
export function recordHarnessToolCalls(sink: CallEventSink, input: RecordHarnessToolCallsInput): RecordHarnessToolCallsResult {
  const taskId = identifier(input.identity.taskId, "taskId");
  const executorId = identifier(input.identity.executorId, "executorId");
  const attemptId = input.identity.attemptId === null ? null : identifier(input.identity.attemptId, "attemptId");
  const role = input.identity.role ?? "worker";
  if (!CALL_ROLES.includes(role)) throw refuse("invalid_identity", "role", `role must be one of ${CALL_ROLES.join("|")}`);
  const observedAt = (input.now ?? new Date()).toISOString();
  const pairing = pairHarnessToolCalls(input.events, { final: input.final });
  const writes: HarnessCallWrite[] = [];

  for (const fact of pairing.facts) {
    const callId = fact.callId.length > 200 ? fact.callId.slice(0, 200) : fact.callId;
    const { outcome, failureKind } = classifyHarnessToolStatus(fact.status);
    const limitations = new Set<HarnessLimitCode>(["harness_bytes_unmeasured"]);
    if (fact.status === "pending") limitations.add("native_status_pending");
    if (fact.callSeq === null) limitations.add("call_start_missing");
    let durationSeconds: number | null = null;
    if (fact.startedAt !== null && fact.endedAt !== null) {
      const elapsed = Date.parse(fact.endedAt) - Date.parse(fact.startedAt);
      if (elapsed >= 0) durationSeconds = Math.round(elapsed) / 1000;
      else limitations.add("timestamp_unparseable");
    } else {
      limitations.add("duration_unknown");
    }
    const toolName = redactCallText(fact.name.slice(0, MAX_TOOL_NAME_CHARACTERS)).text;
    const sourceRef = harnessCallSourceRef({ executorId, attemptId, terminalSeq: fact.terminalSeq });
    const payload: Record<string, unknown> = {
      schema: HARNESS_CALL_SCHEMA,
      channel: "native",
      producer: HARNESS_CALL_PRODUCER,
      role,
      outcome,
      failureKind,
      harnessEventSeq: fact.terminalSeq,
      harnessCallSeq: fact.callSeq,
      callId,
      toolName,
      status: fact.status,
      requestId: fact.requestId,
      turnId: fact.turnId,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
      durationSeconds,
      limitations: [...limitations].sort(),
    };
    const callDigest = digest(
      JSON.stringify({
        channel: "native",
        producer: HARNESS_CALL_PRODUCER,
        outcome,
        failureKind,
        harnessEventSeq: fact.terminalSeq,
        callId,
        toolName,
        endedAt: fact.endedAt,
      }),
    );
    payload.callDigest = callDigest;
    const stored = sink.appendTaskEvent({
      taskId,
      attemptId,
      type: "tool_call_finished",
      occurredAt: fact.endedAt ?? fact.startedAt ?? observedAt,
      observedAt,
      actor: role,
      payload,
      sourceRef,
    });
    const storedDigest = (stored.payload as Record<string, unknown> | null)?.callDigest;
    const status: HarnessCallWrite["status"] =
      storedDigest !== callDigest ? "conflict" : stored.observedAt === observedAt ? "inserted" : "replayed";
    writes.push({ callId, status, eventId: stored.eventId, outcome, failureKind, sourceRef, callDigest });
  }

  return { writes, unpaired: pairing.unpaired, ignored: pairing.ignored, unidentified: pairing.unidentified };
}

/** Read-back of Harness-produced call facts, for tests and receipts. */
export function readHarnessCallEvents(events: readonly StoredTaskEvent[]): StoredTaskEvent[] {
  return events.filter(event => {
    if (event.type !== "tool_call_finished") return false;
    const payload = event.payload as Record<string, unknown> | null;
    return payload?.producer === HARNESS_CALL_PRODUCER;
  });
}
