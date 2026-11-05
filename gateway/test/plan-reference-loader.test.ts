import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceLoader, executionKey } from "../workbench/plan-reference.mjs";

// The confirmation step can be re-entered, dismissed or re-targeted while a
// read is in flight. These tests pin the rule that only the selection that is
// still on screen may write into the panel.

const EXEC = { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-model-alpha", reasoningEffort: null };
const OTHER = { ...EXEC, modelId: "synthetic-model-beta" };

function documentFor(modelId: string, status = "unlinked") {
  return { schemaVersion: "workbuddy-executor/plan-resource-reference-1", association: { status }, execution: { modelId } };
}

function harness() {
  const calls: Array<{ url: string; init: any; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  let aborts = 0;
  const fetchImpl = (url: string, init: any) => new Promise((resolve, reject) => {
    const record = { url, init, resolve, reject };
    calls.push(record);
    init?.signal?.addEventListener("abort", () => {
      aborts += 1;
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  return { calls, fetchImpl, ok, get aborts() { return aborts; } };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test("switching the model aborts the in-flight read and keeps only the new answer", async () => {
  const h = harness();
  const loader = createReferenceLoader({ fetchImpl: h.fetchImpl });
  loader.bind(EXEC, "draft-1");
  void loader.load(false);
  assert.equal(h.calls.length, 1);
  assert.equal(loader.state.loading, true);
  loader.bind(OTHER, "draft-1");
  assert.equal(h.aborts, 1, "the old request is aborted, not just ignored");
  assert.equal(loader.state.document, null);
  void loader.load(false);
  assert.equal(h.calls.length, 2);
  h.calls[1]!.resolve(h.ok(documentFor("synthetic-model-beta", "linked")));
  await tick();
  assert.equal(loader.state.document?.execution.modelId, "synthetic-model-beta");
  assert.equal(loader.state.loading, false);
  // The abandoned response arrives late and must not overwrite the new one.
  h.calls[0]!.resolve(h.ok(documentFor("synthetic-model-alpha")));
  await tick();
  assert.equal(loader.state.document?.execution.modelId, "synthetic-model-beta");
});

test("a late answer for an old key is dropped even when the transport ignored the abort", async () => {
  const calls: Array<{ resolve: (value: unknown) => void }> = [];
  const fetchImpl = () => new Promise(resolve => { calls.push({ resolve }); });
  const loader = createReferenceLoader({ fetchImpl });
  loader.bind(EXEC, "draft-1");
  void loader.load(false);
  loader.bind(OTHER, "draft-1");
  void loader.load(false);
  calls[0]!.resolve({ ok: true, status: 200, json: async () => documentFor("synthetic-model-alpha") });
  await tick();
  assert.equal(loader.state.document, null);
  assert.equal(loader.state.loading, true);
  calls[1]!.resolve({ ok: true, status: 200, json: async () => documentFor("synthetic-model-beta") });
  await tick();
  assert.equal(loader.state.document?.execution.modelId, "synthetic-model-beta");
});

test("closing the panel during a read leaves no state behind", async () => {
  const h = harness();
  const loader = createReferenceLoader({ fetchImpl: h.fetchImpl });
  loader.bind(EXEC, "draft-1");
  void loader.load(false);
  loader.reset();
  assert.equal(h.aborts, 1);
  assert.equal(loader.state.loading, false);
  assert.equal(loader.state.document, null);
  assert.equal(loader.state.execution, null);
  h.calls[0]!.resolve(h.ok(documentFor("synthetic-model-alpha")));
  await tick();
  assert.equal(loader.state.document, null);

  loader.bind(EXEC, "draft-2");
  void loader.load(false);
  loader.destroy();
  assert.equal(h.aborts, 2);
  h.calls[1]!.resolve(h.ok(documentFor("synthetic-model-alpha")));
  await tick();
  assert.equal(loader.state.document, null);
});

test("a failed refresh keeps the previous snapshot and reports the error", async () => {
  const h = harness();
  const loader = createReferenceLoader({ fetchImpl: h.fetchImpl });
  loader.bind(EXEC, "draft-1");
  void loader.load(false);
  h.calls[0]!.resolve(h.ok(documentFor("synthetic-model-alpha", "linked")));
  await tick();
  assert.equal(loader.state.document?.association.status, "linked");

  void loader.load(true);
  h.calls[1]!.resolve({ ok: false, status: 503, json: async () => ({ error: { code: "RESOURCE_STORE_UNAVAILABLE" } }) });
  await tick();
  assert.equal(loader.state.error?.code, "RESOURCE_STORE_UNAVAILABLE");
  assert.equal(loader.state.document?.association.status, "linked", "the last good snapshot is kept");
});

test("the same selection is not re-read twice, but a new draft identity is", async () => {
  const h = harness();
  const loader = createReferenceLoader({ fetchImpl: h.fetchImpl });
  loader.bind(EXEC, "draft-1");
  void loader.load(false);
  h.calls[0]!.resolve(h.ok(documentFor("synthetic-model-alpha")));
  await tick();
  assert.equal(loader.bind(EXEC, "draft-1"), false);
  assert.equal(h.calls.length, 1);
  assert.equal(loader.bind(EXEC, "draft-2"), true, "a new draft identity re-reads the same selection");
  assert.equal(loader.state.document, null, "data from another draft is dropped");
  void loader.load(false);
  assert.equal(h.calls.length, 2);
});

test("the request carries the exact execution selection and never a body", async () => {
  const h = harness();
  const loader = createReferenceLoader({ fetchImpl: h.fetchImpl });
  loader.bind({ ...EXEC, reasoningEffort: "high" }, "draft-1");
  void loader.load(false);
  const call = h.calls[0]!;
  assert.equal(call.url, "/workbench/v1/resources/plan-reference?executorId=workbuddy&connectionId=local-workbuddy&providerId=workbuddy-native&modelId=synthetic-model-alpha&reasoningEffort=high");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.body, undefined);
  assert.equal(call.init.cache, "no-store");
  assert.equal(executionKey(EXEC) === executionKey(EXEC), true);
});
