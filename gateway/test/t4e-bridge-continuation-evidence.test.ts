import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The bridge half of R3: a continuation turn emits no `request/header`, so the
 *  adapter records the native header sequence the request continues from at
 *  admission and serves it back for that requestId only. The evidence stops being
 *  served as soon as that header is no longer the session's header, so the gateway
 *  can never authenticate a turn against a header the native session discarded. */
async function bridge(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t4e-bridge-")));
  const config = { provider: "synthetic-provider", model: "synthetic-model", reasoningEffort: "high" };
  const committed: Array<{ seq: number; type: string; data?: unknown }> = [
    { seq: 0, type: "request/header", data: { header: { config } } },
  ];
  const ctx = {
    get: () => undefined,
    sessionController: {
      async inspect(sessionId: string) { return { meta: { id: sessionId, cwd: dir }, events: committed.map(event => ({ ...event })) }; },
      async prompt() { return { accepted: true }; },
    },
    agents: { get: () => ({ status: "idle", inbox: { nextTurn: [], nextStep: [] } }) },
  };
  const { createAdapter } = await import("../deepseek-plugin/adapter.mjs") as unknown as { createAdapter: (ctx: unknown, options: Record<string, unknown>) => Promise<{ invoke: (method: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>> }> };
  const adapter = await createAdapter(ctx, { root: path.join(dir, "bridge"), hostId: "synthetic-host", identity: { profile: "desktop", runtimeSource: "cli", version: "0.2.1-rc.2" } });
  const signal = new AbortController().signal;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return { adapter, signal, config, committed, dir };
}

test("E01: a continuation's admission records the native header it continues from", async t => {
  const f = await bridge(t);
  const accepted = await f.adapter.invoke("prompt", { sessionId: "session", requestId: "request-2", text: "continue the work", expectedSelection: { providerId: f.config.provider, modelId: f.config.model, reasoningEffort: f.config.reasoningEffort } }, f.signal);
  assert.equal(accepted.accepted, true);
  const page = await f.adapter.invoke("events", { sessionId: "session", requestId: "request-2", afterSeq: -1, limit: 20 }, f.signal);
  assert.deepEqual(page.modelEvidence, { headerSeq: 0, providerId: f.config.provider, modelId: f.config.model, reasoningEffort: f.config.reasoningEffort, sessionId: "session", requestId: "request-2", observedAt: (page.modelEvidence as { observedAt: string }).observedAt });
  assert.equal((page.modelEvidence as { headerSeq: number }).headerSeq, 0);
});

test("E02: evidence is served per requestId and only while its header is still native", async t => {
  const f = await bridge(t);
  await f.adapter.invoke("prompt", { sessionId: "session", requestId: "request-2", text: "continue the work", expectedSelection: { providerId: f.config.provider, modelId: f.config.model, reasoningEffort: f.config.reasoningEffort } }, f.signal);
  const other = await f.adapter.invoke("events", { sessionId: "session", requestId: "request-3", afterSeq: -1, limit: 20 }, f.signal);
  assert.equal(other.modelEvidence, undefined, "another requestId has no admission record of its own");
  // The session discarded the header it recorded: the anchor no longer exists.
  f.committed.splice(0, 1, { seq: 0, type: "model/selection", data: { provider: f.config.provider, model: f.config.model } });
  const dropped = await f.adapter.invoke("events", { sessionId: "session", requestId: "request-2", afterSeq: -1, limit: 20 }, f.signal);
  assert.equal(dropped.modelEvidence, undefined, "a replaced header stops grounding the evidence");
});

test("E03: a different native header is never re-labelled as this request's evidence", async t => {
  const f = await bridge(t);
  await f.adapter.invoke("prompt", { sessionId: "session", requestId: "request-2", text: "continue the work", expectedSelection: { providerId: f.config.provider, modelId: f.config.model, reasoningEffort: f.config.reasoningEffort } }, f.signal);
  f.committed.splice(0, 1, { seq: 0, type: "request/header", data: { header: { config: { provider: f.config.provider, model: "another-model", reasoningEffort: null } } } });
  const page = await f.adapter.invoke("events", { sessionId: "session", requestId: "request-2", afterSeq: -1, limit: 20 }, f.signal);
  assert.equal(page.modelEvidence, undefined);
});
