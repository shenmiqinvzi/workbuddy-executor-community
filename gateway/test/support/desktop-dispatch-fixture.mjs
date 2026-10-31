// Explicit synthetic test harness, excluded from release packaging. It refuses
// every database outside the marked fixture root. It has no native provider.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadDotEnv} from '../../dist/env.js';
import {loadConfig} from '../../dist/config.js';
import {TaskStore} from '../../dist/task-store.js';
import {TaskCoordinator} from '../../dist/coordinator.js';
import {DshTaskCoordinator} from '../../dist/dsh-coordinator.js';
import {TaskApplicationService} from '../../dist/task-application-service.js';
import {WorkbenchHttpServer,workbenchHealth} from '../../dist/workbench-http.js';
import {DesktopDispatchSession} from '../../dist/desktop-dispatch.js';
import {DesktopDispatchJournal} from '../../dist/desktop-dispatch-journal.js';
import {defaultModelPolicy} from '../../dist/collaboration.js';
import {sendDesktopAgreement} from '../../dist/desktop-dispatch-runtime.js';
import {installDesktopCommands} from '../../scripts/workbench-desktop-commands.mjs';

loadDotEnv();
const config=loadConfig(),root=process.env.WORKBENCH_SYNTHETIC_ROOT;
if(!root||!path.isAbsolute(root)||!fs.existsSync(path.join(root,'.synthetic-workbench')))throw Error('Marked synthetic fixture root required.');
const canonical=fs.realpathSync.native(root);
if(!path.resolve(config.dbFile).startsWith(canonical+path.sep)||!path.resolve(config.runsDir||'').startsWith(canonical+path.sep))throw Error('Fixture cannot open an external task database or runs directory.');
const project=path.join(canonical,'project'),stateFile=path.join(canonical,'fixture-requests.sqlite'),journal=new DesktopDispatchJournal(stateFile);
const store=new TaskStore(config.dbFile),statsFile=path.join(canonical,'actor-stats.json');
function count(name){let stats={};try{stats=JSON.parse(fs.readFileSync(statsFile))}catch{}stats[name]=(stats[name]||0)+1;fs.writeFileSync(statsFile,JSON.stringify(stats,null,2));}
const nativeClient={sendMessage:async()=>{count('workbuddyPrompts');return{}},runSnapshot:()=>null,messages:async()=>[]};
const coordinator=new TaskCoordinator(config,store,nativeClient,async(_config,input)=>{count('workbuddyPreparations');return{workspace:input.workspace,sessionId:'synthetic-workbuddy-session'}},async(_config,sessionId,modelId)=>({sessionId,modelId,selectedModel:modelId,credits:'x0.00',observedAt:new Date().toISOString(),level:'selected'}));
let selectedModel=null;
const session={sessionId:'synthetic-dsh-session',workspace:project,attached:true,busy:false};
const dshClient={resolveHostId:()=> 'synthetic-dsh-host',health:async()=>({}),sessions:async()=>({sessions:[session]}),create:async()=>{throw Error('Fixture never creates a DSH session')},session:async()=>({...session,selectedModel}),
 models:async()=>({models:[{providerId:'synthetic-provider',modelId:'synthetic-dsh-model',reasoningEfforts:['low','high'],credits:null}],pricingVerified:false}),
 selectModel:async({providerId,modelId,reasoningEffort})=>{count('dshSelections');selectedModel={providerId,modelId,reasoningEffort};return{...session,selectedModel}},
 prompt:async({requestId})=>{count('dshPrompts');return{requestId,accepted:true}},events:async({afterSeq})=>({events:[],cursor:afterSeq}),cancel:async()=>{throw Error('Fixture does not cancel native work')}};
const service=new TaskApplicationService(coordinator,3,config.runsDir,new DshTaskCoordinator(store,dshClient,config.runsDir));
if(process.argv.includes('--fixture-worker')){
 const id=process.argv.at(-1),draft=journal.claim(id);
 if(draft){
  try{await new Promise(resolve=>setTimeout(resolve,1500));const result=await sendDesktopAgreement(service,draft);if(!result.ok)throw Error('Synthetic dispatch not accepted');journal.finish(id,'submitted');}
  catch{journal.finish(id,'failed','SYNTHETIC_REJECTED','合成请求未完成，未连接真实执行器。');}
 }
 store.close();
}else{
 const models=[{execution:{executorId:'workbuddy',connectionId:'local-workbuddy',providerId:'workbuddy-native',modelId:'synthetic-workbuddy-model',reasoningEffort:null},credits:'x0.00',pricingVerified:true},...['low','high'].map(reasoningEffort=>({execution:{executorId:'dsh',connectionId:'synthetic-dsh-host',providerId:'synthetic-provider',modelId:'synthetic-dsh-model',reasoningEffort},credits:null,pricingVerified:false}))];
 const dispatch=new DesktopDispatchSession({catalog:async()=>({models,sessions:[{hostId:'synthetic-dsh-host',...session}],policy:defaultModelPolicy(),requiredFreeModel:null,dispatchEnabled:true,errors:['合成验证：未连接真实执行器，不产生模型调用。']}),receipt:id=>journal.receipt(id),latest:()=>journal.latest(),
 observe:async id=>{const draft=journal.request(id);if(!draft)throw Error('Missing fixture request');await service.sync(draft.taskId);return{taskId:draft.taskId,observedAt:new Date().toISOString()}},
 enqueue:async draft=>{
  if(draft.workspace.realPath!==project)throw Error('Only the marked synthetic project is allowed.');
  if(journal.receipt(draft.draftId))return journal.receipt(draft.draftId);
  journal.enqueue(draft);
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--fixture-worker',draft.draftId],{cwd:process.cwd(),env:process.env,detached:true,windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();return journal.receipt(draft.draftId);
 }});
 const server=new WorkbenchHttpServer({service,health:()=>workbenchHealth({runtime:{release:'synthetic-validation',pid:process.pid,startedAt:new Date().toISOString(),codeHash:'synthetic'}})});
 const port=await server.listen(0);console.log(JSON.stringify({event:'desktop_host_ready',port,readOnly:true,desktopCommands:true,syntheticValidation:true}));
 installDesktopCommands(dispatch);process.stdin.resume();
 process.stdin.once('end',()=>void server.close().finally(()=>{store.close();process.exit(0)}));
}
