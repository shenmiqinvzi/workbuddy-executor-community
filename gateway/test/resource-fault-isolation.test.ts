import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { SelectedModelClient } from "./support/selected-model-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { WorkBuddyQuotaCollector } from "../src/quota-observation.js";
import { WorkbenchHttpServer, workbenchHealth } from "../src/workbench-http.js";
import { DshTaskCoordinator } from "../src/dsh-coordinator.js";
import type { DshTransport, DshSelection } from "../src/dsh-client.js";
import type { DeepSeekEvent } from "../src/deepseek-client.js";
import { legacyFreeModelPolicy } from "../src/collaboration.js";
import { RunJournal } from "../src/run-journal.js";

function fixture(t: test.TestContext) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"resource-isolation-")), runs=path.join(dir,"runs");
  const native=new DatabaseSync(path.join(dir,"workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?,?,1,NULL)").run("synthetic-session",dir);native.close();
  const config:Config={backend:"desktop-queue",apiBaseUrl:"http://127.0.0.1:1",tokenFile:path.join(dir,"unused"),dbFile:path.join(dir,"tasks.sqlite"),oauthRedirectUri:"http://127.0.0.1:1/oauth",oauthPort:1,oauthScopes:"synthetic",requestTimeoutMs:1000,cliElectronPath:path.join(dir,"absent.exe"),cliScriptPath:path.join(dir,"absent"),cliPermissionMode:"deny",acpPermissionMode:"deny",gatewayUrl:"http://127.0.0.1:1",workbuddyConfigDir:dir,runsDir:runs,taskTimeoutSeconds:600,claimTimeoutSeconds:60,maxTaskAttempts:3,serviceConfigFile:path.join(dir,"service.json")};
  const store=new TaskStore(config.dbFile),client=new SelectedModelClient(config),coordinator=new TaskCoordinator(config,store,client),service=new TaskApplicationService(coordinator,3,runs),queue=new DesktopQueue(config,()=>({desktopPid:process.pid}));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
  return {dir,config,store,coordinator,service,queue};
}
async function running(f:ReturnType<typeof fixture>){
  const sent=await f.coordinator.send({model:"synthetic-user-choice",taskId:"resource-isolation-task",objective:"Synthetic isolation fixture",workspace:f.dir,sessionId:"synthetic-session",timeoutSeconds:120});
  const claim=await f.queue.claim("synthetic-session",0);if(claim.status!=="task")throw Error("expected synthetic claim");
  const task=await f.service.sync(sent.task.taskId);assert.equal(task.state,"working");assert.equal(task.runtimeSource,"desktop_queue");
  return {task,claim};
}
async function source(handler:(req:http.IncomingMessage,res:http.ServerResponse)=>void){
  const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("source address missing");
  return {server,url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
async function httpServer(service:TaskApplicationService){const server=new WorkbenchHttpServer({service,health:()=>workbenchHealth({runtime:{release:"synthetic",packageVersion:"test",startedAt:"test"}})});const port=await server.listen(0);return {server,base:`http://127.0.0.1:${port}`};}
const bounded=<T>(p:Promise<T>)=>Promise.race([p,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error("operation exceeded 10 seconds while resource poll was held")),10000);timer.unref();})]);
const identity=(task:any)=>({taskId:task.taskId,attemptId:task.attemptId,sessionId:task.sessionId,runtimeSource:task.runtimeSource});
const syntheticRow={uid:"synthetic",realm:"cn",model:"synthetic-model",used:20,budget:100,remaining:80,reset_at:null,cooling:false};

