import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyQuotaCollector } from "../src/quota-observation.js";
import { WorkbenchHttpServer,workbenchHealth } from "../src/workbench-http.js";
import type { TaskApplicationService } from "../src/task-application-service.js";

const row=(overrides:Record<string,unknown>={})=>({uid:"private-account-id",nickname:"private nickname",realm:"cn",model:"example-model",used:20,budget:100,remaining:80,reset_at:null,cooling:false,estimated:false,...overrides});
const body=(rows:unknown[]=[row()])=>({generated_at:Date.now()/1000,rows});
function fixture(t:{after:(fn:()=>void|Promise<void>)=>void}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"quota-observation-"));const store=new TaskStore(path.join(dir,"tasks.sqlite"));
  store.createOrGet({taskId:"unrelated-task",messageId:"message",objective:"unrelated",state:"queued"});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
  return {dir,store};
}
async function source(t:{after:(fn:()=>void|Promise<void>)=>void},handler:(request:http.IncomingMessage,response:http.ServerResponse)=>void){
  const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("missing socket");
  t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
  return `http://127.0.0.1:${address.port}`;
}
const input=(baseUrl:string,overrides:Record<string,unknown>={})=>({id:"local-source",baseUrl,apiKey:"synthetic-private-key",intervalMs:1000,maxAgeMs:10000,timeoutMs:5000,...overrides});

test("real GET collection authenticates privately and strips account identities",async t=>{
  const f=fixture(t);let requests=0;
  const url=await source(t,(req,res)=>{requests++;assert.equal(req.url,"/usage/remaining");assert.equal(req.method,"GET");assert.equal(req.headers.authorization,"Bearer synthetic-private-key");assert.equal(req.headers["x-panel-token"],"synthetic-panel-token");res.end(JSON.stringify(body()));});
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url,{panelToken:"synthetic-panel-token"}));
  const before=f.store.get("unrelated-task"),events=f.store.listTaskEvents("unrelated-task");
  await collector.collect();await collector.stop();
  const view=f.store.quotas.read();assert.equal(requests,1);assert.equal(view.connections[0]!.freshness,"fresh");
  const item=view.observations[0]!;assert.equal(item.remaining,80);assert.equal(item.valueKind,"estimated","upstream estimated=false does not make its learned budget authoritative");assert.equal(item.scopeKind,"gateway_pool");assert.equal(item.shared,true);
  const serialized=JSON.stringify(view);
  for(const secret of ["private-account-id","private nickname","synthetic-private-key","synthetic-panel-token",url])assert.equal(serialized.includes(secret),false);
  assert.equal(view.actualTaskTokens,null);assert.deepEqual(f.store.get("unrelated-task"),before);assert.deepEqual(f.store.listTaskEvents("unrelated-task"),events);
});

test("missing budget stays unknown and cooling evidence is distinct from an estimated budget",async t=>{
  const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify(body([row({remaining:null,budget:null}),row({uid:"other",remaining:0,reset_at:Date.now()/1000+3600,cooling:true})]))));
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await collector.collect();await collector.stop();
  const rows=f.store.quotas.read().observations;assert.equal(rows.find(r=>r.remaining===null)!.availability,"unknown");
  assert.equal(rows.find(r=>r.remaining===0)!.availability,"exhausted");assert.equal(rows.find(r=>r.remaining===0)!.valueKind,"estimated");
});

