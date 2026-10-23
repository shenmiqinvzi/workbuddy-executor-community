import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal, writePrivateJson, hasNativeStopEvidence } from "../src/run-journal.js";
import { PersistentDesktopService, recoverExpiredAttempt, reconcileReportedAttempt, readServiceRegistration, serviceRegistrationPath, type NativeDesktopTrigger, type NativeObservation, type ServiceRegistration, type WakeIntent } from "../src/persistent-service.js";
import { installService, launchdPlist, serviceStatus, uninstallService, type LaunchctlRunner } from "../src/service-cli.js";

class FakeTrigger implements NativeDesktopTrigger {
  state: "idle" | "busy" | "waiting_input" | "offline" = "idle";
  workspace?: string;
  accepted = true;
  found = false;
  inspections = 0;
  wakes: Array<{ sessionId: string; wakeId: string; prompt: string; model?:string }> = [];
  beforeSubmit?: () => void | Promise<void>;
  failure?: NativeObservation["failure"];
  cancelAttempt?: NativeDesktopTrigger["cancelAttempt"];
  async inspect() { this.inspections++; return { state: this.state, workspace: this.workspace, failure: this.failure, latestWakeId:this.wakes.at(-1)?.wakeId }; }
  async setModel(sessionId: string, model: string) { return { sessionId, model }; }
  async wakeIdle(sessionId: string, wakeId: string, prompt: string, model?:string) {
    this.wakes.push({ sessionId, wakeId, prompt, model });
    await this.beforeSubmit?.();
    return { accepted: this.accepted, receipt: this.accepted ? "native-receipt" : undefined };
  }
  async findWake() { return this.found; }
}

test("the supervisor keeps a reported turn busy until native idle and preserves the successful report", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const text = "TASK_STATUS: completed\nTEST_RESULT: actual fixture report";
  f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  const initialEvents = journal.events(0, Infinity).filter(event => event.type === "result").length;
  f.trigger.state = "busy";
  assert.equal((await f.service().pump()).status, "active_lease");
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped, false);
  f.trigger.state = "offline";
  assert.equal((await f.service().pump()).status, "unavailable");
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped, false);
  f.trigger.state = "waiting_input";
  assert.equal((await f.service().pump()).status, "waiting_input");
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped, false);
  f.trigger.state = "idle";
  assert.equal((await f.service().pump()).status, "stop_confirmed");
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped, true);
  assert.equal((await f.coordinator.sync(claim.taskId)).state, "needs_review");
  assert.equal(journal.snapshot()?.text, text);
  assert.equal(journal.events(0, Infinity).filter(event => event.type === "result").length, initialEvents);
  assert.equal(f.trigger.wakes.length, 1);
});

test("a claimed turn's native 500 becomes blocked promptly, without resending or fabricating a result", async t => {
  const f = fixture(t); const journal = await f.send();
  await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const artifact = path.join(f.dir, "preserved.css"); fs.writeFileSync(artifact, "actual worker output");
  f.trigger.failure = { wakeId: f.trigger.wakes[0]!.wakeId, error: "500 internal server error", observedAt: new Date().toISOString() };
  assert.equal((await f.service().pump()).status, "stop_unconfirmed");
  const task = await f.coordinator.sync(claim.taskId);
  assert.equal(task.state, "blocked");
  assert.match(task.blockingReason!, /500/);
  assert.equal(journal.snapshot()?.stopReason, undefined);
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped, false);
  assert.equal(fs.readFileSync(artifact, "utf8"), "actual worker output");
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "late result", artifacts: [] }), /no longer active/);
  await f.service().pump();
  assert.equal(f.trigger.wakes.length, 1);
  assert.equal(journal.events(0, Infinity).some(event => event.metadata?.status === "needs_review"), false);
});

test("a native 429 exposes timing but cannot prove stop without a native stop adapter", async t => {
  const f = fixture(t); const journal = await f.send();
  await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const observedAt = new Date().toISOString();
  f.trigger.failure = { wakeId: f.trigger.wakes[0]!.wakeId, error: "429 too many requests; Retry-After: 60", observedAt, phase: "session:sendMessage" };
  assert.equal((await f.service().pump()).status, "stop_unconfirmed");
  const task = await f.coordinator.sync(claim.taskId);
  assert.equal(task.state, "blocked");
  assert.match(task.blockingReason!, /rate limited \(HTTP 429\)/);
  assert.deepEqual(f.coordinator.executionStatus(claim.taskId).nativeRateLimit,
    { kind: "rate_limited", statusCode: 429, phase: "session:sendMessage", retryAfterSeconds: 60, observedAt });
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped, false);
  assert.equal(f.coordinator.executionStatus(claim.taskId).state, "stop_unconfirmed");
  assert.equal(journal.snapshot()?.reportDigest, undefined);
  await f.service().pump();
  assert.equal(f.trigger.wakes.length, 1);
  assert.equal(journal.events(0, Infinity).filter(event => event.type === "result").length, 1);
});

test("a later native 429 preserves the authenticated report and still waits for native idle", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  f.trigger.cancelAttempt = async () => {};
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw Error("Expected claim");
  const text = "Actual completed worker report";
  f.queue.report({...claim,status:"completed",text,artifacts:[]});
  const reportedAt = journal.events(0,Infinity).find(event=>event.metadata?.status === "needs_review")!.createdAt;
  f.trigger.failure = {wakeId:f.trigger.wakes[0]!.wakeId,error:"429 too many requests",observedAt:new Date(Date.parse(reportedAt)+1).toISOString()};
  f.trigger.state = "busy";
  await f.service().pump();
  assert.equal(journal.snapshot()?.status,"needs_review");
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,false);
  await assert.rejects(()=>f.coordinator.accept(claim.taskId,"review",["fixture evidence"]),/not been confirmed stopped/);
  f.trigger.state = "idle";
  await f.service().pump();
  const task = await f.coordinator.sync(claim.taskId);
  assert.equal(task.state,"needs_review");
  assert.equal(task.report?.rawText,text);
  assert.equal(task.blockingReason,undefined);
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,true);
  assert.equal(f.coordinator.executionStatus(claim.taskId).postReportFailure?.reportReceivedAt,reportedAt);
  assert.equal(f.trigger.wakes.length,1);
  assert.equal(journal.events(0,Infinity).filter(event=>event.type === "result").length,1);
});

test("an error preceding the authenticated report remains blocked", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  f.queue.report({...claim,status:"completed",text:"report after the error",artifacts:[]});
  const wake = JSON.parse(fs.readFileSync(path.join(journal.dir,"wake.json"),"utf8"));
  f.trigger.failure = {wakeId:f.trigger.wakes[0]!.wakeId,error:"429",observedAt:wake.createdAt};
  await f.service().pump();
  assert.equal(journal.snapshot()?.status,"blocked");
  assert.equal(journal.snapshot()?.postReportFailure,undefined);
});

