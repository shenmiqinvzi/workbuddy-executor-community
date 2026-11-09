import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { RunJournal } from "../src/run-journal.js";

// F-LEDGER-2 integration: a real TaskStore plus a real run journal, no
// persistent service running. The task row still says queued while the journal
// already carries durable native stop proof. A plain ledger read has to show the
// truth; nothing else may be needed.

const SESSION = "60b7c0de-0000-4000-8000-000000000001";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ledger-advance-"));
  const workspace = path.join(dir, "Project A");
  fs.mkdirSync(workspace);
  const config: Config = {
    ...loadConfig(),
    backend: "desktop-queue",
    dbFile: path.join(dir, "tasks.sqlite"),
    runsDir: path.join(dir, "runs"),
    workbuddyConfigDir: path.join(dir, "cfg"),
    serviceConfigFile: path.join(dir, "persistent-service.json")
  };
  fs.mkdirSync(config.workbuddyConfigDir!, { recursive: true });
  const store = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config);
  const service = new TaskApplicationService(new TaskCoordinator(config, store, client), 3, config.runsDir!);
  let counter = 0;
  const seed = (taskId: string) => {
    counter += 1;
    const digits = String(counter).repeat(8).slice(0, 8);
    const attemptId = `run-${digits}-1111-4111-8111-111111111111`;
    store.createOrGet({
      taskId, messageId: `${attemptId}:0`, objective: "fixture", state: "queued",
      attemptId, sessionId: SESSION, workspace
    });
    const journal = new RunJournal(config.runsDir!, attemptId);
    fs.mkdirSync(journal.dir, { recursive: true });
    fs.writeFileSync(path.join(journal.dir, "request.json"), JSON.stringify({
      attemptId, taskId, prompt: "fixture", workspace, sessionId: SESSION, sessionMode: "existing", timeoutSeconds: 900
    }));
    return journal;
  };
  const journal = (attemptId: string) => new RunJournal(config.runsDir!, attemptId);
  const snapshot = (name: string, taskId: string) => {
    const out = process.env.D3_SNAPSHOT_DIR;
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ task: store.get(taskId), listed: service.listTasks(5) }, null, 2));
  };
  t.after(() => { try { store.close(); } catch { /* closed by the test */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, workspace, config, store, service, seed, journal, snapshot };
}

function stoppedSnapshot(taskId: string, attemptId: string, workspace: string, overrides: Record<string, unknown> = {}) {
  const stoppedAt = new Date(Date.now() - 5_000).toISOString();
  return {
    version: 1, attemptId, taskId, sessionId: SESSION, workspace,
    driver: "desktop-queue", status: "needs_review", stopReason: "end_turn",
    nativeStoppedAt: stoppedAt, nativeStopSource: "native_idle",
    reportDigest: "b".repeat(64), startedAt: new Date(Date.now() - 60_000).toISOString(),
    deadline: new Date(Date.now() + 600_000).toISOString(),
    ...overrides
  };
}

test("F-LEDGER-2 a real ledger with durable stop proof advances on a plain list", async t => {
  const f = fixture(t);
  const taskId = "ledger-one";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot(taskId, attemptId, f.workspace) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION, runtimeSource: "desktop_queue" });
  assert.equal(f.store.get(taskId)!.state, "queued");

  const result = await f.service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, [taskId]);
  assert.equal(f.store.get(taskId)!.state, "needs_review");
  const listed = f.service.listTasks(5);
  assert.equal(listed.find(task => task.taskId === taskId)!.state, "needs_review");
  assert.equal(f.service.listTasks(5).length, 1, "the advance never adds or drops rows");
  f.snapshot("d3-positive", taskId);
});

test("F-LEDGER-2 an attempt without durable stop proof is left alone", async t => {
  const f = fixture(t);
  const taskId = "ledger-two";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot(taskId, attemptId, f.workspace, { nativeStoppedAt: null, nativeStopSource: null, stopReason: "end_turn" }) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION, runtimeSource: "desktop_queue" });

  const result = await f.service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, []);
  assert.equal(f.store.get(taskId)!.state, "queued");
});

test("F-LEDGER-3 another backend's journal is not reconciled by the desktop queue list", async t => {
  const f = fixture(t);
  const taskId = "ledger-other-driver";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot(taskId, attemptId, f.workspace, { driver: "desktop-acp" }) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION });

  assert.deepEqual((await f.service.advanceStoppedAttempts()).advanced, []);
  assert.equal(f.store.get(taskId)!.state, "queued");
});

test("F-LEDGER-2 a journal that belongs to another task never proves this task stopped", async t => {
  const f = fixture(t);
  const taskId = "ledger-three";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot("some-other-task", attemptId, f.workspace) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION, runtimeSource: "desktop_queue" });

  const result = await f.service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, []);
  assert.equal(f.store.get(taskId)!.state, "queued");
});

test("F-LEDGER-3 a missing run request is not stop proof even with a real result event", async t => {
  const f = fixture(t);
  const taskId = "ledger-five";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot(taskId, attemptId, f.workspace) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION, runtimeSource: "desktop_queue" });
  fs.rmSync(path.join(journal.dir, "request.json"));

  const result = await f.service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, []);
  assert.equal(f.store.get(taskId)!.state, "queued");
  f.snapshot("d3-missing-request", taskId);
});

test("F-LEDGER-3 an unreadable run request is not stop proof even with a real result event", async t => {
  const f = fixture(t);
  const taskId = "ledger-six";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot(taskId, attemptId, f.workspace) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION, runtimeSource: "desktop_queue" });
  fs.writeFileSync(path.join(journal.dir, "request.json"), "{ this is not json");

  const result = await f.service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, []);
  assert.equal(f.store.get(taskId)!.state, "queued");
  f.snapshot("d3-unreadable-request", taskId);
});

test("F-LEDGER-3 a run request for another project is not stop proof even with a real result event", async t => {
  const f = fixture(t);
  const taskId = "ledger-seven";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot(taskId, attemptId, f.workspace) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION, runtimeSource: "desktop_queue" });
  fs.writeFileSync(path.join(journal.dir, "request.json"), JSON.stringify({
    attemptId, taskId, prompt: "fixture", workspace: path.join(f.dir, "Elsewhere"), sessionId: SESSION, sessionMode: "existing", timeoutSeconds: 900
  }));

  const result = await f.service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, []);
  assert.equal(f.store.get(taskId)!.state, "queued");
  f.snapshot("d3-wrong-request-workspace", taskId);
});

test("F-LEDGER-3 a run request bound to another session is not stop proof", async t => {
  const f = fixture(t);
  const taskId = "ledger-eight";
  const journal = f.seed(taskId);
  const attemptId = f.store.get(taskId)!.attemptId!;
  journal.save(stoppedSnapshot(taskId, attemptId, f.workspace) as never);
  journal.append("result", "TASK_STATUS: completed", { status: "completed", sessionId: SESSION, runtimeSource: "desktop_queue" });
  fs.writeFileSync(path.join(journal.dir, "request.json"), JSON.stringify({
    attemptId, taskId, prompt: "fixture", workspace: f.workspace, sessionId: "60b7c0de-0000-4000-8000-00000000dead", sessionMode: "existing", timeoutSeconds: 900
  }));

  const result = await f.service.advanceStoppedAttempts();
  assert.deepEqual(result.advanced, []);
  assert.equal(f.store.get(taskId)!.state, "queued");
  f.snapshot("d3-wrong-request-session", taskId);
});
