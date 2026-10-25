import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyCreditBalanceCollector } from "../src/credit-balance.js";
import { WorkbenchHttpServer,workbenchHealth } from "../src/workbench-http.js";
import type { TaskApplicationService } from "../src/task-application-service.js";
import { LocalStatisticsClient } from "../src/local-statistics-client.js";

const payload=(overrides:Record<string,unknown>={})=>({balance:123.45,unit:"credit",realm:"cn",accounts_enabled:4,accounts_with_credit_data:4,updated_at:Date.now()/1000,...overrides});
function fixture(t:{after:(fn:()=>void|Promise<void>)=>void}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"credit-balance-")),store=new TaskStore(path.join(dir,"tasks.sqlite"));
  store.createOrGet({taskId:"existing-task",objective:"Synthetic task",messageId:"initial",state:"queued"});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});return {dir,store};
}
async function source(t:{after:(fn:()=>void|Promise<void>)=>void},handler:(req:http.IncomingMessage,res:http.ServerResponse)=>void){
  const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("No socket");
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));return `http://127.0.0.1:${address.port}`;
}
const connection=(baseUrl:string,overrides:Record<string,unknown>={})=>({id:"credit-local",baseUrl,apiKey:"synthetic-credit-key",intervalMs:1000,maxAgeMs:10000,timeoutMs:5000,...overrides});

test("credit endpoint uses only the existing API key and preserves reported-cache semantics",async t=>{
  const f=fixture(t);let calls=0;const url=await source(t,(req,res)=>{calls++;assert.equal(req.method,"GET");assert.equal(req.url,"/v1/balance-summary");assert.equal(req.headers.authorization,"Bearer synthetic-credit-key");assert.equal(req.headers["x-panel-token"],undefined);res.end(JSON.stringify(payload({nickname:"must-not-leak",accountId:"must-not-leak"})));});
  const collector=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));const before=f.store.get("existing-task"),events=f.store.listTaskEvents("existing-task");
  await collector.collect();await collector.stop();const view=f.store.creditBalances.read();assert.equal(calls,1);assert.equal(view.balances[0]!.balance,123.45);assert.equal(view.balances[0]!.valueKind,"reported_cache");assert.equal(view.balances[0]!.coverage,"complete");
  assert.equal(view.balances[0]!.balanceFreshness,"unavailable","the latest account timestamp cannot establish freshness of every account");
  for(const secret of ["synthetic-credit-key","must-not-leak",url])assert.equal(JSON.stringify(view).includes(secret),false);
  assert.deepEqual(f.store.get("existing-task"),before);assert.deepEqual(f.store.listTaskEvents("existing-task"),events);assert.equal(f.store.quotas.read().observations.length,0);assert.equal(view.actualTaskCredits,null);
});

test("partial, unknown and genuine zero balances remain distinct",async t=>{
  for(const sample of [{balance:50,accounts_with_credit_data:2},{balance:null,accounts_with_credit_data:0,updated_at:null},{balance:0}]){
    const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify(payload(sample))));const collector=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await collector.collect();await collector.stop();
    const balance=f.store.creditBalances.read().balances[0]!;assert.equal(balance.balance,sample.balance);assert.equal(balance.coverage,sample.balance===null?"unavailable":sample.balance===0?"complete":"partial");
    assert.equal("availability" in balance,false,"zero credits do not prove free-model quota exhausted");
  }
});

test("same-region providers share one balance while different regions remain separate",async t=>{
  const f=fixture(t);const url=await source(t,(req,res)=>res.end(JSON.stringify(payload({realm:req.headers.authorization?.includes("intl")?"intl":"cn"}))));
  const collectors=[new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url)),new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url,{id:"same-pool"})),new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url,{id:"intl-pool",apiKey:"intl-key"}))];
  for(const collector of collectors){await collector.collect();await collector.stop();}
  const view=f.store.creditBalances.read();assert.equal(view.connections.length,3);assert.equal(view.balances.length,2);assert.equal(view.balances.find(b=>b.realm==="cn")!.connectionIds.length,2);
  const second=new TaskStore(f.store.file);try{assert.deepEqual(second.creditBalances.read().balances.map(b=>b.scopeId).sort(),view.balances.map(b=>b.scopeId).sort());}finally{second.close();}
});

test("unsupported and unauthorized endpoints stay explicit without fallback or login",async t=>{
  for(const status of [401,403,404,501]){
    const f=fixture(t);let calls=0;const url=await source(t,(req,res)=>{calls++;assert.equal(req.url,"/v1/balance-summary");res.statusCode=status;res.end("private error response");});
    const collector=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await collector.collect();await collector.collect();await collector.stop();
    const view=f.store.creditBalances.read();assert.equal(calls,1);assert.equal(view.balances.length,0);assert.equal(view.connections[0]!.errorCode,status<404?"source_unauthorized":"source_unsupported");assert.equal(JSON.stringify(view).includes("private error response"),false);
  }
});

test("invalid units, impossible counts, negative values and zero without data are refused",async t=>{
  for(const sample of [{unit:"tokens"},{balance:-1},{accounts_with_credit_data:5},{accounts_with_credit_data:0,balance:0},{balance:null},{balance:1.234},{updated_at:Date.now()/1000+3600}]){
    const f=fixture(t);const url=await source(t,(_req,res)=>res.end(JSON.stringify(payload(sample))));const collector=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await collector.collect();await collector.stop();
    const view=f.store.creditBalances.read();assert.equal(view.balances.length,0);assert.equal(view.connections[0]!.errorCode,"source_invalid");
  }
});

