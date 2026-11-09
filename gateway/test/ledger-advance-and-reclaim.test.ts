import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkspaceWorkers, CREATION_STALE_MS } from "../src/workspace-workers.js";

// F-LEDGER-2: a stopped attempt must be advanced by a plain ledger read, so a
// reconnect-and-list shows needs_review without an extra wait call. The advance
// must stay bounded, best effort, and must never run where it can block a pump.

type Row = { taskId: string; state: string; attemptId?: string };
const ATTEMPT_1 = "run-11111111-1111-4111-8111-111111111111";
const ATTEMPT_2 = "run-22222222-2222-4222-8222-222222222222";
const ATTEMPT_3 = "run-33333333-3333-4333-8333-333333333333";

function harness(rows: Row[], stopped: string[], options: { failOn?: string; gate?: (taskId: string) => boolean } = {}) {
  const synced: string[] = [];
  const service = Object.create(TaskApplicationService.prototype) as TaskApplicationService;
  (service as unknown as { listTasks: () => Row[] }).listTasks = () => rows;
  // The strict identity gate lives on the coordinator; the unit harness only
  // decides which rows it admits.
  (service as unknown as { coordinator: { advanceGate: (taskId: string) => boolean } }).coordinator = { advanceGate: (taskId: string) => options.gate ? options.gate(taskId) : true };
  (service as unknown as { executionStatus: (taskId: string) => { remoteStopped: boolean } }).executionStatus = (taskId) => ({ remoteStopped: stopped.includes(taskId) });
  (service as unknown as { sync: (taskId: string) => Promise<Row> }).sync = async (taskId) => {
    if (taskId === options.failOn) throw new Error("stop not confirmed");
    synced.push(taskId);
    const row = rows.find((entry) => entry.taskId === taskId)!;
    return { ...row, state: "needs_review" };
  };
  return { service, synced };
}

test("F-LEDGER-2 a stopped queued attempt is advanced by the read", async () => {
  const { service, synced } = harness(
    [{ taskId: "t1", state: "queued", attemptId: ATTEMPT_1 }, { taskId: "t2", state: "needs_review", attemptId: ATTEMPT_2 }, { taskId: "t3", state: "working", attemptId: ATTEMPT_3 }],
    ["t1", "t3"],
  );
  const result = await service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, ["t1", "t3"]);
  assert.deepEqual(synced, ["t1", "t3"]);
});

test("F-LEDGER-2 a transition is reported even when sync writes through the listed row", async () => {
  // The store hands back its own row instance, so a sync that updates the task
  // in place makes the "after" state look identical to the "before" state. The
  // read must still report the transition, otherwise a real reconcile looks
  // like nothing happened and the caller keeps waiting for a wait call.
  const rows: Row[] = [{ taskId: "t1", state: "queued", attemptId: ATTEMPT_1 }];
  const service = Object.create(TaskApplicationService.prototype) as TaskApplicationService;
  (service as unknown as { listTasks: () => Row[] }).listTasks = () => rows;
  (service as unknown as { coordinator: { advanceGate: (taskId: string) => boolean } }).coordinator = { advanceGate: () => true };
  (service as unknown as { executionStatus: (taskId: string) => { remoteStopped: boolean } }).executionStatus = () => ({ remoteStopped: true });
  (service as unknown as { sync: (taskId: string) => Promise<Row> }).sync = async () => {
    rows[0].state = "needs_review";
    return rows[0];
  };
  const result = await service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, ["t1"]);
});

test("F-LEDGER-2 an unconfirmed stop is never advanced", async () => {
  const { service, synced } = harness([{ taskId: "t1", state: "queued", attemptId: ATTEMPT_1 }], []);
  const result = await service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, []);
  assert.deepEqual(synced, []);
});

test("F-LEDGER-2 a failing advance never fails the read", async () => {
  const { service, synced } = harness(
    [{ taskId: "t1", state: "queued", attemptId: ATTEMPT_1 }, { taskId: "t2", state: "queued", attemptId: ATTEMPT_2 }],
    ["t1", "t2"],
    { failOn: "t1" },
  );
  const result = await service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, ["t2"]);
  assert.deepEqual(synced, ["t2"]);
});

test("F-LEDGER-2 the advance honours its time budget", async () => {
  const { service, synced } = harness([{ taskId: "t1", state: "queued", attemptId: ATTEMPT_1 }], ["t1"]);
  const result = await service.advanceStoppedAttempts({ budgetMs: 0 });
  assert.deepEqual(result.advanced, []);
  assert.equal(result.skipped, 1);
  assert.deepEqual(synced, []);
});

