import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal } from "../src/run-journal.js";
import { PersistentDesktopService, type NativeDesktopTrigger, type ServiceRegistration } from "../src/persistent-service.js";
import { defaultModelPolicy as userChoicePolicy, legacyFreeModelPolicy as defaultModelPolicy, type ModelObservation } from "../src/collaboration.js";
import { validateTaskContract, validateSupportedTaskContract, TASK_CONTRACT_V2_SCHEMA_VERSION } from "../src/task-contract.js";

function v1(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "workbuddy-executor/vnext-1", taskId: "contract-task", workspaceId: "project", title: "修复合成边界",
    objective: "Synthetic contract fixture", model: "deepseek-v4.1-flash", timeoutSeconds: 60, maxAttempts: 2,
    scope: { allowedChanges: ["src/example.ts"], permittedMetadata: [] }, requiredChecks: [], ...overrides };
}
function v2(overrides: Record<string, unknown> = {}) {
  const { model: _model, ...common } = v1();
  return { ...common, schemaVersion: TASK_CONTRACT_V2_SCHEMA_VERSION, execution: defaultModelPolicy().allowed[0]!,
    collaboration: { planId: "proposal-placeholder", expectedPlanRevision: "proposal-placeholder" }, ...overrides };
}

function fixture(t: { after: (fn: () => void) => void }) {
  // Windows runners may expose TEMP through an 8.3 alias. The registry stores
  // real paths, so the synthetic native registration must use that same path.
  // Otherwise this fixture tests a workspace-binding mismatch before dispatch.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "contract-admission-")));
  const project = path.join(dir, "project"); fs.mkdirSync(project);
  const config: Config = { backend: "desktop-queue", apiBaseUrl: "http://127.0.0.1:9", tokenFile: path.join(dir,"unused.json"),
    dbFile: path.join(dir,"tasks.sqlite"), runsDir: path.join(dir,"runs"), oauthRedirectUri: "http://127.0.0.1:0", oauthPort:0,
    oauthScopes:"test", requestTimeoutMs:1000, cliElectronPath:path.join(dir,"missing.exe"), cliScriptPath:path.join(dir,"missing-cli"),
    cliPermissionMode:"deny", acpPermissionMode:"deny", gatewayUrl:"http://127.0.0.1:0", workbuddyConfigDir:dir,
    taskTimeoutSeconds:600, claimTimeoutSeconds:30, maxTaskAttempts:3, serviceConfigFile:path.join(dir,"service.json") };
  const native = new DatabaseSync(path.join(dir,"workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?,?,1,NULL)").run("synthetic-session", project); native.close();
  const store = new TaskStore(config.dbFile), client = new WorkBuddyClient(config);
  store.collaboration.setPolicy(defaultModelPolicy());
  let preparations = 0, observations = 0;
  let prepareHook: (() => Promise<void>) | undefined;
  let observation: Partial<ModelObservation> = {};
  const coordinator = new TaskCoordinator(config, store, client, async (_config, input) => {
    preparations++; assert.equal(store.getContract("contract-task").state,"found","terms must precede model preparation");
    if (prepareHook) await prepareHook();
    return { workspace: input.workspace, sessionId: "synthetic-session" };
  }, async (_config, sessionId, modelId) => {
    observations++;
    return { sessionId, modelId, selectedModel:modelId, credits:"x0.00", observedAt:new Date().toISOString(), level:"selected", ...observation };
  });
  const service = new TaskApplicationService(coordinator,3,config.runsDir!);
  const registration = service.registerWorkspace("project", project, "Synthetic project");
  const queue = new DesktopQueue(config,()=>({desktopPid:process.pid}));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
  const send = (contract: ReturnType<typeof v1> | ReturnType<typeof v2>) => service.send({taskId:contract.taskId,objective:contract.objective,contract});
  function approved(overrides: Record<string,unknown> = {}) {
    const contract = v2(overrides);
    const plan = service.createCollaborationPlan(contract,{mode:"recommend",reason:"Explicit bounded fixture"});
    service.authorizeCollaborationPlan(plan.planId,plan.revision,"synthetic-user-action");
    return {...contract, collaboration:{planId:plan.planId,expectedPlanRevision:plan.revision}};
  }
  async function claim() {
    const task=store.get("contract-task")!;
    // Synthetic wake-service receipt, confined to this fixture; this is not
    // evidence that a real WorkBuddy model was selected or executed.
    fs.writeFileSync(path.join(config.runsDir!,task.attemptId!,"model-ready.json"),JSON.stringify({model:"deepseek-v4.1-flash",sessionId:"synthetic-session",attemptId:task.attemptId}));
    const result=await queue.claim("synthetic-session",0);
    if(result.status!=="task")throw new Error("Synthetic fixture was not claimed");
    return result;
  }
  return {dir,project,config,store,client,coordinator,service,queue,registration,send,approved,claim,
    preparations:()=>preparations, observations:()=>observations, setObservation:(patch:Partial<ModelObservation>)=>{observation=patch;},
    setPrepareHook:(hook:()=>Promise<void>)=>{prepareHook=hook;}};
}

test("v1 remains strict and its digest is unchanged; v2 has an explicit parser",()=>{
  const legacy=validateTaskContract(v1()); assert.equal(legacy.ok,true);
  if(legacy.ok)assert.equal(legacy.contractHash,"fc06b92eb273c82fd45b44086d18eba90991d6d0ebf94a50ca7a51b8b1fef211","baseline 6b278d0 v1 digest must stay identical");
  assert.deepEqual(validateSupportedTaskContract(v1()),legacy);
  assert.equal(validateTaskContract(v2()).ok,false);
  const modern=validateSupportedTaskContract(v2()); assert.equal(modern.ok,true);
  if(modern.ok)assert.equal("model" in modern.contract,false);
  for(const bad of [v2({model:"injected"}),v2({execution:{...defaultModelPolicy().allowed[0],verified:true}}),v2({collaboration:{planId:"a",expectedPlanRevision:"b",approved:true}})])assert.equal(validateSupportedTaskContract(bad).ok,false);
});

test("v2 cannot be persisted by a storage-only caller without trusted admission",t=>{
  const f=fixture(t);
  assert.equal(f.store.createTaskWithContract({taskId:"contract-task",messageId:"pending",state:"queued"},v2(),{maxAttempts:3}).status,"rejected");
  assert.equal(f.store.get("contract-task"),undefined);
});

test("a historical storage-only v1 contract cannot be promoted into native rework",async t=>{
  const f=fixture(t);
  const created=f.store.createTaskWithContract({taskId:"contract-task",messageId:"pending",state:"blocked",workspace:f.project,sessionId:"synthetic-session"},v1(),{maxAttempts:3});
  assert.equal(created.status,"created");
  await assert.rejects(f.coordinator.continue({taskId:"contract-task",feedback:"retry stored terms"}),{code:"MODEL_UNVERIFIED"});
  assert.equal(f.store.listAttempts("contract-task").length,0);assert.equal(f.observations(),0);
});

test("a real queue dispatch persists the selected model and the exact reserved deadline",async t=>{
  const f=fixture(t), contract=f.approved();
  const result=await f.send(contract); assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(result.created,true);
  const task=f.store.get(contract.taskId)!;
  assert.equal(task.workspace,f.registration.realPath);assert.equal(task.attempt,1);
  const admission=f.store.collaboration.getTaskAdmission(task.taskId)!;
  assert.equal(admission.execution.modelId,contract.execution.modelId);
  assert.equal(f.service.getCollaborationPlan(contract.collaboration.planId).consumedBy,task.taskId);
  const attempt=f.store.collaboration.getAttempt(task.attemptId!)!;
  const snapshot=new RunJournal(f.config.runsDir!,task.attemptId!).snapshot()!;
  assert.equal(snapshot.deadline,attempt.deadlineAt);assert.equal(attempt.model.level,"selected");
  const request=JSON.parse(fs.readFileSync(path.join(f.config.runsDir!,task.attemptId!,"request.json"),"utf8"));
  assert.equal(request.model,contract.execution.modelId);assert.equal(request.timeoutSeconds,60);assert.equal(request.deadline,attempt.deadlineAt);
  assert.equal(f.preparations(),1);assert.equal(f.observations(),1);
});

test("concurrent identical submissions create one task and prepare one native session",async t=>{
  const f=fixture(t),contract=f.approved();
  const results=await Promise.all([f.send(contract),f.send(contract)]);
  assert.equal(results.filter(r=>r.created).length,1);assert.equal(f.preparations(),1);
  assert.equal(f.store.listAttempts(contract.taskId).length,1);
  const revision=f.store.get(contract.taskId)!.revision;
  await f.send(contract); assert.equal(f.store.get(contract.taskId)!.revision,revision);assert.equal(f.observations(),1);
});

test("unconfirmed and stale plans cannot create a task",async t=>{
  const f=fixture(t),contract=v2();
  const plan=f.service.createCollaborationPlan(contract,{mode:"recommend",reason:"Wait for actual user"});
  const input={...contract,collaboration:{planId:plan.planId,expectedPlanRevision:plan.revision}};
  await assert.rejects(f.send(input),{code:"PLAN_CONFIRMATION_REQUIRED"});
  await assert.rejects(f.send({...input,collaboration:{...input.collaboration,expectedPlanRevision:"old"}}),{code:"PLAN_STALE"});
  assert.equal(f.store.get(contract.taskId),undefined);assert.equal(f.preparations(),0);
});

test("policy changes after plan authorization invalidate dispatch without native work",async t=>{
  const f=fixture(t),contract=f.approved();
  f.store.collaboration.setPolicy({...defaultModelPolicy(),maxAttempts:1});
  await assert.rejects(f.send(contract),{code:"POLICY_CHANGED"});
  assert.equal(f.store.get(contract.taskId),undefined);assert.equal(f.preparations(),0);
});

test("the same authorized plan cannot be consumed by another task identity",async t=>{
  const f=fixture(t),contract=f.approved();await f.send(contract);
  await assert.rejects(f.send({...contract,taskId:"another-task"}),{code:"PLAN_STALE"});
  assert.equal(f.store.get("another-task"),undefined);assert.equal(f.preparations(),1);
});

test("changed terms or legacy model/check overrides do not reuse plan authorization",async t=>{
  const f=fixture(t),contract=f.approved();
  await assert.rejects(f.send({...contract,title:"Changed title"}),{code:"PLAN_STALE"});
  await assert.rejects(f.service.send({objective:contract.objective,contract,model:"other"}),{code:"TASK_CONFLICT"});
  await assert.rejects(f.service.send({objective:contract.objective,contract,acceptanceCommands:["injected"]}),{code:"TASK_CONFLICT"});
  assert.equal(f.preparations(),0);assert.equal(f.store.get(contract.taskId),undefined);
});

test("failed preparation remains the original task and replay never starts another worker",async t=>{
  const f=fixture(t),contract=f.approved();f.setPrepareHook(async()=>{throw Error("synthetic connection failure");});
  await assert.rejects(f.send(contract),/synthetic connection failure/);
  assert.equal(f.store.get(contract.taskId)!.state,"blocked");
  const replay=await f.send(contract);assert.equal(replay.created,false);assert.equal(f.preparations(),1);
  assert.equal(f.store.listAttempts(contract.taskId).length,0);
});

test("actual selection mismatch and paid/unknown catalog rates cannot reserve an attempt",async t=>{
  for(const patch of [{selectedModel:"other"},{sessionId:"other"},{credits:"x1.00"},{credits:"unknown"},{observedAt:"invalid"}]){
    const f=fixture(t),contract=f.approved();f.setObservation(patch);
    await assert.rejects(f.send(contract),{code:"MODEL_UNVERIFIED"});
    assert.equal(f.store.get(contract.taskId)!.state,"blocked");assert.equal(f.store.listAttempts(contract.taskId).length,0);
  }
});

test("a policy revocation committed during model preparation blocks the first prompt",async t=>{
  const f=fixture(t),contract=f.approved();
  f.setPrepareHook(async()=>{const second=new TaskStore(f.config.dbFile);try{second.collaboration.setPolicy({...defaultModelPolicy(),allowed:[]});}finally{second.close();}});
  await assert.rejects(f.send(contract),{code:"MODEL_POLICY_BLOCKED"});
  assert.equal(f.store.listAttempts(contract.taskId).length,0);
});

test("directory identity replacement cannot silently reuse a registered workspace",async t=>{
  const f=fixture(t),contract=f.approved();
  fs.renameSync(f.project,`${f.project}-old`);fs.mkdirSync(f.project);
  await assert.rejects(f.send(contract),{code:"WORKSPACE_CONFLICT"});assert.equal(f.preparations(),0);
});

test("admission and plan consumption roll back when task creation fails",async t=>{
  const f=fixture(t),contract=f.approved();
  const db=new DatabaseSync(f.config.dbFile);
  db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON task_admissions BEGIN SELECT RAISE(ABORT,'synthetic atomic failure'); END");db.close();
  await assert.rejects(f.send(contract),/synthetic atomic failure/);
  assert.equal(f.store.get(contract.taskId),undefined);assert.equal(f.store.getContract(contract.taskId).state,"absent");
  assert.equal(f.service.getCollaborationPlan(contract.collaboration.planId).consumedBy,null);
  assert.equal(f.preparations(),0);
});

test("saved contract attempt budget survives a higher current global configuration",async t=>{
  const f=fixture(t),contract=f.approved({maxAttempts:1});await f.send(contract);
  const claim=await f.claim();
  await f.coordinator.sync(contract.taskId);
  f.queue.report({...claim,status:"completed",text:"TASK_STATUS: completed\nSynthetic done",artifacts:[]});
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.project});
  await f.coordinator.sync(contract.taskId);
  f.config.maxTaskAttempts=10;
  await assert.rejects(f.coordinator.continue({taskId:contract.taskId,feedback:"another round"}),/attempt limit/i);
  assert.equal(f.store.listAttempts(contract.taskId).length,1);
  assert.equal(f.service.statusView(f.store.get(contract.taskId)!).allowedActions.includes("rework"),false);
});

