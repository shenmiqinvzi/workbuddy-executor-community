import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { DesktopQueue } from "./desktop-queue.js";
import { loadDotEnv } from "./env.js";
import { readWorkerResult, readWorkerContext } from "./worker-result.js";
import { runBounded, type CommandSpec } from "./bounded-command.js";
import { RunJournal } from "./run-journal.js";
import fs from "node:fs";
import path from "node:path";

loadDotEnv();

try {
  const parsed = parseArgs({ allowPositionals: true, options: {
    "session-id": { type: "string" }, "attempt-id": { type: "string" }, "lease-token": { type: "string" },
    "wait-seconds": { type: "string" }, status: { type: "string" }, text: { type: "string" }, artifacts: { type: "string" },
    "claim-file": { type: "string" }, "result-file": { type: "string" }, help: { type: "boolean" },
    "progress-file": {type:"string"}, "command-file": {type:"string"},
  } });
  const [action] = parsed.positionals;
  if (parsed.values.help || action === "help") {
    console.log("claim --session-id ID --wait-seconds 0\nfinish --claim-file PATH --result-file PATH\nprogress/report use the legacy session-id, attempt-id, lease-token and text flags.\nOn helper failure: retry the identical command once at most, preserve files, then stop. Do not investigate the gateway or switch shells.");
  } else {
  const required = (name: keyof typeof parsed.values) => { const value = parsed.values[name]; if (typeof value !== "string" || !value) throw new Error(`Missing --${name}`); return value; };
  const config = loadConfig();
  const queue = new DesktopQueue(config);
  let result: unknown;
  if (action === "finish") result = queue.report(readWorkerResult(config, required("claim-file"), required("result-file")));
  else if (action === "update") {
    const context=readWorkerContext(config,required("claim-file"));
    const file=required("progress-file");if(fs.statSync(file).size>8192)throw Error("Progress JSON too large");
    result=queue.progress({...context,text:fs.readFileSync(file,"utf8").replace(/^\uFEFF/,"")});
  } else if (action === "exec") {
    const context=readWorkerContext(config,required("claim-file")),snapshot=queue.authorizeCommand(context);
    const file=required("command-file");if(fs.statSync(file).size>65536)throw Error("Command JSON too large");
    const spec=JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,"")) as CommandSpec;
    const journal=new RunJournal(queue.root,context.attemptId);
    const outcome=await runBounded(spec,path.join(journal.dir,"commands"),{cancelFile:path.join(journal.dir,"cancel.json"),reportBy:snapshot.reportBy ?? snapshot.deadline});
    result=outcome;
    process.exitCode=outcome.exitCode===0&&outcome.cleanupConfirmed?0:outcome.exitCode||125;
  }
  else if (action === "bootstrap") result = queue.prepare(required("session-id"));
  else if (action === "claim") {
    const seconds = Number(parsed.values["wait-seconds"] ?? "50");
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 55) throw new Error("wait-seconds must be between 0 and 55");
    result = await queue.claim(required("session-id"), seconds);
  } else if (action === "report" || action === "progress") {
    const base = { sessionId: required("session-id"), attemptId: required("attempt-id"), leaseToken: required("lease-token"), text: required("text") };
    if (action === "progress") result = queue.progress(base);
    else {
      const status = required("status");
      if (!["completed", "blocked", "failed", "cancelled"].includes(status)) throw new Error("Report status must be completed, blocked, failed or cancelled");
      const artifacts = JSON.parse(parsed.values.artifacts ?? "[]") as unknown;
      if (!Array.isArray(artifacts) || !artifacts.every((item) => typeof item === "string")) throw new Error("artifacts must be a JSON array of actual paths");
      result = queue.report({ ...base, status: status as "completed" | "blocked" | "failed" | "cancelled", artifacts });
    }
  } else throw new Error("Use bootstrap, claim, finish, progress, report or --help");
  console.log(JSON.stringify(result));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), next: "Preserve the result file. Retry the identical command once at most, then stop and report this error; do not debug the gateway or change shells." }));
  process.exitCode = 1;
}
