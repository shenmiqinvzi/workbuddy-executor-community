import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function listen(server:http.Server) {
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("No socket");return address.port;
}
async function close(server:http.Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}

for(const mode of ["configured","invalid","disabled"] as const){
  test(`compiled entry: quota ${mode} preserves task reads and credential boundaries`,{timeout:20000},async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"quota-entry-"));
    let sourceCalls=0;
    const source=http.createServer((req,res)=>{
      sourceCalls++;assert.equal(req.url,"/usage/remaining");assert.equal(req.headers.authorization,"Bearer synthetic-entry-key");
      res.end(JSON.stringify({generated_at:Date.now()/1000,rows:[{uid:"entry-private-account",nickname:"entry-private-name",realm:"cn",model:"example-model",used:20,budget:100,remaining:80,reset_at:null,cooling:false}]}));
    });
    const sourcePort=await listen(source),reservation=http.createServer();const port=await listen(reservation);await close(reservation);
    const gatewayRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
    const child=spawn(process.execPath,[path.join(gatewayRoot,"dist/workbench-entry.js")],{cwd:gatewayRoot,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{
      ...process.env,WORKBUDDY_BACKEND:"desktop-queue",WORKBUDDY_DB_FILE:path.join(dir,"tasks.sqlite"),WORKBUDDY_RUNS_DIR:path.join(dir,"runs"),
      WORKBUDDY_CONFIG_DIR:path.join(dir,"synthetic-native"),WORKBUDDY_CLI_ELECTRON:path.join(dir,"missing.exe"),WORKBUDDY_TOKEN_FILE:path.join(dir,"unused.json"),
      WORKBUDDY_SERVICE_CONFIG:path.join(dir,"service.json"),WORKBUDDY_WORKBENCH_PORT:String(port),WORKBUDDY_QUOTA_SOURCE_ID:"entry-source",
      WORKBUDDY_QUOTA_SOURCE_URL:mode==="configured"?`http://127.0.0.1:${sourcePort}`:mode==="invalid"?"http://private-secret@127.0.0.1:8788":"",
      WORKBUDDY_QUOTA_API_KEY:"synthetic-entry-key",WORKBUDDY_QUOTA_PANEL_TOKEN:"",
    }});
    let output="";child.stdout.on("data",chunk=>{output+=chunk.toString();});child.stderr.on("data",chunk=>{output+=chunk.toString();});
    const ended=new Promise<void>(resolve=>child.once("close",()=>resolve()));
    t.after(async()=>{if(child.exitCode===null)child.kill();await ended;await close(source);fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
    let resources:any;
    for(let attempt=0;attempt<60;attempt++){
      if(child.exitCode!==null)throw Error("Compiled quota entry exited before readiness");
      try{
        const response=await fetch(`http://127.0.0.1:${port}/workbench/v1/resources/quotas`,{signal:AbortSignal.timeout(1000)});
        if(response.status===200){resources=await response.json();if(mode!=="configured"||resources.observations.length)break;}
      }catch{/* bounded startup observation, not another process or dispatch */}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(resources,"The compiled resource endpoint must answer");
    assert.equal((await fetch(`http://127.0.0.1:${port}/workbench/v1/health`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/workbench/v1/tasks`)).status,200);
    if(mode==="configured"){
      assert.equal(resources.observations[0]?.remaining,80);assert.equal(sourceCalls,1);assert.equal(resources.connections[0].freshness,"fresh");
    }else{assert.equal(sourceCalls,0);assert.equal(resources.observations.length,0);if(mode==="invalid")assert.equal(resources.connections[0].errorCode,"source_configuration_invalid");else assert.equal(resources.connections.length,0);}
    for(const privateText of ["private-secret","synthetic-entry-key","entry-private-account","entry-private-name"]){assert.equal(JSON.stringify(resources).includes(privateText),false);assert.equal(output.includes(privateText),false);}
  });
}
