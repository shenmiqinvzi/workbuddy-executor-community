import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { discoverDesktopPaths, supportedNode } from '../src/deployment-paths.js';
import { diagnose, APPROVED_FREE_MODEL } from '../src/doctor.js';
import { setup, assertInstallationIdle } from '../src/setup.js';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { NativeDesktopRpcTrigger } from '../src/native-desktop-trigger.js';
import { serviceProcessToStop, verifyServiceProcess } from '../src/service-cli.js';
import { TaskStore } from '../src/task-store.js';
import { RunJournal } from '../src/run-journal.js';
import { loadConfig } from '../src/config.js';
import { checkDeploymentTask } from '../src/deployment-acceptance.js';
import type { ServiceRegistration } from '../src/persistent-service.js';

const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t: {after:(f:()=>void)=>void}) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'workbuddy-deployment-'));
  const cleanup:Array<()=>void>=[];
  t.after(()=>{for(const close of cleanup)close();fs.rmSync(temp,{recursive:true,force:true});});
  const root=path.join(temp,'安装 directory'),codexHome=path.join(temp,'独立 codex home'),config=path.join(temp,'native config'),app=path.join(temp,'WorkBuddyAI.exe');
  fs.mkdirSync(path.join(root,'dist'),{recursive:true});fs.mkdirSync(path.join(root,'scripts'),{recursive:true});fs.mkdirSync(config);
  fs.writeFileSync(path.join(root,'dist/server.js'),'export {};');fs.writeFileSync(app,'fixture, never executed');
  const db=new DatabaseSync(path.join(config,'workbuddy.db'));db.exec('CREATE TABLE sessions(id TEXT,cwd TEXT,is_playground INTEGER,deleted_at TEXT)');db.close();
  fs.copyFileSync(path.join(source,'scripts/install-skill.mjs'),path.join(root,'scripts/install-skill.mjs'));
  for(const name of ['SKILL.md','agents/openai.yaml','references/setup.md','references/execution.md','references/dispatch.md','references/agent-hub.md']) {
    const file=path.join(root,'skills/workbuddy-executor',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`fixture ${name}`);
  }
  const env={WORKBUDDY_CLI_ELECTRON:app,WORKBUDDY_CONFIG_DIR:config,WORKBUDDY_REQUIRED_FREE_MODEL:APPROVED_FREE_MODEL};
  return {temp,root,codexHome,config,app,env,dispose:(close:()=>void)=>cleanup.push(close),options:{root,codexHome,env,platform:'win32' as const,apply:true}};
}
test('Node floor matches package; invalid explicit paths never fall back',t=>{
  assert.equal(supportedNode('22.12.9'),false);assert.equal(supportedNode('22.13.0'),true);assert.equal(supportedNode('24.0.0'),true);
  const f=fixture(t),missing=path.join(f.temp,'missing.exe');
  const found=discoverDesktopPaths({env:{...f.env,WORKBUDDY_CLI_ELECTRON:missing},runningExecutables:()=>[f.app]});
  assert.equal(found.executable.value,missing);assert.equal(found.executable.source,'environment');
});
test('data directory discovery requires a native database and refuses ambiguity',t=>{
  const f=fixture(t),home=path.join(f.temp,'home');
  for(const name of ['.workbuddy','.workbuddy-ai']){fs.mkdirSync(path.join(home,name),{recursive:true});fs.writeFileSync(path.join(home,name,'workbuddy.db'),'fixture');}
  const found=discoverDesktopPaths({env:{},home,platform:'win32',runningExecutables:()=>[]});
  assert.equal(found.config.source,'ambiguous');assert.equal(found.config.value,undefined);
});
test('doctor is read only, supports Windows, and never treats static setup as execution',async t=>{
  const f=fixture(t),before=fs.readdirSync(f.root);
  const report=await diagnose({...f.options,live:false});
  assert.equal(report.ok,true);assert.equal(report.checks.platformSupported,true);assert.equal(report.connection,'not_checked');assert.equal(report.taskExecutionVerified,false);
  assert.deepEqual(fs.readdirSync(f.root),before);assert.equal(fs.existsSync(path.join(f.root,'data')),false);
  const unknown=await diagnose({...f.options,live:true,probe:async()=>({bridgeReady:true,models:[{id:APPROVED_FREE_MODEL}]})});
  assert.equal(unknown.ok,false);assert.equal(unknown.modelPolicy,'unknown');
  const paid=await diagnose({...f.options,live:true,probe:async()=>({bridgeReady:true,models:[{id:APPROVED_FREE_MODEL,credits:'x1.00'}]})});
  assert.equal(paid.modelPolicy,'blocked');
  const valid=await diagnose({...f.options,live:true,probe:async()=>({bridgeReady:true,models:[{id:APPROVED_FREE_MODEL,credits:'x0.00'}]})});
  assert.equal(valid.ok,true);assert.equal(valid.login,'unknown');assert.equal(valid.taskSent,false);
});
test('plan writes nothing; install repeats safely in paths with spaces and Unicode',t=>{
  const f=fixture(t);setup('plan',f.options);
  assert.equal(fs.existsSync(f.codexHome),false);assert.equal(fs.existsSync(path.join(f.root,'.env')),false);
  assert.equal(setup('install',f.options).changed,true);
  const env=fs.readFileSync(path.join(f.root,'.env'),'utf8');
  const snippet=fs.readFileSync(path.join(f.root,'data/workbuddy-mcp.toml'),'utf8');
  assert.ok(snippet.includes('[mcp_servers.workbuddy]'));assert.ok(snippet.includes(f.root.replaceAll('\\','/')));
  assert.equal(setup('install',f.options).unchanged,true);assert.equal(fs.readFileSync(path.join(f.root,'.env'),'utf8'),env);
  assert.equal(fs.existsSync(path.join(f.codexHome,'config.toml')),false);
});
test('existing config, modified skills and snippets are preserved',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'.env'),'WORKBUDDY_BACKEND=api\nPRIVATE_SENTINEL=keep\n');
  assert.throws(()=>setup('install',f.options),/preserved/);assert.ok(fs.readFileSync(path.join(f.root,'.env'),'utf8').includes('PRIVATE_SENTINEL=keep'));
  fs.unlinkSync(path.join(f.root,'.env'));
  fs.mkdirSync(path.join(f.root,'data'),{recursive:true});fs.writeFileSync(path.join(f.root,'data/workbuddy-mcp.toml'),'unmanaged configuration');
  assert.throws(()=>setup('install',f.options),/unmanaged/);assert.equal(fs.readFileSync(path.join(f.root,'data/workbuddy-mcp.toml'),'utf8'),'unmanaged configuration');
  fs.unlinkSync(path.join(f.root,'data/workbuddy-mcp.toml'));setup('install',f.options);
  const skill=path.join(f.codexHome,'skills/workbuddy-executor/SKILL.md');fs.appendFileSync(skill,'user modification');
  assert.throws(()=>setup('upgrade',f.options),/local changes/);assert.throws(()=>setup('uninstall',f.options),/local changes/);
  assert.ok(fs.readFileSync(skill,'utf8').endsWith('user modification'));
});
test('upgrade uses new instructions; uninstall preserves env/history and does not restore a managed old version',t=>{
  const f=fixture(t);setup('install',f.options);
  fs.appendFileSync(path.join(f.root,'skills/workbuddy-executor/SKILL.md'),' next version');
  assert.throws(()=>setup('install',f.options),/upgrade/);setup('upgrade',f.options);
  const env=fs.readFileSync(path.join(f.root,'.env'),'utf8');fs.writeFileSync(path.join(f.root,'data/private-history.txt'),'keep');
  setup('uninstall',f.options);
  assert.equal(fs.existsSync(path.join(f.codexHome,'skills/workbuddy-executor')),false);
  assert.equal(fs.readFileSync(path.join(f.root,'.env'),'utf8'),env);assert.equal(fs.readFileSync(path.join(f.root,'data/private-history.txt'),'utf8'),'keep');
});
test('uninstall restores pre-existing skill and refuses concurrent operations',t=>{
  const f=fixture(t),old=path.join(f.codexHome,'skills/workbuddy-executor');fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'personal.txt'),'original instructions');
  setup('install',f.options);fs.writeFileSync(path.join(f.root,'data/setup-in-progress.json'),'{}');
  assert.throws(()=>setup('uninstall',f.options),/EEXIST/);assert.equal(fs.existsSync(path.join(old,'SKILL.md')),true);
  fs.unlinkSync(path.join(f.root,'data/setup-in-progress.json'));setup('uninstall',f.options);
  assert.equal(fs.readFileSync(path.join(old,'personal.txt'),'utf8'),'original instructions');
});
test('failed skill installation rolls back newly created env and setup lock',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'scripts/install-skill.mjs'),'process.exit(3)');
  assert.throws(()=>setup('install',f.options));
  assert.equal(fs.existsSync(path.join(f.root,'.env')),false);assert.equal(fs.existsSync(path.join(f.root,'data/setup-in-progress.json')),false);
});
test('active, unknown-stop and persistent-service records block changes',t=>{
  const f=fixture(t),dbFile=path.join(f.root,'data/tasks.sqlite'),attempt='run-00000000-0000-0000-0000-000000000001';fs.mkdirSync(path.dirname(dbFile));
  const db=new DatabaseSync(dbFile);db.exec('CREATE TABLE tasks(state TEXT,attempt_id TEXT)');db.prepare('INSERT INTO tasks VALUES(?,?)').run('working',attempt);db.close();
  assert.throws(()=>assertInstallationIdle(f.root,dbFile),/Unclosed/);
  const legacy=new DatabaseSync(dbFile);legacy.exec("UPDATE tasks SET state='completed'");legacy.close();assert.throws(()=>assertInstallationIdle(f.root,dbFile),/Unclosed/);
  const change=new DatabaseSync(dbFile);change.exec("UPDATE tasks SET state='cancelled'");change.close();
  const state=path.join(f.root,'data/runs',attempt,'state.json');fs.mkdirSync(path.dirname(state),{recursive:true});fs.writeFileSync(state,JSON.stringify({driver:'desktop-queue',stopReason:'end_turn'}));
  assert.throws(()=>assertInstallationIdle(f.root,dbFile),/unconfirmed/);
  fs.writeFileSync(state,JSON.stringify({driver:'desktop-queue',nativeStoppedAt:new Date().toISOString(),nativeStopSource:'native_idle'}));assert.doesNotThrow(()=>assertInstallationIdle(f.root,dbFile));
  fs.writeFileSync(path.join(f.root,'data/persistent-service.json'),'{}');assert.throws(()=>assertInstallationIdle(f.root,dbFile),/registered/);
});

