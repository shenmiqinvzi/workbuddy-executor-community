import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { DesktopDispatchJournal } from "../src/desktop-dispatch-journal.js";
import type { DesktopDraft } from "../src/desktop-dispatch.js";
import { DISPATCH_LEASE_TTL_MS, settleDispatch } from "../src/dispatch-settlement.js";

const directory = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-settlement-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const lease = (over: Partial<{ state: string; ownerPid: number | null; ownerStartedAt: string | null; claimedAt: string | null; heartbeatAt: string | null }> = {}) => ({
  state: "dispatching", ownerPid: 4242, ownerStartedAt: "2026-11-02T00:00:00.000Z", claimedAt: "2026-11-02T00:00:00.000Z", heartbeatAt: "2026-11-02T00:00:10.000Z", ...over,
});
const now = Date.parse("2026-11-02T00:00:20.000Z");

test("a row without a lease reads as unknown, never as healthy progress", () => {
  for (const row of [lease({ ownerPid: null }), lease({ heartbeatAt: null }), lease({ claimedAt: null })]) {
    assert.deepEqual(settleDispatch(row, { now, alive: () => true }), { settlement: "lease_unavailable", reason: "no_lease_record", ownerAlive: null, heartbeatAgeMs: null });
  }
  assert.equal(settleDispatch(lease({ state: "submitted" }), { now, alive: () => true }).settlement, "lease_unavailable");
});

test("a dead owner is conclusive evidence of an abandoned dispatch", () => {
  const view = settleDispatch(lease(), { now, alive: () => false });
  assert.equal(view.settlement, "abandoned");
  assert.equal(view.reason, "owner_exited");
  assert.equal(view.ownerAlive, false);
});

test("a live owner still has to show a fresh heartbeat; a reused pid never looks healthy", () => {
  assert.equal(settleDispatch(lease(), { now, alive: () => true }).settlement, "live");
  const stale = settleDispatch(lease({ heartbeatAt: "2026-11-01T23:56:00.000Z" }), { now, alive: () => true });
  assert.equal(stale.settlement, "stuck");
  assert.ok((stale.heartbeatAgeMs as number) > DISPATCH_LEASE_TTL_MS);
  const boundary = settleDispatch(lease({ heartbeatAt: new Date(now - DISPATCH_LEASE_TTL_MS).toISOString() }), { now, alive: () => true });
  assert.equal(boundary.settlement, "live");
  assert.equal(settleDispatch(lease(), { now, alive: () => null, ttlMs: 1000 }).settlement, "stuck");
});

test("an older journal gains the lease columns in place and keeps its rows readable", (t) => {
  const file = path.join(directory(t), "desktop.sqlite");
  const draft = { draftId: crypto.randomUUID(), taskId: "legacy-task", operationId: "legacy-operation" };
  const digest = crypto.createHash("sha256").update(JSON.stringify(draft)).digest("hex");
  const write = new DatabaseSync(file);
  write.exec("CREATE TABLE desktop_dispatch_requests (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, code TEXT, message TEXT, updated_at TEXT NOT NULL)");
  write.prepare("INSERT INTO desktop_dispatch_requests VALUES(?,?,?,?,?,'launch_requested',NULL,NULL,?)").run(draft.draftId, draft.taskId, draft.operationId, digest, JSON.stringify(draft), new Date(now).toISOString());
  write.close();

  const journal = new DesktopDispatchJournal(file);
  assert.equal(journal.lease(draft.draftId)?.heartbeatAt, null);
  const owner = { pid: process.pid, startedAt: new Date(now - 60_000).toISOString() };
  assert.equal(journal.claim(draft.draftId, owner)?.taskId, "legacy-task");
  const claimed = journal.lease(draft.draftId)!;
  assert.equal(claimed.state, "dispatching");
  assert.equal(claimed.ownerPid, process.pid);
  assert.equal(claimed.ownerStartedAt, owner.startedAt);
  assert.ok(claimed.claimedAt && claimed.heartbeatAt);
  assert.equal(settleDispatch(claimed, { now: Date.now(), alive: () => true }).settlement, "live");

  const inspect = new DatabaseSync(file);
  const columns = inspect.prepare("PRAGMA table_info(desktop_dispatch_requests)").all().map(row => String((row as Record<string, unknown>).name));
  inspect.close();
  assert.deepEqual(columns.slice(-4), ["owner_pid", "owner_started_at", "claimed_at", "heartbeat_at"]);
});

test("only the exact owner may refresh a lease and reading never advances the row", (t) => {
  const file = path.join(directory(t), "desktop.sqlite");
  const journal = new DesktopDispatchJournal(file);
  const draft = { draftId: crypto.randomUUID(), taskId: "owned-task", operationId: "owned-operation" } as unknown as DesktopDraft;
  journal.enqueue(draft);
  const owner = { pid: process.pid, startedAt: new Date(Date.now() - 30_000).toISOString() };
  journal.claim(draft.draftId, owner);

  assert.equal(journal.heartbeat(draft.draftId, { pid: process.pid, startedAt: new Date().toISOString() }), false);
  assert.equal(journal.heartbeat(draft.draftId, owner), true);

  const before = journal.lease(draft.draftId)!;
  assert.equal(settleDispatch(before, { now: Date.now(), alive: () => false }).settlement, "abandoned");
  assert.deepEqual(journal.lease(draft.draftId), before);
  assert.equal(journal.receipt(draft.draftId)!.state, "dispatching");
});

test("an exited worker pid settles as abandoned once it is gone", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => child.on("exit", () => resolve()));
  const alive = (value: number) => { try { process.kill(value, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null; } };
  assert.equal(settleDispatch(lease({ ownerPid: pid }), { now, alive }).settlement, "abandoned");
});