test("rework keeps model/duration and observes the original session without changing it",async t=>{
  const f=fixture(t),contract=f.approved();await f.send(contract);
  const claim=await f.claim();await f.coordinator.sync(contract.taskId);
  f.queue.report({...claim,status:"completed",text:"TASK_STATUS: completed\nSynthetic done",artifacts:[]});
  f.queue.observeNative(claim.attemptId,{state:"idle",workspace:f.project});await f.coordinator.sync(contract.taskId);
  await assert.rejects(f.coordinator.continue({taskId:contract.taskId,feedback:"fix",model:"other"}),{code:"TASK_CONFLICT"});
  await assert.rejects(f.coordinator.continue({taskId:contract.taskId,feedback:"fix",timeoutSeconds:120}),{code:"TASK_CONFLICT"});
  const next=await f.coordinator.continue({taskId:contract.taskId,feedback:"fix"});assert.equal(next.ok,true);
  assert.equal(f.preparations(),1);assert.equal(f.observations(),2);assert.equal(f.store.get(contract.taskId)!.attempt,2);
});

test("expired reservations are rejected before request creation",t=>{
  const f=fixture(t),attemptId=RunJournal.newId();
  assert.throws(()=>f.queue.start({taskId:"contract-task",attemptId,prompt:"fixture",workspace:f.project,sessionId:"synthetic-session",timeoutSeconds:60,deadline:new Date(Date.now()-1).toISOString()}),/deadline/);
  assert.equal(fs.existsSync(path.join(f.config.runsDir!,attemptId,"request.json")),false);
});