test("F-LEDGER-2 a sync that reports the same state is not a reconciled row", async () => {
  const rows: Row[] = [{ taskId: "t1", state: "needs_review", attemptId: ATTEMPT_1 }];
  const service = Object.create(TaskApplicationService.prototype) as TaskApplicationService;
  (service as unknown as { listTasks: () => Row[] }).listTasks = () => rows;
  (service as unknown as { coordinator: { advanceGate: (taskId: string) => boolean } }).coordinator = { advanceGate: () => true };
  (service as unknown as { executionStatus: (taskId: string) => { remoteStopped: boolean } }).executionStatus = () => ({ remoteStopped: true });
  (service as unknown as { sync: (taskId: string) => Promise<Row> }).sync = async (taskId) => ({ taskId, state: "needs_review", attemptId: ATTEMPT_1 });
  const result = await service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, [], "reading a row must not claim a change that did not happen");
});

test("F-LEDGER-2 the identity gate is consulted before any advance", async () => {
  const { service, synced } = harness(
    [{ taskId: "t1", state: "queued", attemptId: ATTEMPT_1 }, { taskId: "t2", state: "queued", attemptId: ATTEMPT_2 }],
    ["t1", "t2"],
    { gate: (taskId) => taskId !== "t2" },
  );
  const result = await service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, ["t1"]);
  assert.deepEqual(synced, ["t1"], "a row the gate refuses is never synced");
});
// F-WORKER-1: a creator that died between reserve() and settle() leaves a
// creating row that wedges the workspace forever. The reclaim must free that
// row through the real class and real ledger, and must not touch a ready row.

function staleConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-workers-"));
  const config = {
    backend: "desktop-queue" as const,
    dbFile: path.join(root, "tasks.sqlite"),
    runsDir: root,
    workbuddyConfigDir: path.join(root, "cfg"),
  };
  fs.mkdirSync(config.workbuddyConfigDir, { recursive: true });
  // A readable registry that genuinely holds no such session: only that is
  // negative evidence. A missing or unreadable registry is unverifiable and
  // must keep the fence (see workspace-worker-reclaim.test.ts).
  const native = new DatabaseSync(path.join(config.workbuddyConfigDir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.close();
  return { root, config: config as never };
}

test("F-WORKER-1 a stale creating reservation is reclaimed, not re-blocked", async () => {
  const { root, config } = staleConfig();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ws-"));
  const file = path.join(root, "workspace-workers.sqlite");
  const stamp = new Date(Date.now() - CREATION_STALE_MS - 60_000).toISOString();
  const seeded = new DatabaseSync(file);
  seeded.exec(`CREATE TABLE workers(sessionId TEXT PRIMARY KEY, workspace TEXT NOT NULL, state TEXT NOT NULL,
    selected INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT);`);
  seeded.prepare("INSERT INTO workers VALUES (?, ?, 'creating', 1, ?, ?, NULL)").run("00000000-0000-4000-8000-000000000001", path.resolve(workspace), stamp, stamp);
  seeded.close();

  const workers = new WorkspaceWorkers(config);
  const native = {
    createWorker: async () => { throw new Error("stub creation refused"); },
  };
  await assert.rejects(workers.ensure({ workspace }, native), /stub creation refused/);
  workers.close();

  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const old = check.prepare("SELECT state, selected, error FROM workers WHERE sessionId=?").get("00000000-0000-4000-8000-000000000001") as { state: string; selected: number; error: string | null };
    assert.equal(old.selected, 0);
    assert.match(String(old.error), /Reservation reclaimed/);
    const rows = check.prepare("SELECT state FROM workers").all() as { state: string }[];
    assert.equal(rows.length, 2, "the reclaim creates a fresh reservation instead of reusing the dead one");
  } finally { check.close(); }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("F-WORKER-1 a fresh reservation still blocks and is not reclaimed", async () => {
  const { root, config } = staleConfig();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ws-"));
  const file = path.join(root, "workspace-workers.sqlite");
  const stamp = new Date().toISOString();
  const seeded = new DatabaseSync(file);
  seeded.exec(`CREATE TABLE workers(sessionId TEXT PRIMARY KEY, workspace TEXT NOT NULL, state TEXT NOT NULL,
    selected INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT);`);
  seeded.prepare("INSERT INTO workers VALUES (?, ?, 'creating', 1, ?, ?, NULL)").run("00000000-0000-4000-8000-000000000002", path.resolve(workspace), stamp, stamp);
  seeded.close();

  const workers = new WorkspaceWorkers(config);
  const native = { createWorker: async () => { throw new Error("must not be called"); } };
  await assert.rejects(workers.ensure({ workspace }, native), /Native creation is in progress or uncertain/);
  workers.close();

  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const row = check.prepare("SELECT selected, error FROM workers WHERE sessionId=?").get("00000000-0000-4000-8000-000000000002") as { selected: number; error: string | null };
    assert.equal(row.selected, 1, "a live creator keeps its reservation");
    assert.equal(row.error, null);
  } finally { check.close(); }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});
