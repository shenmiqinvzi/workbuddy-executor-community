/**
 * L08 acceptance line — task panel prototype (F01–F20 evidence that can be
 * produced without a real window).
 *
 * The panel's pure model and its DOM builders run against the bundled mini DOM.
 * Anything that needs real layout, real fonts, real zoom or a screen reader is
 * NOT asserted here: those items stay "uncovered" in the delivery report rather
 * than being promoted by a source-level guess.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installMiniDom } from "./support/mini-dom.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workbench = path.join(here, "..");
installMiniDom();

const panel = await import("../attention.mjs");
const model = await import("../model.mjs");
const statistics = await import("../statistics.mjs");
const resources = await import("../resources-model.mjs");

const STATES = ["queued", "running", "waiting_input", "waiting_stop", "needs_review", "accepted", "cancelled", "failed", "expired", "unknown"];

function record(state, overrides = {}) {
  const now = "2026-11-06T00:00:00+08:00";
  const base = {
    ok: true,
    taskId: "l08-panel-task",
    view: {
      schemaVersion: "workbuddy-executor/stage-2",
      taskId: "l08-panel-task",
      revision: "rev-1",
      title: null,
      workspace: { displayName: null, id: "l08-workspace", storedPath: "C:\\synthetic\\workspace" },
      attempt: { id: "run-00000000-0000-4000-8000-000000000000", number: 1, limit: 3 },
      binding: { sessionId: "l08-session", runtimeSource: "desktop_queue" },
      businessState: state === "accepted" ? "accepted" : "needs_review",
      displayState: state,
      remoteStopped: true,
      allowedActions: [],
      timing: { createdAt: now, lastObservedAt: now, reviewedAt: null, nativeStoppedAt: now },
      workspaceScope: { baseline: "present", check: { status: "passed", changes: [], changeCount: 0, changesTruncated: false } },
    },
    presentation: { title: null, objective: "Synthetic L08 objective", report: null, blockingReason: null, allowedChanges: [] },
    reviews: [],
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key in base.view) base.view[key] = value;
    else if (key in base.presentation) base.presentation[key] = value;
    else base[key] = value;
  }
  return base;
}

test("L08 all ten display states are selectable and never share wording", () => {
  assert.deepEqual(Object.keys(model.STATES).sort(), [...STATES].sort(), "the prototype must expose exactly the ten documented states");
  const seen = new Set();
  for (const state of STATES) {
    const info = model.stateInfo(record(state));
    assert.equal(info.key, state);
    assert.ok(info.label.trim().length > 0, `${state} needs a label`);
    assert.ok(info.description.trim().length > 0, `${state} needs a description`);
    assert.ok(!seen.has(info.label), `${state} reuses the label ${info.label}`);
    seen.add(info.label);
  }
  assert.equal(seen.size, 10);
});

test("L08 needs_review without native stop evidence becomes inconsistent, not ready", () => {
  assert.equal(model.stateInfo(record("needs_review", { remoteStopped: false })).key, "inconsistent");
  assert.equal(model.stateInfo(record("needs_review", { remoteStopped: null })).key, "inconsistent");
  assert.equal(model.stateInfo(record("needs_review")).key, "needs_review");
  assert.equal(model.stateInfo({ ok: false }).key, "unknown");
  assert.equal(model.stateInfo({ ok: false }).label, "记录读取失败");

  assert.equal(panel.attentionReason(record("waiting_stop"))?.code, "stop_unconfirmed");
  assert.equal(panel.attentionReason(record("needs_review", { remoteStopped: false }))?.code, "stop_unconfirmed");
  assert.equal(panel.attentionReason(record("waiting_input"))?.code, "input_waiting");
  assert.equal(panel.attentionReason(record("accepted"))?.code ?? null, null, "an accepted task owes no attention card");
  assert.equal(panel.offersDeclaration({ code: "stop_unconfirmed" }, record("waiting_stop")), true);
  assert.equal(panel.offersDeclaration({ code: "review_pending" }, record("needs_review", { remoteStopped: false })), true);
  assert.equal(panel.offersDeclaration({ code: "review_pending" }, record("needs_review")), false);
});

test("L08 a worker report is never rendered as completion or acceptance", () => {
  const reported = record("needs_review", { report: { text: "TASK_STATUS: completed", authentication: "authenticated" } });
  const partial = model.proofs(reported);
  assert.equal(partial[0].confirmed, true, "the report itself is a recorded fact");
  assert.equal(partial[1].confirmed, true, "native stop is proven separately");
  assert.equal(partial[2].value, "尚无审查");
  assert.equal(partial[2].confirmed, false, "a self-reported completion is not acceptance");

  const claimed = record("accepted", { report: { text: "TASK_STATUS: completed", authentication: "authenticated" } });
  assert.equal(model.proofs(claimed)[2].confirmed, false, "accepted without stored reviewer checks is not proof of acceptance");

  const reviewed = record("accepted");
  reviewed.reviews = [{ reviewId: "review-1", attemptId: reviewed.view.attempt.id, checks: [{ checkId: "semantic", status: "passed", actor: "independent_reviewer", evidenceRefs: [] }] }];
  assert.equal(model.proofs(reviewed)[2].confirmed, true);
  const selfReview = record("accepted");
  selfReview.reviews = [{ reviewId: "review-2", attemptId: selfReview.view.attempt.id, checks: [{ checkId: "semantic", status: "passed", actor: "worker", evidenceRefs: [] }] }];
  assert.equal(model.proofs(selfReview)[2].confirmed, false, "worker self-checks never count as independent acceptance");
});

test("L08 clock, midnight, invalid and missing times stay distinguishable", () => {
  assert.equal(model.formatTime(null), "未提供");
  assert.equal(model.formatTime(""), "未提供");
  assert.equal(model.formatTime("not-a-time"), "未提供");
  const midnight = model.formatTime("2026-11-06T00:00:00+08:00");
  assert.notEqual(midnight, "未提供", "midnight is a real instant, not a missing value");
  assert.match(midnight, /^\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.match(midnight, /00:00$/);
  assert.notEqual(model.formatTime("2026-11-06T00:00:00Z"), "未提供");
  // Known limitation, recorded instead of hidden: a numeric epoch zero is
  // treated like a missing timestamp because the formatter truth-tests the input.
  assert.equal(model.formatTime(0), "未提供");
  assert.equal(resources.formatStamp(null), "未提供");
  assert.equal(resources.formatStamp("not-a-time"), "时间不可读");
  assert.match(resources.formatStamp("2026-11-06T00:00:00+08:00"), /00:00$/);
});

test("L08 null counters never collapse into zero", () => {
  assert.equal(statistics.amount(0), "0");
  assert.notEqual(statistics.amount(null), "0");
  assert.equal(statistics.seconds(0), "0m00s");
  assert.notEqual(statistics.seconds(null), "0m00s");
  assert.equal(resources.formatCount(0), "0");
  assert.equal(resources.formatCount(null), null);
  assert.equal(resources.formatTokens(null), null);
  assert.equal(resources.formatCredits(0), "0");
  assert.equal(resources.formatRatio(0, 0), "0 / 0 个已启用账号有数据");
  assert.equal(resources.formatRatio(null, 0), null);
});

test("L08 unknown enums, schemas and contradictions degrade without inventing facts", () => {
  assert.equal(model.eventName("future/event"), "future/event");
  assert.equal(model.eventName("task_closed"), "工作流已关闭");
  assert.equal(model.stateInfo(record("future_state")).key, "unknown");
  assert.equal(model.stateInfo(record("future_state")).label, "状态待核查");

  assert.equal(model.validateRecord(record("needs_review")), true);
  const schema = record("needs_review");
  schema.view.schemaVersion = "workbuddy-executor/stage-1";
  assert.equal(model.validateRecord(schema), false, "an older schema must be reported, not guessed at");
  const missingTiming = record("needs_review");
  delete missingTiming.view.timing;
  assert.equal(model.validateRecord(missingTiming), false);
  const wrongStop = record("needs_review");
  wrongStop.view.remoteStopped = "false";
  assert.equal(model.validateRecord(wrongStop), false);
  const brokenReviews = record("needs_review");
  brokenReviews.reviews = { reviewId: "x" };
  assert.equal(model.validateRecord(brokenReviews), false);
});

test("L08 hostile markup and paths are rendered as text only", () => {
  const hostile = record("failed", { businessState: "blocked", blockingReason: '<img src=x onerror="alert(1)">' });
  hostile.presentation.title = "<script>alert(1)</script>";
  const card = panel.renderAttention(hostile);
  assert.ok(card, "a failed task owes an attention card");
  assert.ok(card.textContent.includes('<img src=x onerror="alert(1)">'), "the markup must survive as literal text");
  assert.equal(model.taskName(hostile), "<script>alert(1)</script>", "a title is data, never markup");
  assert.equal(card.querySelectorAll("img").length, 0);
  assert.equal(card.querySelectorAll("script").length, 0);

  assert.equal(model.workspaceName(record("running", { workspace: { displayName: null, storedPath: "C:\\synthetic\\workspace\\feature" } })), "feature");
  assert.equal(model.workspaceName(record("running", { workspace: { displayName: null, storedPath: "<img onerror=alert(1)>" } })), "<img onerror=alert(1)>");
  assert.equal(model.workspaceName(record("running", { workspace: { displayName: null, storedPath: "" } })), "工作区未提供");
});

test("L08 keyboard navigation, stale-response and responsive guards are present in the panel source", () => {
  assert.equal(model.taskListNavigation([{ taskId: "a" }, { taskId: "b" }, { taskId: "c" }], "a", 1), "b");
  assert.equal(model.taskListNavigation([{ taskId: "a" }, { taskId: "b" }], "b", 1), null, "no wraparound guessing");
  assert.equal(model.taskListNavigation([{ taskId: "a" }], "missing", 1), null);
  assert.equal(model.taskListNavigation([{ taskId: "a" }], "a", 0), null);
  assert.equal(model.nextRetryDelayMs(0), 2000);
  assert.equal(model.nextRetryDelayMs(9), 30000);
  assert.equal(model.nextRetryDelayMs(-1), null);

  const app = fs.readFileSync(path.join(workbench, "app.mjs"), "utf8");
  assert.match(app, /state\.listSerial/, "a list read must be able to drop its own stale answer");
  assert.match(app, /state\.detailSerial/);
  assert.match(app, /serial !== state\.detailSerial \|\| source !== state\.source/, "an old detail response is discarded");
  assert.match(app, /new Map\(\[\.\.\.state\.events, \.\.\.page\.events\]\.map\(e => \[e\.eventId, e\]\)\)/, "events are deduplicated by eventId");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) assert.ok(app.includes(key), `task list keyboard handling must cover ${key}`);
  assert.match(app, /\.focus\(\)/, "the keyboard path moves focus");

  const html = fs.readFileSync(path.join(workbench, "index.html"), "utf8");
  assert.match(html, /name="viewport"/);
  const css = fs.readFileSync(path.join(workbench, "style.css"), "utf8");
  assert.match(css, /@media\(max-width:760px\)/, "the panel defines a narrow layout");
  // A wide breakpoint is allowed only as progressive enhancement; no selector may
  // *require* a desktop width to lay the panel out.
  const demands = css.split(/\r?\n/).filter(line => /min-width:\s*1[0-9]{3}px/.test(line) && !/@media/.test(line));
  assert.deepEqual(demands, [], `unexpected fixed desktop width: ${demands.join(" | ")}`);
});