test("a native failure cannot confirm stop while the original session remains busy", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  f.trigger.state = "busy";
  f.trigger.failure = { wakeId: f.trigger.wakes[0]!.wakeId, error: "500", observedAt: new Date().toISOString() };
  assert.equal((await f.service().pump()).status, "stop_unconfirmed");
  assert.equal(journal.snapshot()?.stopReason, undefined);
  await assert.rejects(() => f.coordinator.continue({ taskId: claim.taskId, feedback: "overlapping retry" }), /not been confirmed stopped/);
  f.trigger.state = "idle";
  f.trigger.cancelAttempt = async () => {};
  await f.service().pump();
  assert.equal(journal.snapshot()?.stopReason, "native_failure_verified");
  assert.equal(f.trigger.wakes.length, 1);
});

test("unrelated failures never block a claimed attempt; native permission wait is visible and recoverable", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  f.trigger.failure = { wakeId: "wake-run-00000000-0000-0000-0000-000000000000", error: "old error", observedAt: new Date().toISOString() };
  f.trigger.state = "waiting_input";
  assert.equal((await f.service().pump()).status, "waiting_input");
  assert.equal((await f.coordinator.sync(claim.taskId)).state, "blocked");
  assert.equal(journal.snapshot()?.status, "working");
  const eventCount = journal.events(0, Infinity).length;
  await f.service().pump();
  assert.equal(journal.events(0, Infinity).length, eventCount);
  await assert.rejects(() => f.coordinator.continue({ taskId: claim.taskId, feedback: "retry" }), /waiting for input/);
  f.trigger.state = "busy";
  assert.equal((await f.service().pump()).status, "active_lease");
  assert.equal((await f.coordinator.sync(claim.taskId)).state, "working");
  assert.equal(journal.snapshot()?.error, undefined);
  assert.equal(f.trigger.wakes.length, 1);
});

test("429 followed by a transient idle never releases the attempt, even if the native error disappears after reconnect", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  const failure = {wakeId:f.trigger.wakes[0]!.wakeId,error:"429 too many requests",observedAt:new Date().toISOString()};
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir,failure});
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,false);
  assert.equal(hasNativeStopEvidence({...journal.snapshot()!,stopReason:"native_failure_verified",nativeStoppedAt:new Date().toISOString(),nativeStopSource:"native_idle"}),false);
  // Simulate a renderer/service reconnect losing its in-memory error map.
  f.trigger.failure = undefined;
  assert.equal((await f.service().pump()).status,"stop_unconfirmed");
  assert.equal(journal.snapshot()?.nativeFailure?.wakeId,failure.wakeId);
  f.trigger.state = "busy";
  assert.equal((await f.service().pump()).status,"stop_unconfirmed");
  f.trigger.state = "idle";
  assert.equal((await f.service().pump()).status,"stop_unconfirmed");
  await assert.rejects(()=>f.coordinator.continue({taskId:claim.taskId,feedback:"overlap"}),/not been confirmed stopped/);
  const second = await f.send("must-not-overlap");
  assert.match(second.snapshot()?.error ?? "",/unresolved/);
  assert.equal(f.trigger.wakes.length,1);
});

test("failed turn stop requires one exact cancellation acknowledgement and stable idle observations", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  let cancellations = 0;
  f.trigger.failure = {wakeId:f.trigger.wakes[0]!.wakeId,error:"429",observedAt:new Date().toISOString()};
  f.trigger.cancelAttempt = async (sid,wake,workspace) => {
    cancellations++;
    assert.equal(sid,claim.sessionId); assert.equal(wake,f.trigger.wakes[0]!.wakeId); assert.equal(workspace,f.dir);
    assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,false,"idle before native acknowledgement is not proof");
    assert.ok(journal.snapshot()?.stopControl?.issuedAt,"issue marker must precede the native request");
    assert.equal(journal.snapshot()?.stopControl?.acknowledgedAt,undefined);
  };
  assert.equal((await f.service().pump()).status,"native_blocked");
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,true);
  const snapshot = journal.snapshot()!;
  assert.ok(snapshot.stopControl?.acknowledgedAt);
  assert.ok(snapshot.nativeStopCheck!.observations >= 2);
  assert.ok(Date.parse(snapshot.nativeStopCheck!.checkedAt)-Date.parse(snapshot.nativeStopCheck!.since) >= 1000);
  assert.equal(snapshot.nativeFailure?.error,"429");
  for (const change of [
    {stopControl:{...snapshot.stopControl!,acknowledgedAt:"invalid"}},
    {nativeStopCheck:{...snapshot.nativeStopCheck!,observations:1}},
    {nativeStopCheck:{...snapshot.nativeStopCheck!,since:snapshot.nativeStopCheck!.checkedAt}},
  ]) assert.equal(hasNativeStopEvidence({...snapshot,...change}),false);
  await f.service().pump();
  assert.equal(cancellations,1); assert.equal(f.trigger.wakes.length,1);
  assert.equal((await f.coordinator.sync(claim.taskId)).state,"blocked","confirmed stop does not manufacture success");
});

test("lost cancellation acknowledgement stays unconfirmed after restart and is never replayed", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  f.trigger.failure = {wakeId:f.trigger.wakes[0]!.wakeId,error:"429",observedAt:new Date().toISOString()};
  let cancellations = 0;
  f.trigger.cancelAttempt = async () => {cancellations++; throw Error("connection lost after native cancellation");};
  assert.equal((await f.service().pump()).status,"stop_unconfirmed");
  assert.equal(journal.snapshot()?.stopControl?.acknowledgedAt,undefined);
  // A fresh service object must use the durable issue marker, not issue again.
  assert.equal((await f.service().pump()).status,"stop_unconfirmed");
  assert.equal(cancellations,1); assert.equal(f.trigger.wakes.length,1);
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,false);
});

test("activity or busy state between post-cancel idle observations resets the failed turn stop check", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  const failure = {wakeId:f.trigger.wakes[0]!.wakeId,error:"429",observedAt:new Date().toISOString()};
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir,failure});
  const acknowledgedAt = new Date().toISOString();
  f.queue.updateStopControl(claim.attemptId,{state:"requested",requestedAt:acknowledgedAt,issuedAt:acknowledgedAt,acknowledgedAt});
  const old = new Date(Date.now()-2000).toISOString();
  journal.save({...journal.snapshot()!,nativeStopCheck:{since:old,checkedAt:old,observations:1,activityAt:10}});
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir,activityAt:11,latestWakeId:failure.wakeId});
  assert.equal(journal.snapshot()?.nativeStopCheck?.observations,1,"new backend activity restarts the check");
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,false);
  f.queue.observeNative(claim.attemptId,{state:"busy",workspace:f.dir,activityAt:11});
  assert.equal(journal.snapshot()?.nativeStopCheck,undefined);
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir,activityAt:11,latestWakeId:failure.wakeId});
  assert.equal(journal.snapshot()?.nativeStopCheck?.observations,1);
  f.queue.recordNativeHealth(claim.attemptId,{state:"offline"});
  assert.equal(journal.snapshot()?.nativeStopCheck,undefined,"disconnection breaks continuous idle proof");
});

