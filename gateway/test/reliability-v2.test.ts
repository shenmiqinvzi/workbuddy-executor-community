import { reviewAccept } from "./support/review-accept.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {loadConfig} from "../src/config.js";
import {DesktopQueue} from "../src/desktop-queue.js";
import {TaskStore} from "../src/task-store.js";
import {TaskCoordinator} from "../src/coordinator.js";
import {WorkBuddyClient} from "../src/workbuddy-client.js";
import {RunJournal,hasNativeStopEvidence} from "../src/run-journal.js";
import {PersistentDesktopService,type NativeDesktopTrigger,type NativeObservation} from "../src/persistent-service.js";
import {latestNativeWake} from "../src/native-ownership.js";
import {progressDelta} from "../src/progress-summary.js";
import {readWorkerResult} from "../src/worker-result.js";
import crypto from "node:crypto";

function fixture(t:{after:(fn:()=>void)=>void}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wb-v2-"));
 const config={...loadConfig(),backend:"desktop-queue" as const,dbFile:path.join(dir,"tasks.sqlite"),runsDir:path.join(dir,"runs"),workbuddyConfigDir:dir};
 const db=new DatabaseSync(path.join(dir,"workbuddy.db"));db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
 for(const id of ["session","other"])db.prepare("INSERT INTO sessions VALUES(?,?,1,NULL)").run(id,dir);db.close();
 const store=new TaskStore(config.dbFile),queue=new DesktopQueue(config,()=>({desktopPid:process.pid})),coordinator=new TaskCoordinator(config,store,new WorkBuddyClient(config));
 let state:NativeObservation["state"]="idle",stopFailure=false,stops=0,wakes=0;
 const trigger:NativeDesktopTrigger={ async setModel(sessionId: string, model: string) { return { sessionId, model }; },inspect:async()=>({state,workspace:dir}),wakeIdle:async()=>{wakes++;state="busy";return {accepted:true};},cancelAttempt:async(sid,wid,workspace)=>{assert.equal(sid,"session");assert.match(wid,/^wake-run-/);assert.equal(workspace,dir);stops++;if(stopFailure)throw Error("stop API failed");state="idle";}};
 const registration={version:1 as const,sessionId:"session",workspace:dir,projectDir:dir,nodeBin:process.execPath,cdpPort:18491,dbFile:config.dbFile,runsDir:config.runsDir,workbuddyConfigDir:dir,cliElectronPath:config.cliElectronPath};
 const service=()=>new PersistentDesktopService(config,registration,trigger,store);
 const send=async(scope?:{allowedChanges:string[];permittedMetadata:string[]})=>{await coordinator.send({ model: "synthetic-user-choice",taskId:"task",objective:"fixture",sessionId:"session",workspace:dir,timeoutSeconds:120,...(scope?{scope}:{})});await service().pump();const claim=await queue.claim("session",0);if(claim.status!=="task")throw Error("no claim");return {...claim,journal:new RunJournal(config.runsDir,claim.attemptId)};};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,config,store,queue,coordinator,trigger,service,send,setState:(s:typeof state)=>state=s,setFailure:(f:boolean)=>stopFailure=f,stops:()=>stops,wakes:()=>wakes};
}
test("busy operator cancel stops exactly the bound native turn, repeated cancel is idempotent",async t=>{
 const f=fixture(t),c=await f.send();await f.coordinator.cancel("task");
 assert.equal((await f.service().pump()).status,"stop_confirmed");
 assert.equal(f.stops(),1);assert.equal(f.wakes(),1);assert.equal(f.coordinator.executionStatus("task").remoteStopped,true);
 await f.coordinator.cancel("task");await f.service().pump();assert.equal(f.stops(),1);
 assert.equal(f.store.get("task")?.state,"cancelled");
 assert.throws(()=>f.queue.report({...c,status:"completed",text:"late",artifacts:[]}),/no longer active/);
});
test("deadline while busy stops automatically and preserves blocked failure and artifacts",async t=>{
 const f=fixture(t),c=await f.send();c.journal.save({...c.journal.snapshot()!,deadline:new Date(Date.now()-1).toISOString()});
 assert.equal((await f.service().pump()).status,"stop_confirmed");assert.equal(f.stops(),1);
 assert.equal((await f.coordinator.sync("task")).state,"blocked");assert.equal(f.coordinator.executionStatus("task").remoteStopped,true);
 const cancel=fs.readFileSync(path.join(c.journal.dir,"cancel.json"),"utf8");await f.coordinator.cancel("task");assert.equal(fs.readFileSync(path.join(c.journal.dir,"cancel.json"),"utf8"),cancel);
 await assert.rejects(()=>f.coordinator.accept("task","bad",["check"]),/finish/);
});
test("stop API failure is visible, not replayed, forbids new sessions/rework/acceptance",async t=>{
 const f=fixture(t),c=await f.send();f.setFailure(true);await f.coordinator.cancel("task");
 assert.equal((await f.service().pump()).status,"stop_unconfirmed");assert.equal(f.stops(),1);
 assert.match(c.journal.snapshot()?.stopControl?.error??"",/stop API failed/);
 assert.equal(f.coordinator.executionStatus("task").remoteStopped,false);
 await assert.rejects(f.coordinator.send({ model: "synthetic-user-choice",taskId:"other-task",objective:"overlap",sessionId:"other",workspace:f.dir}),{code:"CAPACITY_OCCUPIED"});
 assert.equal(f.store.get("other-task"),undefined);
 await assert.rejects(()=>f.coordinator.continue({taskId:"task",feedback:"retry"}),/Cancelled/);
 await assert.rejects(()=>f.coordinator.accept("task","bad",["check"]),/finish/);
 f.setState("idle");assert.equal((await f.service().pump()).status,"stop_confirmed");assert.equal(f.stops(),1);
});
test("offline stop never proves success or cancels another session; recovery inspects original",async t=>{
 const f=fixture(t),c=await f.send();f.setState("offline");await f.coordinator.cancel("task");
 assert.equal((await f.service().pump()).status,"stop_unconfirmed");assert.equal(f.stops(),0);assert.equal(hasNativeStopEvidence(c.journal.snapshot()),false);
 f.setState("busy");assert.equal((await f.service().pump()).status,"stop_confirmed");assert.equal(f.stops(),1);
});
test("mismatched current task/attempt binding never stops native work",async t=>{
 const f=fixture(t),c=await f.send();f.queue.requestCancellation(c.attemptId);f.store.update("task",{sessionId:"other"});
 assert.equal((await f.service().pump()).status,"stop_unconfirmed");assert.equal(f.stops(),0);
});
test("a report received while native work remains busy cannot evade the absolute deadline",async t=>{
 const f=fixture(t),c=await f.send();f.queue.report({...c,status:"completed",text:"real report",artifacts:[]});
 c.journal.save({...c.journal.snapshot()!,deadline:new Date(Date.now()-1).toISOString()});
 assert.equal((await f.service().pump()).status,"stop_confirmed");assert.equal(c.journal.snapshot()?.status,"blocked");assert.equal(c.journal.snapshot()?.text,"real report");
});
test("phase progress survives long tasks, repeated heartbeat does not advance meaningful time",async t=>{
 const f=fixture(t),c=await f.send(),text=JSON.stringify({stage:"validation",completed:"baseline done",running:"long local test",blocker:""});
 f.queue.progress({...c,text});const first=c.journal.snapshot()!.progress!;const count=c.journal.events(0,Infinity).length;
 f.queue.progress({...c,text});assert.equal(c.journal.events(0,Infinity).length,count);assert.equal(c.journal.snapshot()?.progress?.lastMeaningfulAt,first.lastMeaningfulAt);
 await f.service().pump();assert.equal(c.journal.snapshot()?.status,"working");assert.equal(f.stops(),0);
 const task=await f.coordinator.sync("task"),messages=f.store.listMessages("task",100);assert.equal(progressDelta(task,messages,0).changed,true);assert.equal(progressDelta(task,messages,task.lastEventSeq).changed,false);
});
test("same task rework retains session and history; overlapping and duplicate dispatch rejected",async t=>{
 const f=fixture(t),c=await f.send();f.queue.report({...c,status:"completed",text:"actual first result",artifacts:[]});
 await assert.rejects(()=>f.coordinator.continue({taskId:"task",feedback:"fix"}),/not been confirmed/);
 f.setState("idle");await f.service().pump();await f.coordinator.continue({taskId:"task",feedback:"specific correction"});await f.service().pump();
 const current=f.store.get("task")!;assert.equal(current.sessionId,c.sessionId);assert.equal(current.attempt,2);assert.notEqual(current.attemptId,c.attemptId);
 assert.equal((await f.coordinator.send({ model: "synthetic-user-choice",taskId:"task",objective:"fixture",sessionId:"session",workspace:f.dir,timeoutSeconds:120})).created,false);
 await assert.rejects(()=>f.coordinator.send({ model: "synthetic-user-choice",taskId:"task",objective:"duplicate"}),/Task ID conflicts/);assert.equal(f.wakes(),2);assert.equal(f.store.listAttempts("task").length,2);
});

