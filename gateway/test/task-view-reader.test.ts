/**
 * Tests for the read-only projection query.
 *
 * The records are synthetic and the run files live in a temporary directory.
 * Nothing here touches a real task database, a real runs directory or a native
 * session.
 *
 * The last group drives the tool through an in-memory MCP client/server pair,
 * so the check covers the handler that is actually registered rather than only
 * the internal function.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readTaskProjection,
  registerTaskProjectionTool,
  type TaskProjectionSources,
  type TaskProjectionStore,
} from "../src/task-view-reader.js";
import type { StoredAttempt, StoredTask } from "../src/task-store.js";
import type { RunSnapshot } from "../src/run-journal.js";

const TASK_ID = "task-reader-1";
const ATTEMPT_ID = "run-33333333-3333-3333-3333-333333333333";
const OTHER_ATTEMPT_ID = "run-44444444-4444-4444-4444-444444444444";
const SESSION_ID = "session-reader-1";
const STOPPED_AT = "2026-10-18T10:20:00.000Z";

function task(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    taskId: TASK_ID,
    messageId: "msg-1",
    objective: "synthetic objective",
    state: "cancelled",
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:30:00.000Z",
    sessionId: SESSION_ID,
    runtimeSource: "desktop_queue",
    attemptId: ATTEMPT_ID,
    attempt: 1,
    ...overrides,
  };
}

function attemptRow(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  return {
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    attempt: 1,
    messageId: "msg-1",
    sessionId: SESSION_ID,
    runtimeSource: "desktop_queue",
    state: "cancelled",
    lastEventSeq: 0,
    artifacts: [],
    evidence: [],
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:30:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    attemptId: ATTEMPT_ID,
    taskId: TASK_ID,
    status: "cancelled",
    driver: "desktop-queue",
    sessionId: SESSION_ID,
    runtimeSource: "desktop_queue",
    nativeStoppedAt: STOPPED_AT,
    nativeStopSource: "native_idle",
    updatedAt: "2026-10-18T10:30:00.000Z",
    ...overrides,
  };
}

interface RecordingStore extends TaskProjectionStore {
  calls: string[];
}

function storeOf(value: StoredTask | undefined, attempts: StoredAttempt[]): RecordingStore {
  const calls: string[] = [];
  return {
    calls,
    get(id: string) {
      calls.push("get");
      return value && id === value.taskId ? value : undefined;
    },
    listAttempts(id: string) {
      calls.push("listAttempts");
      return value && id === value.taskId ? attempts : [];
    },
  };
}

/** Run a test against a fresh temporary runs directory. */
function withRunsDir(run: (runsDir: string) => void): void {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-projection-"));
  try {
    run(runsDir);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}

function runDirOf(runsDir: string, attemptId = ATTEMPT_ID): string {
  return path.join(runsDir, attemptId);
}

function writeRun(
  runsDir: string,
  files: { state?: unknown; cancel?: unknown; rawState?: string; rawCancel?: string },
  attemptId = ATTEMPT_ID,
): void {
  const dir = runDirOf(runsDir, attemptId);
  fs.mkdirSync(dir, { recursive: true });
  if (files.state !== undefined) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(files.state));
  if (files.rawState !== undefined) fs.writeFileSync(path.join(dir, "state.json"), files.rawState);
  if (files.cancel !== undefined) fs.writeFileSync(path.join(dir, "cancel.json"), JSON.stringify(files.cancel));
  if (files.rawCancel !== undefined) fs.writeFileSync(path.join(dir, "cancel.json"), files.rawCancel);
}