test("admitted models cannot claim DSH or another connection through WorkBuddy",async t=>{
  const f=fixture(t),selection={...defaultModelPolicy().allowed[0]!,executorId:"dsh" as const};
  f.store.collaboration.setPolicy({...defaultModelPolicy(),allowed:[selection]});
  const contract=f.approved({execution:selection});
  await assert.rejects(f.send(contract),{code:"EXECUTOR_UNAVAILABLE"});assert.equal(f.preparations(),0);
});

test("reads and service reconstruction preserve plan, policy and task bytes",async t=>{
  const f=fixture(t),contract=f.approved();await f.send(contract);
  const before=f.store.get(contract.taskId),events=f.store.listTaskEvents(contract.taskId).events;
  const second=new TaskStore(f.config.dbFile);
  try {
    assert.equal(second.collaboration.getPlan(contract.collaboration.planId).consumedBy,contract.taskId);
    assert.equal(second.getContract(contract.taskId).state,"found");
    assert.ok(second.collaboration.getAttempt(before!.attemptId!));
    f.service.getCollaborationPlan(contract.collaboration.planId);f.service.readStageView(contract.taskId);
    assert.deepEqual(f.store.get(contract.taskId),before);assert.deepEqual(f.store.listTaskEvents(contract.taskId).events,events);
  } finally {second.close();}
});

