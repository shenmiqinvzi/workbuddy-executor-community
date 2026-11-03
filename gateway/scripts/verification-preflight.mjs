#!/usr/bin/env node
/**
 * P0-5 预检：只读。回答“现在能不能开始记录一次真实验证”，不做任何写入。
 * 用法：node scripts/verification-preflight.mjs --db <workbuddy.db> [--workspace <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { preflightReport } from "../dist/verification-plan.js";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const databasePath = path.resolve(arg("db"));
const workspace = path.resolve(arg("workspace", process.cwd()));

let occupant = null;
if (databasePath && fs.existsSync(databasePath)) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_capacity'").get();
    if (table) {
      const row = db.prepare("SELECT * FROM workflow_capacity WHERE slot=1").get();
      if (row) occupant = { taskId: String(row.task_id), executor: String(row.executor), operationId: String(row.operation_id) };
    }
  } finally {
    db.close();
  }
}

let workspaceWritable = false;
try {
  fs.accessSync(workspace, fs.constants.W_OK);
  workspaceWritable = fs.statSync(workspace).isDirectory();
} catch {
  workspaceWritable = false;
}

process.stdout.write(`${JSON.stringify(preflightReport({
  occupant,
  dispatchEnabled: process.env.WORKBUDDY_DESKTOP_DISPATCH_ENABLED === "1",
  databasePath: fs.existsSync(databasePath) ? databasePath : "",
  workspace,
  workspaceWritable,
}), null, 2)}\n`);