test("one-time expired recovery cannot bypass an unconfirmed failed turn", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir,failure:{wakeId:f.trigger.wakes[0]!.wakeId,error:"429",observedAt:new Date().toISOString()}});
  await f.coordinator.sync(claim.taskId);
  journal.save({...journal.snapshot()!,deadline:new Date(Date.now()-1).toISOString()});
  await assert.rejects(()=>recoverExpiredAttempt(f.config,f.registration,f.trigger,{taskId:claim.taskId,attemptId:claim.attemptId,reason:"idle is not enough"}),/cannot bypass/);
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,false);
  assert.equal(f.trigger.wakes.length,1);
});

test("post-cancel inspection detects a new native turn instead of reusing the pre-cancel idle", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  f.trigger.failure = {wakeId:f.trigger.wakes[0]!.wakeId,error:"429",observedAt:new Date().toISOString()};
  let cancellations = 0;
  f.trigger.cancelAttempt = async () => {
    cancellations++;
    f.trigger.inspect = async () => ({state:"idle",workspace:f.dir,latestWakeId:null});
  };
  assert.equal((await f.service().pump()).status,"stop_unconfirmed");
  assert.match(journal.snapshot()?.stopControl?.error ?? "",/turn changed or is unknown/);
  assert.equal(f.coordinator.executionStatus(claim.taskId).remoteStopped,false);
  assert.equal(cancellations,1); assert.equal(f.trigger.wakes.length,1);
});

test("idle without a worker report blocks after a propagation window and never implies success", async t => {
  const f = fixture(t); const journal = await f.send(); await f.queue.claim(f.registration.sessionId, 0);
  assert.equal((await f.service().pump()).status, "active_lease");
  assert.equal(journal.snapshot()?.status, "working");
  journal.save({ ...journal.snapshot()!, nativeIdleSince: new Date(Date.now() - 11_000).toISOString() });
  assert.equal((await f.service().pump()).status, "native_blocked");
  assert.equal(journal.snapshot()?.stopReason, "native_idle_without_report");
  assert.equal((await f.coordinator.sync("transport-fixture")).state, "blocked");
  assert.equal(f.trigger.wakes.length, 0);
});

test("claimed deadlines expose stop_unconfirmed without a stop adapter; only native idle confirms it", async t => {
  const f = fixture(t); const journal = await f.send();
  await f.queue.claim(f.registration.sessionId, 0);
  f.trigger.state = "busy";
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1).toISOString() });
  assert.equal((await f.service().pump()).status, "stop_unconfirmed");
  assert.equal(journal.cancellationRequested(), true);
  assert.equal(journal.snapshot()?.stopReason, undefined);
  assert.equal((await f.coordinator.cancel("transport-fixture")).remoteStopped, false);
  f.trigger.state = "idle";
  assert.equal((await f.service().pump()).status, "stop_confirmed");
  assert.equal((await f.coordinator.cancel("transport-fixture")).remoteStopped, true);
});

test("definitely rejected native wakes have a finite retry budget", async t => {
  const f = fixture(t); const journal = await f.send(); f.trigger.accepted = false;
  assert.equal((await f.service().pump()).status, "wake_rejected");
  assert.equal((await f.service().pump()).status, "wake_rejected");
  assert.equal((await f.service().pump()).status, "wake_rejected");
  assert.equal(f.trigger.wakes.length, 2);
  assert.equal(journal.snapshot()?.stopReason, "wake_retry_limit");
  assert.equal((await f.coordinator.sync("transport-fixture")).state, "blocked");
});

test("offline claimed attempts still expire without another wake or native restart", async t => {
  const f = fixture(t); const journal = await f.send();
  await f.queue.claim(f.registration.sessionId, 0);
  f.trigger.state = "offline";
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1).toISOString() });
  assert.equal((await f.service().pump()).status, "stop_unconfirmed");
  assert.equal(journal.snapshot()?.status, "blocked");
  assert.equal(journal.snapshot()?.stopReason, undefined);
  assert.equal(f.trigger.wakes.length, 0);
});

test("native 500 before claim is exposed without waiting for the task deadline", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  f.trigger.failure = { wakeId: f.trigger.wakes[0]!.wakeId, error: "500 before claim", observedAt: new Date().toISOString() };
  assert.equal((await f.service().pump()).status, "stop_unconfirmed");
  assert.equal((await f.coordinator.sync("transport-fixture")).state, "blocked");
  assert.equal(journal.snapshot()?.stopReason, undefined);
  assert.equal((await f.queue.claim(f.registration.sessionId, 0)).status, "retry");
  assert.equal(f.trigger.wakes.length, 1);
});

test("cancelling a delivered but unclaimed wake does not falsely confirm the desktop stopped", async t => {
  const f = fixture(t); const journal = await f.send(); await f.service().pump();
  f.trigger.state = "busy";
  assert.equal((await f.coordinator.cancel("transport-fixture")).remoteStopped, false);
  assert.equal(journal.cancellationRequested(), true);
  assert.equal(journal.snapshot()?.stopReason, undefined);
  assert.equal((await f.service().pump()).status, "stop_unconfirmed");
  assert.equal((await f.queue.claim(f.registration.sessionId, 0)).status, "retry");
  f.trigger.state = "idle";
  assert.equal((await f.service().pump()).status, "stop_confirmed");
  assert.equal(f.coordinator.executionStatus("transport-fixture").remoteStopped, true);
  assert.equal(f.trigger.wakes.length, 1);
});

test('explicit model tasks wait for verified native wake; later models cannot be claimed in the old turn',async t=>{
  const f=fixture(t);
  await f.coordinator.send({taskId:'model-one',objective:'fixture',workspace:f.dir,sessionId:'worker-session',model:'fast'});
  assert.equal((await f.queue.claim('worker-session',0)).status,'retry');
  assert.equal((await f.service().pump()).status,'wake_submitted');assert.equal(f.trigger.wakes[0]?.model,'fast');
  const first=await f.queue.claim('worker-session',0);assert.equal(first.status,'task');if(first.status!=='task')throw Error('missing claim');
  f.queue.report({...first,status:'completed',text:'fixture completed',artifacts:[]});
  f.queue.observeNative(first.attemptId, { state: "idle", workspace: f.dir });
  await f.coordinator.send({taskId:'model-two',objective:'fixture',workspace:f.dir,sessionId:'worker-session',model:'deep'});
  assert.equal((await f.queue.claim('worker-session',0)).status,'retry');
  assert.equal((await f.service().pump()).status,'wake_submitted');assert.equal(f.trigger.wakes[1]?.model,'deep');
  assert.equal((await f.queue.claim('worker-session',0)).status,'task');
});

