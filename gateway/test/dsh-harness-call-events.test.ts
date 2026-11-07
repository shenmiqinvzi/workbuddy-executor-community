import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { DshTaskCoordinator } from "../src/dsh-coordinator.js";
import { legacyFreeModelPolicy } from "../src/collaboration.js";
import type { DshSelection, DshTransport } from "../src/dsh-client.js";
import type { DeepSeekEvent } from "../src/deepseek-client.js";
import { readHarnessCallEvents } from "../src/statistics-harness-calls.js";

/**
 * The real `sync()` path is what turns Harness tool traffic into call facts, so
 * these tests drive the adapter instead of the recording helper: the claim under
 * test is "a synced page produces exactly one fact per finished tool call", not
 * "the writer can write".
 */
function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-calls-")));
  const store = new TaskStore(path.join(dir, "tasks.sqlite")), runs = path.join(dir, "runs");
  const execution = { executorId: "dsh" as const, connectionId: "dsh-synthetic-host", providerId: "synthetic-provider", modelId: "synthetic-model", reasoningEffort: null };
  const events: DeepSeekEvent[] = [];
  let selected: DshSelection | null = null;
  const client: DshTransport = {
    resolveHostId(id) { return id ?? execution.connectionId; },
    async health() { return { capabilities: { automaticReview: false } }; },
    async sessions() { return { sessions: [{ sessionId: "original-session", workspace: dir, busy: false, attached: true }] }; },
    async create() { throw Error("Session creation is forbidden in this fixture"); },
    async session(input) { return { sessionId: input.sessionId, workspace: dir, busy: false, attached: true, selectedModel: selected }; },
    async models() { return { pricingVerified: false, models: [{ ...execution, credits: null, reasoningEfforts: [] }] }; },
    async selectModel(input) { selected = { providerId: input.providerId, modelId: input.modelId, reasoningEffort: input.reasoningEffort }; return { sessionId: input.sessionId, workspace: dir, attached: true, selectedModel: selected }; },
    async prompt(input) { return { requestId: input.requestId, accepted: true }; },
    async events(input) { const page = events.filter(event => event.seq > input.afterSeq).slice(0, input.limit); return { events: page, cursor: page.at(-1)?.seq ?? input.afterSeq }; },
    async cancel() { return { requested: true, stopped: true }; },
  };
  const free = async () => ({ credits: "x0.00", observedAt: new Date().toISOString() });
  const coordinator = new DshTaskCoordinator(store, client, runs, free);
  store.collaboration.registerWorkspace("project", dir, "Synthetic project");
  store.collaboration.setPolicy({ ...legacyFreeModelPolicy(), allowed: [...legacyFreeModelPolicy().allowed, execution] });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const contract = (taskId = "dsh-task") => {
    const proposal = { schemaVersion: "workbuddy-executor/vnext-2", taskId, workspaceId: "project", title: "Synthetic DSH task", objective: "Verify the bounded synthetic adapter", execution, timeoutSeconds: 60, maxAttempts: 2, scope: { allowedChanges: ["src/example.ts"], permittedMetadata: [] }, requiredChecks: [], collaboration: { planId: "placeholder", expectedPlanRevision: "placeholder" } };
    const plan = store.collaboration.createPlan(proposal, coordinator.policy(), { mode: "manual", reason: "Explicit test action" });
    store.collaboration.authorizePlan(plan.planId, plan.revision, coordinator.policy(), "synthetic-user-action");
    return { ...proposal, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  };
  const send = (taskId?: string) => { const input = contract(taskId); return coordinator.send({ contract: input, objective: input.objective, sessionId: "original-session" }); };
  const push = (type: DeepSeekEvent["type"], options: Partial<DeepSeekEvent> = {}) => {
    const binding = store.dshBindings.forTask("dsh-task")!;
    const value: DeepSeekEvent = { seq: events.length, requestId: binding.requestId, type, timestamp: new Date(180_000_000_000 + events.length * 1000).toISOString(), turnId: `${binding.sessionId}:turn:${store.get("dsh-task")!.attempt}`, rawType: type === "started" ? "turn/start" : ["completed", "failed", "cancelled"].includes(type) ? "turn/end" : "request/header", ...options };
    events.push(value); return value;
  };
  const started = () => { push("started"); push("progress", { data: { header: { config: { provider: execution.providerId, model: execution.modelId } } } }); };
  const toolCall = (callId: string, name = "read_file") => push("progress", { rawType: "tool/call", data: { name, callId, arguments: { path: "src/example.ts" } } });
  const toolResult = (callId: string, isError = false) => push("progress", { rawType: "tool/result", data: { message: { toolCallId: callId, isError } } });
  const complete = (text = "TASK_STATUS: completed\nTEST_RESULT: synthetic verification passed") => push("completed", { text });
  const callEvents = () => readHarnessCallEvents(store.listTaskEvents("dsh-task", { afterEventId: 0, limit: 200 }).events);
  return { dir, store, runs, coordinator, send, started, toolCall, toolResult, complete, push, callEvents };
}

