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
import { WorkspaceWorkers } from "../src/workspace-workers.js";
import type { RecoveryInput } from "../src/operation-recovery.js";

type History = "registered" | "tombstoned" | "unreadable";

function fixture(t: TestContext, history: History = "registered") {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t4c-observation-")));
  const nativeDir = path.join(dir, "native"); fs.mkdirSync(nativeDir);
  if (history !== "unreadable") {
    const database = new DatabaseSync(path.join(nativeDir, "workbuddy.db"));
    database.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
    database.prepare("INSERT INTO sessions VALUES ('original',?,1,NULL)").run(dir);
    database.prepare("INSERT INTO sessions VALUES ('reserved-session',?,1,?)").run(dir, history === "tombstoned" ? 1_760_000_000 : null);
    database.close();
  }
  const config = { backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"),
    workbuddyConfigDir: nativeDir, serviceConfigFile: path.join(dir, "persistent-service.json"),
    taskTimeoutSeconds: 60, maxTaskAttempts: 3, claimTimeoutSeconds: 30 } as Config;
  const store = new TaskStore(config.dbFile), other = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config), coordinator = new TaskCoordinator(config, store, client);
  const service = new TaskApplicationService(coordinator, 3, config.runsDir!);
  const sql = new DatabaseSync(config.dbFile);
  t.after(() => { sql.close(); other.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  function input(action: RecoveryInput["action"], id = `recovery-${action}`, target = "send") {
    const view = service.readOperationRecovery(target);
    return { operationId: id, targetOperationId: target, action, reason: "Independent synthetic operator inspected the original receipt",
      expectedRevision: view.revision, expectedAttemptId: view.attemptId, expectedOperationToken: view.operationToken, expectedEvidenceToken: view.evidenceToken } satisfies RecoveryInput;
  }
  function resolve(action: RecoveryInput["action"], id?: string, target?: string) { const request = input(action, id, target); return service.resolveOperationRecovery(request, service.authorizeOperationRecovery(request, "synthetic-human")); }
  /** The durable shape of "the MCP client stopped waiting mid-preparation": the
   *  reservation and its native identity are persisted, the reply never arrives. */
  async function preparation() {
    await assert.rejects(store.operations.run("send", "task", "workbuddy", { model: "user-choice" }, { operationId: "send", expectedRevision: null, expectedAttemptId: null }, { model: "user-choice" }, async op => {
      store.createOrGet({ taskId: "task", messageId: "pending", objective: "Original preparation", state: "blocked", workspace: dir, sessionId: "original" });
      const target = { taskId: "task", workspace: dir, sessionId: null, model: "user-choice", workerKey: null, title: null };
      store.operations.reservePreparation(op.operationId, target);
      store.operations.preparationBoundary(op.operationId, target, undefined, true);
      store.operations.preparationIdentity(op.operationId, "reserved-session");
      throw Error("synthetic preparation interrupted");
    }));
  }
  function registration(dbFile: string, sessionId = "reserved-session") {
    const file = path.join(dir, `registration-${path.basename(dbFile)}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessionId, workspace: dir, projectDir: dir, nodeBin: process.execPath,
      dbFile, runsDir: config.runsDir, workbuddyConfigDir: nativeDir, cliElectronPath: process.execPath, cdpPort: 18491 }));
    return file;
  }
  return { dir, nativeDir, config, store, other, sql, service, coordinator, input, resolve, preparation, registration };
}

const closedEvent = (sql: DatabaseSync, sourceRef: string) => sql.prepare("SELECT payload_json FROM task_events WHERE type='task_closed' AND source_ref=?").get(sourceRef) as { payload_json?: string } | undefined;

test("C01: an observed registered reserved session closes an abandoned preparation as never dispatched", async t => {
  const f = fixture(t); await f.preparation();
  assert.deepEqual(f.service.readOperationRecovery("send").available, [], "an unobserved preparation never authorises closure");
  const observed = await f.service.observeOperationRecovery("send");
  assert.equal(observed.preparation.observation?.state, "registered");
  assert.equal(observed.preparation.observation?.sessionId, "reserved-session");
  assert.equal(observed.preparation.reservedSessionId, "reserved-session");
  assert.deepEqual(observed.available, ["close"]);
  const decision = f.resolve("close");
  assert.equal(decision.proof, "not_dispatched");
  const task = f.store.get("task")!;
  assert.equal(task.state, "cancelled"); assert.equal(task.attemptId, undefined);
  assert.equal(f.store.operations.occupant(), null);
  assert.ok(closedEvent(f.sql, `recovery:${decision.operationId}`), "the closure keeps its own immutable recovery audit");
});

test("C02: an absent reserved session closes as preparation_failed and frees the shared slot", async t => {
  const f = fixture(t, "tombstoned"); await f.preparation();
  assert.deepEqual(f.service.readOperationRecovery("send").available, []);
  const observed = await f.service.observeOperationRecovery("send");
  assert.equal(observed.preparation.observation?.state, "absent");
  const decision = f.resolve("close");
  assert.equal(decision.proof, "preparation_failed");
  assert.ok(closedEvent(f.sql, "preparation_failed:task"), "the attempt-less closure uses the preparation marker");
  assert.equal(f.store.get("task")!.attemptId, undefined);
  assert.equal(f.store.operations.occupant(), null);
  f.store.operations.claim("task-2", "workbuddy", "send-2");
  assert.equal(f.store.operations.occupant()?.taskId, "task-2", "the next workflow can take the slot it freed");
});

test("C03: an unreadable desktop history never grants closure", async t => {
  const f = fixture(t, "unreadable"); await f.preparation();
  const observed = await f.service.observeOperationRecovery("send");
  assert.equal(observed.preparation.observation?.state, "unverifiable");
  assert.match(String(observed.preparation.observation?.reason), /not found|could not be verified/);
  assert.deepEqual(observed.available, []);
  assert.throws(() => f.resolve("close"), { code: "RECOVERY_UNPROVEN" });
  assert.equal(f.store.operations.occupant()?.taskId, "task");
});

test("C04: observing the reserved identity is read-only, idempotent and invents no attempt", async t => {
  const f = fixture(t); await f.preparation();
  const before = { native: fs.readFileSync(path.join(f.nativeDir, "workbuddy.db")).length, task: f.store.get("task"), operation: f.store.operations.get("send") };
  const first = await f.service.observeOperationRecovery("send"), second = await f.service.observeOperationRecovery("send");
  assert.equal(first.preparation.observation?.observedAt, second.preparation.observation?.observedAt, "a repeated query does not rewrite the observation");
  assert.equal(fs.readFileSync(path.join(f.nativeDir, "workbuddy.db")).length, before.native, "no native row is created or deleted");
  assert.deepEqual(f.store.get("task"), before.task);
  const after = f.store.operations.get("send")!;
  assert.equal(after.preparationCompletedAt, undefined); assert.equal(after.dispatchEnteredAt, undefined); assert.equal(after.attemptId, before.operation!.attemptId);
  assert.equal(f.store.listTaskEvents("task").events.filter(event => event.type === "task_closed").length, 0);
});

test("C05: a mismatched service registration fails before the preparation boundary", async t => {
  const f = fixture(t);
  f.config.serviceConfigFile = f.registration(path.join(f.dir, "another", "tasks.sqlite"), "original");
  await assert.rejects(f.coordinator.send({ taskId: "task", objective: "Original explicitly selected task", sessionId: "original", workspace: f.dir, model: "user-choice", operationId: "send", expectedRevision: null, expectedAttemptId: null }), { code: "BRIDGE_DATABASE_MISMATCH" });
  const operation = f.store.operations.get("send")!;
  assert.equal(operation.preparationEnteredAt, undefined, "the fixable mistake never reached the native adapter");
  assert.equal(operation.effectStartedAt, undefined);
  assert.equal(f.store.get("task")?.attemptId, undefined);
});

test("C06: a mismatched service registration refuses a rework before dispatch crosses the native boundary", async t => {
  const f = fixture(t);
  f.store.createOrGet({ taskId: "task", messageId: "pending", objective: "Rework target", state: "queued", workspace: f.dir, sessionId: "original" });
  f.store.operations.claim("task", "workbuddy", "send");
  const workers = new WorkspaceWorkers(f.config);
  workers.seed({ sessionId: "original", workspace: f.dir });
  workers.close();
  const task = f.store.get("task")!;
  f.config.serviceConfigFile = f.registration(path.join(f.dir, "another", "tasks.sqlite"));
  const dispatch = (f.coordinator as unknown as { dispatch: (task: unknown, prompt: string, input: Record<string, unknown>) => Promise<unknown> }).dispatch.bind(f.coordinator);
  await assert.rejects(dispatch(task, "Rework prompt", { sessionMode: "existing", sessionId: "original" }), { code: "BRIDGE_DATABASE_MISMATCH" });
  assert.equal(f.store.get("task")!.attemptId, undefined, "the refused rework never started an attempt");
  assert.deepEqual(fs.readdirSync(f.config.runsDir!), ["workspace-workers.sqlite"], "no run evidence was invented for the refused rework");
});

test("C07: the MCP client wait is configurable and no longer a hard-coded two minutes", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts", "workbuddy-call.mjs"), "utf8");
  assert.match(source, /WORKBUDDY_MCP_CLIENT_TIMEOUT_MS/);
  assert.match(source, /900_000/);
  assert.doesNotMatch(source, /120_000/, "the client wait is not the downstream request budget");
  assert.match(source, /observe_operation_recovery/, "a timeout points at the durable recovery path instead of a resend");
});