test('crash after model wake receipt reconciles claim permission without a second native prompt',async t=>{
  const f=fixture(t);
  await f.coordinator.send({taskId:'model-recovery',objective:'fixture',workspace:f.dir,sessionId:'worker-session',model:'fast'});
  await f.service().pump();const journal=new RunJournal(f.config.runsDir!,f.store.get('model-recovery')!.attemptId!);
  fs.rmSync(path.join(journal.dir,'model-ready.json'));
  assert.equal((await f.queue.claim('worker-session',0)).status,'retry');
  assert.equal((await f.service().pump()).status,'wake_pending');assert.equal(f.trigger.wakes.length,1);
  assert.equal((await f.queue.claim('worker-session',0)).status,'task');
});

test('native model rejection blocks the task before any claim and permits a corrected round',async t=>{
  const f=fixture(t);
  await f.coordinator.send({taskId:'invalid-model',objective:'fixture',workspace:f.dir,sessionId:'worker-session',model:'bad'});
  f.trigger.wakeIdle=async()=>({accepted:false,error:'Model unavailable'});
  assert.equal((await f.service().pump()).status,'wake_rejected');
  assert.equal((await f.coordinator.sync('invalid-model')).state,'blocked');
  assert.equal((await f.queue.claim('worker-session',0)).status,'retry');
  assert.equal((await f.coordinator.continue({taskId:'invalid-model',feedback:'use available model',model:'fast'})).ok,true);
});

function fixture(t: { after: (fn: () => void) => void }, sessionId = "worker-session") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-persistent-unit-"));
  const config: Config = { ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "data", "tasks.sqlite"), runsDir: path.join(dir, "data", "runs"), workbuddyConfigDir: dir };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run(sessionId, dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  // Unit tests must not resolve through a real WorkBuddy desktop process.
  const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config),
    async (_config, input) => ({ workspace: input.workspace, sessionId: input.sessionId ?? sessionId }));
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const registration: ServiceRegistration = { version: 1, sessionId, workspace: dir, projectDir: dir, nodeBin: process.execPath, cdpPort: 9333, dbFile: config.dbFile, runsDir: config.runsDir!, workbuddyConfigDir: dir, cliElectronPath: config.cliElectronPath, intervalMs: 500 };
  const trigger = new FakeTrigger();
  trigger.workspace = dir;
  const service = () => new PersistentDesktopService(config, registration, trigger, store);
  const send = async (taskId = "transport-fixture") => {
    await coordinator.send({ taskId, objective: "Unit transport fixture only", sessionId: registration.sessionId, workspace: dir, timeoutSeconds: 600 });
    return new RunJournal(config.runsDir!, store.get(taskId)!.attemptId!);
  };
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, coordinator, queue, registration, trigger, service, send };
}

async function overwrittenReport(t: {after(fn:()=>void):void}) {
  const f = fixture(t,"11111111-1111-4111-8111-111111111111");
  const journal = await f.send(); await f.service().pump();
  const claim = await f.queue.claim(f.registration.sessionId,0);
  if (claim.status !== "task") throw Error("Expected claim");
  const text = "Authenticated report that predates the later native 429";
  f.queue.report({...claim,status:"completed",text,artifacts:[]});
  const reportEvent = journal.events(0,Infinity).find(event=>event.metadata?.status === "needs_review")!;
  const wake = JSON.parse(fs.readFileSync(path.join(journal.dir,"wake.json"),"utf8"));
  const failure = {wakeId:wake.wakeId,error:"429 too many requests",observedAt:new Date(Date.parse(reportEvent.createdAt)+1).toISOString()};
  f.trigger.failure = failure;
  journal.save({...journal.snapshot()!,status:"blocked",error:failure.error,stopReason:"native_failure_verified",nativeStoppedAt:new Date().toISOString(),nativeStopSource:"native_idle"});
  journal.append("result","TASK_STATUS: blocked\n429 too many requests",{status:"blocked",blockedReason:failure.error,sessionId:claim.sessionId,runtimeSource:"desktop_queue"});
  await f.coordinator.sync(claim.taskId);
  const project = path.join(f.dir,"projects","fixture"); fs.mkdirSync(project,{recursive:true});
  const historyFile = path.join(project,`${claim.sessionId}.jsonl`);
  fs.writeFileSync(historyFile,JSON.stringify({type:"message",sessionId:claim.sessionId,role:"user",content:[{text:`[CODEX_QUEUE_WAKE ${wake.wakeId}]`} ]})+"\n");
  return {...f,journal,claim,historyFile,text,input:{taskId:claim.taskId,attemptId:claim.attemptId,reason:"Reconcile the existing authenticated report after the observed later native error"}};
}

test("bounded reconciliation restores the original report for review without dispatching or accepting", async t => {
  const f = await overwrittenReport(t);
  assert.equal(f.store.get(f.claim.taskId)?.state,"blocked");
  const result = await reconcileReportedAttempt(f.config,f.registration,f.trigger,f.input);
  assert.equal(result.taskCompleted,false);
  const task = await f.coordinator.sync(f.claim.taskId);
  assert.equal(task.state,"needs_review"); assert.equal(task.report?.rawText,f.text);
  assert.equal(task.attemptId,f.claim.attemptId); assert.equal(task.attempt,1);
  assert.equal(f.coordinator.executionStatus(task.taskId).remoteStopped,true);
  await assert.rejects(()=>f.coordinator.accept(task.taskId,"review",[]),/concrete evidence/);
  assert.equal(f.trigger.wakes.length,1);
  assert.equal(f.journal.events(0,Infinity).filter(event=>event.type === "result").length,2,"both original report and failure remain in history");
  const count = f.journal.events(0,Infinity).length;
  assert.equal((await reconcileReportedAttempt(f.config,f.registration,f.trigger,f.input)).alreadyReconciled,true);
  assert.equal(f.journal.events(0,Infinity).length,count);
});

