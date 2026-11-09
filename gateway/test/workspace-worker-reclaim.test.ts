import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { CREATION_STALE_MS, WorkspaceWorkers, type NativeWorkerCreator } from "../src/workspace-workers.js";

const ANCIENT = () => new Date(Date.now() - CREATION_STALE_MS - 60_000).toISOString();

function fixture(t: {after(fn: () => void): void}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-worker-reclaim-"));
  const workspace = path.join(dir, "Project A");
  fs.mkdirSync(workspace);
  const config: Config = {
    ...loadConfig(),
    backend: "desktop-queue",
    dbFile: path.join(dir, "tasks.sqlite"),
    runsDir: path.join(dir, "runs"),
    workbuddyConfigDir: dir,
    serviceConfigFile: path.join(dir, "persistent-service.json")
  };
  const nativeFile = path.join(dir, "workbuddy.db");
  const native = new DatabaseSync(nativeFile);
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  const register = (id: string, cwd: string) => native.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?,0,NULL)").run(id, cwd);
  const unregister = (id: string) => native.prepare("DELETE FROM sessions WHERE id=?").run(id);
  const registry = new WorkspaceWorkers(config);
  const registryFile = path.join(config.runsDir!, "workspace-workers.sqlite");
  const calls: Array<{id: string; workspace: string}> = [];
  const creator: NativeWorkerCreator = {
    async setModel(sessionId, model) { return { sessionId, model }; },
    async createWorker(workspace, sessionId) { calls.push({ id: sessionId, workspace }); register(sessionId, workspace); return { sessionId, workspace }; }
  };
  const mutate = (sql: string, ...args: Array<string | number | null>) => {
    const db = new DatabaseSync(registryFile);
    try { db.prepare(sql).run(...args); } finally { db.close(); }
  };
  const keyRow = (workerKey: string) => {
    const db = new DatabaseSync(registryFile, { readOnly: true });
    try { return db.prepare("SELECT sessionId FROM worker_keys WHERE workspace=? AND workerKey=?").get(path.resolve(workspace), workerKey) as { sessionId: string } | undefined; } finally { db.close(); }
  };
  t.after(() => { try { registry.close(); } catch { /* a test may already have closed it */ } try { native.close(); } catch { /* a test may already have closed it */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, workspace, config, native, nativeFile, register, unregister, registry, registryFile, calls, creator, mutate, keyRow };
}

test("F-WORKER-2 a reclaimed key frees its mapping so the same worker key can retry", async t => {
  const f = fixture(t);
  const first = await f.registry.ensure({ workspace: f.workspace, workerKey: "task-key" }, f.creator);
  assert.equal(first.created, true);
  assert.equal(f.calls.length, 1);
  // The creator died before settling: the row is stale, non-ready, and the
  // native app never registered that identity.
  f.mutate("UPDATE workers SET state='creating', updatedAt=? WHERE sessionId=?", ANCIENT(), first.worker.sessionId);
  f.unregister(first.worker.sessionId);

  const retried = await f.registry.ensure({ workspace: f.workspace, workerKey: "task-key" }, f.creator);
  assert.equal(retried.created, true);
  assert.notEqual(retried.worker.sessionId, first.worker.sessionId);
  assert.equal(f.calls.length, 2);
  // The old record is kept, annotated, and no longer selected.
  const old = f.registry.list().find(worker => worker.sessionId === first.worker.sessionId)!;
  assert.equal(old.selected, false);
  assert.match(old.error ?? "", /Reservation reclaimed/);
  assert.equal(f.keyRow("task-key")?.sessionId, retried.worker.sessionId);
});

test("F-WORKER-2 an unreadable native registry never creates a second native session", async t => {
  const f = fixture(t);
  const first = await f.registry.ensure({ workspace: f.workspace, workerKey: "unreadable" }, f.creator);
  f.mutate("UPDATE workers SET state='creating', updatedAt=? WHERE sessionId=?", ANCIENT(), first.worker.sessionId);
  f.native.close();
  fs.rmSync(f.nativeFile);

  await assert.rejects(
    () => f.registry.ensure({ workspace: f.workspace, workerKey: "unreadable" }, f.creator),
    /could not be read[\s\S]*no second native session/
  );
  assert.equal(f.calls.length, 1, "no creation may follow an unverifiable registry");
  const kept = f.registry.list().find(worker => worker.sessionId === first.worker.sessionId)!;
  assert.equal(kept.state, "creating");
  assert.equal(f.keyRow("unreadable")?.sessionId, first.worker.sessionId);
});

test("F-WORKER-2 a corrupted native registry is treated as unverifiable, not absent", async t => {
  const f = fixture(t);
  const first = await f.registry.ensure({ workspace: f.workspace }, f.creator);
  f.mutate("UPDATE workers SET state='creating', updatedAt=? WHERE sessionId=?", ANCIENT(), first.worker.sessionId);
  f.native.close();
  fs.writeFileSync(f.nativeFile, Buffer.from("this is not a sqlite database at all", "utf8"));

  await assert.rejects(() => f.registry.ensure({ workspace: f.workspace }, f.creator), /could not be read/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.registry.list().find(worker => worker.sessionId === first.worker.sessionId)?.state, "creating");
});

test("F-WORKER-2 a stale reservation the native app did register is reused, never duplicated", async t => {
  const f = fixture(t);
  const first = await f.registry.ensure({ workspace: f.workspace, workerKey: "registered" }, f.creator);
  f.mutate("UPDATE workers SET state='creating', updatedAt=? WHERE sessionId=?", ANCIENT(), first.worker.sessionId);
  // The native session is still registered, so the fence must resolve to reuse.
  const reused = await f.registry.ensure({ workspace: f.workspace, workerKey: "registered" }, f.creator);
  assert.equal(reused.created, false);
  assert.equal(reused.worker.sessionId, first.worker.sessionId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.keyRow("registered")?.sessionId, first.worker.sessionId);
});

test("F-WORKER-2 two writers racing on one stale key produce exactly one new reservation", async t => {
  const f = fixture(t);
  const first = await f.registry.ensure({ workspace: f.workspace, workerKey: "race" }, f.creator);
  f.mutate("UPDATE workers SET state='creating', updatedAt=? WHERE sessionId=?", ANCIENT(), first.worker.sessionId);
  f.unregister(first.worker.sessionId);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const slow: NativeWorkerCreator = {
    async createWorker(workspace, sessionId) { entered(); await gate; f.register(sessionId, workspace); return { sessionId, workspace }; }
  };
  const winner = f.registry.ensure({ workspace: f.workspace, workerKey: "race" }, slow);
  await started;
  const other = new WorkspaceWorkers(f.config);
  try {
    await assert.rejects(() => other.ensure({ workspace: f.workspace, workerKey: "race" }, f.creator), /in progress or uncertain/);
  } finally { other.close(); }
  release();
  const result = await winner;
  assert.equal(result.created, true);
  const rows = f.registry.list();
  assert.equal(rows.filter(worker => worker.selected).length, 1, "only one reservation may be selected");
  assert.equal(f.keyRow("race")?.sessionId, result.worker.sessionId);
});

test("F-WORKER-3 an explicitly chosen session without a project directory is never bound", async t => {
  const f = fixture(t);
  const modelCalls: string[] = [];
  const creator: NativeWorkerCreator = {
    async setModel(sessionId, model) { modelCalls.push(sessionId); return { sessionId, model }; },
    createWorker: f.creator.createWorker
  };
  // The native registry can hold a row whose cwd is null: an identity exists but
  // no project directory can be verified for it.
  f.register("session-legacy", null as unknown as string);

  await assert.rejects(
    f.registry.ensure({ workspace: f.workspace, sessionId: "session-legacy", model: "deepseek-v4.1-flash-sg" }, creator),
    /no recorded project directory/
  );
  assert.deepEqual(modelCalls, []);
  assert.deepEqual(f.calls, []);
});

test("F-WORKER-3 an explicitly chosen session in another directory is never bound", async t => {
  const f = fixture(t);
  const elsewhere = path.join(f.dir, "Project B");
  fs.mkdirSync(elsewhere);
  const modelCalls: string[] = [];
  const creator: NativeWorkerCreator = {
    async setModel(sessionId, model) { modelCalls.push(sessionId); return { sessionId, model }; },
    createWorker: f.creator.createWorker
  };
  f.register("session-elsewhere", elsewhere);

  await assert.rejects(
    f.registry.ensure({ workspace: f.workspace, sessionId: "session-elsewhere", model: "deepseek-v4.1-flash-sg" }, creator),
    /workspace differs from the requested project/
  );
  assert.deepEqual(modelCalls, []);
  assert.deepEqual(f.calls, []);
});

test("F-WORKER-3 a reused reservation whose directory cannot be verified is kept, not replaced", async t => {
  const f = fixture(t);
  const first = await f.registry.ensure({ workspace: f.workspace, workerKey: "task-key" }, f.creator);
  assert.equal(f.calls.length, 1);
  f.mutate("UPDATE workers SET state='creating', updatedAt=? WHERE sessionId=?", ANCIENT(), first.worker.sessionId);
  f.native.prepare("UPDATE sessions SET cwd=NULL WHERE id=?").run(first.worker.sessionId);

  await assert.rejects(
    f.registry.ensure({ workspace: f.workspace, workerKey: "task-key", model: "deepseek-v4.1-flash-sg" }, f.creator),
    /no recorded project directory/
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.keyRow("task-key")?.sessionId, first.worker.sessionId);
});