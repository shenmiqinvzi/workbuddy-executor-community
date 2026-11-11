import assert from "node:assert/strict";
import test from "node:test";
import { DesktopControlSession, type DesktopControlSnapshot } from "../src/desktop-control.js";
import type { DesktopControlDraft, DesktopControlReceipt } from "../src/desktop-control-journal.js";

/**
 * WB13 completion criterion: "操作拒绝给具体下一步" (a refusal names the concrete next step).
 * The page can only render what the refusal carries, so each of these messages has to say what to
 * do — refresh, wait for stop evidence, re-read the review — and not just that something is wrong.
 */
function fixture() {
  let snapshot: DesktopControlSnapshot = {
    taskId: "task", attemptId: "attempt", revision: "revision", title: "Example", workspace: "project",
    allowedActions: ["cancel", "rework", "review", "accept"], displayState: "needs_review",
    remoteStopped: true, model: "model-a", rate: "x0.00", executorId: "workbuddy", connectionId: "local",
    providerId: "native", reasoningEffort: null, attempt: 1, attemptLimit: 2, currentReviewId: "review-1",
    requirements: [{ id: "semantic-1", kind: "semantic", definition: "Keep behavior" }],
  };
  const sent: DesktopControlDraft[] = [];
  const session = new DesktopControlSession({
    inspect: async () => structuredClone(snapshot),
    enqueue: async (draft) => {
      sent.push(draft);
      return { requestId: draft.requestId, operationId: draft.operationId, kind: draft.kind, taskId: draft.taskId, attemptId: draft.attemptId, revision: draft.revision, state: "requested" } satisfies DesktopControlReceipt;
    },
    receipt: () => null,
    forAttempt: () => [],
  });
  const input = { kind: "rework" as const, taskId: "task", attemptId: "attempt", revision: "revision", feedback: "Fix the boundary", reviewId: null, inspectionFiles: null, semanticChecks: null };
  return { session, input, sent, update: (patch: Partial<DesktopControlSnapshot>) => { snapshot = { ...snapshot, ...patch }; } };
}

async function refuses(action: () => Promise<unknown>, expected: string) {
  try {
    await action();
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    assert.equal(failure.code, expected, `expected ${expected}, got ${failure.code}: ${failure.message}`);
    return failure.message ?? "";
  }
  assert.fail(`expected ${expected}, but the action was allowed`);
}

test("a missing stop proof names the evidence that has to arrive first", async () => {
  const f = fixture();
  f.update({ remoteStopped: false });
  const message = await refuses(() => f.session.preview(f.input), "STOP_UNCONFIRMED");
  assert.match(message, /停止证据/);
  assert.match(message, /不会因超时放行/);
  assert.equal(f.sent.length, 0);
});

test("a stale page tells the operator to refresh instead of reusing the answer", async () => {
  const f = fixture();
  const preview = await f.session.preview(f.input);
  f.update({ revision: "moved-on" });
  const message = await refuses(() => f.session.commit(preview.draft.requestId, preview.digest), "STALE_REVISION");
  assert.match(message, /刷新/);
  assert.match(message, /不要沿用旧页面/);
  assert.equal(f.sent.length, 0);
});

test("an unavailable action names the observed state and the actions that do exist", async () => {
  const f = fixture();
  f.update({ allowedActions: ["cancel"], displayState: "blocked" });
  const message = await refuses(() => f.session.preview(f.input), "ACTION_UNAVAILABLE");
  assert.match(message, /displayState=blocked/);
  assert.match(message, /可用操作=cancel/);
  assert.equal(f.sent.length, 0);
});