test("report reconciliation refuses invalid report, cancellation, wrong ownership and unresolved commands", async t => {
  const changes: Array<(f:Awaited<ReturnType<typeof overwrittenReport>>)=>void> = [
    f=>f.journal.save({...f.journal.snapshot()!,text:"tampered report"}),
    f=>f.journal.save({...f.journal.snapshot()!,reportDigest:undefined}),
    f=>f.journal.cancel("operator"),
    f=>{f.trigger.state="busy";},
    f=>{f.trigger.state="offline";},
    f=>{f.trigger.workspace=path.join(f.dir,"another-workspace");},
    f=>{f.trigger.failure!.observedAt=f.journal.events(0,Infinity).find(e=>e.metadata?.status === "needs_review")!.createdAt;},
    f=>fs.appendFileSync(f.historyFile,JSON.stringify({type:"message",sessionId:f.claim.sessionId,role:"user",content:[{text:"another native turn"}]})+"\n"),
    f=>{const dir=path.join(f.journal.dir,"commands");fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,"22222222-2222-4222-8222-222222222222.json"),JSON.stringify({endedAt:new Date().toISOString(),cleanupConfirmed:false}));},
    f=>f.journal.save({...f.journal.snapshot()!,deadline:"2000-01-01T00:00:00.000Z"}),
    f=>f.journal.save({...f.journal.snapshot()!,stopReason:"end_turn",nativeStoppedAt:undefined,nativeStopSource:undefined}),
    f=>f.journal.save({...f.journal.snapshot()!,nativeFailure:f.trigger.failure}),
  ];
  for (const change of changes) {
    const f = await overwrittenReport(t); change(f);
    await assert.rejects(()=>reconcileReportedAttempt(f.config,f.registration,f.trigger,f.input));
    assert.equal(f.journal.snapshot()?.status,"blocked");
    assert.equal(f.trigger.wakes.length,1);
  }
});

test("reconciliation repairs a crash between snapshot preservation and its audit event", async t => {
  const f = await overwrittenReport(t);
  await reconcileReportedAttempt(f.config,f.registration,f.trigger,f.input);
  const file = path.join(f.journal.dir,"events.jsonl");
  const original = f.journal.events(0,Infinity).filter(event=>event.metadata?.reportPreserved !== true);
  fs.writeFileSync(file,original.map(event=>JSON.stringify(event)).join("\n")+"\n");
  assert.equal(f.store.get(f.claim.taskId)?.state,"blocked");
  await reconcileReportedAttempt(f.config,f.registration,f.trigger,f.input);
  assert.equal((await f.coordinator.sync(f.claim.taskId)).state,"needs_review");
  assert.equal(f.journal.events(0,Infinity).filter(event=>event.metadata?.reportPreserved === true).length,1);
  assert.equal(f.trigger.wakes.length,1);
});

test("coordinator refuses report reconciliation through another installation's database", async t => {
  const f = await overwrittenReport(t);
  f.config.serviceConfigFile = serviceRegistrationPath(f.dir);
  writePrivateJson(f.config.serviceConfigFile,{...f.registration,dbFile:path.join(f.dir,"another-installation.sqlite")});
  await assert.rejects(()=>f.coordinator.reconcileReport(f.input),/another task database/);
  assert.equal(f.journal.snapshot()?.status,"blocked");
  assert.equal(f.trigger.wakes.length,1);
});

test('the native helper can claim immediately during wake, before a submission receipt returns', async t => {
  const f = fixture(t);
  await f.coordinator.send({ taskId: 'immediate-claim', objective: 'race fixture', workspace: f.dir, sessionId: f.registration.sessionId, model: 'deepseek-v4.1-flash' });
  let claimed = false;
  f.trigger.beforeSubmit = async () => {
    const result = await f.queue.claim(f.registration.sessionId, 0);
    assert.equal(result.status, 'task', 'native execution must not see an empty queue after verified model configuration');
    claimed = result.status === 'task';
  };
  assert.equal((await f.service().pump()).status, 'wake_submitted');
  assert.equal(claimed, true);
  assert.equal((await f.coordinator.sync('immediate-claim')).state, 'working');
});

test('a failed native model preparation never authorizes or sends the queued task', async t => {
  const f = fixture(t);
  await f.coordinator.send({ taskId: 'prepare-failure', objective: 'fixture', workspace: f.dir, sessionId: f.registration.sessionId, model: 'deepseek-v4.1-flash' });
  f.trigger.setModel = async () => { throw Error('Free model unavailable'); };
  assert.equal((await f.service().pump()).status, 'wake_rejected');
  assert.equal(f.trigger.wakes.length, 0);
  assert.equal((await f.coordinator.sync('prepare-failure')).state, 'blocked');
  const task = f.store.get('prepare-failure')!;
  const journal = new RunJournal(f.config.runsDir!, task.attemptId!);
  assert.equal(fs.existsSync(path.join(journal.dir, 'model-ready.json')), false);
  assert.equal(f.coordinator.executionStatus('prepare-failure').remoteStopped, true);
});

async function expiredClaim(f: ReturnType<typeof fixture>) {
  const journal = await f.send();
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected native fixture claim");
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await f.coordinator.sync(claim.taskId)).state, "blocked");
  return { journal, claim, input: { taskId: claim.taskId, attemptId: claim.attemptId, reason: "Inspected native aborted network turn and existing partial output" } };
}

test("explicit idle recovery preserves failure and artifacts; only a new same-task native attempt can report", async (t) => {
  const f = fixture(t);
  const { journal, claim, input } = await expiredClaim(f);
  const artifact = path.join(f.dir, "partial.json");
  fs.writeFileSync(artifact, '{"clips":[1,2]}');
  const failure = journal.snapshot()!.error;
  await assert.rejects(() => f.coordinator.continue({ taskId: claim.taskId, feedback: "Resume" }), /not been confirmed stopped/);
  const result = await recoverExpiredAttempt(f.config, f.registration, f.trigger, input);
  assert.equal(result.taskCompleted, false);
  assert.equal(journal.snapshot()!.status, "blocked");
  assert.equal(journal.snapshot()!.stopReason, "native_idle_verified");
  assert.equal(journal.snapshot()!.error, failure);
  assert.equal(fs.readFileSync(artifact, "utf8"), '{"clips":[1,2]}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(journal.dir, "recovery.json"), "utf8")).taskCompleted, false);
  assert.equal((await recoverExpiredAttempt(f.config, f.registration, f.trigger, input)).alreadyRecovered, true);
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "Late result", artifacts: [artifact] }), /no longer active/);
  await f.coordinator.continue({ taskId: claim.taskId, feedback: "Validate existing partial.json and report through this new lease" });
  const resumed = await f.queue.claim(f.registration.sessionId, 0);
  if (resumed.status !== "task") throw new Error("Expected resumed native claim");
  assert.notEqual(resumed.attemptId, claim.attemptId);
  assert.equal(resumed.taskId, claim.taskId);
  assert.equal(resumed.sessionId, claim.sessionId);
  f.queue.report({ ...resumed, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: revalidated existing partial", artifacts: [artifact] });
  assert.equal((await f.coordinator.sync(claim.taskId)).state, "needs_review");
});

