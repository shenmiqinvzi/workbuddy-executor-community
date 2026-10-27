import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathToFileURL } from "node:url";
import type { Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal, writePrivateJson } from "../src/run-journal.js";
import type { RecoveryInput } from "../src/operation-recovery.js";
import { runRecoveryConsole } from "../src/recovery-console.js";

function fixture(t: TestContext) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t4b-recovery-")));
  const config = { backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"),
    workbuddyConfigDir: dir, serviceConfigFile: path.join(dir, "none.json"), taskTimeoutSeconds: 60, maxTaskAttempts: 3, claimTimeoutSeconds: 30 } as Config;
  const native = new DatabaseSync(path.join(dir, "workbuddy.db")); native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES ('original',?,1,NULL)").run(dir); native.close();
  const store = new TaskStore(config.dbFile), other = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config), coordinator = new TaskCoordinator(config, store, client);
  const service = new TaskApplicationService(coordinator, 3, config.runsDir!);
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const sql = new DatabaseSync(config.dbFile);
  t.after(() => { sql.close(); other.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  function input(action: RecoveryInput["action"], id = `recovery-${action}`, target = "send") {
    const view = service.readOperationRecovery(target);
    return { operationId: id, targetOperationId: target, action, reason: "Independent synthetic operator inspected the original receipt",
      expectedRevision: view.revision, expectedAttemptId: view.attemptId, expectedOperationToken: view.operationToken, expectedEvidenceToken: view.evidenceToken } satisfies RecoveryInput;
  }
  function resolve(action: RecoveryInput["action"], id?: string, target?: string) { const request = input(action, id, target); return service.resolveOperationRecovery(request, service.authorizeOperationRecovery(request, "synthetic-human")); }
  async function crashedSend() {
    sql.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON task_operations WHEN NEW.operation_id='send' AND NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic receipt crash'); END");
    try { await assert.rejects(coordinator.send({ taskId: "task", objective: "Original explicitly selected task", sessionId: "original", workspace: dir, model: "user-choice", operationId: "send", expectedRevision: null, expectedAttemptId: null })); }
    finally { sql.exec("DROP TRIGGER fail_receipt"); }
    assert.equal(store.operations.get("send")!.state, "outcome_unknown");
    const task = store.get("task")!; assert.ok(task.attemptId);
    return task;
  }
  async function stopped() {
    const task = await crashedSend(); resolve("reconcile");
    writePrivateJson(path.join(config.runsDir!, task.attemptId!, "model-ready.json"), { attemptId: task.attemptId, sessionId: "original", model: "user-choice" });
    const claim = await queue.claim("original", 0); assert.equal(claim.status, "task"); if (claim.status !== "task") throw Error("No claim");
    queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nOriginal synthetic report", artifacts: [] });
    queue.observeNative(task.attemptId!, { state: "idle", workspace: dir }); await coordinator.sync("task");
    return store.get("task")!;
  }
  async function preparation(complete: boolean) {
    await assert.rejects(store.operations.run("send", "task", "workbuddy", { model: "user-choice" }, { operationId: "send", expectedRevision: null, expectedAttemptId: null }, { model: "user-choice" }, async op => {
      store.createOrGet({ taskId: "task", messageId: "pending", objective: "Original preparation", state: "blocked", workspace: dir, sessionId: "original" });
      store.operations.nativeBoundary("task"); if (complete) store.operations.preparationReturned(op.operationId);
      throw Error("synthetic preparation interrupted");
    }));
  }
  return { dir, config, store, other, sql, service, coordinator, queue, input, resolve, crashedSend, stopped, preparation };
}

test("R01: inspection reads original receipts without mutating task, operation or files", async t => {
  const f = fixture(t), task = await f.crashedSend();
  const before = { task: f.store.get("task"), operation: f.store.operations.get("send"), events: f.store.listTaskEvents("task"), request: fs.readFileSync(path.join(f.config.runsDir!, task.attemptId!, "request.json"), "utf8") };
  assert.deepEqual(f.service.readOperationRecovery("send").available, ["reconcile"]);
  assert.deepEqual(f.store.get("task"), before.task); assert.deepEqual(f.store.operations.get("send"), before.operation);
  assert.deepEqual(f.store.listTaskEvents("task"), before.events); assert.equal(fs.readFileSync(path.join(f.config.runsDir!, task.attemptId!, "request.json"), "utf8"), before.request);
  assert.deepEqual(f.store.recoveries.history("task"), []);
});
test("R02: reconcile restores the original queue receipt without resending or releasing capacity", async t => {
  const f = fixture(t), task = await f.crashedSend(), original = f.store.operations.get("send");
  const request = f.input("reconcile"), auth = f.service.authorizeOperationRecovery(request, "synthetic-human"), decision = f.service.resolveOperationRecovery(request, auth);
  assert.equal(decision.proof, "queue_receipt"); assert.equal(f.store.operations.occupant()!.taskId, "task");
  assert.deepEqual(f.store.operations.get("send"), original); assert.equal(f.store.get("task")!.attemptId, task.attemptId);
  assert.deepEqual(f.service.resolveOperationRecovery(request, "already-used-is-replay"), decision);
  assert.throws(() => f.service.resolveOperationRecovery({ ...request, reason: "Changed" }, auth), { code: "OPERATION_CONFLICT" });
  assert.throws(() => f.store.operations.assertExecution("task", task.attemptId!, { sessionId: "other", model: "user-choice", workspace: f.dir }), { code: "MODEL_BINDING_CHANGED" });
  f.store.operations.assertExecution("task", task.attemptId!, { sessionId: "original", model: "user-choice", workspace: f.dir });
  await assert.rejects(f.coordinator.send({ taskId: "task", objective: "Original explicitly selected task", sessionId: "original", workspace: f.dir, model: "user-choice", operationId: "send", expectedRevision: null, expectedAttemptId: null }), { code: "OPERATION_RESOLVED", recoveryOperationId: request.operationId });
});
test("R03: partial or changed queue evidence never authorizes reconciliation", async t => {
  const f = fixture(t), task = await f.crashedSend(), file = path.join(f.config.runsDir!, task.attemptId!, "request.json"), saved = fs.readFileSync(file, "utf8");
  for (const content of ["{", JSON.stringify({ ...JSON.parse(saved), prompt: "Forged replacement" }), JSON.stringify({ ...JSON.parse(saved), sessionId: "other" })]) {
    fs.writeFileSync(file, content); assert.deepEqual(f.service.readOperationRecovery("send").available, []);
    assert.throws(() => f.resolve("reconcile"), { code: "RECOVERY_UNPROVEN" });
  }
  assert.equal(f.store.operations.occupant()!.taskId, "task"); assert.deepEqual(f.store.recoveries.history("task"), []);
});
test("R04: wake/idle, missing files and caller assertions cannot authorize closing an uncertain attempt", async t => {
  const f = fixture(t), task = await f.crashedSend();
  assert.throws(() => f.resolve("close"), { code: "RECOVERY_UNPROVEN" });
  const request = { ...f.input("close"), approved: true, stopped: true };
  assert.throws(() => f.service.resolveOperationRecovery(request, "client-approved"), { code: "AUTHORIZATION_REQUIRED" });
  fs.rmSync(path.join(f.config.runsDir!, task.attemptId!, "state.json"));
  assert.deepEqual(f.service.readOperationRecovery("send").available, []); assert.equal(f.store.operations.occupant()!.taskId, "task");
});
test("R05: closing requires the original stop identity and never accepts the report", async t => {
  const f = fixture(t), task = await f.stopped(), original = f.store.operations.get("send");
  const decision = f.resolve("close"); assert.equal(decision.proof, "native_stopped"); assert.equal(f.store.get("task")!.state, "cancelled");
  assert.equal(f.store.operations.occupant(), null); assert.equal(f.store.operations.isClosed(f.store.get("task")!), true);
  assert.deepEqual(f.store.operations.get("send"), original); assert.equal(f.store.get("task")!.attemptId, task.attemptId);
  assert.equal(f.store.listTaskEvents("task").events.filter(e => e.type === "task_closed").length, 1);
  assert.throws(() => f.store.update("task", { state: "working" }), { code: "WORKFLOW_CLOSED" });
  assert.throws(() => f.store.beginAttempt("task", { attemptId: RunJournal.newId(), messageId: "new" }), { code: "WORKFLOW_CLOSED" });
  const next = await f.coordinator.send({ taskId: "next", objective: "Next explicitly selected workflow", sessionId: "original", workspace: f.dir, model: "user-choice" }); assert.equal(next.ok, true);
});
test("R06: confirmed preparation without dispatch can close without inventing an attempt or native stop", async t => {
  const f = fixture(t); await f.preparation(true);
  const decision = f.resolve("close"); assert.equal(decision.proof, "not_dispatched");
  assert.equal(f.store.get("task")!.attemptId, undefined); assert.equal(f.store.get("task")!.state, "cancelled"); assert.equal(f.store.operations.occupant(), null);
  assert.equal(fs.existsSync(f.config.runsDir!), false); assert.equal(f.store.get("task")!.runEvidenceDigest, undefined);
});
test("R07: incomplete and historical preparation fields never prove no dispatch", async t => {
  const f = fixture(t); await f.preparation(false); assert.deepEqual(f.service.readOperationRecovery("send").available, []);
  const record = f.store.operations.get("send")!; delete record.phaseVersion; delete record.effectStartedAt;
  f.sql.prepare("UPDATE task_operations SET body_json=? WHERE operation_id='send'").run(JSON.stringify(record));
  assert.throws(() => f.resolve("close"), { code: "RECOVERY_UNPROVEN" }); assert.equal(f.store.operations.occupant()!.taskId, "task");
});
test("R08: a suspended original call cannot revive a workflow closed before preparation", async t => {
  const f = fixture(t); let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const pending = f.store.operations.run("send", "task", "workbuddy", {}, { operationId: "send", expectedRevision: null, expectedAttemptId: null }, {}, async () => {
    await barrier; f.store.createOrGet({ taskId: "task", messageId: "pending", objective: "Must stay fenced", state: "queued" }); return { ok: true };
  });
  const rejected = assert.rejects(pending, { code: "OPERATION_RESOLVED" });
  f.resolve("close"); release(); await rejected;
  assert.equal(f.store.get("task"), undefined); assert.equal(f.store.operations.occupant(), null);
  assert.throws(() => f.store.operations.claim("task", "workbuddy", "other"), { code: "WORKFLOW_CLOSED" });
});
test("R09: a suspended call after a complete preparation cannot start another attempt", async t => {
  const f = fixture(t); let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
  const pending = f.store.operations.run("send", "task", "workbuddy", {}, { operationId: "send", expectedRevision: null, expectedAttemptId: null }, {}, async op => {
    f.store.createOrGet({ taskId: "task", messageId: "pending", objective: "Prepared original", state: "blocked" });
    f.store.operations.nativeBoundary("task"); f.store.operations.preparationReturned(op.operationId); await barrier;
    f.store.beginAttempt("task", { attemptId: RunJournal.newId(), messageId: "must-not-send" }); return { ok: true };
  });
  const rejected = assert.rejects(pending, { code: "OPERATION_RESOLVED" }); f.resolve("close"); release(); await rejected;
  assert.equal(f.store.get("task")!.state, "cancelled"); assert.equal(f.store.get("task")!.attemptId, undefined); assert.equal(f.store.operations.occupant(), null);
});
test("R10: audit failure rolls back task closure, event, authorization use and capacity release", async t => {
  const f = fixture(t); await f.preparation(true); const input = f.input("close"), before = f.store.get("task"), auth = f.service.authorizeOperationRecovery(input, "synthetic-human");
  f.sql.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON operation_recoveries BEGIN SELECT RAISE(ABORT,'synthetic audit crash'); END");
  assert.throws(() => f.service.resolveOperationRecovery(input, auth), /synthetic audit crash/);
  assert.deepEqual(f.store.get("task"), before); assert.equal(f.store.operations.occupant()!.taskId, "task"); assert.equal(f.store.recoveries.history("task").length, 0);
  assert.equal(f.store.listTaskEvents("task").events.filter(e => e.type === "task_closed").length, 0);
  f.sql.exec("DROP TRIGGER fail_audit"); assert.equal(f.service.resolveOperationRecovery(input, auth).action, "close");
});
test("R11: authorization binds exact tokens and rejects revision, attempt and evidence changes", async t => {
  const f = fixture(t); await f.crashedSend(); const input = f.input("reconcile"), auth = f.service.authorizeOperationRecovery(input, "synthetic-human");
  assert.throws(() => f.service.resolveOperationRecovery({ ...input, expectedAttemptId: "stale" }, auth), { code: "AUTHORIZATION_REQUIRED" });
  f.store.update("task", { blockingReason: "New original evidence" });
  assert.throws(() => f.service.resolveOperationRecovery(input, auth), { code: "STALE_REVISION" });
  const fresh = f.input("reconcile"), another = f.service.authorizeOperationRecovery(fresh, "synthetic-human");
  const task = f.store.get("task")!, journal = new RunJournal(f.config.runsDir!, task.attemptId!); journal.save({ ...journal.snapshot()!, error: "Evidence advanced" });
  assert.throws(() => f.service.resolveOperationRecovery(fresh, another), { code: "EVIDENCE_STALE" }); assert.equal(f.store.recoveries.history("task").length, 0);
});
test("R12: two real processes race on one immutable recovery decision", async t => {
  const f = fixture(t); await f.preparation(true);
  const jobs = ["left", "right"].map(id => { const input = f.input("close", id); return { input, auth: f.service.authorizeOperationRecovery(input, "synthetic-human") }; });
  const storeUrl = pathToFileURL(path.resolve("src/task-store.ts")).href;
  const code = `import {TaskStore} from ${JSON.stringify(storeUrl)};const [file,runs,payload]=process.argv.slice(1);const s=new TaskStore(file);try{const p=JSON.parse(payload);s.recoveries.resolve(p.input,runs,p.auth);console.log('resolved');}catch(e){console.log(e.code);process.exitCode=2;}finally{s.close();}`;
  const results = await Promise.all(jobs.map(job => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(path.resolve("test/support/typescript-loader.mjs")).href, "--input-type=module", "-e", code, f.store.file, f.config.runsDir!, JSON.stringify(job)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; }); child.once("error", reject); child.once("exit", () => { resolve(output.trim() || errors.trim()); });
  })));
  assert.equal(results.filter(value => value === "resolved").length, 1, JSON.stringify(results)); assert.equal(results.filter(value => ["STALE_REVISION", "EVIDENCE_STALE", "RECOVERY_UNPROVEN"].includes(value)).length, 1, JSON.stringify(results));
  assert.equal(f.store.recoveries.history("task").length, 1); assert.equal(f.store.operations.occupant(), null);
});
test("R13: console requires a real interactive exact confirmation and rechecks after it", async t => {
  const f = fixture(t); await f.preparation(true); const args = ["close", "send", "--operation-id", "console", "--reason", "Verified original preparation"];
  await assert.rejects(runRecoveryConsole(f.service, args, { interactive: false, write() {}, async question() { throw Error("must not ask"); } }), { code: "AUTHORIZATION_REQUIRED" });
  await assert.rejects(runRecoveryConsole(f.service, args, { interactive: true, write() {}, async question() { return "yes"; } }), { code: "AUTHORIZATION_REQUIRED" });
  assert.equal(f.store.recoveries.history("task").length, 0);
  await assert.rejects(runRecoveryConsole(f.service, args, { interactive: true, write() {}, async question() { f.store.update("task", { blockingReason: "Changed while human read" }); return "close send console"; } }), { code: "STALE_REVISION" });
  await runRecoveryConsole(f.service, args, { interactive: true, write() {}, async question() { return "close send console"; } });
  assert.equal(f.store.recoveries.get("console")!.actor, "local-interactive-user"); assert.equal(f.store.operations.occupant(), null);
  const replay = await runRecoveryConsole(f.service, args, { interactive: false, write() {}, async question() { throw Error("read-only replay must not reconfirm"); } });
  assert.equal((replay as { operationId: string }).operationId, "console");
});

