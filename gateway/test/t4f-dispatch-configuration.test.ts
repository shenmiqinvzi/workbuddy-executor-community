import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { writePrivateJson } from "../src/run-journal.js";

/** FC11-D1: a dispatch reads this process's WorkBuddy directory, while preparation
 *  binds the persistent service's registration. When the two disagree — or when the
 *  directory cannot name the session — the refusal has to happen before an attempt
 *  exists, or the operator is left with a blocked attempt that has no recovery path. */
function fixture(t: TestContext) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t4f-dispatch-config-")));
  const config = {
    backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"),
    workbuddyConfigDir: dir, serviceConfigFile: path.join(dir, "none.json"),
    taskTimeoutSeconds: 60, maxTaskAttempts: 3, claimTimeoutSeconds: 30,
  } as Config;
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES ('original',?,1,NULL)").run(dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  const service = new TaskApplicationService(coordinator, 3, config.runsDir!);
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  /** A registration for this task database, naming the directory the service reads. */
  function register(profileDir: string) {
    const file = path.join(dir, "persistent-service.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessionId: "original", workspace: dir, projectDir: dir,
      nodeBin: process.execPath, dbFile: config.dbFile, runsDir: config.runsDir,
      workbuddyConfigDir: profileDir, cliElectronPath: process.execPath, cdpPort: 18491 }));
    config.serviceConfigFile = file;
  }
  /** A profile directory whose history knows some other session, or nothing at all. */
  function profile(name: string, sessions: string[]) {
    const target = path.join(dir, name);
    fs.mkdirSync(target, { recursive: true });
    if (!sessions.length) return target;
    const sql = new DatabaseSync(path.join(target, "workbuddy.db"));
    sql.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
    for (const id of sessions) sql.prepare("INSERT INTO sessions VALUES (?,?,1,NULL)").run(id, target);
    sql.close();
    return target;
  }
  async function stopped() {
    await coordinator.send({ taskId: "task", objective: "Synthetic selected task", sessionId: "original", workspace: dir, model: "user-choice", operationId: "send", expectedRevision: null, expectedAttemptId: null });
    const task = store.get("task")!;
    writePrivateJson(path.join(config.runsDir!, task.attemptId!, "model-ready.json"), { attemptId: task.attemptId, sessionId: "original", model: "user-choice" });
    const claim = await queue.claim("original", 0);
    assert.equal(claim.status, "task");
    if (claim.status !== "task") throw Error("No claim");
    queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nOriginal synthetic report", artifacts: [] });
    queue.observeNative(task.attemptId!, { state: "idle", workspace: dir });
    await coordinator.sync("task");
    return store.get("task")!;
  }
  async function rework(original: ReturnType<TaskStore["get"]>, operationId = "review-rework") {
    try {
      await coordinator.continue({ taskId: "task", feedback: "Synthetic rework", operationId, expectedRevision: original!.revision, expectedAttemptId: original!.attemptId });
      return null;
    } catch (error) { return error as { code?: string; message?: string }; }
  }
  return { dir, config, store, service, coordinator, register, profile, stopped, rework };
}

test("F01: a registration and this process naming different WorkBuddy directories is refused before the attempt", async t => {
  const f = fixture(t);
  const original = await f.stopped();
  f.register(f.profile("service-profile", ["original"]));
  f.config.workbuddyConfigDir = f.profile("process-profile", ["original"]);
  const error = await f.rework(original);
  assert.equal(error?.code, "BRIDGE_CONFIG_MISMATCH");
  assert.match(String(error?.message), /set WORKBUDDY_CONFIG_DIR/);
  const after = f.store.get("task")!;
  assert.equal(after.attemptId, original!.attemptId, "a wrong WORKBUDDY_CONFIG_DIR must be refused before beginAttempt");
  assert.equal(f.store.operations.get("review-rework")?.dispatchEnteredAt, undefined);
  assert.equal(after.state, "needs_review", "the original reviewable attempt stays as it was");
});

test("F02: a directory that does not know the session stops the rework before the attempt", async t => {
  const f = fixture(t);
  const original = await f.stopped();
  const elsewhere = f.profile("other-profile", ["some-other-session"]);
  f.register(elsewhere);
  f.config.workbuddyConfigDir = elsewhere;
  const error = await f.rework(original);
  assert.equal(error?.code, "BRIDGE_SESSION_ABSENT");
  assert.equal(f.store.get("task")!.attemptId, original!.attemptId);
  assert.equal(f.store.operations.get("review-rework")?.dispatchEnteredAt, undefined);
});

test("F03: an unreadable history is a configuration error, not a blocked attempt", async t => {
  const f = fixture(t);
  const original = await f.stopped();
  const empty = f.profile("empty-profile", []);
  f.register(empty);
  f.config.workbuddyConfigDir = empty;
  const error = await f.rework(original);
  assert.equal(error?.code, "BRIDGE_HISTORY_UNREADABLE");
  assert.equal(f.store.get("task")!.attemptId, original!.attemptId);
});

test("F04: after the directory is corrected the same task reworks on the supported path", async t => {
  const f = fixture(t);
  const original = await f.stopped();
  const wrong = f.profile("wrong-profile", []);
  f.register(wrong);
  f.config.workbuddyConfigDir = wrong;
  assert.equal((await f.rework(original))?.code, "BRIDGE_HISTORY_UNREADABLE");
  f.register(f.dir);
  f.config.workbuddyConfigDir = f.dir;
  // The refused attempt kept its own replay key, so the corrected retry is a new
  // operation: an operation id is never reused to dispatch twice.
  assert.equal(await f.rework(f.store.get("task"), "review-rework-2"), null, "the corrected configuration dispatches the rework");
  assert.notEqual(f.store.get("task")!.attemptId, original!.attemptId);
});
