/** Regression tests for persisted evidence, real HTTP and concurrent readers. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import { TaskStore, type StoredTask } from "../src/task-store.js";
import { TaskCoordinator, runEvidenceDigestOf } from "../src/coordinator.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal } from "../src/run-journal.js";
import { WorkbenchHttpServer, workbenchHealth } from "../src/workbench-http.js";
import type { StageTaskView } from "../src/task-view-stage.js";

const temporaryDirs: string[] = [];
after(() => { for (const dir of temporaryDirs) fs.rmSync(dir, {recursive:true, force:true, maxRetries:3, retryDelay:50}); });

function fixture(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evidence-${name}-`));
  temporaryDirs.push(dir);
  const config: Config = {
    backend: "desktop-queue", apiBaseUrl: "http://127.0.0.1:9", tokenFile: path.join(dir,"credentials.json"),
    dbFile: path.join(dir,"tasks.sqlite"), runsDir: path.join(dir,"runs"),
    oauthRedirectUri: "http://127.0.0.1:0", oauthPort: 0, oauthScopes: "test", requestTimeoutMs: 1000,
    cliElectronPath: path.join(dir,"missing.exe"), cliScriptPath: path.join(dir,"missing-cli"),
    cliPermissionMode: "deny", acpPermissionMode: "deny", gatewayUrl: "http://127.0.0.1:0",
    workbuddyConfigDir: dir, taskTimeoutSeconds: 600, claimTimeoutSeconds: 60, maxTaskAttempts: 3,
    serviceConfigFile: path.join(dir,"service.json"),
  };
  const native = new DatabaseSync(path.join(dir,"workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("fixture-session",dir); native.close();
  const store=new TaskStore(config.dbFile),client=new WorkBuddyClient(config);
  const coordinator=new TaskCoordinator(config,store,client),service=new TaskApplicationService(coordinator,3,config.runsDir!);
  const queue=new DesktopQueue(config,()=>({desktopPid:process.pid})),taskId="fixture-task";
  return {dir,config,store,coordinator,service,queue,taskId,
    send:()=>coordinator.send({taskId,objective:"Synthetic consistency fixture",workspace:dir,sessionId:"fixture-session",timeoutSeconds:600}),
    events:()=>store.listTaskEvents(taskId,{limit:200}).events,
    view:()=>{const r=service.readStageView(taskId);if(!r.ok)throw Error(r.code);return r.view;},
  };
}
async function reported(f: ReturnType<typeof fixture>){
  await f.send();const c=await f.queue.claim('fixture-session',0);assert.equal(c.status,'task');
  await f.coordinator.sync(f.taskId);
  f.queue.report({...c,status:'completed',text:'TASK_STATUS: completed\nPositive acceptance fixture',artifacts:[]});
  await f.coordinator.sync(f.taskId);return c;
}
const get=(port: number,p: string)=>new Promise<{status: number; body: any}>((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port,path:p},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode ?? 0,body:JSON.parse(body)}));});r.on('error',reject);});
// Valid outcomes: a named conflict, the unchanged facts of the old revision,
// or a complete snapshot genuinely bound to the current persisted revision.
// In particular, snapshotOnly=true does not waive these requirements.
function requireConsistent(result: ReturnType<TaskApplicationService["readStageView"]>,before: StageTaskView,current: StoredTask){
  if(!result.ok){assert.ok(['evidence_stale','read_conflict'].includes(result.code),`Expected explicit evidence conflict; got ${result.code}`);return;}
  const v=result.view;
  if(v.revision===before.revision){
    assert.deepEqual(
      {displayState:v.displayState,remoteStopped:v.remoteStopped,nativeStoppedAt:v.timing.nativeStoppedAt},
      {displayState:before.displayState,remoteStopped:before.remoteStopped,nativeStoppedAt:before.timing.nativeStoppedAt},
      'FAIL: the same persisted revision must not describe new stop facts; return a conflict or its actual old snapshot',
    );
  }else{
    assert.equal(v.revision,current.revision,'A returned newer revision must actually exist in storage');
    assert.notEqual(current.revision,before.revision,'GET cannot invent a new revision');
    assert.equal(v.remoteStopped,true,'The concurrent newer snapshot must describe its confirmed stop');
    assert.equal(v.displayState,'needs_review');
  }
}

test('R1: HTTP must not return new stop evidence with the previous persisted revision',async()=>{
  const f=fixture('http-stop');const c=await reported(f);const before=f.view();assert.equal(before.displayState,'waiting_stop');
  f.queue.observeNative(c.attemptId,{state:'idle',workspace:f.dir});
  const rowBefore=f.store.get(f.taskId),eventsBefore=f.events();
  const server=new WorkbenchHttpServer({service:f.service,health:()=>workbenchHealth({runtime:{release:'fixture',packageVersion:'0',startedAt:'fixture'}})});
  const port=await server.listen(0);
  try{
    const r=await get(port,`/workbench/v1/tasks/${f.taskId}`);
    assert.deepEqual(f.store.get(f.taskId),rowBefore,'GET must not update the task');
    assert.deepEqual(f.events(),eventsBefore,'GET must not append events');
    if(r.status===200)requireConsistent({ok:true,view:r.body} as ReturnType<TaskApplicationService['readStageView']>,before,f.store.get(f.taskId)!);
    else{
      assert.ok([400,503].includes(r.status));
      assert.ok(['EVIDENCE_STALE','READ_CONFLICT'].includes(r.body.error?.code));
    }
  }finally{await server.close();f.store.close();}
});

test('R1: before the first sync, later claim/report/stop facts cannot reuse the dispatch revision',async()=>{
  const f=fixture('first-sync');
  try{
    await f.send();const before=f.view();assert.equal(before.remoteStopped,false);
    const c=await f.queue.claim('fixture-session',0);assert.equal(c.status,'task');
    f.queue.report({...c,status:'completed',text:'TASK_STATUS: completed\nBefore first sync',artifacts:[]});
    f.queue.observeNative(c.attemptId,{state:'idle',workspace:f.dir});
    const rowBefore=f.store.get(f.taskId),eventsBefore=f.events();
    const result=f.service.readStageView(f.taskId);
    assert.deepEqual(f.store.get(f.taskId),rowBefore);assert.deepEqual(f.events(),eventsBefore);
    requireConsistent(result,before,f.store.get(f.taskId)!);
  }finally{f.store.close();}
});

test('R1: a real concurrent evidence commit must not endorse new file facts under the first revision',async()=>{
  const f=fixture('real-concurrent-commit');let writer: TaskStore | undefined;const original=f.store.get.bind(f.store);
  try{
    const c=await reported(f),before=f.view();f.queue.observeNative(c.attemptId,{state:'idle',workspace:f.dir});
    const snapshot=new RunJournal(f.config.runsDir!,c.attemptId).snapshot();writer=new TaskStore(f.config.dbFile);let gets=0;
    f.store.get=id=>{
      if(id===f.taskId&&++gets===2)writer!.updateAttempt(f.taskId,c.attemptId,{runEvidenceDigest:runEvidenceDigestOf(snapshot!)});
      return original(id);
    };
    const result=f.service.readStageView(f.taskId);f.store.get=original;
    assert.equal(gets,2,'The real recheck window must execute');
    const current=f.store.get(f.taskId)!;assert.notEqual(current.revision,before.revision,'The second connection must actually commit');
    requireConsistent(result,before,current);
  }finally{f.store.get=original;writer?.close();f.store.close();}
});

test('R1 positive control: sync commits new evidence and revision; unchanged later sync stays stable',async()=>{
  const f=fixture('sync-control');
  try{
    const c=await reported(f),before=f.view();f.queue.observeNative(c.attemptId,{state:'idle',workspace:f.dir});
    await f.coordinator.sync(f.taskId);const after=f.view();
    assert.equal(after.remoteStopped,true);assert.equal(after.displayState,'needs_review');assert.notEqual(after.revision,before.revision);
    await f.coordinator.sync(f.taskId);assert.equal(f.view().revision,after.revision);
  }finally{f.store.close();}
});

test('cancellation evidence is versioned and GET never consumes it', async () => {
  const f = fixture('cancellation');
  try {
    const c = await reported(f);
    f.queue.observeNative(c.attemptId, {state:'idle', workspace:f.dir});
    await f.coordinator.sync(f.taskId);
    const before = f.store.get(f.taskId)!;
    const events = f.events();
    const journal = new RunJournal(f.config.runsDir!, c.attemptId);
    fs.writeFileSync(path.join(journal.dir, 'cancel.json'), JSON.stringify({requestedAt:'2026-10-25T00:00:00.000Z', reason:'deadline'}));
    const result = f.service.readStageView(f.taskId);
    assert.equal(result.ok, false);
    if (result.ok) throw Error('Expected stale cancellation evidence');
    assert.equal(result.code, 'evidence_stale');
    assert.deepEqual(f.store.get(f.taskId), before);
    assert.deepEqual(f.events(), events);
    await f.coordinator.sync(f.taskId);
    assert.notEqual(f.store.get(f.taskId)!.revision, before.revision);
    assert.equal(f.service.readStageView(f.taskId).ok, true);
  } finally { f.store.close(); }
});

test('a missing previously bound run file cannot keep the old revision', async () => {
  const f = fixture('missing-file');
  try {
    const c = await reported(f);
    fs.unlinkSync(path.join(f.config.runsDir!, c.attemptId, 'state.json'));
    const result = f.service.readStageView(f.taskId);
    assert.equal(result.ok, false);
    if (result.ok) throw Error('Expected missing evidence conflict');
    assert.equal(result.code, 'evidence_stale');
  } finally { f.store.close(); }
});

test('run task and session identity changes invalidate the persisted evidence', async () => {
  const f = fixture('identity');
  try {
    const c = await reported(f);
    const journal = new RunJournal(f.config.runsDir!, c.attemptId);
    const snapshot = journal.snapshot()!;
    for (const patch of [{taskId:'foreign-task'}, {sessionId:'foreign-session'}]) {
      journal.save({...snapshot, ...patch});
      const result = f.service.readStageView(f.taskId);
      assert.equal(result.ok, false);
      if (result.ok) throw Error('Expected foreign evidence conflict');
      assert.equal(result.code, 'evidence_stale');
    }
  } finally { f.store.close(); }
});
