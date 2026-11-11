#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, argument = "{}"] = process.argv.slice(2);
if (!name || !name.startsWith("workbuddy_")) throw new Error("Usage: node live-call.mjs workbuddy_<tool> '<JSON>'|@file");
const parameters = JSON.parse(argument.startsWith("@") ? fs.readFileSync(argument.slice(1), "utf8") : argument);
const root = "E:/javaproject/workbuddy-forward-20261107/R-executor-plan-20261111/gateway";
const timeout = Number(process.env.LIVE_CALL_TIMEOUT_MS ?? 600000);
const client = new Client({ name: "workbuddy-live-client", version: "0.7.1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "server.js")],
  cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string")),
  stderr: "inherit",
});
try {
  await client.connect(transport);
  const started = Date.now();
  const result = await client.callTool({ name, arguments: parameters }, undefined, { timeout });
  for (const block of result.content) {
    if (block.type === "text") {
      process.stdout.write(block.text + "\n");
      try {
        if (JSON.parse(block.text)?.ok === false) process.exitCode = 1;
      } catch {}
    }
  }
  if (result.isError) process.exitCode = 1;
  process.stderr.write(`[live-call] ${name} elapsed ${Date.now() - started}ms\n`);
} finally {
  await client.close();
}
