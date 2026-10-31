import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TaskStore } from "../src/task-store.js";

// Real stdio processes, synthetic history, absent native executable/profile.
test("fresh MCP processes preserve history and enforce current admission/review schema", { timeout: 30_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-mcp-entry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gateway = fileURLToPath(new URL("../", import.meta.url));
  const database = path.join(directory, "tasks.sqlite");
  const profile = path.join(directory, "absent-native-profile");
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const store = new TaskStore(database);
  store.createOrGet({ taskId: "persisted-history", messageId: "historical-message", objective: "synthetic historical task", state: "accepted", workspace });
  store.close();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => typeof value === "string" && !key.startsWith("WORKBUDDY_") && !key.startsWith("DSH_"))) as Record<string, string>;
  Object.assign(env, {
    WORKBUDDY_BACKEND: "desktop-queue", WORKBUDDY_DB_FILE: database,
    WORKBUDDY_RUNS_DIR: path.join(directory, "runs"), WORKBUDDY_CONFIG_DIR: profile,
    WORKBUDDY_CLI_ELECTRON: path.join(directory, "absent-native-executable"),
    WORKBUDDY_SERVICE_CONFIG: path.join(directory, "absent-service.json"), WORKBUDDY_DSH_ENABLED: "0",
  });
  const observations: Array<{ pid: number; codeHash: string; task: unknown }> = [];
  for (let round = 0; round < 2; round++) {
    const client = new Client({ name: "isolated-entry-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(gateway, "dist/server.js")], cwd: directory, env, stderr: "pipe" }));
      const tools = (await client.listTools()).tools;
      const accept = tools.find(tool => tool.name === "workbuddy_accept_task")!;
      assert.ok(accept.inputSchema.required?.includes("reviewId"));
      assert.ok(accept.inputSchema.required?.includes("expectedRevision"));
      const send = tools.find(tool => tool.name === "workbuddy_send_task")!;
      assert.ok(send.inputSchema.properties?.scope);
      assert.ok(send.inputSchema.properties?.operationId);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const block = result.content.find(block => block.type === "text");
        assert.ok(block && block.type === "text");
        return { result, text: block.text };
      };
      assert.match((await call("workbuddy_ensure_workspace", { workspace, workerKey: "no-native-work", model: "synthetic-explicit-choice" })).text, /OPERATION_REQUIRED/);
      assert.match((await call("workbuddy_send_task", { taskId: "unselected", operationId: "unselected-send", objective: "must not run", workspace })).text, /MODEL_SELECTION_REQUIRED/);
      const legacyAccept = await call("workbuddy_accept_task", { taskId: "persisted-history", note: "legacy text", evidence: ["passed"] });
      assert.equal(legacyAccept.result.isError, true);
      const history = JSON.parse((await call("workbuddy_list_tasks", { detail: "full" })).text);
      assert.equal(history.ok, true);
      assert.equal(history.tasks.length, 1, "rejected calls must not reserve new tasks");
      assert.equal(history.tasks[0].taskId, "persisted-history");
      assert.equal(history.tasks[0].state, "accepted");
      observations.push({ pid: history.runtime.pid, codeHash: history.runtime.codeHash, task: history.tasks[0] });
      assert.equal(fs.existsSync(profile), false, "admission failures must not prepare a native profile");
    } finally {
      await client.close();
    }
  }
  assert.notEqual(observations[0].pid, observations[1].pid);
  assert.equal(observations[0].codeHash, observations[1].codeHash);
  assert.deepEqual(observations[0].task, observations[1].task);
});
