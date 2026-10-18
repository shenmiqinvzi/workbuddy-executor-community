import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {runBounded} from "../src/bounded-command.js";
function fixture(t:{after:(fn:()=>void)=>void}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wb-command-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test("arguments including whitespace, quotes, backslashes and Unicode survive exact execution",async t=>{
 const dir=fixture(t),args=['with spaces','quote"here','trail\\',' space ','中文'];
 const r=await runBounded({executable:process.execPath,args:['-e','console.log(JSON.stringify(process.argv.slice(1)))',...args],cwd:dir,timeoutSeconds:5},dir);
 assert.equal(r.exitCode,0,JSON.stringify(r));assert.equal(r.cleanupConfirmed,true);assert.deepEqual(JSON.parse(fs.readFileSync(r.stdout,'utf8')),args);
});
test("intentional hang and its detached child end within bound with owned tree cleanup",async t=>{
 const dir=fixture(t),pidFile=path.join(dir,"child.pid");
 const script=`const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);`;
 const start=Date.now(),r=await runBounded({executable:process.execPath,args:['-e',script,pidFile],cwd:dir,timeoutSeconds:1},dir);
 assert.equal(r.reason,"timeout",JSON.stringify(r));assert.equal(r.exitCode,124);assert.equal(r.cleanupConfirmed,true);assert.ok(Date.now()-start<15000);
 const pid=Number(fs.readFileSync(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});assert.throws(()=>process.kill(r.pid!,0),{code:"ESRCH"});
});
test("cancellation file cleans a running command without affecting other processes",async t=>{
 const dir=fixture(t),cancelFile=path.join(dir,"cancel.json"),pidFile=path.join(dir,"child.pid");const timer=setInterval(()=>{if(fs.existsSync(pidFile)){fs.writeFileSync(cancelFile,'{}');clearInterval(timer);}},100);
 const script=`const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;
 try{const r=await runBounded({executable:process.execPath,args:['-e',script,pidFile],cwd:dir,timeoutSeconds:10},dir,{cancelFile});assert.equal(r.reason,"cancelled");assert.equal(r.exitCode,130);assert.equal(r.cleanupConfirmed,true);assert.throws(()=>process.kill(Number(fs.readFileSync(pidFile,'utf8')),0),{code:"ESRCH"});assert.throws(()=>process.kill(r.pid!,0),{code:"ESRCH"});}finally{clearInterval(timer);}
 assert.doesNotThrow(()=>process.kill(process.pid,0));
});
test("normal exit still cleans detached descendants and records current source hashes",async t=>{
 const dir=fixture(t),pidFile=path.join(dir,"child.pid");fs.writeFileSync(path.join(dir,"input.txt"),"current");
 const script=`const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));process.exit(7);`;
 const r=await runBounded({executable:process.execPath,args:['-e',script,pidFile],cwd:dir,timeoutSeconds:5,inputs:['input.txt']},dir);
 assert.equal(r.exitCode,7);assert.equal(r.cleanupConfirmed,true);assert.deepEqual(r.before,r.after);assert.match(Object.values(r.after)[0]!,/^[a-f0-9]{64}$/);
 assert.throws(()=>process.kill(Number(fs.readFileSync(pidFile,'utf8')),0),{code:"ESRCH"});assert.throws(()=>process.kill(r.pid!,0),{code:"ESRCH"});
});
test("report reserve forbids new commands without extending the deadline",async t=>{
 const dir=fixture(t);await assert.rejects(()=>runBounded({executable:process.execPath,args:[],cwd:dir,timeoutSeconds:5},dir,{reportBy:new Date(Date.now()-1).toISOString()}),/Report reserve/);
});