async function expiredUnclaimed(f: ReturnType<typeof fixture>) {
  const journal = await f.send();
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  const task = await f.coordinator.sync(journal.snapshot()!.taskId);
  assert.equal(task.state, "blocked");
  return { journal, input: { taskId: task.taskId, attemptId: journal.attemptId, reason: "Service was absent; original session is idle and no native wake or claim exists" } };
}

test("unclaimed expired recovery preserves failure without inventing a claim or result", async t => {
  const f = fixture(t);
  const { journal, input } = await expiredUnclaimed(f);
  const previousError = journal.snapshot()!.error;
  const previousResults = journal.events(0, Infinity).filter(event => event.type === "result");
  assert.equal(f.coordinator.executionStatus(input.taskId).remoteStopped, false);
  assert.equal((await recoverExpiredAttempt(f.config, f.registration, f.trigger, input)).taskCompleted, false);
  assert.equal(f.coordinator.executionStatus(input.taskId).remoteStopped, true);
  assert.equal(journal.snapshot()!.status, "blocked");
  assert.equal(journal.snapshot()!.error, previousError);
  assert.equal(journal.snapshot()!.runtimeSource, undefined);
  assert.equal(fs.existsSync(path.join(journal.dir, "claim.json")), false);
  assert.equal(fs.existsSync(path.join(journal.dir, "wake.json")), false);
  assert.equal(f.trigger.wakes.length, 0);
  assert.deepEqual(journal.events(0, Infinity).filter(event => event.type === "result"), previousResults);
  assert.equal((await recoverExpiredAttempt(f.config, f.registration, f.trigger, input)).alreadyRecovered, true);
});

test("unclaimed expired recovery refuses every existing wake, even rejected delivery", async t => {
  const f = fixture(t);
  const { journal, input } = await expiredUnclaimed(f);
  for (const state of ["submitting", "submitted", "uncertain", "rejected"]) {
    writePrivateJson(path.join(journal.dir, "wake.json"), { version: 1, state, sessionId: input.taskId, attemptId: input.attemptId });
    await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /Unclaimed recovery requires no native delivery or execution evidence/);
    assert.equal(f.coordinator.executionStatus(input.taskId).remoteStopped, false);
  }
});

test("unclaimed expired recovery refuses execution, report or native failure evidence", async t => {
  const f = fixture(t);
  const { journal, input } = await expiredUnclaimed(f);
  const original = journal.snapshot()!;
  for (const extra of [
    { runtimeSource: "desktop_queue" },
    { reportDigest: "existing-report-digest" },
    { nativeFailure: { wakeId: "wake-existing", error: "500 provider error", observedAt: new Date().toISOString() } },
    { stopControl: { state: "requested" as const, requestedAt: new Date().toISOString(), issuedAt: new Date().toISOString() } },
  ]) {
    journal.save({ ...original, ...extra });
    await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /Unclaimed recovery requires no native delivery or execution evidence/);
    assert.equal(f.coordinator.executionStatus(input.taskId).remoteStopped, false);
  }
});

test("unclaimed recovery refuses mismatched persisted task and attempt identities", async t => {
  const f = fixture(t);
  const { journal, input } = await expiredUnclaimed(f);
  const original = journal.snapshot()!;
  const request = journal.request();
  for (const [record, field, value] of [
    ["state", "attemptId", RunJournal.newId()],
    ["request", "attemptId", RunJournal.newId()],
    ["request", "taskId", "different-task"],
  ] as const) {
    journal.save(original);
    writePrivateJson(path.join(journal.dir, "request.json"), request);
    if (record === "state") journal.save({ ...original, [field]: value });
    else writePrivateJson(path.join(journal.dir, "request.json"), { ...request, [field]: value });
    await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /identity|original|attempt/i);
    assert.equal(f.coordinator.executionStatus(input.taskId).remoteStopped, false);
    assert.equal(fs.existsSync(path.join(journal.dir, "recovery.json")), false);
  }
});

test("unclaimed recovery requires a valid elapsed deadline", async t => {
  const f = fixture(t);
  const { journal, input } = await expiredUnclaimed(f);
  journal.save({ ...journal.snapshot()!, deadline: "invalid-deadline" });
  await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /expired|deadline/i);
  assert.equal(f.coordinator.executionStatus(input.taskId).remoteStopped, false);
  assert.equal(fs.existsSync(path.join(journal.dir, "recovery.json")), false);
});

test("recovery refuses busy, waiting-input, offline or changed native workspace", async (t) => {
  const f = fixture(t);
  const { journal, input } = await expiredClaim(f);
  for (const state of ["busy", "waiting_input", "offline"] as const) {
    f.trigger.state = state;
    await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /verified idle/);
  }
  f.trigger.state = "idle";
  f.trigger.workspace = path.join(f.dir, "another-project");
  await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /verified idle/);
  assert.equal(journal.snapshot()!.stopReason, undefined);
});

test("recovery refuses current working or unexpired attempts and stale attempt identities", async (t) => {
  const f = fixture(t);
  const { journal, input } = await expiredClaim(f);
  await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, { ...input, attemptId: RunJournal.newId() }));
  journal.save({ ...journal.snapshot()!, status: "working" });
  await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /blocked/);
  journal.save({ ...journal.snapshot()!, status: "blocked", deadline: new Date(Date.now() + 60_000).toISOString() });
  await assert.rejects(() => recoverExpiredAttempt(f.config, f.registration, f.trigger, input), /expired/);
  assert.equal(journal.snapshot()!.stopReason, undefined);
});

test("native inspection holds the pump lock so recovery cannot overlap an automatic wake", async (t) => {
  const f = fixture(t);
  const { input } = await expiredClaim(f);
  await f.send("queued-next");
  let release!: () => void;
  let entered!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  f.trigger.inspect = async () => { entered(); await released; return { state: "idle", workspace: f.dir }; };
  const recovery = recoverExpiredAttempt(f.config, f.registration, f.trigger, input);
  await inspecting;
  assert.equal((await f.service().pump()).status, "session_busy");
  assert.equal(f.trigger.wakes.length, 0);
  release();
  assert.equal((await recovery).taskCompleted, false);
});