async function validatedReport(f: ReturnType<typeof fixture>) {
 const c=await f.send({allowedChanges:["source.js"],permittedMetadata:[]}),source=path.join(f.dir,"source.js");fs.writeFileSync(source,"verified source");
 // Follow the actual claim's JSON example, as a native worker does, rather
 // than supplying a hand-built report that hides omissions in that example.
 const reportContract=c.prompt.split("[QUEUE_REPORT_CONTRACT]")[1];
 const templateLine=reportContract?.split("\n").find(line=>line.startsWith("格式："));
 assert.ok(templateLine,"Claim must carry a file-report JSON example");
 const template=JSON.parse(templateLine.slice("格式：".length));
 assert.ok(Array.isArray(template.validationRecords)&&template.validationRecords.length>0,"Claim report template must show how to cite validation records");
 const hash=crypto.createHash("sha256").update("verified source").digest("hex"),dir=path.join(c.journal.dir,"commands"),record=path.join(dir,crypto.randomUUID()+".json");
 fs.mkdirSync(dir);fs.writeFileSync(record,JSON.stringify({endedAt:new Date().toISOString(),exitCode:0,cleanupConfirmed:true,before:{[source]:hash},after:{[source]:hash}}));
 fs.writeFileSync(c.reporting.resultFile,JSON.stringify({...template,status:"completed",text:"actual validated result",artifacts:[source],validationRecords:template.validationRecords.map(()=>record)}));
 const input=readWorkerResult(f.config,path.join(c.journal.dir,"worker-context.json"),c.reporting.resultFile);
 assert.deepEqual(input.validationRecords,[{path:record,sha256:crypto.createHash("sha256").update(fs.readFileSync(record)).digest("hex")}]);
 f.queue.report(input);f.setState("idle");await f.service().pump();await f.coordinator.sync("task");
 return {...c,source,record,input};
}

