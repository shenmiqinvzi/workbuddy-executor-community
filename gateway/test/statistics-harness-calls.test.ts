import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/task-store.js";
import {
  pairHarnessToolCalls,
  recordHarnessToolCalls,
  observeAttemptHarnessCalls,
  readHarnessCallEvents,
  harnessCallSourceRef,
} from "../src/statistics-harness-calls.js";
import { buildTaskMetricSummary } from "../src/task-metrics.js";
import { handleStatisticsRequest, statisticsSources } from "../src/statistics-http.js";

const ATTEMPT_A = "run-11111111-1111-1111-1111-111111111111";
const TASK_A = "6f1a0a3e-0000-4000-8000-000000000001";

function tempStore(t: test.TestContext): { store: TaskStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c04-harness-calls-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

function seedTask(store: TaskStore): void {
  store.createOrGet({
    taskId: TASK_A,
    messageId: "m-1",
    objective: "produce call facts from the harness stream",
    state: "running",
    createdAt: "2026-11-07T00:00:00.000Z",
  });

}

const CALL_1 = { seq: 11, rawType: "tool/call", timestamp: "2026-11-07T00:00:10.000Z", name: "read_file", callId: "call-abc", requestId: "req-1" };
const RESULT_1 = { seq: 12, rawType: "tool/result", timestamp: "2026-11-07T00:00:12.500Z", name: "read_file", callId: "call-abc", isError: false };

test("a tool call plus its result becomes exactly one native call fact", t => {
  const { store } = tempStore(t);
  seedTask(store);
  const result = recordHarnessToolCalls(store, {
    identity: { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" },
    events: [
      { seq: 10, rawType: "text/delta", timestamp: "2026-11-07T00:00:09.000Z" },
      CALL_1,
      RESULT_1,
    ],
    final: true,
    now: new Date("2026-11-07T00:00:13.000Z"),
  });
  assert.equal(result.writes.length, 1);
  assert.equal(result.ignored, 1);
  assert.equal(result.unidentified, 0);
  assert.equal(result.writes[0].status, "inserted");
  assert.equal(result.writes[0].outcome, "succeeded");
  assert.equal(result.writes[0].sourceRef, harnessCallSourceRef({ executorId: "dsh", attemptId: ATTEMPT_A, terminalSeq: 12 }));

  const stored = readHarnessCallEvents(store.listTaskEvents(TASK_A, { limit: 50 }).events);
  assert.equal(stored.length, 1);
  const payload = stored[0].payload as Record<string, unknown>;
  assert.equal(payload.channel, "native");
  assert.equal(payload.outcome, "succeeded");
  assert.equal(payload.harnessEventSeq, 12);
  assert.equal(payload.harnessCallSeq, 11);
  assert.equal(payload.callId, "call-abc");
  assert.equal(payload.durationSeconds, 2.5);
  assert.equal("bytes" in payload, false, "the harness publishes no byte counts, so no bytes key is written");
  assert.deepEqual(payload.limitations, ["harness_bytes_unmeasured"]);
});

test("an error result is a failure and a missing isError is unknown, never a pass", t => {
  const { store } = tempStore(t);
  seedTask(store);
  const writes = recordHarnessToolCalls(store, {
    identity: { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" },
    events: [
      { seq: 20, rawType: "tool/call", timestamp: "2026-11-07T00:01:00.000Z", name: "run_shell", callId: "call-fail" },
      { seq: 21, rawType: "tool/result", timestamp: "2026-11-07T00:01:01.000Z", callId: "call-fail", isError: true },
      { seq: 22, rawType: "tool/call", timestamp: "2026-11-07T00:01:02.000Z", name: "run_shell", callId: "call-unknown" },
      { seq: 23, rawType: "tool/result", timestamp: "2026-11-07T00:01:03.000Z", callId: "call-unknown" },
    ],
    final: true,
  });
  assert.deepEqual(writes.writes.map(write => write.outcome), ["failed", "outcome_unknown"]);
  assert.equal(writes.writes[0].failureKind, "tool_error");
  assert.equal(writes.writes[1].failureKind, "no_terminal_status");
});

test("a call with no result is not a fact until the stream is final", t => {
  const { store } = tempStore(t);
  seedTask(store);
  const events = [{ seq: 31, rawType: "tool/call", timestamp: "2026-11-07T00:02:00.000Z", name: "search", callId: "call-open" }];
  const streaming = recordHarnessToolCalls(store, { identity: { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" }, events, final: false });
  assert.equal(streaming.writes.length, 0);
  assert.deepEqual(streaming.unpaired.map(entry => entry.callId), ["call-open"]);
  assert.equal(readHarnessCallEvents(store.listTaskEvents(TASK_A, { limit: 50 }).events).length, 0);

  const finalised = recordHarnessToolCalls(store, { identity: { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" }, events, final: true });
  assert.equal(finalised.writes.length, 1);
  assert.equal(finalised.writes[0].outcome, "outcome_unknown");
  assert.equal(finalised.writes[0].failureKind, "no_terminal_status");
});

test("re-observing the same page is a replay, and a changed fact on the same seq is a conflict", t => {
  const { store } = tempStore(t);
  seedTask(store);
  const identity = { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" };
  const first = recordHarnessToolCalls(store, { identity, events: [CALL_1, RESULT_1], final: true, now: new Date("2026-11-07T00:00:13.000Z") });
  const replay = recordHarnessToolCalls(store, { identity, events: [CALL_1, RESULT_1], final: true, now: new Date("2026-11-07T00:00:20.000Z") });
  assert.equal(first.writes[0].status, "inserted");
  assert.equal(replay.writes[0].status, "replayed");
  assert.equal(replay.writes[0].eventId, first.writes[0].eventId);

  const conflict = recordHarnessToolCalls(store, {
    identity,
    events: [CALL_1, { ...RESULT_1, isError: true }],
    final: true,
    now: new Date("2026-11-07T00:00:30.000Z"),
  });
  assert.equal(conflict.writes[0].status, "conflict");
  const stored = readHarnessCallEvents(store.listTaskEvents(TASK_A, { limit: 50 }).events);
  assert.equal(stored.length, 1, "a conflict never overwrites the first observation");
  assert.equal((stored[0].payload as Record<string, unknown>).outcome, "succeeded");
});

test("a result without its call is still recorded, flagged as missing the start", t => {
  const { store } = tempStore(t);
  seedTask(store);
  const pairing = pairHarnessToolCalls([{ seq: 41, rawType: "tool/result", timestamp: "2026-11-07T00:03:00.000Z", name: "grep", callId: "call-orphan", isError: false }], { final: true });
  assert.equal(pairing.facts.length, 1);
  assert.equal(pairing.facts[0].callSeq, null);
  const result = recordHarnessToolCalls(store, {
    identity: { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" },
    events: [{ seq: 41, rawType: "tool/result", timestamp: "2026-11-07T00:03:00.000Z", name: "grep", callId: "call-orphan", isError: false }],
    final: true,
  });
  assert.equal(result.writes[0].outcome, "succeeded");
  const payload = readHarnessCallEvents(store.listTaskEvents(TASK_A, { limit: 50 }).events)[0].payload as Record<string, unknown>;
  assert.ok((payload.limitations as string[]).includes("call_start_missing"));
});

test("identity is required: no task, attempt shape or executor is invented", t => {
  const { store } = tempStore(t);
  seedTask(store);
  assert.throws(() => recordHarnessToolCalls(store, { identity: { taskId: "", attemptId: ATTEMPT_A, executorId: "dsh" }, events: [], final: true }), /taskId/);
  assert.throws(() => recordHarnessToolCalls(store, { identity: { taskId: TASK_A, attemptId: "a b", executorId: "dsh" }, events: [], final: true }), /attemptId/);
  assert.throws(() => recordHarnessToolCalls(store, { identity: { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "" }, events: [], final: true }), /executorId/);
});

test("chain: harness events -> calls metric -> statistics HTTP body", async t => {
  const { store } = tempStore(t);
  seedTask(store);
  recordHarnessToolCalls(store, {
    identity: { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" },
    events: [
      CALL_1,
      RESULT_1,
      { seq: 21, rawType: "tool/call", timestamp: "2026-11-07T00:00:20.000Z", name: "run_shell", callId: "call-fail" },
      { seq: 22, rawType: "tool/result", timestamp: "2026-11-07T00:00:21.000Z", callId: "call-fail", isError: true },
    ],
    final: true,
  });

  const task = store.get(TASK_A)!;
  const attempts: never[] = [];
  const events = store.listTaskEvents(TASK_A, { limit: 200 }).events;
  const summary = buildTaskMetricSummary({ task, attempts, events, reviews: store.reviews.list(TASK_A), contract: null, usage: null });
  assert.deepEqual(
    summary.calls.map(call => [call.channel, call.outcome, call.count]),
    [["native", "succeeded", 1], ["native", "failed", 1]],
  );
  assert.equal(summary.calls[0].stdoutBytes, null);
  assert.equal(summary.calls[0].wireBytes, null);

  const response = handleStatisticsRequest(statisticsSources(store), "/workbench/v1/statistics", "");
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = response.body as { totals: { calls: { channel: string; outcome: string; count: number }[] } };
  assert.deepEqual(body.totals.calls.map(call => [call.channel, call.outcome, call.count]), [["native", "failed", 1], ["native", "succeeded", 1]]);
});

test("the one-shot producer reads the attempt events and re-consuming them adds nothing", t => {
  const { store } = tempStore(t);
  seedTask(store);
  const batch = [
    { seq: 10, rawType: "text/delta", timestamp: "2026-11-07T00:00:09.000Z" },
    CALL_1,
    RESULT_1,
  ];
  const reader = { events: (attemptId: string, limit?: number) => batch.slice(0, limit ?? batch.length) };
  const identity = { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" };

  const first = observeAttemptHarnessCalls({
    sink: store, reader, identity, final: true, now: new Date("2026-11-07T00:00:13.000Z"),
  });
  assert.equal(first.read, 3);
  assert.equal(first.writes.length, 1);
  assert.equal(first.writes[0].status, "inserted");

  // The same synchronized batch is consumed again (a retrying poller, a second
  // reader): it resolves to the same row, not to a second call.
  const second = observeAttemptHarnessCalls({
    sink: store, reader, identity, final: true, now: new Date("2026-11-07T00:00:19.000Z"),
  });
  assert.equal(second.writes.length, 1);
  assert.equal(second.writes[0].eventId, first.writes[0].eventId);
  assert.equal(second.writes[0].status, "replayed");
  assert.equal(readHarnessCallEvents(store.listTaskEvents(TASK_A, { limit: 200 }).events).length, 1);
});

test("a non-terminal batch leaves an unfinished call unwritten; the terminal one resolves it", t => {
  const { store } = tempStore(t);
  seedTask(store);
  let batch: Record<string, unknown>[] = [CALL_1];
  const reader = { events: () => batch as never };
  const identity = { taskId: TASK_A, attemptId: ATTEMPT_A, executorId: "dsh" };

  const open = observeAttemptHarnessCalls({ sink: store, reader, identity, final: false });
  assert.equal(open.writes.length, 0);
  assert.equal(open.unpaired.length, 1);
  assert.equal(readHarnessCallEvents(store.listTaskEvents(TASK_A, { limit: 200 }).events).length, 0);

  batch = [CALL_1, RESULT_1];
  const done = observeAttemptHarnessCalls({ sink: store, reader, identity, final: true });
  assert.equal(done.writes.length, 1);
  assert.equal(done.writes[0].outcome, "succeeded");
  assert.throws(() => observeAttemptHarnessCalls({ sink: store, reader, identity: { ...identity, attemptId: null }, final: true }), /needs the attempt/);
});
