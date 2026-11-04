import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DSH_DISCOVERY_SCHEMA_VERSION, dshExecutorSummary, dshSessionsFor, summarizeDshHosts } from "../src/dsh-discovery.js";

type Host = { hostId: string; socketPath: string; token: string; profile?: string; version?: string; processAlive?: boolean };
const reader = (...hosts: Host[]) => ({ hosts: () => hosts });
const live = (hostId: string, extra: Partial<Host> = {}): Host => ({ hostId, socketPath: `\\\\\\.\\pipe\\workbuddy-dsh-${hostId}`, token: "synthetic-token-0000000000", profile: "desktop", version: "0.2.1", processAlive: true, ...extra });

test("host summaries drop dead and duplicate bridges and never leak credentials", () => {
  const summary = summarizeDshHosts(reader(live("dsh-b"), live("dsh-a"), live("dsh-a"), live("dsh-dead", { processAlive: false })));
  assert.deepEqual(summary, [{ hostId: "dsh-a", profile: "desktop", version: "0.2.1" }, { hostId: "dsh-b", profile: "desktop", version: "0.2.1" }]);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /token|pipe|synthetic-token/);
  assert.equal(DSH_DISCOVERY_SCHEMA_VERSION, "workbuddy-executor/dsh-discovery-1");
});

test("the DSH adapter reports disabled before it reports anything about bridges", () => {
  assert.deepEqual(dshExecutorSummary({}, reader(live("dsh-a"))), { adapter: "disabled", reason: "adapter_disabled", hosts: [], defaultHostId: null });
  assert.deepEqual(dshExecutorSummary({ WORKBUDDY_DSH_ENABLED: "0" }, reader(live("dsh-a"))), { adapter: "disabled", reason: "adapter_disabled", hosts: [], defaultHostId: null });
});

test("an enabled adapter without a live bridge stays unavailable instead of guessing a host", () => {
  assert.deepEqual(dshExecutorSummary({ WORKBUDDY_DSH_ENABLED: "1" }, reader()), { adapter: "enabled", reason: "native_bridge_not_registered", hosts: [], defaultHostId: null });
  // A registration whose process is gone is not a bridge, even while the file exists.
  assert.equal(dshExecutorSummary({ WORKBUDDY_DSH_ENABLED: "1" }, reader(live("dsh-a", { processAlive: false }))).reason, "native_bridge_not_registered");
  // A throwing registry is treated as "no bridge" rather than as readiness.
  assert.equal(dshExecutorSummary({ WORKBUDDY_DSH_ENABLED: "1" }, { hosts: () => { throw Error("registry"); } }).reason, "native_bridge_not_registered");
});

test("the default host is only named when it is unambiguous or explicitly configured", () => {
  const env = { WORKBUDDY_DSH_ENABLED: "1" };
  assert.equal(dshExecutorSummary(env, reader(live("dsh-a"))).defaultHostId, "dsh-a");
  assert.equal(dshExecutorSummary(env, reader(live("dsh-a"), live("dsh-b"))).defaultHostId, null);
  assert.equal(dshExecutorSummary({ ...env, WORKBUDDY_DSH_HOST_ID: "dsh-b" }, reader(live("dsh-a"), live("dsh-b"))).defaultHostId, "dsh-b");
  // Naming a host that is not live must not become a silent fallback.
  assert.equal(dshExecutorSummary({ ...env, WORKBUDDY_DSH_HOST_ID: "dsh-gone" }, reader(live("dsh-a"))).defaultHostId, null);
  assert.equal(dshExecutorSummary({ ...env, WORKBUDDY_DSH_HOST_ID: "dsh-a" }, reader(live("dsh-a"))).reason, "ready");
});

test("session discovery separates a missing registry from a live session", t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-discovery-")), workspace = path.join(parent, "workspace"), registry = path.join(parent, "coord.sqlite");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const missing = dshSessionsFor(workspace, undefined, registry);
  assert.equal(missing.registry, "missing");
  assert.equal(missing.reason, "registry_missing");
  assert.deepEqual(missing.candidates, []);
  const db = new DatabaseSync(registry);
  db.exec("CREATE TABLE live_sessions (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, lease_until INTEGER NOT NULL)");
  db.prepare("INSERT INTO live_sessions (session_id, cwd, lease_until) VALUES (?,?,?)").run("session-live", workspace, Date.now() + 60_000);
  db.prepare("INSERT INTO live_sessions (session_id, cwd, lease_until) VALUES (?,?,?)").run("session-expired", workspace, Date.now() - 60_000);
  db.close();
  const matched = dshSessionsFor(workspace, undefined, registry);
  assert.equal(matched.registry, "available");
  assert.equal(matched.reason, "matched");
  assert.equal(matched.selected?.sessionId, "session-live");
  // An expired lease is not a candidate, so an exact name cannot select it.
  assert.equal(dshSessionsFor(workspace, "session-expired", registry).reason, "session_not_matched");
});