test("expired plans fail without a prompt or task",async t=>{
  const f=fixture(t),proposal=v2();
  const plan=f.service.createCollaborationPlan(proposal,{mode:"recommend",reason:"Expiry fixture",ttlSeconds:1});
  f.service.authorizeCollaborationPlan(plan.planId,plan.revision,"synthetic-user-action");
  const originalNow=Date.now; Date.now=()=>originalNow()+2000;
  try{await assert.rejects(f.send({...proposal,collaboration:{planId:plan.planId,expectedPlanRevision:plan.revision}}),{code:"PLAN_STALE"});}
  finally{Date.now=originalNow;}
  assert.equal(f.store.get(proposal.taskId),undefined);assert.equal(f.preparations(),0);
});

test("deleted admission and corrupted attempt records are explicit integrity failures",async t=>{
  const f=fixture(t),contract=f.approved();await f.send(contract);
  const db=new DatabaseSync(f.config.dbFile);
  try {
    db.prepare("UPDATE task_attempt_admissions SET body_json='{}' WHERE task_id=?").run(contract.taskId);
    assert.throws(()=>f.store.collaboration.getAttempt(f.store.get(contract.taskId)!.attemptId!),{code:"CONTRACT_INTEGRITY"});
    db.prepare("DELETE FROM task_admissions WHERE task_id=?").run(contract.taskId);
    assert.equal(f.store.getContract(contract.taskId).state,"integrity_failure");
    const view=f.service.readStageView(contract.taskId);assert.equal(view.ok,false);
    if(!view.ok)assert.equal(view.code,"contract_integrity");
  }finally{db.close();}
});

