import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { diagnose } from "./doctor.js";
import { loadConfig, type Config } from "./config.js";
import { loadDotEnv } from "./env.js";
import { inspectTask } from "./inspect-task.js";
import { runtimeVersion } from "./runtime-version.js";
import { runsDirectory } from "./run-journal.js";

type Scenario = "normal" | "rework" | "cancel";
/** Saved evidence only: no native connection, synchronization, dispatch or stop request. */
export function checkDeploymentTask(config: Config, scenario: Scenario, taskId?: string) {
  if (!taskId) return {status:"pending",reason:"No task selected; run the documented real scenario first."};
  try {
    const view=inspectTask(config,taskId), task=view.task;
    const snapshot=JSON.parse(fs.readFileSync(path.join(runsDirectory(config),task.attemptId!,"state.json"),"utf8"));
    if (snapshot.taskId!==taskId || snapshot.attemptId!==task.attemptId || snapshot.sessionId!==task.sessionId) return {status:"failed",reason:"Saved task, attempt or native session identity does not match."};
    if (task.runtimeSource!=="desktop_queue" || !view.execution.remoteStopped) return {status:"failed",reason:"Desktop provenance or saved native stop evidence is missing."};
    if (scenario==="cancel") return {status:task.state==="cancelled"?"passed":"failed",reason:"Requires a formally cancelled task with saved native stop evidence."};
    if (task.state!=="accepted" || !task.evidence?.length || !view.workerResult.authenticated) return {status:"failed",reason:"Requires independent acceptance, authenticated report and matching saved evidence."};
    if (scenario==="rework" && (task.attempt??0)<2) return {status:"failed",reason:"No same-task rework attempt is recorded."};
    return {status:"passed",reason:"Saved task record meets the scenario checks; review coverage remains the reviewer's responsibility."};
  } catch { return {status:"failed",reason:"The selected local task evidence could not be read or verified."}; }
}
export async function runDeploymentCheck(args=process.argv.slice(2)) {
  const parsed=parseArgs({args,options:{"machine-label":{type:"string"},"normal-task":{type:"string"},"rework-task":{type:"string"},"cancel-task":{type:"string"},output:{type:"string"}}});
  const label=parsed.values["machine-label"]??"unlabelled";
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(label))throw new Error("Use an anonymous machine label of 1-40 letters, digits, underscores or hyphens.");
  loadDotEnv();
  const config=loadConfig();
  const report={schemaVersion:"workbuddy-deployment/v1",machineLabel:label,checkedAt:new Date().toISOString(),platform:process.platform,node:process.versions.node,runtime:{release:runtimeVersion.release,codeHash:runtimeVersion.codeHash},
    local:await diagnose(),scenarios:{normal:checkDeploymentTask(config,"normal",parsed.values["normal-task"]),rework:checkDeploymentTask(config,"rework",parsed.values["rework-task"]),cancel:checkDeploymentTask(config,"cancel",parsed.values["cancel-task"]),reconnect:{status:"pending",reason:"Observe reconnection of the original task and record the manual check separately."}},
    scope:"Local configuration and saved evidence only. No proof of a second physical machine, live native state or manual reconnection is inferred.",taskSent:false};
  if(parsed.values.output){
    const output=path.resolve(parsed.values.output);
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
  }
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.local.ok?0:1;
}