test("R14: a reserved rework never proves its historical active attempt was not dispatched", async t => {
  const f = fixture(t), attemptId = RunJournal.newId();
  f.store.createOrGet({ taskId: "task", messageId: attemptId, attemptId, attempt: 1, objective: "Historical active task", state: "working", sessionId: "original" });
  new RunJournal(f.config.runsDir!, attemptId).save({ taskId: "task", attemptId, sessionId: "original", driver: "desktop-queue", status: "working", updatedAt: new Date().toISOString() });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }), barrier = new Promise<void>(r => { release = r; });
  const client = new WorkBuddyClient(f.config); client.messages = async () => { entered(); await barrier; return []; };
  const coordinator = new TaskCoordinator(f.config, f.store, client), original = f.store.get("task")!;
  const pending = coordinator.continue({ taskId: "task", feedback: "Old view", operationId: "send", expectedRevision: original.revision, expectedAttemptId: attemptId });
  const rejected = assert.rejects(pending); await started;
  try { assert.deepEqual(f.service.readOperationRecovery("send").available, []); assert.throws(() => f.resolve("close"), { code: "RECOVERY_UNPROVEN" }); }
  finally { release(); await rejected; }
  assert.equal(f.store.operations.occupant()!.taskId, "task"); assert.equal(f.store.get("task")!.attemptId, attemptId);
});