test("in-flight resource collection cannot block original WorkBuddy supervision, cancellation or native stop evidence",async t=>{
  const f=fixture(t),{task,claim}=await running(f),original=identity(task),occupant=f.store.operations.occupant();assert.equal(occupant?.taskId,task.taskId);
  let entered!:()=>void;const requestEntered=new Promise<void>(resolve=>{entered=resolve;});let requests=0;
  const upstream=await source((_req,_res)=>{requests++;entered();});
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,{id:"synthetic-source",baseUrl:upstream.url,apiKey:"fixture-key",intervalMs:1000,maxAgeMs:10000,timeoutMs:30000});
  const server=await httpServer(f.service);const poll=collector.collect();
  try {
    await bounded(requestEntered);
    const beforeTask=f.store.get(task.taskId),beforeOps=f.store.operations.forTask(task.taskId),beforeCapacity=f.store.operations.occupant();
    for(const route of ["quotas","credit-balances","routing"]){const response=await fetch(`${server.base}/workbench/v1/resources/${route}`);assert.equal(response.status,200);}
    assert.equal(requests,1,"page GET does not collect");assert.deepEqual(f.store.get(task.taskId),beforeTask);assert.deepEqual(f.store.operations.forTask(task.taskId),beforeOps);assert.deepEqual(f.store.operations.occupant(),beforeCapacity);
    const list=await fetch(`${server.base}/workbench/v1/tasks`).then(r=>r.json()) as any;assert.equal(list.tasks[0].taskId,task.taskId);assert.deepEqual(identity(f.store.get(task.taskId)),original);
    const supervised=await bounded(f.service.sync(task.taskId));assert.equal(supervised.state,"working");assert.deepEqual(identity(supervised),original);
    const cancelled=await bounded((async()=>await f.service.cancel(task.taskId,"synthetic operator stop"))());assert.equal(cancelled.remoteStopped,false);assert.equal("execution" in cancelled && cancelled.execution?.state,"stop_unconfirmed");
    assert.equal(f.queue.progress({...claim,text:"synthetic progress"}).cancellationRequested,true);assert.deepEqual(f.store.operations.occupant(),occupant);assert.equal(f.store.listAttempts(task.taskId).length,1);
    await assert.rejects(f.coordinator.send({model:"synthetic-user-choice",taskId:"must-not-dispatch",objective:"Synthetic admission probe",workspace:f.dir,sessionId:"synthetic-session"}),{code:"CAPACITY_OCCUPIED"});
    assert.equal(f.store.get("must-not-dispatch"),undefined,"a pending stop never admits another task");
    await collector.stop();await poll;assert.equal(f.store.quotas.read().connections[0]!.errorCode,null,"intentional collector stop is not a task stop");
    assert.equal(f.service.executionStatus(task.taskId).remoteStopped,false);assert.deepEqual(f.store.operations.occupant(),occupant);
    f.queue.report({...claim,status:"cancelled",text:"synthetic worker report",artifacts:[]});assert.equal(f.service.executionStatus(task.taskId).remoteStopped,false,"worker report is not native stop evidence");assert.deepEqual(f.store.operations.occupant(),occupant);
    f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.dir});assert.equal(f.service.executionStatus(task.taskId).remoteStopped,true);
    const nativeStop=new RunJournal(f.config.runsDir!,claim.attemptId).snapshot()!;assert.equal(nativeStop.nativeStopSource,"native_idle");assert.ok(nativeStop.nativeStoppedAt);assert.equal(nativeStop.sessionId,claim.sessionId);
    const stopped=await bounded(f.service.sync(task.taskId));assert.equal(stopped.state,"cancelled");assert.notEqual(stopped.state,"accepted");assert.equal(f.store.listAttempts(task.taskId).length,1);assert.deepEqual(identity(stopped),original);
    assert.equal(f.store.operations.isClosed(stopped),true,"closure requires the persisted native stop and task_closed evidence");
    assert.deepEqual(f.store.operations.occupant(),occupant,"the saved slot is retained until the next admission checks closure");
    assert.equal(requests,1);assert.deepEqual(f.store.operations.forTask(task.taskId).find(op=>op.kind==="send"),beforeOps.find(op=>op.kind==="send"));
    assert.equal(f.service.executionStatus(task.taskId).remoteStopped,true);
  }finally{await collector.stop();await poll;await server.server.close();await upstream.close();}
  await assert.rejects(fetch(`${server.base}/workbench/`,{signal:AbortSignal.timeout(1500)}));
  await assert.rejects(fetch(upstream.url,{signal:AbortSignal.timeout(1500)}));
});