test("accept rechecks cited validation after report, native stop and coordinator reconnect",async t=>{
 const f=fixture(t),c=await validatedReport(f);
 assert.equal(f.coordinator.executionStatus("task").remoteStopped,true);
 assert.equal(c.journal.snapshot()?.validationRecords?.[0]?.path,c.record);
 fs.writeFileSync(c.source,"changed during review");
 const reconnect=new TaskCoordinator(f.config,f.store,new WorkBuddyClient(f.config));
 await assert.rejects(()=>reconnect.accept("task","reviewed",["inspected output"]),/Source changed/);
 assert.equal(f.store.get("task")?.state,"needs_review");assert.deepEqual(f.store.get("task")?.evidence,[]);
});

test("accept preserves valid cited evidence without requiring a duplicate test run",async t=>{
 const f=fixture(t),c=await validatedReport(f);
 assert.equal((await reviewAccept(f.coordinator, "task","reviewed",["inspected source and recorded check"],[c.source])).state,"accepted");
});

test("accept rejects a rewritten command record even if its current source hashes still match",async t=>{
 const f=fixture(t),c=await validatedReport(f),record=JSON.parse(fs.readFileSync(c.record,"utf8"));
 fs.writeFileSync(c.record,JSON.stringify({...record,extra:"rewritten after report"}));
 await assert.rejects(()=>f.coordinator.accept("task","reviewed",["check"]),/record changed/);
 assert.equal(f.store.get("task")?.state,"needs_review");
});