test('online diagnosis observes an existing bridge without installing it or changing model policy',async()=>{
  let modelReads=0,connections=0;
  const bridge={revision:7,listModels:async()=>{modelReads++;return {models:[{id:APPROVED_FREE_MODEL,credits:'x0.00'}]};},configurePolicy:()=>{throw new Error('Policy must not change');}};
  const context={__codexNativeQueueBridgeV2:bridge};
  const observer=new NativeDesktopRpcTrigger({} as never,18491,false);
  Object.assign(observer,{connect:async(observeOnly:boolean)=>{assert.equal(observeOnly,true);connections++;},evaluateConnected:(expression:string)=>vm.runInNewContext(expression,context)});
  assert.equal((await observer.diagnoseReadOnly()).bridgeReady,true);assert.equal(modelReads,1);assert.equal(connections,1);assert.equal(context.__codexNativeQueueBridgeV2,bridge);
  delete (context as {__codexNativeQueueBridgeV2?:unknown}).__codexNativeQueueBridgeV2;
  assert.equal((await observer.diagnoseReadOnly()).bridgeReady,false);
  await assert.rejects(()=>new NativeDesktopRpcTrigger({} as never,18491,true).diagnoseReadOnly(),/autoLaunch=false/);
});
test('service PID verification rejects reused identities and unrelated Node command lines',t=>{
  const f=fixture(t),configFile=path.join(f.root,'data/persistent-service.json');
  const registration={projectDir:f.root,nodeBin:process.execPath} as ServiceRegistration;
  const row={pid:123,ppid:1,exe:process.execPath,commandLine:`"${process.execPath}" "${path.join(f.root,'dist/service-cli.js')}" run --config "${configFile}"`};
  assert.doesNotThrow(()=>verifyServiceProcess(registration,configFile,123,[row]));
  assert.throws(()=>verifyServiceProcess(registration,configFile,123,[{...row,exe:f.app}]),/ownership/);
  assert.throws(()=>verifyServiceProcess(registration,configFile,123,[{...row,commandLine:'node unrelated.js'}]),/ownership/);
  assert.throws(()=>verifyServiceProcess(registration,configFile,123,[{...row,commandLine:'"' + process.execPath + '" -e "console.log(' + path.join(f.root,'dist/service-cli.js') + ' ' + configFile + ')"'}]),/ownership/);
  assert.throws(()=>verifyServiceProcess(registration,configFile,123,[{...row,commandLine:'"' + process.execPath + '" "' + path.join(f.root,'dist/service-cli.js') + '" status --config "' + configFile + '"'}]),/ownership/);
  assert.throws(()=>verifyServiceProcess(registration,configFile,123,[{...row,commandLine:row.commandLine + ' --extra'}]),/ownership/);
  assert.throws(()=>verifyServiceProcess(registration,configFile,124,[row]),/ownership/);
  assert.equal(serviceProcessToStop(registration,configFile,[row]),123);
  assert.equal(serviceProcessToStop(registration,configFile,[]),undefined);
  assert.throws(()=>serviceProcessToStop(registration,configFile,[{...row,exe:f.app}],123),/ownership/);
  assert.throws(()=>serviceProcessToStop(registration,configFile,[row,{...row,pid:124}],123),/Multiple/);
  assert.throws(()=>serviceProcessToStop(registration,configFile,[row],-1),/Invalid/);
});
test('deployment report requires authentic saved evidence, matching identities and real rework count',t=>{
  const f=fixture(t),config={...loadConfig(),dbFile:path.join(f.root,'tasks.sqlite'),runsDir:path.join(f.root,'runs')};
  const store=new TaskStore(config.dbFile);f.dispose(()=>store.close());
  const attemptId=RunJournal.newId(),result={status:'completed',text:'fixture report',artifacts:[]};
  store.createOrGet({taskId:'fixture-task',messageId:attemptId,state:'accepted',objective:'fixture',attemptId,attempt:2,sessionId:'fixture-session',runtimeSource:'desktop_queue',evidence:['fixture independent check']});
  const journal=new RunJournal(config.runsDir,attemptId);
  const snapshot={taskId:'fixture-task',attemptId,sessionId:'fixture-session',status:'needs_review' as const,driver:'desktop-queue' as const,nativeStoppedAt:new Date().toISOString(),nativeStopSource:'native_idle' as const,updatedAt:new Date().toISOString(),reportDigest:crypto.createHash('sha256').update(JSON.stringify([result.status,result.text,result.artifacts])).digest('hex')};
  journal.save(snapshot);fs.writeFileSync(path.join(journal.dir,'worker-result.json'),JSON.stringify(result));
  assert.equal(checkDeploymentTask(config,'normal','fixture-task').status,'passed');assert.equal(checkDeploymentTask(config,'rework','fixture-task').status,'passed');
  assert.equal(checkDeploymentTask(config,'normal').status,'pending');
  journal.save({...snapshot,sessionId:'wrong-session'});assert.equal(checkDeploymentTask(config,'normal','fixture-task').status,'failed');
  journal.save(snapshot);fs.writeFileSync(path.join(journal.dir,'worker-result.json'),JSON.stringify({...result,text:'tampered'}));assert.equal(checkDeploymentTask(config,'normal','fixture-task').status,'failed');
  assert.equal(checkDeploymentTask(config,'cancel','fixture-task').status,'failed');
});


