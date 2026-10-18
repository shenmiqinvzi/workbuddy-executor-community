import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import {reconcileOwnedCommands} from "../src/command-cleanup.js";
import {runBounded} from "../src/bounded-command.js";

function fixture(t:{after:(fn:()=>void)=>void}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wb-cleanup-")),file=path.join(dir,crypto.randomUUID()+".json"),specFile=file.slice(0,-5)+".spec.json";
 const value={executable:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:dir,state:"running",stdout:file.slice(0,-5)+".stdout.log",stderr:file.slice(0,-5)+".stderr.log",supervisorPid:123456789};
 fs.writeFileSync(file,JSON.stringify(value));fs.writeFileSync(specFile,JSON.stringify(value));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,file,specFile,value};
}
test("live exact supervisor cannot be reconciled or treated as stopped",{skip:process.platform!=="win32"},t=>{
 const f=fixture(t);assert.deepEqual(reconcileOwnedCommands(f.dir,()=>[{pid:f.value.supervisorPid,ppid:1,commandLine:`powershell.exe -File bounded-job.ps1 -SpecFile "${f.specFile}"`}]).recovered,[]);assert.equal(JSON.parse(fs.readFileSync(f.file,"utf8")).endedAt,undefined);
});
test("absent exact Job owner confirms cleanup while keeping unknown command outcome 125",{skip:process.platform!=="win32"},t=>{
 const f=fixture(t);assert.equal(reconcileOwnedCommands(f.dir,()=>[]).recovered.length,1);const record=JSON.parse(fs.readFileSync(f.file,"utf8"));assert.equal(record.cleanupConfirmed,true);assert.equal(record.exitCode,125);assert.equal(record.cleanupEvidence.exitCodeKnown,false);assert.equal(reconcileOwnedCommands(f.dir,()=>[]).recovered.length,0);
});
test("unknown or mismatched spec cannot manufacture cleanup evidence",{skip:process.platform!=="win32"},t=>{
 const f=fixture(t);fs.writeFileSync(f.specFile,JSON.stringify({...f.value,args:["unrelated"]}));assert.equal(reconcileOwnedCommands(f.dir,()=>[]).recovered.length,0);
});
test("real nested Job cancellation leaves no descendants and orphan record is reconciled",{skip:process.platform!=="win32"},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wb-nested-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runner=path.resolve("dist/bounded-command.js").replaceAll("\\","/");
 const script=path.join(dir,"nested.mjs");
 fs.writeFileSync(script,`import {runBounded} from 'file:///${runner}';await runBounded({executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:process.cwd(),timeoutSeconds:30},${JSON.stringify(path.join(dir,"inner"))});`);
 const outer=await runBounded({executable:process.execPath,args:[script],cwd:dir,timeoutSeconds:4},path.join(dir,"outer"));assert.equal(outer.exitCode,124);assert.equal(outer.cleanupConfirmed,true);
 const recovered=reconcileOwnedCommands(path.join(dir,"inner"));assert.equal(recovered.recovered.length,1);const inner=JSON.parse(fs.readFileSync(path.join(dir,"inner",recovered.recovered[0]!),"utf8"));assert.equal(inner.exitCode,125);assert.equal(inner.cleanupConfirmed,true);
});
