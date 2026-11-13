#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, argument = "{}"] = process.argv.slice(2);
if (!name || !name.startsWith("workbuddy_")) throw new Error("Usage: node scripts/workbuddy-call.mjs workbuddy_<tool> '<JSON>' (or @arguments.json)");
const parameters = JSON.parse(argument.startsWith("@") ? fs.readFileSync(argument.slice(1), "utf8") : argument);
// Two waits are deliberately separate facts:
//   * WORKBUDDY_MCP_CLIENT_TIMEOUT_MS (here) bounds how long this local client
//     stays attached to one tool call. Native workspace creation plus model
//     configuration can legitimately take minutes, so this default is 15 minutes
//     and no longer a hard-coded 120 seconds.
//   * WORKBUDDY_REQUEST_TIMEOUT_MS (src/config.ts) bounds the gateway's own
//     downstream request. It never extended this wait: raising it did not keep
//     this client attached, and lowering this one still does not shorten the
//     gateway's work.
const parsedTimeout = Number.parseInt(process.env.WORKBUDDY_MCP_CLIENT_TIMEOUT_MS ?? "", 10);
const clientTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 900_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "workbuddy-local-client", version: "0.7.1" });
// The POSIX launcher and the Node entry both load this installation's .env and
// keep its queue/Node configuration; Windows cannot run the sh launcher.
const launch = process.platform === "win32"
  ? { command: process.execPath, args: [path.join(root, "dist", "server.js")] }
  : { command: path.join(root, "bin/workbuddy-gateway"), args: [] };
const transport = new StdioClientTransport({ command: launch.command, args: launch.args, cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter(entry=>typeof entry[1]==="string")),stderr:"inherit" });
try {
  await client.connect(transport);
  const result = await client.callTool({ name, arguments: parameters },undefined,{timeout:clientTimeoutMs});
  for(const block of result.content)if(block.type==='text') {
    process.stdout.write(block.text+"\n");
    try {if(JSON.parse(block.text)?.ok===false)process.exitCode=1;}catch{}
  }
  if(result.isError)process.exitCode=1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s?out|timeout/i.test(message)) {
    // This client giving up is not the gateway giving up, and it is not proof that
    // the native preparation never ran. Say what to read, and say what not to do.
    process.stderr.write([
      `workbuddy-call: ${name} did not answer within ${clientTimeoutMs} ms (WORKBUDDY_MCP_CLIENT_TIMEOUT_MS).`,
      "The admitted operation stays durable; this wait ending neither cancels it nor proves it had no native effect.",
      "Read it with workbuddy_get_operation_recovery, then workbuddy_observe_operation_recovery to record what the native desktop history says about the reserved session.",
      "Close it only through the authorized local recovery flow, and do not re-dispatch the same task to obtain a second native session.",
    ].join("\n") + "\n");
  }
  throw error;
} finally { await client.close(); }
