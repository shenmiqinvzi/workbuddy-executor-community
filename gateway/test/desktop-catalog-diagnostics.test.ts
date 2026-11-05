import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskStore} from '../src/task-store.js';
import {desktopModelCatalog} from '../src/desktop-dispatch-runtime.js';
import {DesktopDispatchSession, type DesktopCatalogSource} from '../src/desktop-dispatch.js';
import {defaultModelPolicy} from '../src/collaboration.js';
import type {Config} from '../src/config.js';

function fixture(t:test.TestContext){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-diagnostics-'));const file=path.join(dir,'tasks.sqlite');const db=new TaskStore(file);db.close();t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50}));return {dir,config:{dbFile:file,maxTaskAttempts:3} as Config};}
const err=(code:string)=>Object.assign(new Error('private token and path must not leak'),{code});
const model={providerId:'sample-provider',modelId:'sample-model',reasoningEfforts:['low'],credits:null};
const readers=(overrides:Record<string,unknown>={})=>({workbuddy:async()=>({models:[{id:'wb-synthetic',credits:null}]}),dsh:()=>({resolveHostId:()=> 'sample-host',models:async()=>({models:[model],pricingVerified:false}),sessions:async()=>({sessions:[]}),...overrides})}) as never;

test('disabled, missing, ambiguous and unverifiable host remain distinct without leaking errors',async t=>{
 const f=fixture(t);const cases=[['HOST_NOT_FOUND','host_missing'],['HOST_AMBIGUOUS','host_ambiguous'],['HOST_DISCOVERY_UNAVAILABLE','registry_unverified'],['unexpected','source_unavailable']];
 const disabled=await desktopModelCatalog(f.config,{},readers());assert.equal(disabled.diagnostics?.find(x=>x.source==='dsh')?.code,'source_disabled');assert.equal(disabled.models.length,1);
 for(const [code,expected] of cases){const catalog=await desktopModelCatalog(f.config,{WORKBUDDY_DSH_ENABLED:'1'},readers({resolveHostId:()=>{throw err(code!)}}));assert.equal(catalog.diagnostics?.find(x=>x.source==='dsh')?.code,expected);assert.equal(catalog.models[0]?.execution.modelId,'wb-synthetic');assert.doesNotMatch(JSON.stringify(catalog),/private token|must not leak/);}
});
test('one failed source or session listing keeps other candidates without model preparation',async t=>{
 const f=fixture(t);let models=0,sessions=0;const dep={workbuddy:async()=>{throw err('WB');},dsh:()=>({resolveHostId:()=> 'sample-host',models:async()=>{models++;return {models:[model],pricingVerified:false};},sessions:async()=>{sessions++;throw err('session');}})};
 const result=await desktopModelCatalog(f.config,{WORKBUDDY_DSH_ENABLED:'1'},dep as never);assert.equal(result.models.length,1);assert.equal(result.models[0]!.execution.executorId,'dsh');assert.equal(result.models[0]!.credits,null);assert.deepEqual(new Set(result.diagnostics?.map(d=>d.code)),new Set(['catalog_unavailable','sessions_unavailable']));assert.equal(models,1);assert.equal(sessions,1);assert.doesNotMatch(JSON.stringify(result),/private token/);
});
test('session availability distinguishes unknown, busy, disconnected and idle',async t=>{
 const f=fixture(t);const members=[{sessionId:'unknown',workspace:f.dir,attached:true},{sessionId:'busy',workspace:f.dir,attached:true,busy:true},{sessionId:'disconnected',workspace:f.dir,attached:false,busy:false},{sessionId:'idle',workspace:f.dir,attached:true,busy:false}];
 const catalog=await desktopModelCatalog(f.config,{WORKBUDDY_DSH_ENABLED:'1'},readers({sessions:async()=>({sessions:members})}));
 assert.deepEqual(catalog.sessions.map(s=>s.availability),['unknown','busy','disconnected','idle']);assert.equal(catalog.sessions[0]!.busy,true,'unknown cannot be selected as idle');
});
test('malformed catalogs are reported instead of masquerading as an empty source',async t=>{
 const f=fixture(t);const dependency={workbuddy:async()=>({}),dsh:()=>({resolveHostId:()=> 'sample-host',models:async()=>({models:[{providerId:'p',modelId:'m',reasoningEfforts:null}],pricingVerified:false}),sessions:async()=>({sessions:[]})})};
 const result=await desktopModelCatalog(f.config,{WORKBUDDY_DSH_ENABLED:'1'},dependency as never);assert.deepEqual(result.models,[]);assert.deepEqual(result.diagnostics?.map(x=>[x.source,x.code]).sort(),[['dsh','catalog_unavailable'],['workbuddy','catalog_unavailable']]);
});
test('session selection rejects wrong project, duplicates and inaccessible workspace without leaking paths',async t=>{
 const f=fixture(t);let enqueues=0;const execution={executorId:'dsh' as const,connectionId:'sample-host',providerId:'sample-provider',modelId:'sample-model',reasoningEffort:'low'};
 const source:DesktopCatalogSource={models:[{execution,credits:null,pricingVerified:false}],sessions:[],policy:defaultModelPolicy(),requiredFreeModel:null,dispatchEnabled:true,errors:[]};
 const session=new DesktopDispatchSession({catalog:async()=>source,receipt:()=>null,enqueue:async()=>{enqueues++;throw Error('unexpected enqueue')}});
 const make=async()=>{const catalog=await session.catalog();return session.preview({catalogId:catalog.catalogId,modelKey:catalog.models[0]!.key,workspace:f.dir,title:'Synthetic',objective:'Test',allowedChanges:[],permittedMetadata:[],checks:['Inspect'],maxAttempts:1,timeoutSeconds:60,sessionId:'sample-session'});};
 const candidate={hostId:'sample-host',sessionId:'sample-session',workspace:f.dir,attached:true,busy:false};
 for(const sessions of [[],[{...candidate,hostId:'another-host'}],[{...candidate,busy:true}],[{...candidate,attached:false}],[{...candidate,workspace:os.tmpdir()}],[{...candidate,workspace:path.join(f.dir,'secret-missing')}],[candidate,candidate]]){source.sessions=sessions;await assert.rejects(make(),(error:any)=>error.code==='SESSION_REQUIRED'&&!String(error.message).includes(f.dir));}
 source.sessions=[candidate];assert.equal((await make()).sessionId,'sample-session');assert.equal(enqueues,0);
});
