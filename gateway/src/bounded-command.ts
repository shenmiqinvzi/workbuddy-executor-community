import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writePrivateJson } from "./run-journal.js";
import { windowsPowerShellPath } from "./native-process.js";

export interface CommandSpec {executable:string;args:string[];cwd:string;timeoutSeconds:number;inputs?:string[]}

/** The supervision phase in which a run stopped making progress. */
export type CommandSupervisionPhase = "helper_startup" | "target_start" | "supervisor_completion";

/**
 * Why the Windows job supervisor did not produce a result.
 *
 * The supervisor starts PowerShell, loads (or compiles) its C# helper and only
 * then begins supervising, so its total time is startup + the command's own
 * bound + cleanup. These three phases are reported separately because they have
 * different safe bounds: startup never runs the submitted command, so a slow
 * startup must not be confused with a command that overran its own deadline.
 */
export interface CommandFailureEvidence {
  /** True when the parent watchdog killed the supervisor because it never returned. */
  watchdogFired: boolean;
  /** The supervisor exit code, or null when it never exited. */
  helperExitCode: number | null;
  /** Wall time from spawning the supervisor to the failure. */
  elapsedMs: number;
  /** Bytes the supervisor wrote to stdout. */
  stdoutBytes: number;
  /** The bounded tail of the supervisor stderr. */
  stderrTail: string;
  /** Which supervision phase ran out of budget, when the watchdog fired. */
  phase?: CommandSupervisionPhase;
}

/**
 * Startup budgets. They bound only the supervisor's own preparation, never the
 * submitted command: a supervisor that has not reported "helper ready" or has
 * not created the target yet cannot have executed anything user-visible, so a
 * generous budget here cannot extend a command's runtime. The execution bound
 * starts at the durable target-start marker instead (see `target_start`).
 */
export const DEFAULT_STARTUP_BUDGET_MS = 60_000;
export const DEFAULT_TARGET_START_BUDGET_MS = 60_000;
/** Extra time the supervisor needs to kill and account for the job after the deadline. */
export const SUPERVISOR_COMPLETION_GRACE_MS = 15_000;
/** How often the parent re-reads the phase markers. */
const PHASE_POLL_MS = 50;

export interface CommandTimings {
  /** Supervisor spawn -> "helper ready" marker, or null when it never appeared. */
  helperStartupMs: number | null;
  /** "helper ready" -> durable target-start marker, or null when it never appeared. */
  targetStartMs: number | null;
  /** Supervisor spawn -> run end. */
  supervisorMs: number;
}

