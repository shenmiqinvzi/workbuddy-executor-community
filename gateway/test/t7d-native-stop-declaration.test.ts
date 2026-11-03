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
import { writePrivateJson } from "../src/run-journal.js";
import type { RecoveryInput } from "../src/operation-recovery.js";

function fixture(t: TestContext) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t7d-declaration-")));
  const config = { backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"),
    workbuddyConfigDir: dir, serviceConfigFile: path.join(dir, "none.json"), taskTimeoutSeconds: 60, maxTaskAttempts: 3, claimTimeoutSeconds: 30 } as Config;
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES ('original',?,1,NULL)").run(dir); native.close();
  const store = new TaskStore(config.dbFile);
  const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config));
  const service = new TaskApplicationService(coordinator, 3, config.runsDir!);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

  async function sent() {
    await coordinator.send({ taskId: "task", objective: "Original explicitly selected task", sessionId: "original", workspace: dir, model: "user-choice",
      operationId: "send", expectedRevision: null, expectedAttemptId: null });
    const task = store.get("task")!;
    const runDir = path.join(config.runsDir!, task.attemptId!);
    fs.mkdirSync(runDir, { recursive: true });
    writePrivateJson(path.join(runDir, "request.json"), { attemptId: task.attemptId, sessionId: "original", model: "user-choice" });
    writeRun({ status: "needs_review", reportDigest: "a".repeat(64) });
    return store.get("task")!;
  }
  function writeRun(patch: Record<string, unknown>) {
    const task = store.get("task")!;
    writePrivateJson(path.join(config.runsDir!, task.attemptId!, "state.json"), { taskId: "task", attemptId: task.attemptId, sessionId: "original",
      driver: "desktop-queue", updatedAt: new Date().toISOString(), ...patch });
  }
  const snapshot = () => JSON.parse(fs.readFileSync(path.join(config.runsDir!, store.get("task")!.attemptId!, "state.json"), "utf8"));
  const declare = (statement = "我在原生窗口看到会话已结束，任务栏没有运行中的会话。") => {
    const task = store.get("task")!;
    return store.stopDeclarations.declare({ taskId: "task", attemptId: task.attemptId!, revision: task.revision, actor: "synthetic-human", statement, snapshot: snapshot() });
  };
  function input(action: RecoveryInput["action"], id = `recovery-${action}`) {
    const view = service.readOperationRecovery("send");
    return { operationId: id, targetOperationId: "send", action, reason: "Independent synthetic operator inspected the original receipt",
      expectedRevision: view.revision, expectedAttemptId: view.attemptId, expectedOperationToken: view.operationToken, expectedEvidenceToken: view.evidenceToken } satisfies RecoveryInput;
  }
  const resolve = (action: RecoveryInput["action"], id?: string) => { const request = input(action, id); return service.resolveOperationRecovery(request, service.authorizeOperationRecovery(request, "synthetic-human")); };
  return { config, store, service, sent, writeRun, snapshot, declare, input, resolve };
}

test("without a declaration a reported run that never proved its stop cannot be closed", async t => {
  const f = fixture(t);
  await f.sent();
  const view = f.service.readOperationRecovery("send");
  assert.deepEqual(view.available, []);
  assert.equal(view.proof.close, null);
  assert.equal(view.declaration, null);
  assert.throws(() => f.resolve("close"), (error: any) => error.code === "RECOVERY_UNPROVEN");
});

test("a declaration is recorded apart from native evidence and moves nothing on its own", async t => {
  const f = fixture(t);
  const task = await f.sent();
  const capacity = () => new DatabaseSync(f.config.dbFile, { readOnly: true });
  const occupancy = () => { const db = capacity(); try { return db.prepare("SELECT COUNT(*) AS n FROM workflow_capacity").get() as { n: number }; } finally { db.close(); } };
  const before = occupancy().n;
  const declaration = f.declare();
  assert.equal(declaration.schemaVersion, "native-stop-declaration/1");
  assert.equal(declaration.basis.nativeStoppedAt, null);
  assert.equal(f.store.get("task")!.state, task.state);
  assert.equal(occupancy().n, before);
  // It is still not native evidence: the run record has no stop proof.
  const view = f.service.readOperationRecovery("send");
  assert.equal(view.proof.close, "declared_stop");
  assert.equal(view.declaration?.declarationId, declaration.declarationId);
  const events = f.store.listTaskEvents("task", { limit: 100 }).events.filter(event => event.type === "native_stop_declared");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor, "declared_user");
});

test("a declared stop lets an authorized close release the slot, and the decision keeps the weaker proof", async t => {
  const f = fixture(t);
  await f.sent();
  const declaration = f.declare();
  const view = f.service.readOperationRecovery("send");
  assert.ok(view.available.includes("close"));
  const decision = f.resolve("close");
  assert.equal(decision.action, "close");
  assert.equal(decision.proof, "declared_stop");
  assert.equal(decision.declarationId, declaration.declarationId);
  assert.equal(f.store.get("task")!.state, "cancelled");
  const db = new DatabaseSync(f.config.dbFile, { readOnly: true });
  try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM workflow_capacity").get() as { n: number }).n, 0); } finally { db.close(); }
});

test("a declaration is refused when the run already proves the stop, is still active, or the statement is too thin", async t => {
  const f = fixture(t);
  await f.sent();
  f.writeRun({ status: "needs_review", nativeStoppedAt: "2026-11-02T12:10:00.000Z", nativeStopSource: "native_idle" });
  assert.throws(() => f.declare(), (error: any) => error.code === "NATIVE_EVIDENCE_PRESENT");
  f.writeRun({ status: "working" });
  assert.throws(() => f.declare(), (error: any) => error.code === "STILL_RUNNING");
  f.writeRun({ status: "needs_review" });
  assert.throws(() => f.declare("短"), (error: any) => error.code === "DECLARATION_INVALID");
  // A different statement cannot silently overwrite an existing declaration.
  f.declare();
  assert.throws(() => f.declare("另一段完全不同的说明文字，试图覆盖原有记录。"), (error: any) => error.code === "DECLARATION_CONFLICT");
});