test("two real SQLite processes cannot consume one plan under different task IDs",{timeout:20_000},async t=>{
  const f=fixture(t),contract=f.approved();
  function worker(taskId:string) {
    const input=path.join(f.dir,`${taskId}.json`);fs.writeFileSync(input,JSON.stringify({...contract,taskId}));
    const child=spawn(process.execPath,["--import",new URL("./support/typescript-loader.mjs",import.meta.url).href,fileURLToPath(new URL("./support/admission-race-worker.ts",import.meta.url)),f.config.dbFile,input],{stdio:["pipe","pipe","pipe"],windowsHide:true});
    let output="",errors="";let readyResolve!:()=>void;let readyReject!:(error:Error)=>void;
    const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes("READY\n"))readyResolve();});
    child.stderr.on("data",chunk=>{errors+=chunk.toString();});
    const done=new Promise<{status?:string;code?:string}>((resolve,reject)=>{
      child.on("error",error=>{readyReject(error);reject(error);});child.on("close",code=>{if(!output.includes("READY\n"))readyReject(Error(errors || "Worker closed before readiness"));if(code!==0)return reject(Error(errors));
        resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1)!));});
    });
    void done.catch(()=>{});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    return {child,ready,done};
  }
  const a=worker("race-a"),b=worker("race-b");
  await Promise.all([a.ready,b.ready]);a.child.stdin.end("GO\n");b.child.stdin.end("GO\n");
  const results=await Promise.all([a.done,b.done]);
  assert.equal(results.filter(r=>r.status==="created").length,1);assert.equal(results.filter(r=>r.code==="PLAN_STALE").length,1);
  assert.equal(f.store.listTasks().length,1);assert.equal(f.preparations(),0);
});