function fingerprints(spec:CommandSpec) {
  return Object.fromEntries((spec.inputs ?? []).map(file=>{
    const absolute=path.resolve(spec.cwd,file);
    return [absolute,fs.existsSync(absolute)?crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"):"missing"];
  }));
}
export async function runBounded(spec:CommandSpec, directory:string, options:{cancelFile?:string;reportBy?:string;startupBudgetMs?:number;targetStartBudgetMs?:number;completionGraceMs?:number}={}) {
  if(!path.isAbsolute(spec.executable)||!fs.statSync(spec.executable).isFile()||!Array.isArray(spec.args)||!spec.args.every(v=>typeof v==="string")||!path.isAbsolute(spec.cwd)||!fs.statSync(spec.cwd).isDirectory())throw Error("Use an absolute executable/cwd and an array of arguments; no implicit shell");
  if(!Number.isFinite(spec.timeoutSeconds)||spec.timeoutSeconds<=0||spec.timeoutSeconds>86400)throw Error("Command timeoutSeconds must be in (0,86400]");
  const remaining=options.reportBy?Date.parse(options.reportBy)-Date.now():Infinity;
  if(options.cancelFile&&fs.existsSync(options.cancelFile))throw Error("Cancellation requested; command was not started");
  if(remaining<=0||Number.isNaN(remaining))throw Error("Report reserve reached; submit real partial/blocked result now");
  fs.mkdirSync(directory,{recursive:true});
  const id=crypto.randomUUID(),base=path.join(directory,id),stdout=base+".stdout.log",stderr=base+".stderr.log",record=base+".json",startedMarker=base+".started.json",readyMarker=base+".ready.json";
  const timeoutMs=Math.max(1,Math.min(spec.timeoutSeconds*1000,remaining)),startedAt=new Date().toISOString(),before=fingerprints(spec);
  writePrivateJson(record,{...spec,startedAt,before,state:"running",stdout,stderr});
  let outcome: {exitCode:number;reason:string;cleanupConfirmed:boolean;pid?:number;ownership?:string;failure?:CommandFailureEvidence};
  let timings:CommandTimings|undefined;
  if(process.platform==="win32") {
    const specFile=base+".spec.json";
    writePrivateJson(specFile,{...spec,stdout,stderr,timeoutMs:Math.ceil(timeoutMs),cancelFile:options.cancelFile});
    const startupBudgetMs=options.startupBudgetMs??DEFAULT_STARTUP_BUDGET_MS,targetStartBudgetMs=options.targetStartBudgetMs??DEFAULT_TARGET_START_BUDGET_MS,completionGraceMs=options.completionGraceMs??SUPERVISOR_COMPLETION_GRACE_MS;
    if(![startupBudgetMs,targetStartBudgetMs,completionGraceMs].every(v=>Number.isFinite(v)&&v>0))throw Error("Supervision budgets must be positive numbers of milliseconds");
    outcome=await new Promise<typeof outcome>((resolve)=>{
      const helper=fileURLToPath(new URL("../scripts/bounded-job.ps1",import.meta.url));
      // This is the gateway's own bundled helper, not user content: the machine's execution policy
      // (a machine with CurrentUser=RemoteSigned refuses every unsigned local script) must not be able
      // to turn every bounded validation into "supervisor exited 1". Bypass applies to this child only.
      const child=spawn(windowsPowerShellPath(),["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",helper,"-SpecFile",specFile,"-StartedFile",startedMarker,"-ReadyFile",readyMarker],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
      writePrivateJson(record,{...spec,startedAt,before,state:"running",stdout,stderr,supervisorPid:child.pid,supervisorSpec:specFile,readyMarker,ownership:"windows_job_object"});
      let out="",err="",helperExitCode:number|null=null,phaseExpired:CommandSupervisionPhase|null=null;
      const spawnedAt=Date.now();
      let readyAt:number|null=null,targetAt:number|null=null,settled=false;
      const phase=():CommandSupervisionPhase=>targetAt?"supervisor_completion":readyAt?"target_start":"helper_startup";
      timings={helperStartupMs:null,targetStartMs:null,supervisorMs:0};
      const evidence=():CommandFailureEvidence=>({watchdogFired:phaseExpired!==null,helperExitCode,elapsedMs:Date.now()-spawnedAt,stdoutBytes:Buffer.byteLength(out,"utf8"),stderrTail:err.slice(-600),...(phaseExpired?{phase:phaseExpired}:{})});
      const finish=(value:typeof outcome)=>{if(settled)return;settled=true;clearInterval(poll);resolve(value);};
      const fail=(reason:string)=>finish({exitCode:125,reason,cleanupConfirmed:false,failure:evidence()});
      // Phase deadlines replace the single spawn-relative watchdog. The execution deadline is
      // anchored to the durable start marker, so supervisor preparation can never consume the
      // command's own bound, and a slow preparation is reported as such instead of as "125".
      const poll=setInterval(()=>{
        const now=Date.now();
        if(!targetAt&&fs.existsSync(startedMarker)){targetAt=now;readyAt??=now;}
        else if(!readyAt&&fs.existsSync(readyMarker))readyAt=now;
        if(timings){timings.helperStartupMs=readyAt===null?null:readyAt-spawnedAt;timings.targetStartMs=readyAt===null||targetAt===null?null:targetAt-readyAt;}
        const current=phase();
        const budget=current==="helper_startup"?startupBudgetMs:current==="target_start"?targetStartBudgetMs:timeoutMs+completionGraceMs;
        const anchor=current==="helper_startup"?spawnedAt:current==="target_start"?readyAt!:(targetAt??spawnedAt);
        if(now-anchor>=budget){phaseExpired=current;child.kill();fail(`Job supervisor stopped making progress in its ${current} phase after ${now-spawnedAt}ms (budget ${budget}ms)`);}
      },PHASE_POLL_MS);
      child.stdout.on("data",b=>out+=String(b));child.stderr.on("data",b=>err+=String(b));
      child.once("error",e=>{fail(`Job supervisor could not be started: ${String(e)}`);});
      child.once("exit",code=>{
        helperExitCode=code;
        if(code!==0)return fail(`Job supervisor exited ${code}: ${err.slice(-2000)||"no stderr"}`);
        try{finish(JSON.parse(out.trim()));}catch{fail(`Job supervisor did not return a JSON result: ${err.slice(-2000)||"no stderr"}`);}
      });
    });
  } else {
    const out=fs.openSync(stdout,"w"),err=fs.openSync(stderr,"w");
    outcome=await new Promise((resolve)=>{
      const child=spawn(spec.executable,spec.args,{cwd:spec.cwd,detached:true,stdio:["ignore",out,err]});
      if(child.pid)writePrivateJson(startedMarker,{pid:child.pid,startedAt:new Date().toISOString()});
      let reason="exit";const start=Date.now();
      const kill=()=>{try{process.kill(-child.pid!,"SIGKILL");}catch{}};
      const timer=setInterval(()=>{if(options.cancelFile&&fs.existsSync(options.cancelFile)){reason="cancelled";kill();}else if(Date.now()-start>=timeoutMs){reason="timeout";kill();}},100);
      child.once("error",e=>{clearInterval(timer);resolve({exitCode:125,reason:String(e),cleanupConfirmed:false});});
      child.once("exit",code=>{clearInterval(timer);kill();resolve({pid:child.pid,exitCode:reason==="timeout"?124:reason==="cancelled"?130:code??1,reason,cleanupConfirmed:true,ownership:"process_group"});});
    });
    fs.closeSync(out);fs.closeSync(err);
  }
  // The marker is written only after the target process exists. Its absence is the one fact that
  // separates "a supervisor which never ran" from "a command that may still own a process tree".
  const processStarted=fs.existsSync(startedMarker);
  if(timings)timings.supervisorMs=Date.now()-Date.parse(startedAt);
  const result={...spec,startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(startedAt),before,after:fingerprints(spec),...outcome,processStarted,startedMarker,...(process.platform==="win32"?{readyMarker,phaseTimings:timings}:{}),stdout,stderr,record};
  writePrivateJson(record,result);return result;
}
