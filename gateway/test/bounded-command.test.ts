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
 assert.equal(r.processStarted,true,"a started command must leave a durable start marker");assert.ok(fs.existsSync(r.startedMarker!),"the marker path must be reported");
});
test("a one-second deadline stops a command that is already running",{skip:process.platform!=="win32"},async t=>{
 // The deadline is measured from resuming the target, so it also covers the
 // target's own startup. A Node target needs hundreds of milliseconds to boot
 // before it can even hang, which makes a one-second bound a race against that
 // boot (see the next test). ping.exe is a real Windows program that starts in
 // tens of milliseconds and then blocks for its full count, so this case proves
 // a short deadline fires promptly instead of only proving that a slow start
 // was interrupted.
 const dir=fixture(t);
 const ping=path.join(process.env.SystemRoot??"C:\\Windows","System32","ping.exe");
 const start=Date.now(),r=await runBounded({executable:ping,args:["-n","12","127.0.0.1"],cwd:dir,timeoutSeconds:1},dir);
 assert.equal(r.reason,"timeout",JSON.stringify(r));assert.equal(r.exitCode,124);assert.equal(r.cleanupConfirmed,true);
 const elapsed=Date.now()-start;
 assert.ok(elapsed<15000,`the bound must not wait for the 12 second ping: ${elapsed}ms`);
 assert.throws(()=>process.kill(r.pid!,0),{code:"ESRCH"});
});
test("intentional hang and its detached child end within bound with owned tree cleanup",async t=>{
 // The bound has to cover this target's startup as well, because the deadline
 // runs from process resume. Measurements on a 20-core machine under load:
 // writing the pid file took a median of 1.35s and at most 5.3s when 24-48
 // Node processes started at once, so a one-second budget killed the fixture
 // before it wrote the file (the previous full-suite ENOENT). Ten seconds is
 // twice the worst measured start; the elapsed assertion below still proves the
 // deadline fired rather than the child being waited for.
 const dir=fixture(t),pidFile=path.join(dir,"child.pid");
 const script=`const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);`;
 const start=Date.now(),r=await runBounded({executable:process.execPath,args:['-e',script,pidFile],cwd:dir,timeoutSeconds:10},dir);
 assert.equal(r.reason,"timeout",JSON.stringify(r));assert.equal(r.exitCode,124);assert.equal(r.cleanupConfirmed,true);
 const elapsed=Date.now()-start;
 assert.ok(elapsed>=9000,`the run must wait for its own bound instead of giving up early: ${elapsed}ms`);assert.ok(elapsed<25000);
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
test("a supervisor that cannot start reports why instead of a bare 125",{skip:process.platform!=="win32"},async t=>{
 // A real file that is not an executable makes CreateProcess fail inside the
 // supervisor, so the parent sees a non-zero helper exit. The failure must
 // carry the helper exit code, the elapsed time and the stderr tail; without
 // them a 125 cannot be told apart from a slow or hung supervisor.
 const dir=fixture(t),notAProgram=path.join(dir,"not-a-program.txt");
 fs.writeFileSync(notAProgram,"this file is not an executable");
 const r=await runBounded({executable:notAProgram,args:[],cwd:dir,timeoutSeconds:5},dir);
 assert.equal(r.exitCode,125,JSON.stringify(r));assert.equal(r.cleanupConfirmed,false);
 // D-4: a supervisor that never created the target leaves no marker, so nothing is left to clean.
 assert.equal(r.processStarted,false,"no start marker means the target process never existed");
 assert.ok(r.failure,"a failed supervisor must carry evidence");
 assert.equal(r.failure!.watchdogFired,false,"the supervisor exited, so the watchdog did not fire");
 assert.equal(r.failure!.helperExitCode,1,"the supervisor should report a PowerShell failure exit code");
 assert.ok(r.failure!.elapsedMs>=0);
 assert.ok(r.failure!.stderrTail.length>0,"the supervisor stderr tail must be kept");
 assert.ok(r.failure!.stderrTail.length<=600,"the stderr tail must stay bounded");
 assert.match(r.reason,/Job supervisor exited 1/);
});

test("the supervisor reports its startup phases and a durable target start",{skip:process.platform!=="win32"},async t=>{
 // Supervision is measured in phases: supervisor spawn -> helper ready -> target start -> end.
 // Only the last phase runs the submitted command, so the numbers have to be recorded to prove
 // that the command's own deadline is anchored to a real target start and not to spawn time.
 const dir=fixture(t);
 const r:any=await runBounded({executable:process.execPath,args:["-e","0"],cwd:dir,timeoutSeconds:5},dir);
 assert.equal(r.exitCode,0,JSON.stringify(r));
 assert.ok(r.readyMarker,"a windows run must report the helper-ready marker path");
 assert.ok(fs.existsSync(r.readyMarker),"the helper must write its ready marker before it compiles or starts anything");
 assert.equal(JSON.parse(fs.readFileSync(r.readyMarker,"utf8")).phase,"helper_ready");
 assert.equal(typeof r.phaseTimings.helperStartupMs,"number","helper startup must be measured");
 assert.equal(typeof r.phaseTimings.targetStartMs,"number","the time from helper ready to target start must be measured");
 assert.ok(r.phaseTimings.targetStartMs<r.durationMs,"the command deadline is anchored after the target started");
});
test("a startup budget is reported as the helper_startup phase instead of a bare 125",{skip:process.platform!=="win32"},async t=>{
 // A supervisor that never reported ready cannot have created the target, so the failure must name
 // the phase instead of only returning 125, and it must not claim anything was cleaned up.
 const dir=fixture(t);
 const r=await runBounded({executable:process.execPath,args:["-e","0"],cwd:dir,timeoutSeconds:5},dir,{startupBudgetMs:50});
 assert.equal(r.exitCode,125,JSON.stringify(r));
 assert.equal(r.cleanupConfirmed,false);
 assert.equal(r.processStarted,false);
 assert.equal(r.failure!.watchdogFired,true);
 assert.equal(r.failure!.phase,"helper_startup");
 assert.match(r.reason,/helper_startup/);
});