test("wake intent is durable before native submission, and daemon restart never submits accepted wake twice", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  f.trigger.beforeSubmit = () => {
    const intent = JSON.parse(fs.readFileSync(path.join(journal.dir, "wake.json"), "utf8")) as WakeIntent;
    assert.equal(intent.state, "submitting");
    assert.equal(intent.attemptId, journal.attemptId);
    assert.equal(journal.snapshot()?.runtimeSource, undefined);
    assert.equal(journal.snapshot()?.status, "queued");
  };
  assert.equal((await f.service().pump()).status, "wake_submitted");
  assert.equal((await f.service().pump()).status, "wake_pending");
  assert.equal(f.trigger.wakes.length, 1);
  assert.match(f.trigger.wakes[0]!.prompt, /CODEX_QUEUE_WAKE/);
  assert.match(f.trigger.wakes[0]!.prompt, /claim --session-id/);
  assert.match(f.trigger.wakes[0]!.prompt, /成功回报后也结束/);
  assert.doesNotMatch(f.trigger.wakes[0]!.prompt, /连续重试 4 次/);
  assert.equal(f.trigger.wakes[0]!.sessionId, "worker-session");
  assert.equal(f.store.get("transport-fixture")?.runtimeSource, undefined);
  assert.equal(journal.events(0, Infinity).filter((event) => event.type === "result").length, 0);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(journal.dir, "wake.json")).mode & 0o777, 0o600);
});

test("installed binding supplies the worker identity without a new listener or explicit session", async (t) => {
  const f = fixture(t);
  f.config.serviceConfigFile = serviceRegistrationPath(f.dir);
  writePrivateJson(f.config.serviceConfigFile, f.registration);
  const result = await f.coordinator.send({ taskId: "bound-default", objective: "Unit binding fixture" });
  assert.equal(result.ok, true);
  const stored = f.store.get("bound-default")!;
  assert.equal(stored.sessionId, f.registration.sessionId);
  assert.equal(stored.workspace, f.dir);
  assert.equal(f.queue.listeners().length, 0);
});

test("two concurrent service instances reserve one native wake for the session", async (t) => {
  const f = fixture(t);
  await f.send("first");
  const rejected=await f.send("second");
  assert.match(rejected.snapshot()?.error ?? "", /unresolved/);
  let entered!: () => void;
  let release!: () => void;
  const submitting = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  f.trigger.beforeSubmit = async () => { entered(); await released; };
  const first = f.service().pump();
  await submitting;
  assert.equal((await f.service().pump()).status, "session_busy");
  release();
  assert.equal((await first).status, "wake_submitted");
  assert.equal(f.trigger.wakes.length, 1);
});

test("ambiguous submission is reconciled by native history and never blindly replayed", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  f.trigger.beforeSubmit = () => { throw new Error("Connection lost after submit"); };
  assert.equal((await f.service().pump()).status, "wake_uncertain");
  assert.equal((await f.service().pump()).status, "wake_uncertain");
  assert.equal(f.trigger.wakes.length, 1);
  f.trigger.found = true;
  assert.equal((await f.service().pump()).status, "wake_pending");
  assert.equal(f.trigger.wakes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(journal.dir, "wake.json"), "utf8")).state, "submitted");
  f.trigger.found = false;
  assert.equal((await f.service().pump()).status, "wake_pending");
  assert.equal(f.trigger.wakes.length, 1);
});

test("a persisted pre-submit intent is uncertain after restart, while a definite rejection may retry", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  const now = new Date().toISOString();
  const intent: WakeIntent = { version: 1, sessionId: f.registration.sessionId, attemptId: journal.attemptId, wakeId: `wake-${journal.attemptId}`, state: "submitting", submissions: 0, createdAt: now, updatedAt: now };
  writePrivateJson(path.join(journal.dir, "wake.json"), intent);
  assert.equal((await f.service().pump()).status, "wake_uncertain");
  assert.equal(f.trigger.wakes.length, 0);
  writePrivateJson(path.join(journal.dir, "wake.json"), { ...intent, state: "rejected" });
  f.trigger.accepted = false;
  assert.equal((await f.service().pump()).status, "wake_rejected");
  f.trigger.accepted = true;
  assert.equal((await f.service().pump()).status, "wake_submitted");
  assert.equal(f.trigger.wakes.length, 2);
  assert.equal(f.trigger.wakes[0]!.wakeId, f.trigger.wakes[1]!.wakeId);
});

test("idle checks reject busy, waiting-input, offline and changed workspaces without a wake", async (t) => {
  const f = fixture(t);
  await f.send();
  for (const state of ["busy", "waiting_input", "offline"] as const) {
    f.trigger.state = state;
    assert.equal((await f.service().pump()).status, state === "offline" ? "unavailable" : "session_busy");
  }
  f.trigger.state = "idle";
  f.trigger.workspace = path.join(f.dir, "other-workspace");
  assert.equal((await f.service().pump()).status, "binding_mismatch");
  assert.equal(f.trigger.wakes.length, 0);
});

test("unresolved execution leases suppress wake, including claimed timeouts", async (t) => {
  const f = fixture(t);
  const journal = await f.send("first");
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  assert.equal(claim.status, "task");
  const rejected=await f.send("second");
  assert.match(rejected.snapshot()?.error ?? "", /unresolved/);
  assert.equal((await f.service().pump()).status, "active_lease");
  journal.save({ ...journal.snapshot()!, status: "blocked", error: "deadline passed" });
  assert.equal((await f.service().pump()).status, "native_blocked");
  assert.equal(f.trigger.wakes.length, 0);
  await f.coordinator.sync("first");
  await assert.rejects(() => f.coordinator.continue({ taskId: "first", feedback: "Do not overlap an unresolved execution" }), /stopped|lease|unfinished/);
  assert.equal((await f.queue.claim(f.registration.sessionId, 0)).status,"retry");

  // A genuine native report releases the queue lease. The helper itself remains
  // a listener during the next claim, so the daemon still need not send a prompt.
  journal.save({ ...journal.snapshot()!, status: "working" });
  if (claim.status !== "task") throw new Error("Expected unit claim");
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: transport fixture", artifacts: [] });
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  await f.coordinator.continue({taskId:"second",feedback:"first is now proven stopped"});
  const waiting = f.queue.claim(f.registration.sessionId, 0.1);
  // Second task is claimed immediately; it is now protected by its active lease.
  await waiting;
  assert.equal((await f.service().pump()).status, "active_lease");
  assert.equal(f.trigger.wakes.length, 0);
});

test("a live native claim listener consumes newly queued work without an extra desktop prompt", async (t) => {
  const f = fixture(t);
  const waiting = f.queue.claim(f.registration.sessionId, 0.5);
  await f.send();
  assert.equal((await f.service().pump()).status, "listener_ready");
  assert.equal(f.trigger.inspections, 0);
  assert.equal(f.trigger.wakes.length, 0);
  const claim = await waiting;
  assert.equal(claim.status, "task");
});