test("R15: closure binds freshly received stop evidence without requiring a prior sync and stays readable", async t => {
  const f = fixture(t), task = await f.crashedSend(); f.resolve("reconcile");
  writePrivateJson(path.join(f.config.runsDir!, task.attemptId!, "model-ready.json"), { attemptId: task.attemptId, sessionId: "original", model: "user-choice" });
  const claim = await f.queue.claim("original", 0); if (claim.status !== "task") throw Error("No claim");
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nUnsynced original report", artifacts: [] });
  f.queue.observeNative(task.attemptId!, { state: "idle", workspace: f.dir });
  f.resolve("close"); const closed = f.store.get("task")!;
  assert.equal(JSON.parse(closed.runEvidenceDigest!).stopped, true);
  assert.deepEqual(await f.coordinator.sync("task"), closed);
  assert.equal(f.service.readStageView("task").ok, true);
});

test("R16: a stopped snapshot cannot close a queue whose original request was substituted", async t => {
  const f = fixture(t), task = await f.stopped(), file = path.join(f.config.runsDir!, task.attemptId!, "request.json");
  const request = JSON.parse(fs.readFileSync(file, "utf8")); writePrivateJson(file, { ...request, model: "replacement" });
  assert.throws(() => f.resolve("close"), { code: "RECOVERY_UNPROVEN" }); assert.equal(f.store.operations.occupant()!.taskId, "task");
  writePrivateJson(file, request); writePrivateJson(path.join(f.config.runsDir!, task.attemptId!, "cancel.json"), true);
  assert.throws(() => f.resolve("close"), { code: "RECOVERY_UNPROVEN" }); assert.equal(f.store.operations.occupant()!.taskId, "task");
});

