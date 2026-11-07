/**
 * B04 acceptance tests: notification episodes over a real persistent task store.
 *
 * The unit tests next door use an in-memory fake, which cannot show that an
 * episode is keyed by a stored event id, that the ledger survives a reopened
 * process, or that a failed delivery stays explainable after a restart. These
 * tests open a real tasks.sqlite, append real events, and only then poll.
 *
 * No balloon is shown: `deliver` is a local recorder.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NotificationCenter, type DesktopNotification } from "../src/notification-center.js";
import { TaskStore, type StoredTask } from "../src/task-store.js";

const T0 = Date.parse("2026-11-05T10:00:00.000Z");

function taskFixture(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    taskId: "persistent-task",
    messageId: "msg-1",
    attemptId: "attempt-1",
    attempt: 1,
    sessionId: "native-session",
    runtimeSource: "desktop_queue",
    state: "working",
    lastEventSeq: 0,
    objective: "Summarise the isolated sample",
    constraints: [],
    acceptanceCommands: ["run the acceptance check"],
    workspace: "/fixture/workspace",
    artifacts: [],
    ...overrides,
  };
}

interface Harness {
  directory: string;
  store: TaskStore;
  configFile: string;
  ledgerFile: string;
  clock: { now: number; advance(ms: number): void };
  center(options?: { deliver?: (notification: DesktopNotification) => void }): NotificationCenter;
}

function harness(t: { after(callback: () => void): void }): Harness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-notification-"));
  const store = new TaskStore(path.join(directory, "tasks.sqlite"));
  const configFile = path.join(directory, "notifications.json");
  const ledgerFile = path.join(directory, "notification-ledger.json");
  const clock = {
    now: T0,
    advance(ms: number) { this.now += ms; },
  };
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, store, configFile, ledgerFile, clock,
    center(options = {}) {
      return new NotificationCenter({ store, configFile, ledgerFile, now: () => new Date(clock.now), ...options });
    },
  };
}

function appendInputRequested(store: TaskStore, taskId: string, occurredAt: string, attemptId = "attempt-1"): void {
  store.appendTaskEvent({ taskId, attemptId, type: "input_requested", occurredAt, observedAt: occurredAt, actor: "workbuddy", payload: { prompt: "Which sample?" }, sourceRef: null });
  store.update(taskId, { state: "waiting_input" });
}

function appendNeedsReview(store: TaskStore, taskId: string, occurredAt: string, attemptId = "attempt-1"): void {
  store.appendTaskEvent({ taskId, attemptId, type: "task_state_changed", occurredAt, observedAt: occurredAt, actor: "workbuddy", payload: { patch: { state: "needs_review" } }, sourceRef: null });
  store.update(taskId, { state: "needs_review" });
}

test("real stored events open one episode each, and a second poll adds nothing", (t) => {
  const h = harness(t);
  const task = h.store.createOrGet(taskFixture()).task;
  appendInputRequested(h.store, task.taskId, new Date(T0).toISOString());
  const delivered: DesktopNotification[] = [];
  const center = h.center({ deliver: notification => delivered.push(notification) });

  const first = center.poll([]);
  assert.equal(first.delivered.length, 1);
  assert.equal(first.delivered[0]!.reason, "input_requested");
  assert.equal(first.delivered[0]!.taskId, task.taskId);
  assert.equal(first.delivered[0]!.taskTitle.length > 0, true);
  assert.equal(first.deliveryFailures, 0);
  // The episode identity is the stored event id, not a timestamp we invented.
  assert.match(first.delivered[0]!.episodeKey, new RegExp(`^${task.taskId}\\|input_requested\\|event:\\d+$`));

  h.clock.advance(60_000);
  const second = center.poll(first.delivered);
  assert.equal(second.delivered.length, 0);
  assert.equal(delivered.length, 1);

  // Reopening the process (fresh instance, same ledger) does not replay it.
  const reopened = h.center({ deliver: notification => delivered.push(notification) });
  h.clock.advance(60_000);
  assert.equal(reopened.poll([]).delivered.length, 0);
  assert.equal(delivered.length, 1);
});

test("a failed delivery is recorded with its reason and survives a reopened process", (t) => {
  const h = harness(t);
  const task = h.store.createOrGet(taskFixture()).task;
  appendInputRequested(h.store, task.taskId, new Date(T0).toISOString());

  const broken = h.center({ deliver: () => { throw new Error("native presenter is not available"); } });
  const failed = broken.poll([]);
  assert.equal(failed.delivered.length, 0);
  assert.equal(failed.deliveryFailures, 1);
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.failures[0]!.taskId, task.taskId);
  assert.equal(failed.failures[0]!.reason, "input_requested");
  assert.match(failed.failures[0]!.message, /native presenter is not available/);
  assert.equal(failed.failures[0]!.attempts, 1);

  // The episode is still pending, with the cause attached instead of silence.
  const pending = broken.pending();
  assert.equal(pending.length, 1);
  // A failed attempt does not push the episode into a throttle window: it is
  // retryable at once, which is exactly why the reason has to be recorded.
  assert.equal(pending[0]!.readyAt, null);
  assert.equal(pending[0]!.lastFailure?.attempts, 1);
  assert.match(pending[0]!.lastFailure!.message, /native presenter/);

  // A reopened process still knows why nothing appeared.
  h.clock.advance(1_000);
  const reopened = h.center({ deliver: () => { throw new Error("still unavailable"); } });
  const afterRestart = reopened.pending();
  assert.equal(afterRestart.length, 1);
  assert.match(afterRestart[0]!.lastFailure!.message, /native presenter is not available/);

  // A working presenter delivers it once, and the recorded failure is cleared.
  h.clock.advance(60_000);
  const delivered: DesktopNotification[] = [];
  const working = h.center({ deliver: notification => delivered.push(notification) });
  const recovered = working.poll([]);
  assert.equal(recovered.delivered.length, 1);
  assert.equal(recovered.deliveryFailures, 0);
  assert.equal(delivered.length, 1);
  assert.equal(working.pending().length, 0);
  h.clock.advance(60_000);
  assert.equal(working.poll([]).delivered.length, 0);
});

test("several real episodes of the same reason stay separate and are throttled, not merged", (t) => {
  const h = harness(t);
  const alpha = h.store.createOrGet(taskFixture({ taskId: "task-alpha", messageId: "msg-a", attemptId: "attempt-alpha" })).task;
  const beta = h.store.createOrGet(taskFixture({ taskId: "task-beta", messageId: "msg-b", attemptId: "attempt-beta" })).task;
  appendNeedsReview(h.store, alpha.taskId, new Date(T0).toISOString(), "attempt-alpha");
  appendNeedsReview(h.store, beta.taskId, new Date(T0 + 1_000).toISOString(), "attempt-beta");

  const center = h.center({ deliver: () => {} });
  const first = center.poll([]);
  assert.equal(first.delivered.length, 1);
  assert.equal(first.delivered[0]!.taskId, alpha.taskId);
  assert.ok(first.deferred >= 1);
  assert.notEqual(first.delivered[0]!.episodeKey, `${beta.taskId}|needs_review|event:0`);

  // The throttled episode keeps its own identity and is not merged with the
  // one already shown for the same reason on another task.
  const pending = center.pending();
  const betaPending = pending.filter(item => item.taskId === beta.taskId);
  assert.ok(betaPending.length >= 1);
  for (const item of betaPending) {
    assert.match(item.episodeKey, new RegExp(`^${beta.taskId}\\|needs_review\\|`));
    assert.ok(item.readyAt !== null && Date.parse(item.readyAt!) > T0);
  }
  const keys = pending.map(item => item.episodeKey);
  assert.equal(new Set(keys).size, keys.length);

  h.clock.advance(10 * 60_000);
  const later = center.poll([]);
  assert.ok(later.delivered.some(item => item.taskId === beta.taskId));
  assert.ok(later.delivered.every(item => item.reason === "needs_review"));
});

test("notifications switched off drop the real episode instead of replaying it later", (t) => {
  const h = harness(t);
  const task = h.store.createOrGet(taskFixture()).task;
  appendInputRequested(h.store, task.taskId, new Date(T0).toISOString());

  const center = h.center({ deliver: () => {} });
  const off = center.setConfig({ enabled: false });
  assert.equal(off.ok, true);
  const suppressed = center.poll([]);
  assert.equal(suppressed.delivered.length, 0);
  assert.equal(suppressed.suppressedByReasonOff, 1);

  h.clock.advance(60_000);
  const on = center.setConfig({ enabled: true });
  assert.equal(on.ok, true);
  h.clock.advance(60_000);
  assert.equal(center.poll([]).delivered.length, 0);
  assert.equal(center.pending().length, 0);
});

test("a notification never changes the stored task and never becomes a state", (t) => {
  const h = harness(t);
  const task = h.store.createOrGet(taskFixture()).task;
  appendInputRequested(h.store, task.taskId, new Date(T0).toISOString());
  const before = h.store.get(task.taskId)!;
  const center = h.center({ deliver: () => {} });
  center.poll([]);
  const after = h.store.get(task.taskId)!;
  assert.equal(after.state, "waiting_input");
  assert.equal(after.revision, before.revision);
  assert.equal(after.updatedAt, before.updatedAt);
});
