import test from "node:test";
import assert from "node:assert/strict";
import { sameWorkspacePath } from "../src/native-process.js";
import { CREATION_STALE_MS, isStaleReservation } from "../src/workspace-workers.js";

// F-PATH-1: a live run was reported as "Native observation does not match the
// execution" only because the native app hands the session cwd back with
// backslashes while the dispatch carried forward slashes.
test("the same workspace in either separator spelling is the same workspace", () => {
  assert.equal(sameWorkspacePath("E:/work/ws", "E:\\work\\ws"), true);
  assert.equal(sameWorkspacePath("E:\\work\\ws", "E:/work/ws"), true);
  assert.equal(sameWorkspacePath("E:/work/ws/", "E:\\work\\ws"), true);
  assert.equal(sameWorkspacePath("E:\\work\\ws\\\\", "E:/work/ws//"), true);
  if (process.platform === "win32") assert.equal(sameWorkspacePath("e:/work/WS", "E:\\work\\ws"), true);
});

test("a workspace difference is still a difference", () => {
  assert.equal(sameWorkspacePath("E:/work/ws", "E:/work/ws2"), false);
  assert.equal(sameWorkspacePath("E:/work/ws", "E:/other/ws"), false);
  assert.equal(sameWorkspacePath("E:/work/ws", "F:/work/ws"), false);
  assert.equal(sameWorkspacePath("E:/work/ws", ""), false);
  assert.equal(sameWorkspacePath(undefined, "E:/work/ws"), false);
});

// F-WORKER-1: a creator that died between reserve() and settling left
// state='creating' forever, so every later ensure_workspace refused to work.
test("a reservation whose creator never settled goes stale, a ready one never does", () => {
  const now = Date.parse("2026-11-08T09:00:00.000Z");
  const old = new Date(now - CREATION_STALE_MS - 1_000).toISOString();
  const fresh = new Date(now - 1_000).toISOString();
  assert.equal(isStaleReservation({ state: "creating", updatedAt: old }, now), true);
  assert.equal(isStaleReservation({ state: "uncertain", updatedAt: old }, now), true);
  assert.equal(isStaleReservation({ state: "creating", updatedAt: fresh }, now), false);
  assert.equal(isStaleReservation({ state: "ready", updatedAt: old }, now), false);
  assert.equal(isStaleReservation({ state: "creating", updatedAt: "not-a-date" }, now), true);
});