test("a synced Harness page turns one finished tool call into one call fact", async t => {
  const f = fixture(t);
  await f.send();
  f.started();
  f.toolCall("call-1");
  f.toolResult("call-1");
  f.complete();
  await f.coordinator.sync("dsh-task");

  const events = f.callEvents();
  assert.equal(events.length, 1);
  const payload = events[0].payload as Record<string, any>;
  assert.equal(events[0].type, "tool_call_finished");
  assert.equal(payload.channel, "native");
  assert.equal(payload.producer, "dsh_harness_events");
  assert.equal(payload.outcome, "succeeded");
  assert.equal(payload.status, "completed");
  assert.equal(payload.toolName, "read_file");
  // The Harness stream publishes no byte counts; absence must stay absence.
  assert.equal(Object.hasOwn(payload, "bytes"), false);
  assert.ok((payload.limitations as string[]).includes("harness_bytes_unmeasured"));
  const attemptId = f.store.get("dsh-task")!.attemptId!;
  assert.match(events[0].sourceRef!, new RegExp(`^tool-call:dsh:${attemptId}:\\d+$`));

  // Syncing again reads no new page and must not duplicate the fact.
  await f.coordinator.sync("dsh-task");
  assert.equal(f.callEvents().length, 1);
});

test("an unpaired tool call only becomes a fact once the stream is final", async t => {
  const f = fixture(t);
  await f.send();
  f.started();
  f.toolCall("call-orphan");
  await f.coordinator.sync("dsh-task");
  // Still running: nothing observed has finished, so no fact is written.
  assert.equal(f.callEvents().length, 0);

  f.complete();
  await f.coordinator.sync("dsh-task");
  const events = f.callEvents();
  assert.equal(events.length, 1);
  const payload = events[0].payload as Record<string, any>;
  assert.equal(payload.outcome, "outcome_unknown");
  assert.equal(payload.failureKind, "no_terminal_status");
  assert.ok((payload.limitations as string[]).includes("call_start_missing") === false);
});

test("a failed tool result is recorded as a failure, not as an unknown", async t => {
  const f = fixture(t);
  await f.send();
  f.started();
  f.toolCall("call-2");
  f.toolResult("call-2", true);
  f.complete();
  await f.coordinator.sync("dsh-task");
  const events = f.callEvents();
  assert.equal(events.length, 1);
  const payload = events[0].payload as Record<string, any>;
  assert.equal(payload.outcome, "failed");
  assert.equal(payload.failureKind, "tool_error");
});

test("a read-only sync reads the same page without writing any call fact", async t => {
  const f = fixture(t);
  await f.send();
  f.started();
  f.toolCall("call-3");
  f.toolResult("call-3");
  await f.coordinator.sync("dsh-task", 100, true);
  // Observation must not create task events: the page is only looked at.
  assert.equal(f.callEvents().length, 0);
  const all = f.store.listTaskEvents("dsh-task", { afterEventId: 0, limit: 200 }).events;
  assert.deepEqual(all.filter(event => event.type === "tool_call_finished"), []);
});