test("native wake rechecks free rate, policy and deadline instead of trusting preflight",async t=>{
  for(const variant of ["ok","paid","revoked","during-catalog","wrong-session","deadline"]){
    const f=fixture(t),contract=f.approved();await f.send(contract);let wakes=0;
    if(variant==="revoked")f.store.collaboration.setPolicy({...defaultModelPolicy(),allowed:[]});
    const task=f.store.get(contract.taskId)!,journal=new RunJournal(f.config.runsDir!,task.attemptId!);
    if(variant==="deadline"){
      const request=journal.request();fs.writeFileSync(path.join(journal.dir,"request.json"),JSON.stringify({...request,deadline:new Date(Date.now()+120000).toISOString()}));
    }
    const trigger:NativeDesktopTrigger={
      inspect:async()=>({state:"idle",workspace:f.registration.realPath}),
      setModel:async(sessionId,model)=>({sessionId,model}),
      listModels:async()=>{
        if(variant==="during-catalog")f.store.collaboration.setPolicy({...defaultModelPolicy(),allowed:[]});
        return {models:[{id:contract.execution.modelId,credits:variant==="paid"?"x1.00":"x0.00"}],currentModel:contract.execution.modelId,sessionId:variant==="wrong-session"?"other":"synthetic-session"};
      },
      wakeIdle:async()=>{wakes++;return {accepted:true,receipt:"synthetic-receipt"};},
    };
    const registration:ServiceRegistration={version:1,sessionId:"synthetic-session",workspace:f.registration.realPath,projectDir:path.dirname(f.dir),nodeBin:process.execPath,cdpPort:18491,dbFile:f.config.dbFile,runsDir:f.config.runsDir!,workbuddyConfigDir:f.dir,cliElectronPath:f.config.cliElectronPath};
    const result=await new PersistentDesktopService(f.config,registration,trigger,f.store).pump();
    assert.equal(wakes,variant==="ok"?1:0,`${variant}: wake must be admitted independently`);
    assert.equal(result.status,variant==="ok"?"wake_submitted":"wake_rejected");
    assert.equal(fs.existsSync(path.join(journal.dir,"model-ready.json")),variant==="ok");
  }
});


test("new defaults have no fixed model and v1 cannot bypass user confirmation", async t => {
  const f = fixture(t), policy = userChoicePolicy();
  assert.equal(policy.requireFree, false); assert.equal(policy.selectionMode, "user_choice"); assert.deepEqual(policy.allowed, []);
  f.store.collaboration.setPolicy(policy);
  await assert.rejects(f.send(v1()), { code: "PLAN_CONFIRMATION_REQUIRED" }); assert.equal(f.preparations(), 0);
});

test("WorkBuddy user-selected paid and unknown models survive independent wake verification", async t => {
  for (const credits of ["x2.50", null]) {
    const f = fixture(t); f.store.collaboration.setPolicy(userChoicePolicy());
    const contract = f.approved({execution:{ ...defaultModelPolicy().allowed[0]!, modelId:"user-chosen-native-model" }});
    f.setObservation({credits}); await f.send(contract); let wakes=0;
    const task=f.store.get(contract.taskId)!, attempt=f.store.collaboration.getAttempt(task.attemptId!)!;
    assert.equal(attempt.model.modelId, "user-chosen-native-model"); assert.equal(attempt.model.credits, credits);
    const trigger:NativeDesktopTrigger={
      inspect:async()=>({state:"idle",workspace:f.registration.realPath}),
      setModel:async(sessionId,model)=>({sessionId,model}),
      listModels:async()=>({models:[{id:contract.execution.modelId,credits}],currentModel:contract.execution.modelId,sessionId:"synthetic-session"}),
      wakeIdle:async()=>{wakes++;return {accepted:true,receipt:"synthetic-receipt"};},
    };
    const registration:ServiceRegistration={version:1,sessionId:"synthetic-session",workspace:f.registration.realPath,projectDir:path.dirname(f.dir),nodeBin:process.execPath,cdpPort:18491,dbFile:f.config.dbFile,runsDir:f.config.runsDir!,workbuddyConfigDir:f.dir,cliElectronPath:f.config.cliElectronPath};
    assert.equal((await new PersistentDesktopService(f.config,registration,trigger,f.store).pump()).status,"wake_submitted"); assert.equal(wakes,1);
  }
});
