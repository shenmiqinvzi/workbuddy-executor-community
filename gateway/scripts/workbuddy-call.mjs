#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, argument = "{}"] = process.argv.slice(2);
if (!name || !name.startsWith("workbuddy_")) throw new Error("Usage: node scripts/workbuddy-call.mjs workbuddy_<tool> '<JSON>' (or @arguments.json)");
const parameters = JSON.parse(argument.startsWith("@") ? fs.readFileSync(argument.slice(1), "utf8") : argument);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "workbuddy-local-client", version: "0.6.0" });
// The POSIX launcher and the Node entry both load this installation's .env and
// keep its queue/Node configuration; Windows cannot run the sh launcher.
const launch = process.platform === "win32"
  ? { command: process.execPath, args: [path.join(root, "dist", "server.js")] }
  : { command: path.join(root, "bin/workbuddy-gateway"), args: [] };
const transport = new StdioClientTransport({ command: launch.command, args: launch.args, cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter(entry=>typeof entry[1]==="string")),stderr:"inherit" });
try {
  await client.connect(transport);
  const result = await client.callTool({ name, arguments: parameters },undefined,{timeout:120_000});
  for(const block of result.content)if(block.type==='text') {
    process.stdout.write(block.text+"\n");
    try {if(JSON.parse(block.text)?.ok===false)process.exitCode=1;}catch{}
  }
  if(result.isError)process.exitCode=1;
}finally{await client.close();}
