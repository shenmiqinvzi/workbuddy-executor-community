/**
 * L06 acceptance tests: desktop notification episodes.
 *
 * The center is read-only over the task store; it owns a config file and a
 * ledger file. These tests use an in-memory fake store, so no task database is
 * opened and no notification is shown. They cover the acceptance list:
 * duplicate polls, out-of-order and repeated events, a reopened process, several
 * episodes of the same reason, notifications switched off, throttling, a failing
 * presenter, and the rule that a notification never becomes a task state.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_NOTIFICATION_CONFIG,
  NOTIFICATION_SCHEMA,
  NotificationCenter,
  applyNotificationConfig,
  type DesktopNotification,
  type NotificationStore,
} from "../src/notification-center.js";
import type { StoredTask, StoredTaskEvent, TaskContractRead } from "../src/task-store.js";

const T0 = Date.parse("2026-11-05T10:00:00.000Z");

function taskFixture(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    taskId: "task-1",
    messageId: "msg-1",
    objective: "SECRET-OBJECTIVE-BODY",
    state: "working",
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    revision: "rev-1",
    ...overrides,
  };
}

function eventFixture(taskId: string, eventId: number, type: string, payload: unknown, occurredAt: string): StoredTaskEvent {
  return { taskId, eventId, attemptId: null, type, occurredAt, observedAt: occurredAt, actor: "workbuddy", payload, sourceRef: `event-${eventId}` };
}

class FakeStore implements NotificationStore {
  readonly tasks: StoredTask[];
  readonly events = new Map<string, StoredTaskEvent[]>();
  readonly contract: TaskContractRead;
  constructor(tasks: StoredTask[], events: Record<string, StoredTaskEvent[]>, contract: TaskContractRead = { state: "absent" }) {
    this.tasks = tasks;
    for (const [taskId, list] of Object.entries(events)) this.events.set(taskId, list);
    this.contract = contract;
  }
  get(taskId: string): StoredTask | undefined { return this.tasks.find(task => task.taskId === taskId); }
  listTasksByCreatedCursor(options: { limit: number; afterTaskId?: string }): { tasks: StoredTask[]; anchorFound: boolean } {
    const start = options.afterTaskId ? this.tasks.findIndex(task => task.taskId === options.afterTaskId) + 1 : 0;
    return { tasks: this.tasks.slice(start, start + options.limit), anchorFound: true };
  }
  listTaskEvents(taskId: string, options: { afterEventId?: number; limit?: number } = {}): { events: StoredTaskEvent[]; nextEventId: number } {
    const all = [...(this.events.get(taskId) ?? [])].sort((a, b) => a.eventId - b.eventId);
    const after = options.afterEventId ?? 0;
    const page = all.filter(event => event.eventId > after).slice(0, options.limit ?? 100);
    return { events: page, nextEventId: page.length ? page[page.length - 1]!.eventId : after };
  }
  getContract(): TaskContractRead { return this.contract; }
}

function tempDir(t: { after(callback: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l06-notify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return dir;
}

function files(dir: string): { configFile: string; ledgerFile: string } {
  return { configFile: path.join(dir, "notifications.json"), ledgerFile: path.join(dir, "notification-ledger.json") };
}

function inputEpisode(taskId = "task-1", eventId = 1): StoredTaskEvent {
  return eventFixture(taskId, eventId, "input_requested", { patch: { state: "blocked" } }, "2026-11-05T10:01:00.000Z");
}

test("notification: the same event is delivered once and a reopened process does not repeat it", (t) => {
  const dir = tempDir(t);
  const store = new FakeStore([taskFixture({ state: "blocked", blockingReason: "需要确认目录" })], { "task-1": [inputEpisode()] });
  const delivered: DesktopNotification[] = [];
  let now = T0 + 60_000;
  const center = new NotificationCenter({ store, ...files(dir), deliver: item => delivered.push(item), now: () => new Date(now) });
  const first = center.poll();
  assert.equal(first.delivered.length, 1);
  assert.equal(delivered[0]?.schemaVersion, NOTIFICATION_SCHEMA);
  assert.equal(delivered[0]?.reason, "input_requested");
  assert.equal(delivered[0]?.notificationId.startsWith("ntf-"), true);

  const second = center.poll();
  assert.equal(second.delivered.length, 0, "the same event id is the same episode");

  now += 60_000;
  const reopened = new NotificationCenter({ store, ...files(dir), deliver: item => delivered.push(item), now: () => new Date(now) });
  assert.equal(reopened.poll().delivered.length, 0, "the ledger survives a restart");
  assert.equal(delivered.length, 1);
});

test("notification: two episodes of the same reason are both delivered, the second after the throttle", (t) => {
  const dir = tempDir(t);
  const store = new FakeStore([taskFixture({ state: "blocked", blockingReason: "第一次" })], {
    "task-1": [
      inputEpisode("task-1", 1),
      eventFixture("task-1", 2, "input_resolved", { patch: { blockingReason: null } }, "2026-11-05T10:02:00.000Z"),
      inputEpisode("task-1", 3),
    ],
  });
  const delivered: DesktopNotification[] = [];
  let now = T0 + 10 * 60_000;
  const center = new NotificationCenter({ store, ...files(dir), deliver: item => delivered.push(item), now: () => new Date(now) });
  const first = center.poll();
  assert.equal(first.delivered.length, 1);
  assert.equal(first.deferred, 1, "the second episode of the same reason waits for the throttle");

  const early = center.pending();
  assert.equal(early.length, 1);
  assert.ok(early[0]?.readyAt, "the pending view names the ready time instead of hiding the episode");

  now += DEFAULT_NOTIFICATION_CONFIG.minIntervalMs;
  const second = center.poll();
  assert.equal(second.delivered.length, 1);
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0]?.notificationId, delivered[1]?.notificationId);
});

test("notification: duplicate and out-of-order rows never produce two balloons for one episode", (t) => {
  const dir = tempDir(t);
  const store = new FakeStore([taskFixture({ state: "needs_review" })], {
    "task-1": [
      eventFixture("task-1", 2, "task_state_changed", { patch: { state: "needs_review" } }, "2026-11-05T10:03:00.000Z"),
      eventFixture("task-1", 1, "input_resolved", { patch: { blockingReason: null } }, "2026-11-05T10:02:00.000Z"),
      eventFixture("task-1", 2, "task_state_changed", { patch: { state: "needs_review" } }, "2026-11-05T10:03:00.000Z"),
    ],
  });
  const delivered: DesktopNotification[] = [];
  const center = new NotificationCenter({ store, ...files(dir), deliver: item => delivered.push(item), now: () => new Date(T0 + 10 * 60_000) });
  const result = center.poll();
  assert.equal(result.delivered.length, 1);
  assert.equal(delivered[0]?.anchor.kind, "event");
  assert.equal(delivered[0]?.anchor.eventId, 2);
});

test("notification: switching notifications off keeps evidence and does not backfill on re-enable", (t) => {
  const dir = tempDir(t);
  const store = new FakeStore([taskFixture({ state: "blocked", blockingReason: "等确认" })], { "task-1": [inputEpisode()] });
  const delivered: DesktopNotification[] = [];
  let now = T0 + 60_000;
  const center = new NotificationCenter({ store, ...files(dir), deliver: item => delivered.push(item), now: () => new Date(now) });
  const off = center.setConfig({ enabled: false });
  assert.equal(off.ok, true);
  const silent = center.poll();
  assert.equal(silent.delivered.length, 0);
  assert.equal(silent.suppressedByReasonOff, 1);
  assert.equal(store.get("task-1")?.state, "blocked", "the task store is untouched by the notification switch");

  center.setConfig({ enabled: true });
  now += 120_000;
  assert.equal(center.poll().delivered.length, 0, "an episode suppressed while off is not replayed later");
});

test("notification: a failing presenter does not consume the episode", (t) => {
  const dir = tempDir(t);
  const store = new FakeStore([taskFixture({ state: "failed" })], {
    "task-1": [eventFixture("task-1", 1, "task_state_changed", { patch: { state: "failed" } }, "2026-11-05T10:05:00.000Z")],
  });
  let fail = true;
  const delivered: DesktopNotification[] = [];
  const center = new NotificationCenter({
    store, ...files(dir),
    deliver: item => { if (fail) throw new Error("balloon failed"); delivered.push(item); },
    now: () => new Date(T0 + 10 * 60_000),
  });
  assert.equal(center.poll().delivered.length, 0);
  fail = false;
  assert.equal(center.poll().delivered.length, 1, "the retry after a presenter failure still delivers");
  assert.equal(delivered[0]?.reason, "failed");
});

test("notification: a deadline is derived from the stored contract and never changes the state", (t) => {
  const dir = tempDir(t);
  const task = taskFixture({ state: "working", createdAt: "2026-11-05T09:00:00.000Z" });
  const contract: TaskContractRead = {
    state: "found",
    record: {
      taskId: "task-1",
      agreementVersion: "v1",
      contractHash: "a".repeat(64),
      schemaVersion: "workbuddy-executor/vnext-1",
      contract: {
        schemaVersion: "workbuddy-executor/vnext-1", taskId: "task-1", workspaceId: "ws", title: "五分钟任务", objective: "SECRET",
        model: "m", timeoutSeconds: 600, maxAttempts: 1,
        scope: { allowedChanges: [], permittedMetadata: [] },
        requiredChecks: [],
      },
      requestedMaxAttempts: 1,
      policyMaxAttempts: 1,
      effectiveMaxAttempts: 1,
      createdAt: "2026-11-05T09:00:00.000Z",
    } as TaskContractRead extends { state: "found"; record: infer R } ? R : never,
  };
  const store = new FakeStore([task], { "task-1": [] }, contract);
  const delivered: DesktopNotification[] = [];
  const center = new NotificationCenter({ store, ...files(dir), deliver: item => delivered.push(item), now: () => new Date("2026-11-05T09:20:00.000Z") });
  const result = center.poll();
  assert.equal(result.delivered.length, 1);
  assert.equal(delivered[0]?.reason, "deadline");
  assert.equal(delivered[0]?.anchor.kind, "derived");
  assert.equal(delivered[0]?.taskTitle, "五分钟任务");
  assert.equal(JSON.stringify(delivered[0]).includes("SECRET"), false, "the objective body never reaches a balloon");
  assert.equal(store.get("task-1")?.state, "working");
});

test("notification: config rejects unknown fields, unknown reasons and out-of-range intervals", (t) => {
  const dir = tempDir(t);
  const store = new FakeStore([taskFixture()], {});
  const center = new NotificationCenter({ store, ...files(dir), now: () => new Date(T0) });
  const badField = center.setConfig({ sound: true });
  assert.equal(badField.ok, false);
  if (!badField.ok) assert.equal(badField.rejection.code, "unknown_field");

  const badReason = center.setConfig({ reasons: { "needs-review": true } });
  assert.equal(badReason.ok, false);
  if (!badReason.ok) {
    assert.equal(badReason.rejection.code, "unknown_enum");
    assert.ok(badReason.rejection.allowed?.includes("needs_review"));
  }

  const badInterval = center.setConfig({ minIntervalMs: -1 });
  assert.equal(badInterval.ok, false);
  if (!badInterval.ok) assert.equal(badInterval.rejection.code, "invalid_value");

  const ok = applyNotificationConfig(DEFAULT_NOTIFICATION_CONFIG, { reasons: { deadline: false } });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.config.reasons.deadline, false);
});

test("notification: a corrupt ledger is explained and never touches the task store", (t) => {
  const dir = tempDir(t);
  const { configFile, ledgerFile } = files(dir);
  fs.writeFileSync(ledgerFile, "{ broken", "utf8");
  const store = new FakeStore([taskFixture({ state: "blocked" })], { "task-1": [inputEpisode()] });
  const delivered: DesktopNotification[] = [];
  const center = new NotificationCenter({ store, configFile, ledgerFile, deliver: item => delivered.push(item), now: () => new Date(T0 + 60_000) });
  assert.equal(center.poll().delivered.length, 1);
  assert.ok(center.issues().some(issue => issue.includes("账本")));
  assert.equal(fs.readFileSync(ledgerFile, "utf8").startsWith("{"), true);
  assert.equal(store.get("task-1")?.state, "blocked");
});
