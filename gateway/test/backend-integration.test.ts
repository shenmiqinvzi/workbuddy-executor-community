import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal } from "../src/run-journal.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { TaskStore } from "../src/task-store.js";
import { registerTaskProjectionTool } from "../src/task-view-reader.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-integration-"));
  const config: Config = { ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"),
    runsDir: path.join(dir, "runs"), workbuddyConfigDir: dir };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 0, NULL)").run("integration-session", dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config));
  const service = new TaskApplicationService(coordinator, 3, config.runsDir!);
  // Synthetic native actor: this exercises the actual queue, not the desktop transport.
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const report = async () => {
    await service.send({ taskId: "integrated-task", objective: "Integration fixture", workspace: dir,
      sessionId: "integration-session", timeoutSeconds: 600 });
    const claim = await queue.claim("integration-session", 0);
    if (claim.status !== "task") throw Error("Expected a queue claim");
    queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nSynthetic integration result", artifacts: [] });
    return claim;
  };
  return { dir, config, store, coordinator, service, queue, report };
}

function fileHashes(directory: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).map(String).sort().flatMap(relative => {
    const filename = path.join(directory, relative);
    return fs.statSync(filename).isFile()
      ? [[relative, crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex")]] : [];
  }));
}

test("shared service and MCP read the authenticated queue result without synchronising or writing", async t => {
  const f = fixture(t);
  const claim = await f.report();
  const beforeStop = f.service.readProjection(claim.taskId);
  assert.equal(beforeStop.ok, true);
  if (!beforeStop.ok) throw Error("Expected a projection");
  assert.equal(beforeStop.projection.facts!.report.state, "authenticated");
  assert.equal(beforeStop.projection.displayState, "waiting_stop");

  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  const before = fileHashes(f.dir);
  const storedTask = f.store.get(claim.taskId);
  // A stored projection must not accidentally acquire the live status path from #4.
  f.coordinator.sync = async () => { throw Error("Projection must not synchronise"); };
  f.coordinator.executionStatus = () => { throw Error("Projection must not observe execution"); };
  const projection = f.service.readProjection(claim.taskId);
  assert.equal(projection.ok, true);
  if (!projection.ok) throw Error("Expected a projection");
  assert.equal(projection.snapshotOnly, true);
  assert.equal(projection.projection.displayState, "needs_review");
  assert.equal(projection.contract, null, "legacy sends do not acquire an invented contract");
  assert.deepEqual(projection.projection.allowedActions, ["export"]);
  assert.equal(f.store.get(claim.taskId)!.runtimeSource, undefined, "reading must not repair the lagging task row");

  const server = new McpServer({ name: "backend-integration", version: "0.0.0" });
  registerTaskProjectionTool(server, f.service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "backend-integration-client", version: "0.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "workbuddy_get_task_projection", arguments: { taskId: claim.taskId } });
    const content = response.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(content.find(item => item.type === "text")!.text!);
    delete payload.runtime;
    assert.deepEqual(payload, projection);
  } finally {
    await client.close();
    await server.close();
  }
  assert.deepEqual(f.store.get(claim.taskId), storedTask);
  assert.deepEqual(fileHashes(f.dir), before, "service and MCP reads leave every stored file unchanged");
});

test("shared projection refuses to promote a tampered report after native stop", async t => {
  const f = fixture(t);
  const claim = await f.report();
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  const journal = new RunJournal(f.config.runsDir!, claim.attemptId);
  journal.save({ ...journal.snapshot()!, text: "Altered report content" });
  const result = f.service.readProjection(claim.taskId);
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("Expected a projection");
  assert.equal(result.projection.facts!.report.state, "unknown");
  assert.notEqual(result.projection.displayState, "needs_review");
  assert.notEqual(result.projection.displayState, "accepted");
  assert.deepEqual(result.projection.allowedActions, ["export"]);
});
