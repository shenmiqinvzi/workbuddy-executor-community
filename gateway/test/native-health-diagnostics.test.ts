import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { RunJournal } from "../src/run-journal.js";

// F-DIAG-1: the stop gate deliberately keeps the busy rule for replayed
// unfinished tool calls. Operators still have to see why a session stayed busy,
// so the diagnostics the desktop bridge records must survive the read path. The
// observable entry point is workbuddy_get_task -> execution.nativeHealth
// (statusView does not carry native health and is not the place to look).

const SESSION = "60b7c0de-0000-4000-8000-0000000000aa";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-diagnostics-"));
  const workspace = path.join(dir, "Project A");
  fs.mkdirSync(workspace);
  const config: Config = {
    ...loadConfig(),
    backend: "desktop-queue",
    dbFile: path.join(dir, "tasks.sqlite"),
    runsDir: path.join(dir, "runs"),
    workbuddyConfigDir: path.join(dir, "cfg"),
    serviceConfigFile: path.join(dir, "persistent-service.json")
  };
  fs.mkdirSync(config.workbuddyConfigDir!, { recursive: true });
  const store = new TaskStore(config.dbFile);
  const service = new TaskApplicationService(new TaskCoordinator(config, store, new WorkBuddyClient(config)), 3, config.runsDir!);
  const attemptId = "run-aaaaaaaa-1111-4111-8111-111111111111";
  const taskId = "diagnostics-one";
  store.createOrGet({ taskId, messageId: `${attemptId}:0`, objective: "fixture", state: "queued", attemptId, sessionId: SESSION, workspace });
  const journal = new RunJournal(config.runsDir!, attemptId);
  fs.mkdirSync(journal.dir, { recursive: true });
  fs.writeFileSync(path.join(journal.dir, "request.json"), JSON.stringify({ attemptId, taskId, prompt: "fixture", workspace, sessionId: SESSION, sessionMode: "existing", timeoutSeconds: 900 }));
  t.after(() => { try { store.close(); } catch { /* closed by the test */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, service, journal, attemptId, taskId };
}

test("F-DIAG-1 the busy reason and its diagnostics reach the execution view", async t => {
  const f = fixture(t);
  const observedAt = new Date().toISOString();
  f.journal.save({
    version: 1, attemptId: f.attemptId, taskId: f.taskId, sessionId: SESSION, workspace: path.dirname(path.dirname(f.journal.dir)),
    driver: "desktop-queue", status: "working", stopReason: "end_turn",
    nativeStoppedAt: null, nativeStopSource: null,
    nativeHealth: {
      state: "busy",
      reason: "Native WorkBuddy session is active",
      observedAt,
      diagnostics: {
        stillBusy: ["unfinishedTools"],
        pendingToolCalls: [{ toolCallId: "call-1", status: "pending" }],
        observedAt,
        requiredUpstreamEvidence: [
          "a native event that binds each unfinished tool call to a finished turn (attempt or wake identity, or a terminal tool_call_update)",
          "or a daemon signal that the current turn ended for this session"
        ]
      }
    },
    startedAt: observedAt, deadline: new Date(Date.now() + 600_000).toISOString()
  } as never);

  const execution = f.service.executionStatus(f.taskId) as {
    nativeHealth?: { state?: string; diagnostics?: { stillBusy?: string[]; pendingToolCalls?: Array<{ toolCallId: string; status: string }>; requiredUpstreamEvidence?: string[] } };
  };
  assert.equal(execution.nativeHealth?.state, "busy");
  assert.deepEqual(execution.nativeHealth?.diagnostics?.stillBusy, ["unfinishedTools"]);
  assert.deepEqual(execution.nativeHealth?.diagnostics?.pendingToolCalls, [{ toolCallId: "call-1", status: "pending" }]);
  assert.match((execution.nativeHealth?.diagnostics?.requiredUpstreamEvidence ?? []).join(" | "), /binds each unfinished tool call to a finished turn/);

  // statusView stays a status summary: it must not invent a second place where
  // stop evidence lives.
  const view = f.service.statusView(f.store.get(f.taskId)!);
  assert.equal("nativeHealth" in view, false);
});