test('fresh setup and doctor do not impose a fixed or free-only model',async t=>{
  const f=fixture(t),env={WORKBUDDY_CLI_ELECTRON:f.app,WORKBUDDY_CONFIG_DIR:f.config};
  const options={...f.options,env}; setup('install',options);
  for(const file of ['.env','data/workbuddy-mcp.toml']) {
    const text=fs.readFileSync(path.join(f.root,file),'utf8');
    assert.equal(text.includes('WORKBUDDY_REQUIRED_FREE_MODEL'),false); assert.equal(text.includes(APPROVED_FREE_MODEL),false);
  }
  const report=await diagnose({...options,live:true,probe:async()=>({bridgeReady:true,models:[{id:'user-selected-model',credits:'x2.50'}]})});
  assert.equal(report.ok,true); assert.equal(report.modelPolicy,'user_choice'); assert.equal(report.checks.freePolicyEnabled,false); assert.equal(report.taskSent,false);
});

test('upgrade preserves an existing explicit restriction without imposing the old model',t=>{
  const f=fixture(t),env={WORKBUDDY_CLI_ELECTRON:f.app,WORKBUDDY_CONFIG_DIR:f.config};
  const original='WORKBUDDY_BACKEND=desktop-queue\nWORKBUDDY_REQUIRED_FREE_MODEL=another-approved-model\n';
  fs.writeFileSync(path.join(f.root,'.env'),original); setup('install',{...f.options,env});
  assert.equal(fs.readFileSync(path.join(f.root,'.env'),'utf8'),original);
  assert.ok(fs.readFileSync(path.join(f.root,'data/workbuddy-mcp.toml'),'utf8').includes('another-approved-model'));
  assert.throws(()=>setup('upgrade',f.options),/policy conflict/);
});
