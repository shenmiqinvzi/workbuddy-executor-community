import fs from "node:fs";
import { TaskStore } from "../../src/task-store.js";
import { defaultModelPolicy } from "../../src/collaboration.js";

const [file, contractFile] = process.argv.slice(2);
if (!file || !contractFile) throw new Error("Fixture paths required");
const input = JSON.parse(fs.readFileSync(contractFile, "utf8"));
const store = new TaskStore(file);
process.stdout.write("READY\n");
await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
try {
  const policy = store.collaboration.currentPolicy(defaultModelPolicy());
  const workspace = store.collaboration.getWorkspace(input.workspaceId);
  const result = store.createTaskWithContract({ taskId: input.taskId, messageId: "pending", state: "queued", workspace: workspace.realPath }, input, {maxAttempts:policy.maxAttempts}, policy);
  process.stdout.write(`${JSON.stringify({status:result.status})}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({code:(error as {code?:string}).code ?? "ERROR"})}\n`);
} finally {store.close();}