test("accept rejects missing cited records and a mismatched authenticated session",async t=>{
 const f=fixture(t),c=await validatedReport(f),bytes=fs.readFileSync(c.record);fs.unlinkSync(c.record);
 await assert.rejects(()=>f.coordinator.accept("task","reviewed",["check"]),/ENOENT/);
 fs.writeFileSync(c.record,bytes);c.journal.save({...c.journal.snapshot()!,sessionId:"other"});
 await assert.rejects(()=>f.coordinator.accept("task","reviewed",["check"]),/matching task\/attempt\/session/);
 assert.equal(f.store.get("task")?.state,"needs_review");
});
test("ownership reader refuses another user turn even when older wake marker exists",t=>{
 const f=fixture(t),sid="00000000-0000-0000-0000-000000000001",wake="wake-run-00000000-0000-0000-0000-000000000002";
 const dir=path.join(f.dir,"projects","project");fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,sid+".jsonl");
 const line=(text:string)=>JSON.stringify({type:"message",sessionId:sid,role:"user",content:[{text}]})+"\n";
 fs.writeFileSync(file,line(`[CODEX_QUEUE_WAKE ${wake}]`));assert.equal(latestNativeWake(f.dir,sid),wake);
 fs.appendFileSync(file,line("unrelated manual work"));assert.equal(latestNativeWake(f.dir,sid),undefined);
});
test("native idle cannot prove stop while an owned command lacks cleanup evidence",async t=>{
 const f=fixture(t),c=await f.send(),dir=path.join(c.journal.dir,"commands"),file=path.join(dir,crypto.randomUUID()+".json");fs.mkdirSync(dir);fs.writeFileSync(file,JSON.stringify({state:"running"}));
 f.queue.report({...c,status:"completed",text:"actual report",artifacts:[]});
 assert.throws(()=>f.queue.observeNative(c.attemptId,{state:"idle",workspace:f.dir}),/owned command cleanup/);
 assert.equal(hasNativeStopEvidence(c.journal.snapshot()),false);
 fs.writeFileSync(file,JSON.stringify({endedAt:new Date().toISOString(),cleanupConfirmed:true}));f.queue.observeNative(c.attemptId,{state:"idle",workspace:f.dir});assert.equal(hasNativeStopEvidence(c.journal.snapshot()),true);
});
test("finish rejects a cited validation after the verified source changed",async t=>{
 const f=fixture(t),c=await f.send(),source=path.join(f.dir,"source.js");fs.writeFileSync(source,"current");const hash=crypto.createHash("sha256").update("current").digest("hex");
 const dir=path.join(c.journal.dir,"commands"),record=path.join(dir,crypto.randomUUID()+".json");fs.mkdirSync(dir);fs.writeFileSync(record,JSON.stringify({endedAt:new Date().toISOString(),exitCode:0,cleanupConfirmed:true,before:{[source]:hash},after:{[source]:hash}}));
 fs.writeFileSync(c.reporting.resultFile,JSON.stringify({status:"completed",text:"actual result",artifacts:[source],validationRecords:[record]}));
 const context=path.join(c.journal.dir,"worker-context.json");assert.equal(readWorkerResult(f.config,context,c.reporting.resultFile).status,"completed");
 fs.writeFileSync(source,"modified after test");assert.throws(()=>readWorkerResult(f.config,context,c.reporting.resultFile),/Source changed/);
});
test("operator cancellation before deadline cannot later be overwritten by timeout or a repeated cancel",async t=>{
 const f=fixture(t),c=await f.send();await f.coordinator.cancel("task");
 c.journal.save({...c.journal.snapshot()!,deadline:new Date(Date.now()-1).toISOString()});
 f.queue.checkDeadline(c.attemptId);await f.coordinator.cancel("task");
 assert.equal(c.journal.snapshot()?.error,undefined);
 assert.equal(f.queue.report({...c,status:"completed",text:"late worker response after operator cancellation",artifacts:[]}).status,"cancelled");
 f.setState("idle");await f.service().pump();assert.equal(c.journal.snapshot()?.status,"cancelled");assert.equal(f.store.get("task")?.state,"cancelled");
});
