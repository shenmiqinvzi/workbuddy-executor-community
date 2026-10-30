import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DesktopDispatchSession, type DesktopCatalogSource, type DesktopDraft, type DesktopReceipt } from "../src/desktop-dispatch.js";
import { DesktopDispatchJournal } from "../src/desktop-dispatch-journal.js";
import { assertDesktopDispatchDatabase, sendDesktopAgreement } from "../src/desktop-dispatch-runtime.js";
import { defaultModelPolicy } from "../src/collaboration.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import type { Config } from "../src/config.js";
import type { WorkBuddyClient } from "../src/workbuddy-client.js";

function fixture(t:{after:(fn:()=>void)=>void}) {
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"desktop-dispatch-"))),project=path.join(dir,"project");fs.mkdirSync(project);
 const cleanup:Array<()=>void>=[];
 t.after(()=>{for(const close of cleanup)close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 let now=Date.now(),enqueued=0,source:DesktopCatalogSource={models:[{execution:{executorId:"workbuddy",connectionId:"local-workbuddy",providerId:"workbuddy-native",modelId:"synthetic-model",reasoningEffort:null},credits:null,pricingVerified:false}],sessions:[],policy:defaultModelPolicy(),requiredFreeModel:null,dispatchEnabled:true,errors:[]};
 const receipts=new Map<string,DesktopReceipt>();
 const session=new DesktopDispatchSession({catalog:async()=>structuredClone(source),now:()=>now,receipt:id=>receipts.get(id)??null,enqueue:async draft=>{enqueued++;const receipt:DesktopReceipt={requestId:draft.draftId,taskId:draft.taskId,operationId:draft.operationId,state:"launch_requested"};receipts.set(draft.draftId,receipt);return receipt;}});
 return {dir,project,session,source,receipts,cleanup,get enqueued(){return enqueued;},advance:()=>{now+=300001;}};
}
async function draft(f:ReturnType<typeof fixture>,override:Record<string,unknown>={}) {
 const catalog=await f.session.catalog();
 return f.session.preview({catalogId:catalog.catalogId,modelKey:catalog.models[0]!.key,workspace:f.project,title:"Synthetic scoped task",objective:"Update the explicitly allowed file",allowedChanges:["src/**"],permittedMetadata:[],checks:["Independent check of the requested behavior"],maxAttempts:1,timeoutSeconds:600,sessionId:null,...override});
}
const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==="object"&&"code" in error&&error.code===code;

test("catalog and draft are non-dispatching, explicit and immutable; unknown rates are never free",async t=>{
 const f=fixture(t),catalog=await f.session.catalog();
 assert.equal(f.enqueued,0);assert.equal(catalog.models[0]!.credits,null);assert.equal(catalog.models[0]!.pricingVerified,false);
 await assert.rejects(draft(f,{modelKey:""}),hasCode("MODEL_SELECTION_REQUIRED"));
 const value=await draft(f);assert.equal(value.contract.execution.modelId,"synthetic-model");assert.deepEqual(value.contract.scope.allowedChanges,["src/**"]);
 value.contract.scope.allowedChanges.push("**");assert.deepEqual(f.session.review(value.draftId,value.digest).contract.scope.allowedChanges,["src/**"]);assert.equal(f.enqueued,0);
 assert.throws(()=>f.session.review(value.draftId,"other"),hasCode("DRAFT_CHANGED"));
 f.source.models[0]!.credits="free (unverified text)";f.source.models[0]!.pricingVerified=true;
 const normalized=await f.session.catalog();assert.equal(normalized.models[0]!.credits,null);assert.equal(normalized.models[0]!.pricingVerified,false);
});
test("invalid scope, undeclared fields, missing checks and over-budget drafts fail before any enqueue",async t=>{
 const f=fixture(t);
 for(const change of [{allowedChanges:["../outside"]},{extra:"not allowed"},{checks:[]},{maxAttempts:4},{timeoutSeconds:86401}])await assert.rejects(draft(f,change));
 assert.equal(f.enqueued,0);
});
test("duplicate and concurrent confirmation retains one exact request, task and operation",async t=>{
 const f=fixture(t),value=await draft(f);
 const [first,second]=await Promise.all([f.session.commit(value.draftId,value.digest),f.session.commit(value.draftId,value.digest)]);
 assert.deepEqual(first,second);assert.equal(f.enqueued,1);assert.equal(first.operationId,value.operationId);assert.equal(first.taskId,value.taskId);
 assert.deepEqual(f.session.receipt(first.requestId),first);
});
test("pending and uncertain commits keep original identities, never re-enqueue, and observation requires a submitted receipt",async t=>{
 const f=fixture(t);let release!:()=>void,enqueue=0,observations=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const receipts=new Map<string,DesktopReceipt>();
 const session=new DesktopDispatchSession({catalog:async()=>structuredClone(f.source),receipt:id=>receipts.get(id)??null,latest:()=>[...receipts.values()].at(-1)??null,enqueue:async draft=>{enqueue++;await gate;throw Error("Synthetic connection lost");},observe:async requestId=>{observations++;return{taskId:receipts.get(requestId)!.taskId,observedAt:new Date().toISOString()};}});
 const catalog=await session.catalog(),value=session.preview({catalogId:catalog.catalogId,modelKey:catalog.models[0]!.key,workspace:f.project,title:"Original pending request",objective:"Keep the original operation identity",allowedChanges:[],permittedMetadata:[],checks:["No duplicate preparation"],maxAttempts:1,timeoutSeconds:600,sessionId:null});
 const commit=session.commit(value.draftId,value.digest);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(session.latest()!.state,"outcome_unknown");assert.equal(session.latest()!.operationId,value.operationId);
 assert.throws(()=>session.observe(value.draftId),hasCode("OPERATION_PENDING"));assert.equal(observations,0);
 release();await assert.rejects(commit);await assert.rejects(session.commit(value.draftId,value.digest));assert.equal(enqueue,1);
 receipts.set(value.draftId,{requestId:value.draftId,taskId:value.taskId,operationId:value.operationId,state:"submitted"});
 assert.equal((await session.observe(value.draftId)).taskId,value.taskId);assert.equal(observations,1);assert.equal(enqueue,1);
});
test("changed quote, policy, availability and expired agreements never prepare or substitute a model",async t=>{
 for(const mutation of ["quote","policy","missing","expired"]){const f=fixture(t),value=await draft(f);
  if(mutation==="quote"){f.source.models[0]!.credits="x1.00";f.source.models[0]!.pricingVerified=true;}
  if(mutation==="policy")f.source.policy.version="changed";
  if(mutation==="missing")f.source.models=[];
  if(mutation==="expired")f.advance();
  await assert.rejects(Promise.resolve().then(()=>f.session.commit(value.draftId,value.digest)));assert.equal(f.enqueued,0);
 }
});
test("deployment free-only restrictions remain in force; explicit paid and unknown rates can be chosen otherwise",async t=>{
 const f=fixture(t);f.source.requiredFreeModel="another-model";
 await assert.rejects(draft(f),hasCode("MODEL_POLICY_BLOCKED"));
 f.source.requiredFreeModel=null;f.source.policy.requireFree=true;
 await assert.rejects(draft(f),hasCode("MODEL_POLICY_BLOCKED"));
 f.source.policy.requireFree=false;f.source.models[0]!.credits="x2.00";f.source.models[0]!.pricingVerified=true;
 const paid=await draft(f);assert.equal(paid.quote.credits,"x2.00");assert.equal(f.enqueued,0);
});
test("DSH session must be explicitly selected, attached, idle and bound to the exact project",async t=>{
 const f=fixture(t);f.source.models[0]!.execution={executorId:"dsh",connectionId:"synthetic-host",providerId:"synthetic-provider",modelId:"synthetic-model",reasoningEffort:"low"};
 f.source.sessions=[{hostId:"synthetic-host",sessionId:"synthetic-session",workspace:f.project,attached:true,busy:false}];
 await assert.rejects(draft(f),hasCode("SESSION_REQUIRED"));
 const value=await draft(f,{sessionId:"synthetic-session"});assert.equal(value.contract.execution.reasoningEffort,"low");
 f.source.sessions[0]!.busy=true;await assert.rejects(f.session.commit(value.draftId,value.digest),hasCode("SESSION_REQUIRED"));assert.equal(f.enqueued,0);
});
test("journal reads are zero-creation, worker claims are durable and singular, and corruption is rejected",async t=>{
 const f=fixture(t),value=await draft(f),file=path.join(f.dir,"state","requests.sqlite"),journal=new DesktopDispatchJournal(file);
 assert.equal(journal.receipt(value.draftId),null);assert.equal(fs.existsSync(file),false);
 journal.enqueue(value);assert.equal(journal.receipt(value.draftId)!.state,"launch_requested");
 assert.deepEqual(journal.claim(value.draftId),value);assert.equal(new DesktopDispatchJournal(file).claim(value.draftId),null);
 journal.finish(value.draftId,"outcome_unknown","OUTCOME_UNKNOWN","Query the original operation");
 assert.equal(new DesktopDispatchJournal(file).receipt(value.draftId)!.operationId,value.operationId);
 const raw=new DatabaseSync(file);raw.prepare("UPDATE desktop_dispatch_requests SET body='{}'").run();raw.close();assert.throws(()=>journal.receipt(value.draftId));
});
test("legacy database is refused before migration and its bytes stay unchanged",t=>{
 const f=fixture(t),file=path.join(f.dir,"legacy.sqlite"),db=new DatabaseSync(file);db.exec("CREATE TABLE tasks(task_id TEXT PRIMARY KEY)");db.close();
 const before=fs.readFileSync(file);assert.throws(()=>assertDesktopDispatchDatabase({dbFile:file} as Config),hasCode("GATEWAY_UPGRADE_REQUIRED"));assert.deepEqual(fs.readFileSync(file),before);
});
test("trusted agreement uses real T4/T5 admission and stores terms before the fake native boundary",async t=>{
 const f=fixture(t),value=await draft(f),config={backend:"desktop-queue",dbFile:path.join(f.dir,"tasks.sqlite"),runsDir:path.join(f.dir,"runs"),maxTaskAttempts:3,taskTimeoutSeconds:600,claimTimeoutSeconds:30,serviceConfigFile:path.join(f.dir,"service.json"),workbuddyConfigDir:f.dir} as Config;
 const store=new TaskStore(config.dbFile);f.cleanup.push(()=>store.close());let preparations=0,prompts=0;
 const client={sendMessage:async()=>{prompts++;return {};},runSnapshot:()=>null} as unknown as WorkBuddyClient;
 const coordinator=new TaskCoordinator(config,store,client,async(_config,input)=>{preparations++;assert.equal(store.getContract(value.taskId).state,"found");return {workspace:input.workspace,sessionId:"synthetic-session"};},async(_config,sessionId,modelId)=>({sessionId,modelId,selectedModel:modelId,credits:null,observedAt:new Date().toISOString(),level:"selected"}));
 const service=new TaskApplicationService(coordinator,3,config.runsDir!);
 assertDesktopDispatchDatabase(config);
 const result=await sendDesktopAgreement(service,value);assert.equal(result.ok,true);assert.equal(preparations,1);assert.equal(prompts,1);
 assert.equal(store.operations.get(value.operationId)!.state,"succeeded");assert.equal(store.getContract(value.taskId).state,"found");
 const admission=store.collaboration.getTaskAdmission(value.taskId)!;assert.equal(admission.execution.modelId,"synthetic-model");assert.equal(admission.workspace.realPath,f.project);
 const second=await draft(f);await assert.rejects(sendDesktopAgreement(service,second));assert.equal(preparations,1);assert.equal(prompts,1);
});