test("expired unclaimed tasks and deleted native sessions are never woken", async (t) => {
  const f = fixture(t);
  const journal = await f.send();
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await f.service().pump()).status, "deadline_passed");
  assert.equal(journal.snapshot()?.status, "blocked");
  assert.equal(f.trigger.inspections, 0);
  journal.save({ ...journal.snapshot()!, status: "queued", deadline: new Date(Date.now() + 60_000).toISOString() });
  const native = new DatabaseSync(path.join(f.dir, "workbuddy.db"));
  native.exec("UPDATE sessions SET deleted_at=1");
  native.close();
  assert.equal((await f.service().pump()).status, "unavailable");
  assert.equal(f.trigger.wakes.length, 0);
});

test("same-chat rework gets one new wake and preserves original task identity and constraints", async (t) => {
  const f = fixture(t);
  await f.coordinator.send({ taskId: "rework", objective: "Unit fixture", constraints: ["Preserve original constraint"], sessionId: f.registration.sessionId, workspace: f.dir });
  assert.equal((await f.service().pump()).status, "wake_submitted");
  const claim = await f.queue.claim(f.registration.sessionId, 0);
  if (claim.status !== "task") throw new Error("Expected unit claim");
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: first fixture", artifacts: [] });
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  await f.coordinator.sync("rework");
  await f.coordinator.continue({ taskId: "rework", feedback: "Correct fixture item" });
  assert.equal((await f.service().pump()).status, "wake_submitted");
  assert.equal(f.trigger.wakes.length, 2);
  assert.notEqual(f.trigger.wakes[0]!.wakeId, f.trigger.wakes[1]!.wakeId);
  assert.equal(f.trigger.wakes[0]!.sessionId, f.trigger.wakes[1]!.sessionId);
  const request = new RunJournal(f.config.runsDir!, f.store.get("rework")!.attemptId!).request();
  assert.match(request.prompt, /Preserve original constraint/);
  assert.match(request.prompt, /Correct fixture item/);
  assert.equal(f.store.get("rework")?.runtimeSource, undefined);
});

test("service finds queued work beyond its first 500 stored tasks", async (t) => {
  const f = fixture(t);
  const target = await f.send("oldest-task");
  f.store.update("oldest-task", { state: "queued" });
  // Make 500 newer unclaimable records; pagination must reach the durable queue attempt.
  for (let index = 0; index < 500; index++) f.store.createOrGet({ taskId: `new-${index}`, messageId: `pending-${index}`, objective: "Record only", state: "queued", createdAt: "2099-01-01T00:00:00.000Z" });
  const result = await f.service().pump();
  assert.equal(result.status, "wake_submitted");
  assert.equal(result.attemptId, target.attemptId);
});

function fakeLaunchctl(initial?: string) {
  let value = initial;
  let loaded = false;
  const calls: string[][] = [];
  const run: LaunchctlRunner = (args) => {
    calls.push(args);
    if (args[0] === "getenv") return { status: value === undefined ? 1 : 0, stdout: value === undefined ? "" : `${value}\n` };
    if (args[0] === "setenv") { value = args[2]; return { status: 0, stdout: "" }; }
    if (args[0] === "unsetenv") { value = undefined; return { status: 0, stdout: "" }; }
    if (args[0] === "bootstrap") { loaded = true; return { status: 0, stdout: "" }; }
    if (args[0] === "bootout") { const status = loaded ? 0 : 1; loaded = false; return { status, stdout: "" }; }
    if (args[0] === "print") return { status: loaded ? 0 : 1, stdout: loaded ? "state = running" : "" };
    throw new Error(`Unexpected unit launchctl command: ${args[0]}`);
  };
  return { run, calls, value: () => value };
}

test("launchd installer preserves the original environment through reinstall and uninstall", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "dist"));
  fs.writeFileSync(path.join(f.dir, "dist", "service-cli.js"), "// Unit installer fixture; never executed\n");
  const fake = fakeLaunchctl("original-value");
  const options = { config: f.config, sessionId: f.registration.sessionId, workspace: f.dir, projectDir: f.dir, cdpPort: 9333, platform: "darwin" as const, homeDir: f.dir, uid: 501 };
  const installed = installService(options, fake.run);
  installService(options, fake.run);
  const registration = readServiceRegistration(installed.configFile)!;
  assert.deepEqual(registration.launchctlEnvPrevious, { present: true, value: "original-value" });
  assert.equal(fake.value(), "9333");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(installed.configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(registration.plistPath!).mode & 0o777, 0o600);
  }
  const plist = fs.readFileSync(registration.plistPath!, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /WORKBUDDY_REMOTE_DEBUGGING_PORT/);
  assert.equal(serviceStatus(installed.configFile, fake.run, 501).launchdLoaded, true);
  const removed = uninstallService(installed.configFile, fake.run, 501);
  assert.equal(removed.environmentRestored, true);
  assert.equal(fake.value(), "original-value");
  assert.equal(fs.existsSync(registration.plistPath!), false);
  assert.equal(fs.existsSync(f.config.dbFile), true);
  assert.equal(fs.existsSync(serviceRegistrationPath(f.dir)), false);
});

test("uninstall restores an originally absent environment without overriding a later external change", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, "dist"));
  fs.writeFileSync(path.join(f.dir, "dist", "service-cli.js"), "// Unit fixture\n");
  const options = { config: f.config, sessionId: f.registration.sessionId, workspace: f.dir, projectDir: f.dir, cdpPort: 9333, platform: "darwin" as const, homeDir: f.dir, uid: 501 };
  const absent = fakeLaunchctl();
  const installed = installService(options, absent.run);
  assert.equal(uninstallService(installed.configFile, absent.run, 501).environmentRestored, true);
  assert.equal(absent.value(), undefined);
  installService(options, absent.run);
  absent.run(["setenv", "WORKBUDDY_REMOTE_DEBUGGING_PORT", "later-external-value"]);
  assert.equal(uninstallService(installed.configFile, absent.run, 501).environmentRestored, false);
  assert.equal(absent.value(), "later-external-value");
});

test("launchd plist quotes path characters as XML and carries no shell command or credentials", () => {
  const registration: ServiceRegistration = { version: 1, sessionId: "test", workspace: "/tmp/a & b", projectDir: "/tmp/a & b", nodeBin: "/tmp/node with spaces", cdpPort: 9333, dbFile: "/tmp/task.sqlite", runsDir: "/tmp/runs", workbuddyConfigDir: "/tmp/workbuddy", cliElectronPath: "/Applications/WorkBuddy.app/Contents/MacOS/Electron", launchdLabel: "com.codex.fixture" };
  const plist = launchdPlist(registration, "/tmp/a & b/data/persistent-service.json");
  assert.match(plist, /a &amp; b/);
  assert.match(plist, /<string>\/tmp\/node with spaces<\/string>/);
  assert.doesNotMatch(plist, /CLIENT_SECRET|ACCESS_TOKEN|fullAccess|\/bin\/sh/);
});