test("resource failures and corrupt cache preserve a working task, its operation and held capacity",async t=>{
  const f=fixture(t),{task}=await running(f),server=await httpServer(f.service);let mode="ok",requests=0;
  const upstream=await source((_req,res)=>{requests++;if(mode==="timeout")return;if(mode==="unauthorized"||mode==="forbidden"){res.statusCode=mode==="unauthorized"?401:403;res.end("private error");}else if(mode==="invalid")res.end('{"rows":"invalid"}');else res.end(JSON.stringify({generated_at:Date.now()/1000,rows:[syntheticRow]}));});
  const spec={id:"synthetic-source",baseUrl:upstream.url,apiKey:"fixture-key",intervalMs:1000,maxAgeMs:10000,timeoutMs:1000};
  try {
    let collector=new WorkBuddyQuotaCollector(f.store.quotas,spec);await collector.collect();await collector.stop();const saved=f.store.quotas.read();
    const priorTask=f.store.get(task.taskId),priorOps=f.store.operations.forTask(task.taskId),priorCapacity=f.store.operations.occupant();
    for(const failure of ["unauthorized","forbidden","invalid","timeout"]){mode=failure;collector=new WorkBuddyQuotaCollector(f.store.quotas,spec);await collector.collect();await collector.stop();const view=f.store.quotas.read();assert.equal(view.observations[0]!.remaining,80);assert.equal(view.connections[0]!.snapshotId,saved.connections[0]!.snapshotId);assert.equal(view.connections[0]!.freshness,"stale");assert.equal(view.connections[0]!.errorCode,failure==="invalid"?"source_invalid":failure==="timeout"?"source_timeout":"source_unauthorized");assert.equal((await fetch(`${server.base}/workbench/v1/tasks`)).status,200);assert.deepEqual(f.store.get(task.taskId),priorTask);assert.deepEqual(f.store.operations.forTask(task.taskId),priorOps);assert.deepEqual(f.store.operations.occupant(),priorCapacity);}
    const db=new DatabaseSync(f.config.dbFile);try{db.exec("UPDATE quota_connections SET snapshot_json='corrupt'");}finally{db.close();}
    const beforeRequests=requests;for(const route of ["quotas","routing"]){const response=await fetch(`${server.base}/workbench/v1/resources/${route}`);assert.equal(response.status,503);assert.equal((await response.json() as any).error.code,"RESOURCE_STORE_UNAVAILABLE");}
    assert.equal((await fetch(`${server.base}/workbench/v1/resources/credit-balances`)).status,200);assert.equal((await fetch(`${server.base}/workbench/v1/tasks`)).status,200);assert.equal(requests,beforeRequests);assert.deepEqual(f.store.get(task.taskId),priorTask);assert.deepEqual(f.store.operations.forTask(task.taskId),priorOps);assert.deepEqual(f.store.operations.occupant(),priorCapacity);assert.equal(f.store.listAttempts(task.taskId).length,1);
  }finally{await server.server.close();await upstream.close();}
});

