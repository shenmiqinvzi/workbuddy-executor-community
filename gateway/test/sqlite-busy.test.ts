import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS, sqliteBusyTimeoutMs } from "../src/sqlite-busy.js";

test("the busy budget is bounded, documented and overridable", () => {
  assert.equal(DEFAULT_SQLITE_BUSY_TIMEOUT_MS, 15000);
  assert.equal(sqliteBusyTimeoutMs({}), DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
  assert.equal(sqliteBusyTimeoutMs({ WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS: "" }), DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
  assert.equal(sqliteBusyTimeoutMs({ WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS: "9000" }), 9000);
  assert.equal(sqliteBusyTimeoutMs({ WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS: "1" }), 1000, "a wait budget below one second cannot cover a WAL checkpoint");
  assert.equal(sqliteBusyTimeoutMs({ WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS: "999999" }), 120000, "a two-minute wait is the ceiling before the real error must surface");
  assert.equal(sqliteBusyTimeoutMs({ WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS: "not-a-number" }), DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
  assert.equal(sqliteBusyTimeoutMs({ WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS: "7500.6" }), 7501);
});

test("every writing connection accepts a concurrent reader instead of failing on the first lock", async () => {
  const { TaskStore } = await import("../src/task-store.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "busy-budget-"));
  const previous = process.env.WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS;
  // Shrink the budget for this case only: the point is that the store publishes
  // it and waits, not that a full 15s wait is pleasant to sit through.
  process.env.WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS = "1500";
  try {
    const file = path.join(directory, "tasks.sqlite");
    const store = new TaskStore(file);
    const timeout = (store.database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    assert.equal(timeout, 1500, "the task store publishes the configured wait budget");
    // A second connection taking the write lock must not make the first one
    // fail instantly; it waits the published budget and then reports the real error.
    const { DatabaseSync } = await import("node:sqlite");
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    let refused: (Error & { code?: string }) | null = null;
    try {
      store.database.exec("BEGIN IMMEDIATE");
      store.database.exec("ROLLBACK");
    } catch (error) {
      refused = error as Error & { code?: string };
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    const waited = Date.now() - started;
    assert.ok(refused, "a held write lock must end in the real refusal, not silently succeed");
    assert.equal(refused!.code, "ERR_SQLITE_ERROR");
    assert.ok(waited >= 1000, `the connection waited for the budget before failing (waited ${waited}ms)`);
    store.close();
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS;
    else process.env.WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