test("refresh failure preserves the last value and leaves task queries unchanged",async t=>{
  const f=fixture(t);let fail=false;const url=await source(t,(_req,res)=>{res.statusCode=fail?503:200;res.end(fail?"error":JSON.stringify(payload()));});
  const a=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await a.collect();await a.stop();fail=true;
  const b=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await b.collect();await b.stop();const view=f.store.creditBalances.read();assert.equal(view.balances[0]!.balance,123.45);assert.equal(view.connections[0]!.cacheFreshness,"stale");assert.equal(f.store.get("existing-task")!.state,"queued");
});

test("late responses cannot overwrite a newer source configuration",async t=>{
  const f=fixture(t);let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const url=await source(t,(req,res)=>{if(req.headers.authorization==="Bearer synthetic-credit-key"){entered();release=()=>res.end(JSON.stringify(payload({balance:10})));}else res.end(JSON.stringify(payload({balance:70})));});
  const a=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url)),pending=a.collect();await waiting;
  const b=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url,{apiKey:"replacement-key"}));await b.collect();release();await pending;await a.stop();await b.stop();assert.equal(f.store.creditBalances.read().balances[0]!.balance,70);
});

test("credit HTTP reads use only the saved cache and preserve access boundaries",async t=>{
  const f=fixture(t);let calls=0;const url=await source(t,(_req,res)=>{calls++;res.end(JSON.stringify(payload()));});const collector=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await collector.collect();await collector.stop();
  const service={readCreditBalances:(id?:string)=>f.store.creditBalances.read(id)} as unknown as TaskApplicationService;
  const server=new WorkbenchHttpServer({service,health:()=>workbenchHealth({runtime:{release:"test",packageVersion:"test",startedAt:"test"}})}),port=await server.listen(0);
  try{
    const before=fs.readFileSync(f.store.file);const endpoint=`http://127.0.0.1:${port}/workbench/v1/resources/credit-balances`;
    const response=await fetch(endpoint);assert.equal(response.status,200);assert.equal((await response.json() as {schemaVersion:string}).schemaVersion,"workbuddy-executor/credit-balance-1");
    await fetch(endpoint);assert.equal(calls,1);assert.deepEqual(fs.readFileSync(f.store.file),before);assert.equal((await fetch(endpoint,{method:"POST"})).status,405);
    assert.equal((await fetch(endpoint+"?url=http://example.com")).status,400);assert.equal((await fetch(endpoint,{headers:{Origin:"https://example.com"}})).status,403);
    const db=new DatabaseSync(f.store.file);try{const row=db.prepare("SELECT snapshot_json FROM credit_balance_connections").get()!;const snapshot=JSON.parse(String(row.snapshot_json));snapshot.apiKey="must-not-leak";db.prepare("UPDATE credit_balance_connections SET snapshot_json=?").run(JSON.stringify(snapshot));}finally{db.close();}
    const corrupt=await fetch(endpoint);assert.equal(corrupt.status,503);assert.equal((await corrupt.text()).includes("must-not-leak"),false);
  }finally{await server.close();}
});

test("old aggregate timestamps remain stale even when their local cache was just collected",async t=>{
  const f=fixture(t),url=await source(t,(_req,res)=>res.end(JSON.stringify(payload({updated_at:Date.now()/1000-3600}))));const collector=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await collector.collect();await collector.stop();
  const view=f.store.creditBalances.read();assert.equal(view.connections[0]!.cacheFreshness,"fresh");assert.equal(view.balances[0]!.balanceFreshness,"stale");
});

test("a verified background refresh repairs corrupt cache, while reads never repair it",async t=>{
  const f=fixture(t),url=await source(t,(_req,res)=>res.end(JSON.stringify(payload())));
  const a=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await a.collect();await a.stop();
  const db=new DatabaseSync(f.store.file);try{db.exec("UPDATE credit_balance_connections SET snapshot_json='corrupt'");}finally{db.close();}
  assert.throws(()=>f.store.creditBalances.read(),/credit_resource_corrupt/);assert.throws(()=>f.store.creditBalances.read(),/credit_resource_corrupt/);
  const b=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await b.collect();await b.stop();assert.equal(f.store.creditBalances.read().balances[0]!.balance,123.45);
});

test("statistics transport refuses upstream-refresh paths and oversized otherwise-valid payloads",async t=>{
  const f=fixture(t);let calls=0;const url=await source(t,(_req,res)=>{calls++;res.end(JSON.stringify(payload({extra:"x".repeat(1024*1024)})));});
  const client=new LocalStatisticsClient({baseUrl:url,apiKey:"synthetic-credit-key"});
  await assert.rejects(client.read("/accounts/credits" as "/v1/balance-summary",new AbortController().signal),{code:"source_unsupported"});assert.equal(calls,0);
  const collector=new WorkBuddyCreditBalanceCollector(f.store.creditBalances,connection(url));await collector.collect();await collector.stop();
  assert.equal(f.store.creditBalances.read().balances.length,0);assert.equal(f.store.creditBalances.read().connections[0]!.errorCode,"source_invalid");
});