/** A recursive content snapshot, used to prove the query writes nothing. */
function dirSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${rel}/`] = "<dir>";
        walk(absolute, rel);
      } else {
        out[rel] = fs.readFileSync(absolute, "utf8");
      }
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out;
}

/* ------------------------------------------------------------------ *
 * Normal query
 * ------------------------------------------------------------------ */

test("a stored task is projected with its gaps and identity", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot(), cancel: { requestedAt: "2026-10-18T10:10:00.000Z", reason: "cancellation" } });
    const result = readTaskProjection({ store: storeOf(task(), [attemptRow()]), runsDir }, TASK_ID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.readOnly, true);
    assert.equal(result.snapshotOnly, true);
    assert.equal(result.task.taskId, TASK_ID);
    assert.equal(result.task.attemptId, ATTEMPT_ID);
    assert.equal(result.task.state, "cancelled");
    assert.equal(result.projection.displayState, "cancelled");
    assert.equal(result.projection.facts!.terminalDecision.cause, "cancellation");
    assert.equal(result.projection.facts!.stop.proven, true);
    // The adapter's gaps are preserved, including the ones this round cannot fix.
    assert.ok(result.projection.gaps.some(gap => gap.code === "review_id_unavailable"));
    assert.deepEqual(result.projection.allowedActions, ["export"]);
    assert.equal(result.projection.actionFacts, null);
  });
});

/* ------------------------------------------------------------------ *
 * Missing task and missing attempt
 * ------------------------------------------------------------------ */

test("an unknown task id is reported as not found", () => {
  withRunsDir(runsDir => {
    const result = readTaskProjection({ store: storeOf(undefined, []), runsDir }, "no-such-task");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "task_not_found");
    assert.equal(result.attemptId, null);
  });
});

test("a task without a current attempt invents no identity and reads no files", () => {
  withRunsDir(runsDir => {
    const result = readTaskProjection(
      { store: storeOf(task({ attemptId: undefined }), [attemptRow()]), runsDir },
      TASK_ID,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.task.attemptId, null);
    assert.equal(result.projection.facts, null);
    assert.ok(result.projection.gaps.some(gap => gap.code === "attempt_missing"));
    // No directory was created for the query.
    assert.deepEqual(fs.readdirSync(runsDir), []);
  });
});

/* ------------------------------------------------------------------ *
 * Run files: absent, corrupt, unreadable
 * ------------------------------------------------------------------ */

test("a missing state file is reported as an absent snapshot, not as a failure", () => {
  withRunsDir(runsDir => {
    const result = readTaskProjection({ store: storeOf(task(), [attemptRow()]), runsDir }, TASK_ID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.projection.facts!.stop.proven, null);
    assert.ok(result.projection.gaps.some(gap => gap.code === "snapshot_missing"));
  });
});

test("a corrupt state file is a structured failure, not a missing file", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { rawState: "{ this is not json" });
    const result = readTaskProjection({ store: storeOf(task(), [attemptRow()]), runsDir }, TASK_ID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "state_corrupt");
    assert.equal(result.field, "state.json");
  });
});

test("a state path that cannot be read is not disguised as a missing file", () => {
  withRunsDir(runsDir => {
    // A directory where the file is expected fails with a non-ENOENT error.
    fs.mkdirSync(path.join(runDirOf(runsDir), "state.json"), { recursive: true });
    const result = readTaskProjection({ store: storeOf(task(), [attemptRow()]), runsDir }, TASK_ID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "state_unreadable");
    assert.equal(result.field, "state.json");
  });
});

test("a corrupt cancel file is a structured failure", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot(), rawCancel: "not json at all" });
    const result = readTaskProjection({ store: storeOf(task(), [attemptRow()]), runsDir }, TASK_ID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "cancel_corrupt");
    assert.equal(result.field, "cancel.json");
  });
});

test("an absent cancel file leaves the projection without a cancellation record", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot() });
    const result = readTaskProjection(
      { store: storeOf(task({ state: "cancelled" }), [attemptRow()]), runsDir },
      TASK_ID,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The coarse cancelled state still names the cause; no record contradicts it.
    assert.equal(result.projection.facts!.terminalDecision.cause, "cancellation");
    assert.ok(!result.projection.gaps.some(gap => gap.code === "cancellation_reason_missing"));
  });
});

/* ------------------------------------------------------------------ *
 * Read conflict
 * ------------------------------------------------------------------ */

test("a change of the current attempt during the read is reported as a conflict", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot() });
    let reads = 0;
    const store: TaskProjectionStore = {
      get() {
        reads += 1;
        return reads === 1 ? task() : task({ attemptId: OTHER_ATTEMPT_ID });
      },
      listAttempts() {
        return [attemptRow()];
      },
    };
    const result = readTaskProjection({ store, runsDir }, TASK_ID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "read_conflict");
    assert.equal(result.field, "task.attemptId");
  });
});

test("a task that disappears during the read is reported as a conflict", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot() });
    let reads = 0;
    const store: TaskProjectionStore = {
      get() {
        reads += 1;
        return reads === 1 ? task() : undefined;
      },
      listAttempts() {
        return [attemptRow()];
      },
    };
    const result = readTaskProjection({ store, runsDir }, TASK_ID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "read_conflict");
  });
});

/* ------------------------------------------------------------------ *
 * The query stays read-only
 * ------------------------------------------------------------------ */

test("the query writes nothing to the runs directory", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot(), cancel: { requestedAt: "2026-10-18T10:10:00.000Z", reason: "cancellation" } });
    const before = dirSnapshot(runsDir);
    readTaskProjection({ store: storeOf(task(), [attemptRow()]), runsDir }, TASK_ID);
    assert.deepEqual(dirSnapshot(runsDir), before);
  });
});

test("the query reads only get and listAttempts from the store", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot() });
    const recording = storeOf(task(), [attemptRow()]);
    readTaskProjection({ store: recording, runsDir }, TASK_ID);
    assert.deepEqual([...new Set(recording.calls)], ["get", "listAttempts"]);
  });
});

test("the query never reaches for a synchronising or native entry point", () => {
  withRunsDir(runsDir => {
    writeRun(runsDir, { state: snapshot() });
    const base = storeOf(task(), [attemptRow()]);
    const guarded = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "get" || property === "listAttempts" || property === "calls") {
          return Reflect.get(target, property, receiver);
        }
        throw new Error(`unexpected store access: ${String(property)}`);
      },
    });
    const result = readTaskProjection({ store: guarded, runsDir }, TASK_ID);
    assert.equal(result.ok, true);
  });
});

test("the query does not create the runs directory when it is absent", () => {
  const missing = path.join(os.tmpdir(), `task-projection-absent-${process.pid}-${Date.now()}`);
  const result = readTaskProjection({ store: storeOf(task(), [attemptRow()]), runsDir: missing }, TASK_ID);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(missing), false);
});

/* ------------------------------------------------------------------ *
 * The registered MCP handler
 * ------------------------------------------------------------------ */

interface RegisteredToolResult {
  payload: Record<string, unknown>;
  tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
}

async function callRegisteredTool(
  sources: TaskProjectionSources,
  taskId: string,
): Promise<RegisteredToolResult> {
  const server = new McpServer({ name: "task-projection-test", version: "0.0.0" });
  registerTaskProjectionTool(server, sources);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "task-projection-test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const response = await client.callTool({ name: "workbuddy_get_task_projection", arguments: { taskId } });
    const content = response.content as Array<{ type: string; text?: string }>;
    const text = content.find(part => part.type === "text")?.text ?? "{}";
    return {
      payload: JSON.parse(text) as Record<string, unknown>,
      tools: listed.tools as RegisteredToolResult["tools"],
    };
  } finally {
    await client.close();
    await server.close();
  }
}

test("the registered tool returns the projection", async () => {
  await withRunsDirAsync(async runsDir => {
    writeRun(runsDir, { state: snapshot(), cancel: { requestedAt: "2026-10-18T10:10:00.000Z", reason: "cancellation" } });
    const { payload, tools } = await callRegisteredTool(
      { store: storeOf(task(), [attemptRow()]), runsDir },
      TASK_ID,
    );
    assert.equal(payload.ok, true);
    assert.equal(payload.readOnly, true);
    assert.equal(payload.snapshotOnly, true);
    const projection = payload.projection as { displayState?: string; gaps?: unknown[]; allowedActions?: string[] };
    assert.equal(projection.displayState, "cancelled");
    assert.ok(Array.isArray(projection.gaps) && projection.gaps.length > 0);
    assert.deepEqual(projection.allowedActions, ["export"]);
    // The projection is not dropped by any presentation filter.
    assert.ok("projection" in payload);

    const tool = tools.find(entry => entry.name === "workbuddy_get_task_projection");
    assert.ok(tool, "the tool must be registered under its documented name");
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["taskId"]);
  });
});

test("the registered tool reports an unknown task without throwing", async () => {
  await withRunsDirAsync(async runsDir => {
    const { payload } = await callRegisteredTool({ store: storeOf(undefined, []), runsDir }, "no-such-task");
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "task_not_found");
    assert.equal(payload.readOnly, true);
  });
});

/** Async counterpart of withRunsDir. */
async function withRunsDirAsync(run: (runsDir: string) => Promise<void>): Promise<void> {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-projection-"));
  try {
    await run(runsDir);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}