test("R17: an unused authorization still expires without releasing the original workflow", async t => {
  const f = fixture(t); await f.preparation(true); const request = f.input("close"), authorization = f.service.authorizeOperationRecovery(request, "synthetic-human");
  f.sql.prepare("UPDATE recovery_authorizations SET confirmed_at=? WHERE authorization_id=?").run(new Date(Date.now() - 360000).toISOString(), authorization);
  assert.throws(() => f.service.resolveOperationRecovery(request, authorization), { code: "AUTHORIZATION_REQUIRED" });
  assert.equal(f.store.recoveries.history("task").length, 0); assert.equal(f.store.operations.occupant()!.taskId, "task");
});

test("R18: committed MCP entry offers recovery reads and explicit observation, with no human decision tool", async t => {
  const f = fixture(t); await f.preparation(true);
  const client = new Client({ name: "synthetic-recovery-reader", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/server.js")], cwd: process.cwd(), stderr: "pipe",
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      WORKBUDDY_BACKEND: "desktop-queue", WORKBUDDY_DB_FILE: f.store.file, WORKBUDDY_RUNS_DIR: f.config.runsDir!, WORKBUDDY_DSH_ENABLED: "0",
      WORKBUDDY_CONFIG_DIR: f.dir, WORKBUDDY_SERVICE_CONFIG: path.join(f.dir, "none.json"), WORKBUDDY_CLI_ELECTRON: process.execPath } });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name).filter(name => name.includes("operation_recovery"));
    assert.deepEqual(tools.sort(), ["workbuddy_get_operation_recovery", "workbuddy_observe_operation_recovery"].sort());
    const before = { task: f.store.get("task"), operation: f.store.operations.get("send"), events: f.store.listTaskEvents("task") };
    for (const name of tools) {
      const result = await client.callTool({ name, arguments: { operationId: "send" } });
      const block = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")!;
      const parsed = JSON.parse(block.text!); assert.equal(parsed.ok, true); assert.deepEqual(parsed.recovery.available, ["close"]);
    }
    assert.deepEqual(f.store.get("task"), before.task); assert.deepEqual(f.store.operations.get("send"), before.operation);
    assert.deepEqual(f.store.listTaskEvents("task"), before.events); assert.equal(f.store.recoveries.history("task").length, 0);
  } finally { await client.close(); }
});
