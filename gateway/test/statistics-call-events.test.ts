/**
 * C04 acceptance tests: the trusted producer for tool/check call events.
 *
 * The chain under test is the one the statistics page depends on:
 *
 *   bounded command (isolated, real exit code) -> call event -> store ->
 *   MetricSummary.calls -> statistics overview -> HTTP body
 *
 * The "product entry" part of that chain is not wired yet (it lives in the
 * gateway's check-command lifecycle, which this line does not own), so the
 * first hop uses `runSurrogateCheckCommand` and the event says so. Everything
 * after the event is the real read path.
 *
 * No test calls a model, opens a socket, reads a run directory of another
 * component or writes task state beyond the synthetic store in a temp dir.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore, type StoredTaskEvent } from "../src/task-store.js";
import {
  CALL_EVENT_SCHEMA,
  classifyCommandOutcome,
  measuredLogBytes,
  readCallEvents,
  recordCallEvent,
  recordGatewayToolCall,
  recordNativeToolObservation,
  redactCallText,
  runSurrogateCheckCommand,
  tallyCallEvents,
  type CallEventError,
} from "../src/statistics-call-events.js";
import { readStatisticsOverview, readTaskStatistics, parseStatisticsQuery } from "../src/statistics-service.js";
import { handleStatisticsRequest, statisticsSources } from "../src/statistics-http.js";

const ATTEMPT_A = "run-11111111-1111-1111-1111-111111111111";

function tempStore(t: { after(callback: () => void): void }): { dir: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c04-call-events-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { dir, store };
}

function seedTask(store: TaskStore, taskId = "task-1"): void {
  store.createOrGet({ taskId, messageId: `msg-${taskId}`, objective: "synthetic objective", state: "working", createdAt: "2026-11-06T10:00:00.000Z" });
}

function nodeSpec(args: string[], cwd: string, timeoutSeconds = 20): { executable: string; args: string[]; cwd: string; timeoutSeconds: number } {
  return { executable: process.execPath, args, cwd, timeoutSeconds };
}

function payloadOf(event: StoredTaskEvent): Record<string, unknown> {
  return event.payload ?? {};
}

// ------------------------------------------------------------- classification --

test("outcome classification: only a clean exit is a pass", () => {
  assert.deepEqual(classifyCommandOutcome({ processStarted: true, cleanupConfirmed: true, exitCode: 0 }), { outcome: "succeeded", failureKind: null });
  assert.deepEqual(classifyCommandOutcome({ processStarted: true, cleanupConfirmed: true, exitCode: 7 }), { outcome: "failed", failureKind: "nonzero_exit" });
  assert.deepEqual(classifyCommandOutcome({ processStarted: true, cleanupConfirmed: true, exitCode: 124 }), { outcome: "failed", failureKind: "timeout" });
  assert.deepEqual(classifyCommandOutcome({ processStarted: true, cleanupConfirmed: true, exitCode: 125 }), { outcome: "failed", failureKind: "supervisor_failure" });
  assert.deepEqual(classifyCommandOutcome({ processStarted: true, cleanupConfirmed: true, exitCode: 130 }), { outcome: "outcome_unknown", failureKind: "cancelled" });
  assert.deepEqual(classifyCommandOutcome({ processStarted: true, cleanupConfirmed: false, exitCode: 0 }), { outcome: "outcome_unknown", failureKind: "cleanup_unconfirmed" });
  assert.deepEqual(classifyCommandOutcome({ processStarted: false, cleanupConfirmed: false, exitCode: null }), { outcome: "outcome_unknown", failureKind: "not_started" });
});

test("redaction: credential-shaped arguments and user paths never reach the payload", () => {
  const redacted = redactCallText("node --token=sk-live-1234567890 C:\\Users\\example\\repo\\a.ts Bearer abcdefgh12345678");
  assert.equal(redacted.redactions, 4);
  assert.ok(!redacted.text.includes("sk-live-1234567890"));
  assert.ok(!redacted.text.includes("example"));
  assert.ok(!redacted.text.includes("abcdefgh12345678"));
});

// -------------------------------------------------------------- event writing --

test("local check events carry the observable facts and never invent bytes", (t) => {
  const { store } = tempStore(t);
  seedTask(store);
  const write = recordCallEvent(store, {
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    operationId: "op-1",
    role: "program",
    channel: "local_check",
    producer: "gateway_review_command",
    startedAt: "2026-11-06T10:01:00.000Z",
    endedAt: "2026-11-06T10:01:02.500Z",
    exitCode: 0,
    processStarted: true,
    cleanupConfirmed: true,
    command: { executable: "C:\\Program Files\\nodejs\\node.exe", args: ["-v"], cwd: "C:\\work", timeoutSeconds: 60, inputs: ["src/a.ts"] },
    bytes: { stdout: 12, stderr: 0, combined: null, wire: null },
    now: new Date("2026-11-06T10:01:03.000Z"),
  });
  assert.equal(write.status, "inserted");
  assert.equal(write.type, "local_check_finished");
  assert.equal(write.outcome, "succeeded");

  const [event] = readCallEvents(store, "task-1");
  assert.ok(event);
  assert.equal(event.type, "local_check_finished");
  assert.equal(event.actor, "program");
  assert.equal(event.attemptId, ATTEMPT_A);
  assert.equal(event.occurredAt, "2026-11-06T10:01:00.000Z");
  assert.equal(event.observedAt, "2026-11-06T10:01:03.000Z");
  const payload = payloadOf(event);
  assert.equal(payload.schema, CALL_EVENT_SCHEMA);
  assert.equal(payload.channel, "local_check");
  assert.equal(payload.failureKind, null);
  assert.equal(payload.durationMs, 2500);
  assert.deepEqual(payload.bytes, { stdout: 12, stderr: 0, combined: null, wire: null });
  // combined/wire were not measured: the limitation says so instead of a zero.
  assert.ok((payload.limitations as string[]).includes("combined_bytes_unmeasured"));
  assert.ok((payload.limitations as string[]).includes("wire_bytes_unmeasured"));
  assert.equal(typeof payload.callDigest, "string");
});

test("a replayed report folds onto the original row and a conflicting replay is refused", (t) => {
  const { store } = tempStore(t);
  seedTask(store);
  const base = {
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    operationId: "op-replay",
    role: "program" as const,
    channel: "local_check" as const,
    producer: "gateway_review_command" as const,
    startedAt: "2026-11-06T10:02:00.000Z",
    endedAt: "2026-11-06T10:02:01.000Z",
    exitCode: 0,
    processStarted: true,
    cleanupConfirmed: true,
  };
  const first = recordCallEvent(store, { ...base, now: new Date("2026-11-06T10:02:02.000Z") });
  const replay = recordCallEvent(store, { ...base, now: new Date("2026-11-06T10:03:00.000Z") });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.eventId, first.eventId);
  assert.equal(readCallEvents(store, "task-1").length, 1);

  const conflict = recordCallEvent(store, { ...base, exitCode: 9, now: new Date("2026-11-06T10:04:00.000Z") });
  assert.equal(conflict.status, "conflict");
  const events = readCallEvents(store, "task-1");
  assert.equal(events.length, 1);
  assert.equal(payloadOf(events[0]!).exitCode, 0, "the first observation is not overwritten");
});

test("distinct operations produce distinct events; identity is validated", (t) => {
  const { store } = tempStore(t);
  seedTask(store);
  const facts = {
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    role: "checker" as const,
    channel: "local_check" as const,
    producer: "gateway_review_command" as const,
    startedAt: "2026-11-06T10:05:00.000Z",
    endedAt: "2026-11-06T10:05:01.000Z",
    exitCode: 0,
    processStarted: true,
    cleanupConfirmed: true,
  };
  recordCallEvent(store, { ...facts, operationId: "op-a" });
  recordCallEvent(store, { ...facts, operationId: "op-b" });
  assert.equal(readCallEvents(store, "task-1").length, 2);

  assert.throws(() => recordCallEvent(store, { ...facts, operationId: "has space" }), (error: CallEventError) => error.code === "invalid_identity" && error.field === "operationId");
  assert.throws(() => recordCallEvent(store, { ...facts, operationId: "op-c", endedAt: "2026-11-06T10:04:00.000Z" }), (error: CallEventError) => error.code === "invalid_time");
  assert.throws(() => recordCallEvent(store, { ...facts, operationId: "op-d", startedAt: "not-a-time" }), (error: CallEventError) => error.code === "invalid_time");
});

// ---------------------------------------------------------------- tool calls --

test("a native tool observation without a renderer bridge is refused, not invented", (t) => {
  const { store } = tempStore(t);
  seedTask(store);
  assert.throws(() => recordNativeToolObservation(store, {
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "Read",
    status: "completed",
    startedAt: "2026-11-06T10:06:00.000Z",
    endedAt: "2026-11-06T10:06:01.000Z",
    bridge: "renderer_event_history",
    bridgedAt: "",
  }), (error: CallEventError) => error.code === "native_unbridged");
  assert.equal(readCallEvents(store, "task-1").length, 0);
});

test("a bridged native observation and a gateway tool call land as tool_call_finished", (t) => {
  const { store } = tempStore(t);
  seedTask(store);
  const native = recordNativeToolObservation(store, {
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "Read",
    status: "cancelled",
    startedAt: "2026-11-06T10:06:00.000Z",
    endedAt: "2026-11-06T10:06:01.000Z",
    requestId: "req-7",
    bridge: "renderer_event_history",
    bridgedAt: "2026-11-06T10:06:02.000Z",
  });
  assert.equal(native.type, "tool_call_finished");
  assert.equal(native.outcome, "outcome_unknown");
  assert.equal(native.failureKind, "tool_cancelled");

  const gateway = recordGatewayToolCall(store, {
    taskId: "task-1",
    attemptId: ATTEMPT_A,
    callId: "mcp-call-1",
    role: "supervisor",
    toolName: "workbuddy_review_task",
    startedAt: "2026-11-06T10:07:00.000Z",
    endedAt: "2026-11-06T10:07:01.000Z",
    status: "failed",
    reason: "binding digest mismatch",
  });
  assert.equal(gateway.outcome, "failed");
  assert.equal(gateway.failureKind, "tool_error");

  const events = readCallEvents(store, "task-1");
  assert.equal(events.length, 2);
  assert.deepEqual(tallyCallEvents(events), [
    { channel: "mcp", outcome: "failed", count: 1 },
    { channel: "native", outcome: "outcome_unknown", count: 1 },
  ]);
  const nativePayload = payloadOf(events[0]!);
  assert.deepEqual((nativePayload.tool as Record<string, unknown>), { name: "Read", requestId: "req-7", sessionId: "session-1", status: "cancelled" });
});

// ------------------------------------------------------ real bounded execution --

test("measuredLogBytes reports null for a log that does not exist", (t) => {
  const { dir } = tempStore(t);
  const bytes = measuredLogBytes({ stdout: path.join(dir, "missing.stdout.log"), stderr: null });
  assert.equal(bytes.stdout, null);
  assert.equal(bytes.stderr, null);
  assert.equal(bytes.combined, null);
  assert.equal(bytes.wire, null);
  assert.equal(bytes.missingLogs, 2);
});

test("surrogate entry: a passing command becomes one local_check_finished event", async (t) => {
  const { dir, store } = tempStore(t);
  seedTask(store);
  const runsDir = path.join(dir, "runs", ATTEMPT_A, "commands");
  const outcome = await runSurrogateCheckCommand({
    sink: store,
    runsDir,
    identity: { taskId: "task-1", attemptId: ATTEMPT_A, operationId: "op-surrogate-1", role: "program", checkId: "unit" },
    spec: nodeSpec(["-e", "process.stdout.write('ok');process.stderr.write('warn')"], dir),
  });
  assert.equal(outcome.write.status, "inserted");
  assert.equal(outcome.write.outcome, "succeeded");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.cleanupConfirmed, true);

  const [event] = readCallEvents(store, "task-1");
  assert.ok(event);
  const payload = payloadOf(event);
  assert.equal(payload.channel, "local_check");
  assert.equal(payload.producer, "surrogate_entry");
  assert.equal(payload.surrogate, true);
  assert.equal(payload.realEntry, "workbuddy_run_review_command");
  assert.ok((payload.limitations as string[]).includes("producer_is_surrogate"));
  const bytes = payload.bytes as Record<string, number | null>;
  assert.equal(typeof bytes.stdout, "number");
  assert.equal(typeof bytes.stderr, "number");
  assert.equal(typeof bytes.combined, "number");
  assert.equal(bytes.wire, null);
});

test("surrogate entry: a failing command is a failure, not a pass", async (t) => {
  const { dir, store } = tempStore(t);
  seedTask(store);
  const outcome = await runSurrogateCheckCommand({
    sink: store,
    runsDir: path.join(dir, "runs", ATTEMPT_A, "commands"),
    identity: { taskId: "task-1", attemptId: ATTEMPT_A, operationId: "op-surrogate-2", role: "program" },
    spec: nodeSpec(["-e", "process.exit(3)"], dir),
  });
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.write.outcome, "failed");
  assert.equal(outcome.write.failureKind, "nonzero_exit");
});

// ------------------------------------------------------- statistics read path --

test("chain: check event -> MetricSummary.calls -> overview -> HTTP body", async (t) => {
  const { dir, store } = tempStore(t);
  seedTask(store);
  await runSurrogateCheckCommand({
    sink: store,
    runsDir: path.join(dir, "runs", ATTEMPT_A, "commands"),
    identity: { taskId: "task-1", attemptId: ATTEMPT_A, operationId: "op-chain-1", role: "program", checkId: "unit" },
    spec: nodeSpec(["-e", "process.exit(0)"], dir),
  });
  recordCallEvent(store, {
    taskId: "task-1",
    attemptId: null,
    operationId: "op-chain-2",
    role: "worker",
    channel: "cli",
    producer: "worker_bounded_exec",
    startedAt: "2026-11-06T10:08:00.000Z",
    endedAt: "2026-11-06T10:08:03.000Z",
    exitCode: 124,
    processStarted: true,
    cleanupConfirmed: true,
    reason: "timeout",
  });

  const perTask = readTaskStatistics({ store }, "task-1", {});
  assert.equal(perTask.ok, true);
  if (!perTask.ok) return;
  const calls = perTask.metrics.calls;
  assert.equal(calls.length, 2);
  const rows = calls.map(call => ({ channel: call.channel, outcome: call.outcome, count: call.count }));
  assert.deepEqual(rows, [
    { channel: "cli", outcome: "failed", count: 1 },
    { channel: "local_check", outcome: "succeeded", count: 1 },
  ]);
  assert.equal(perTask.sources.events, 3, "task_received plus the two call events");
  assert.ok(!perTask.metrics.limitations.includes("event_stream_absent"));

  const parsedQuery = parseStatisticsQuery("");
  assert.equal(parsedQuery.ok, true);
  if (!parsedQuery.ok) return;
  const overview = readStatisticsOverview({ store }, parsedQuery.query);
  assert.equal(overview.ok, true);
  if (!overview.ok) return;
  assert.equal(overview.coverage.eventsRead, 3);
  assert.deepEqual(overview.totals.calls.map(call => ({ channel: call.channel, outcome: call.outcome, count: call.count })), rows);

  const response = handleStatisticsRequest(statisticsSources(store), "/workbench/v1/statistics", "");
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = response.body as { totals: { calls: Array<{ channel: string; count: number }> } };
  assert.equal(body.totals.calls.length, 2);
});