test("DSH cancellation requires the original terminal event while resource collection is held",async t=>{
  const f=fixture(t),dir=fs.realpathSync.native(f.dir),execution={executorId:"dsh" as const,connectionId:"synthetic-host",providerId:"synthetic-provider",modelId:"synthetic-model",reasoningEffort:null};
  let selected:DshSelection|null=null,prompts=0,selections=0,cancels=0;let cancelInput:unknown;const events:DeepSeekEvent[]=[];
  const client:DshTransport={
    resolveHostId:()=>execution.connectionId,async health(){return {capabilities:{automaticReview:false}};},
    async sessions(){return {sessions:[{sessionId:"dsh-session",workspace:dir,busy:false,attached:true}]};},
    async create(){throw Error("unexpected session creation");},async session(input){return {sessionId:input.sessionId,workspace:dir,busy:false,attached:true,selectedModel:selected};},
    async models(){return {pricingVerified:false,models:[{...execution,credits:null,reasoningEfforts:[]}]};},
    async selectModel(input){selections++;selected={providerId:input.providerId,modelId:input.modelId,reasoningEffort:input.reasoningEffort};return {sessionId:input.sessionId,workspace:dir,attached:true,selectedModel:selected};},
    async prompt(input){prompts++;return {requestId:input.requestId,accepted:true};},
    async events(input){const page=events.filter(e=>e.seq>input.afterSeq).slice(0,input.limit);return {events:page,cursor:page.at(-1)?.seq??input.afterSeq};},
    async cancel(input){cancels++;cancelInput=input;return {requested:true,stopped:true};},
  };
  const dsh=new DshTaskCoordinator(f.store,client,f.config.runsDir!,async()=>({credits:"x0.00",observedAt:new Date().toISOString()}));
  f.store.collaboration.registerWorkspace("synthetic-project",dir,"Synthetic project");f.store.collaboration.setPolicy({...legacyFreeModelPolicy(),allowed:[...legacyFreeModelPolicy().allowed,execution]});
  const proposal={schemaVersion:"workbuddy-executor/vnext-2",taskId:"synthetic-dsh",workspaceId:"synthetic-project",title:"Synthetic DSH",objective:"Isolated test",execution,timeoutSeconds:60,maxAttempts:2,scope:{allowedChanges:["sample.txt"],permittedMetadata:[]},requiredChecks:[],collaboration:{planId:"placeholder",expectedPlanRevision:"placeholder"}};
  const plan=f.store.collaboration.createPlan(proposal,dsh.policy(),{mode:"manual",reason:"Synthetic fixture"});f.store.collaboration.authorizePlan(plan.planId,plan.revision,dsh.policy(),"synthetic-user");
  const contract={...proposal,collaboration:{planId:plan.planId,expectedPlanRevision:plan.revision}};
  const sent=await dsh.send({contract,objective:contract.objective,sessionId:"dsh-session"});assert.equal(sent.ok,true);
  const binding=f.store.dshBindings.forTask(contract.taskId)!;
  events.push({seq:0,requestId:binding.requestId,type:"started",timestamp:new Date().toISOString(),turnId:`${binding.sessionId}:turn:1`,rawType:"turn/start"});
  const service=new TaskApplicationService(f.coordinator,3,f.config.runsDir!,dsh);const active=await service.sync(contract.taskId),occupant=f.store.operations.occupant();
  assert.equal(active.runtimeSource,"dsh");assert.equal(occupant?.taskId,contract.taskId);
  let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});const upstream=await source((_req,_res)=>enter());
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,{id:"held-dsh-source",baseUrl:upstream.url,apiKey:"synthetic",timeoutMs:30000});const http=await httpServer(service);const poll=collector.collect();
  try{
    await bounded(entered);const response=await fetch(`${http.base}/workbench/v1/tasks`);assert.equal(response.status,200);
    const supervised=await bounded(service.sync(contract.taskId));assert.equal(supervised.attemptId,active.attemptId);assert.equal(supervised.sessionId,active.sessionId);
    const stopped=await bounded((async()=>await service.cancel(contract.taskId,"synthetic stop"))());assert.equal(stopped.remoteStopped,false);assert.equal(cancels,1);assert.deepEqual(cancelInput,{hostId:binding.hostId,sessionId:binding.sessionId,requestId:binding.requestId});assert.deepEqual(f.store.operations.occupant(),occupant);
    assert.equal(service.executionStatus(contract.taskId).remoteStopped,false,"native cancel acknowledgement is not a terminal event");
    events.push({seq:1,requestId:binding.requestId,type:"cancelled",timestamp:new Date().toISOString(),turnId:`${binding.sessionId}:turn:1`,rawType:"turn/end"});
    const final=await bounded(service.sync(contract.taskId));assert.equal(final.state,"cancelled");assert.equal(service.executionStatus(contract.taskId).remoteStopped,true);assert.equal(f.store.operations.isClosed(final),true);assert.deepEqual(f.store.operations.occupant(),occupant);
    const snapshot=new RunJournal(f.config.runsDir!,final.attemptId!).snapshot()!;assert.equal(snapshot.nativeStopSource,"dsh_terminal_event");assert.equal(snapshot.nativeStoppedAt,events[1]!.timestamp);
    assert.equal(prompts,1);assert.equal(selections,1);assert.equal(f.store.listAttempts(contract.taskId).length,1);assert.equal(f.store.dshBindings.forTask(contract.taskId)!.requestId,binding.requestId);
  }finally{await collector.stop();await poll;await http.server.close();await upstream.close();}
  await assert.rejects(fetch(`${http.base}/workbench/`,{signal:AbortSignal.timeout(1500)}));
  await assert.rejects(fetch(upstream.url,{signal:AbortSignal.timeout(1500)}));
});