test("GET resource snapshots never invoke the source and return no false task costs",async t=>{
  const f=fixture(t);let calls=0;const url=await source(t,(_req,res)=>{calls++;res.end(JSON.stringify(body()));});
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await collector.collect();
  const service={readQuotaResources:(options:Parameters<typeof f.store.quotas.read>[0])=>f.store.quotas.read(options)} as unknown as TaskApplicationService;
  const server=new WorkbenchHttpServer({service,health:()=>workbenchHealth({runtime:{release:"test",packageVersion:"test",startedAt:"test"}})});
  const port=await server.listen(0);
  try{
    const before=fs.readFileSync(f.store.file),task=f.store.get("unrelated-task");
    const response=await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/quotas`);assert.equal(response.status,200);
    const result=await response.json() as {schemaVersion:string};assert.equal(result.schemaVersion,"workbuddy-executor/quota-1");
    await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/quotas`);assert.equal(calls,1);assert.deepEqual(fs.readFileSync(f.store.file),before);assert.deepEqual(f.store.get("unrelated-task"),task);
    assert.equal((await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/quotas`,{method:"POST"})).status,405);
    assert.equal((await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/quotas?url=http://example.com`)).status,400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/quotas`,{headers:{Origin:"https://example.com"}})).status,403);
  }finally{await server.close();await collector.stop();}
});

test("unauthorized or malformed sources never become zero quota and retain no raw error",async t=>{
  for(const variant of ["unauthorized","invalid","negative","fractional","unsafe","duplicate"]){
    const f=fixture(t);let calls=0;
    const url=await source(t,(_req,res)=>{calls++;if(variant==="unauthorized"){res.statusCode=401;res.end("private server body");return;}
      const invalidRows=variant==="negative"?[row({remaining:-1})]:variant==="fractional"?[row({used:0.5})]:variant==="unsafe"?[row({remaining:Number.MAX_SAFE_INTEGER+1})]:[row(),row()];
      res.end(variant==="invalid"?"not json":JSON.stringify(body(invalidRows)));});
    const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await collector.collect();await collector.collect();await collector.stop();
    const view=f.store.quotas.read();assert.equal(view.observations.length,0);assert.equal(view.connections[0]!.freshness,"unavailable");assert.equal(view.connections[0]!.errorCode,variant==="unauthorized"?"source_unauthorized":"source_invalid");assert.equal(calls,1,"failed sources back off");assert.equal(JSON.stringify(view).includes("private server body"),false);
  }
});

test("old source observation timestamps do not become fresh merely because GET succeeded",async t=>{
  const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify({...body(),generated_at:Date.now()/1000-3600})));
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await collector.collect();await collector.stop();assert.equal(f.store.quotas.read().connections[0]!.freshness,"stale");
});

test("failed refresh preserves the last snapshot and explicitly marks it stale",async t=>{
  const f=fixture(t);let fail=false;const url=await source(t,(_req,res)=>{res.statusCode=fail?503:200;res.end(fail?"private error":JSON.stringify(body()));});
  const a=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await a.collect();const before=f.store.quotas.read();fail=true;
  const b=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await b.collect();await a.stop();await b.stop();
  const after=f.store.quotas.read();assert.equal(after.observations[0]!.remaining,80);assert.equal(after.connections[0]!.snapshotId,before.connections[0]!.snapshotId);assert.equal(after.connections[0]!.freshness,"stale");
});

test("connection rotation rejects late responses from the original credentials",async t=>{
  const f=fixture(t);let release!:()=>void;let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const url=await source(t,(req,res)=>{if(req.headers.authorization==="Bearer synthetic-private-key"){release=()=>res.end(JSON.stringify(body([row({remaining:10})])));entered();}else res.end(JSON.stringify(body([row({remaining:70})])));});
  const old=new WorkBuddyQuotaCollector(f.store.quotas,input(url));const pending=old.collect();await waiting;
  const current=new WorkBuddyQuotaCollector(f.store.quotas,input(url,{apiKey:"replacement-key"}));await current.collect();release();await pending;await old.stop();await current.stop();
  assert.equal(f.store.quotas.read().observations[0]!.remaining,70);
});

test("two collectors cannot let an older in-flight poll overwrite a newer observation",async t=>{
  const f=fixture(t);let calls=0;let release!:()=>void;let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const url=await source(t,(_req,res)=>{calls++;if(calls===1){release=()=>res.end(JSON.stringify(body([row({remaining:10})])));entered();}else res.end(JSON.stringify(body([row({remaining:70})])));});
  const a=new WorkBuddyQuotaCollector(f.store.quotas,input(url));const pending=a.collect();await waiting;const b=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await b.collect();release();await pending;await a.stop();await b.stop();
  assert.equal(f.store.quotas.read().observations[0]!.remaining,70);
});

test("shared scopes are deduplicated across connection IDs and survive restart",async t=>{
  const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify(body())));
  const a=new WorkBuddyQuotaCollector(f.store.quotas,input(url)),b=new WorkBuddyQuotaCollector(f.store.quotas,input(url,{id:"other-connection"}));
  await a.collect();await b.collect();await a.stop();await b.stop();
  const before=f.store.quotas.read();assert.equal(before.connections.length,2);assert.equal(before.observations.length,1);assert.equal(before.observations[0]!.connectionIds.length,2);
  const second=new TaskStore(f.store.file);try{const restored=second.quotas.read();assert.deepEqual(restored.observations,before.observations);assert.deepEqual(restored.connections.map(c=>c.snapshotId),before.connections.map(c=>c.snapshotId));}finally{second.close();}
});

test("redirects and arbitrary source origins are refused without forwarding credentials",async t=>{
  const f=fixture(t);let targetCalls=0;const target=await source(t,(_req,res)=>{targetCalls++;res.end(JSON.stringify(body()));});
  const redirect=await source(t,(_req,res)=>{res.statusCode=302;res.setHeader("location",`${target}/usage/remaining`);res.end();});
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(redirect));await collector.collect();await collector.stop();assert.equal(targetCalls,0);assert.equal(f.store.quotas.read().observations.length,0);
  for(const url of ["https://127.0.0.1:8788","http://localhost:8788","http://example.com","http://secret@127.0.0.1:8788","http://127.0.0.1:8788/?token=secret"]){assert.throws(()=>new WorkBuddyQuotaCollector(f.store.quotas,input(url)));}
});

test("single-flight requests coalesce and a timeout is not reported as exhausted quota",async t=>{
  const f=fixture(t);let calls=0;const url=await source(t,()=>{calls++;});
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url,{timeoutMs:1000}));const a=collector.collect(),b=collector.collect();assert.equal(a,b);await a;await collector.stop();assert.equal(calls,1);assert.equal(f.store.quotas.read().connections[0]!.errorCode,"source_timeout");
});

test("stop aborts only its own pending collection without marking the source exhausted",async t=>{
  const f=fixture(t);let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const url=await source(t,(req,res)=>{if(req.headers.authorization==="Bearer synthetic-private-key")entered();else res.end(JSON.stringify(body()));});
  const a=new WorkBuddyQuotaCollector(f.store.quotas,input(url));const pending=a.collect();await waiting;
  const b=new WorkBuddyQuotaCollector(f.store.quotas,input(url,{id:"other-source",apiKey:"other-key"}));
  await a.stop();await pending;await b.collect();await b.stop();
  const view=f.store.quotas.read();assert.equal(view.connections.find(c=>c.connectionId==="local-source")!.errorCode,null);assert.equal(view.observations[0]!.remaining,80);
});

test("missing source time remains unavailable and contradictory cooling data is refused",async t=>{
  for(const variant of ["time","cooling"]){
    const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify(variant==="time"?{rows:[row()]}:body([row({cooling:true,remaining:80})]))));
    const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await collector.collect();await collector.stop();
    const view=f.store.quotas.read();assert.equal(view.connections[0]!.freshness,"unavailable");
    if(variant==="time")assert.equal(view.connections[0]!.sourceObservedAt,null);else assert.equal(view.connections[0]!.errorCode,"source_invalid");
  }
});

test("invalid source configuration can be recorded without blocking task reads",t=>{
  const f=fixture(t),before=f.store.get("unrelated-task");f.store.quotas.configurationError("invalid secret / source");
  const view=f.store.quotas.read();assert.equal(view.connections[0]!.connectionId,"quota-source-invalid");assert.equal(view.connections[0]!.errorCode,"source_configuration_invalid");
  assert.equal(JSON.stringify(view).includes("invalid secret"),false);assert.deepEqual(f.store.get("unrelated-task"),before);
});

test("resource row limits are explicit rather than silently presented as a whole pool",async t=>{
  const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify(body([row(),row({uid:"second"})]))));
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await collector.collect();await collector.stop();const view=f.store.quotas.read({limit:1});assert.equal(view.observations.length,1);assert.equal(view.truncated,true);
});

test("corrupt cached observations cannot leak unexpected fields through the HTTP view",async t=>{
  const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify(body())));
  const collector=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await collector.collect();await collector.stop();
  const db=new DatabaseSync(f.store.file);
  try{
    const record=db.prepare("SELECT snapshot_json FROM quota_connections").get()!;const snapshot=JSON.parse(String(record.snapshot_json));
    snapshot.observations[0].rawAccount="must-not-be-returned";db.prepare("UPDATE quota_connections SET snapshot_json=?").run(JSON.stringify(snapshot));
  }finally{db.close();}
  assert.throws(()=>f.store.quotas.read(),/resource_corrupt/);assert.equal(f.store.get("unrelated-task")!.state,"queued");
  const service={readQuotaResources:()=>f.store.quotas.read()} as unknown as TaskApplicationService;
  const server=new WorkbenchHttpServer({service,health:()=>workbenchHealth({runtime:{release:"test",packageVersion:"test",startedAt:"test"}})});const port=await server.listen(0);
  try{const response=await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/quotas`);assert.equal(response.status,503);assert.equal((await response.text()).includes("must-not-be-returned"),false);}
  finally{await server.close();}
  const repaired=new WorkBuddyQuotaCollector(f.store.quotas,input(url));await repaired.collect();await repaired.stop();
  assert.equal(f.store.quotas.read().observations[0]!.remaining,80,"validated background collection may repair the cache");
});
