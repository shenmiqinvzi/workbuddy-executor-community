import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { codeHashOf, desktopInstanceKey, observeDesktopWindow, observeReadiness, readRuntimeSummary, describeReadiness, type DesktopWindowObservation, type ReadinessReport } from "../src/readiness.js";
import { createReadinessProbes } from "../src/readiness-probes.js";
import type { Config } from "../src/config.js";

function hashOfDist(dist: string): string {
  const files = fs.readdirSync(dist, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".js")).map(entry => entry.name).sort();
  const hash = crypto.createHash("sha256");
  for (const name of files) hash.update(name).update(fs.readFileSync(path.join(dist, name)));
  return hash.digest("hex");
}

function snapshot(root: string): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [`${path.relative(root, path.join(dir, entry.name))}:${fs.statSync(path.join(dir, entry.name)).size}`]).sort();
  return walk(root);
}

interface Fixture {
  root: string;
  configDir: string;
  dbFile: string;
  config: Config;
  env: NodeJS.ProcessEnv;
  report(options?: Parameters<typeof observeReadiness>[0]): Promise<ReadinessReport>;
  layer(report: ReadinessReport, name: string): ReadinessReport["layers"][number];
  writeSummary(runtime?: { codeHash?: string; packageVersion?: string }): void;
  dispose(): void;
}

function fixture(t: test.TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness 目录 "));
  const configDir = path.join(root, "native");
  const dist = path.join(root, "dist");
  const data = path.join(root, "data");
  fs.mkdirSync(dist, { recursive: true }); fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(dist, "server.js"), "export const value = 1;\n");
  // The tool layer is answered by the read-only entry, so a fixture install needs it too.
  fs.writeFileSync(path.join(dist, "health-entry.js"), "export const health = 1;\n");
  fs.writeFileSync(path.join(dist, "helpers.js"), "export const helper = 2;\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "gateway", version: "0.7.1" }));
  fs.writeFileSync(path.join(root, "WorkBuddyAI.exe"), "stub");
  const nativeDb = new DatabaseSync(path.join(configDir, "workbuddy.db"));
  nativeDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at TEXT)");
  nativeDb.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run("session-one", "C:/work/project", 0, null);
  nativeDb.close();
  const dbFile = path.join(data, "tasks.sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE workflow_capacity (slot INTEGER PRIMARY KEY CHECK(slot=1), task_id TEXT, executor TEXT, operation_id TEXT)");
  db.close();
  const config = {
    backend: "desktop-queue", apiBaseUrl: "", tokenFile: path.join(data, "token.json"), dbFile, oauthRedirectUri: "", oauthPort: 0, oauthScopes: "",
    requestTimeoutMs: 1000, cliElectronPath: path.join(root, "WorkBuddyAI.exe"), cliScriptPath: "", cliPermissionMode: "deny", acpPermissionMode: "deny",
    gatewayUrl: "", workbuddyConfigDir: configDir, runsDir: path.join(data, "runs"),
  } as Config;
  const env: NodeJS.ProcessEnv = { WORKBUDDY_CLI_ELECTRON: path.join(root, "WorkBuddyAI.exe"), WORKBUDDY_CONFIG_DIR: configDir, WORKBUDDY_DESKTOP_DISPATCH_ENABLED: "1" };
  const fx: Fixture = {
    root, configDir, dbFile, config, env,
    report: options => observeReadiness({ root, config, env, platform: "win32", desktopObservation: { reachable: false, reason: "no window" }, ...options }),
    layer: (report, name) => { const found = report.layers.find(item => item.layer === name); assert.ok(found, `layer ${name} missing`); return found; },
    writeSummary: runtime => fs.writeFileSync(path.join(data, "persistent-service-status.json"), JSON.stringify({ pid: process.pid, dataRoot: data, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running", runtime: { release: "test", packageVersion: "0.7.1", ...(runtime ?? {}) } })),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  t.after(() => fx.dispose());
  return fx;
}

function occupy(dbFile: string, taskId: string): void {
  const db = new DatabaseSync(dbFile);
  db.prepare("INSERT INTO workflow_capacity VALUES (1,?,?,?)").run(taskId, "workbuddy", `operation-${taskId}`);
  db.close();
}

/** The slot row plus the task row and closure event that make it provably closed. */
function occupyClosed(dbFile: string, taskId: string, state = "accepted"): string {
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, state TEXT, attempt_id TEXT, run_evidence_digest TEXT)");
  db.exec("CREATE TABLE task_events (task_id TEXT, attempt_id TEXT, type TEXT, source_ref TEXT)");
  const attempt = `run-${taskId}`;
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?)").run(taskId, state, attempt, JSON.stringify({ stopped: true, attemptId: attempt, nativeStopSource: "native_idle", reportedStatus: "completed" }));
  db.prepare("INSERT INTO task_events VALUES (?,?,?,?)").run(taskId, attempt, "task_closed", `${attempt}:task_closed`);
  db.prepare("INSERT INTO workflow_capacity VALUES (1,?,?,?)").run(taskId, "workbuddy", `operation-${taskId}`);
  db.close();
  return attempt;
}

/** Probe pair that reports both live layers as reachable. */
const readyProbes = { tool: async () => ({ responsive: true }), native: async () => ({ bridgeReady: true }) };

function readyObservation(page = "http://127.0.0.1:62997/workbench/"): DesktopWindowObservation {
  return { reachable: true, snapshot: { status: "ready", pid: 4000, windowHandle: 99, gatewayPid: 4001, ready: true, taskId: null, page, startupStage: "navigate", failureCode: null, startup: { outcome: "ready", startupStage: "navigate", stageElapsedMs: 41, awaitingStage: null, awaitingMs: null, awaitingBoundedMs: null, transitions: [{ stage: "runtime", elapsedMs: 3, boundMs: 0, atUnixMs: 1 }], failureCode: null, failureStage: null, failureDetail: null } } };
}

test("readiness never writes to the install root or the native store", async t => {
  const fx = fixture(t); fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const before = snapshot(fx.root);
  await fx.report({ probes: { tool: async () => ({ responsive: true }), native: async () => ({ bridgeReady: true }) }, desktopObservation: readyObservation() });
  assert.deepEqual(snapshot(fx.root), before);
});

test("a missing runtime summary is unknown and the disk version is not substituted", async t => {
  const fx = fixture(t);
  const report = await fx.report({ probes: readyProbes });
  const deployed = fx.layer(report, "candidateDeployed");
  assert.equal(deployed.state, "unknown");
  assert.ok(deployed.missing.includes("runtime_summary"));
  assert.equal(deployed.facts.diskPackageVersion, "0.7.1");
  assert.notEqual(deployed.state, "ready");
  assert.match(report.nextAction!.action, /运行摘要/);
});

test("a runtime summary without a code hash stays unknown", async t => {
  const fx = fixture(t); fx.writeSummary();
  const deployed = fx.layer(await fx.report(), "candidateDeployed");
  assert.equal(deployed.state, "unknown");
  assert.ok(deployed.missing.includes("runtime_code_hash"));
  assert.equal(deployed.facts.runtimeCodeHash, null);
});

test("matching running and installed code reports the candidate as deployed", async t => {
  const fx = fixture(t); fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const deployed = fx.layer(await fx.report(), "candidateDeployed");
  assert.equal(deployed.state, "ready");
  assert.equal(deployed.facts.runtimeCodeHash, hashOfDist(path.join(fx.root, "dist")));
});

test("a hash mismatch blocks instead of claiming the candidate runs", async t => {
  const fx = fixture(t); fx.writeSummary({ codeHash: "a".repeat(64) });
  const deployed = fx.layer(await fx.report(), "candidateDeployed");
  assert.equal(deployed.state, "blocked");
  assert.match(deployed.reason!, /differ/);
});

test("an occupied shared slot blocks dispatch and names the occupant", async t => {
  const fx = fixture(t); occupy(fx.dbFile, "d1-workbuddy-2cc8e262");
  const report = await fx.report({ probes: readyProbes });
  const dispatch = fx.layer(report, "projectSessionDispatchable");
  assert.equal(dispatch.state, "blocked");
  assert.equal(dispatch.facts.occupantTask, "d1-workbuddy-2cc8e262");
  assert.match(dispatch.reason!, /never treated as free/);
  assert.match(report.nextAction!.action, /d1-workbuddy-2cc8e262/);
});

test("a closed occupant is released on the next send, not reported as a blocker", async t => {
  const fx = fixture(t); occupyClosed(fx.dbFile, "live-loop-20261108-07");
  const dispatch = fx.layer(await fx.report({ probes: readyProbes }), "projectSessionDispatchable");
  assert.equal(dispatch.facts.occupantLive, false, "a closed owner is not a live occupant");
  assert.equal(dispatch.facts.occupantTask, "live-loop-20261108-07");
  assert.equal(dispatch.facts.occupantTaskState, "accepted");
  assert.match(String(dispatch.facts.capacityState), /released on the next send/);
  assert.equal(dispatch.state, "ready");
  assert.doesNotMatch(String(dispatch.facts.blockers ?? ""), /capacity_held_by_another_task/);
});

test("an accepted occupant without its closure event is still live", async t => {
  const fx = fixture(t); occupyClosed(fx.dbFile, "no-closure");
  const db = new DatabaseSync(fx.dbFile); db.exec("DELETE FROM task_events"); db.close();
  const dispatch = fx.layer(await fx.report({ probes: readyProbes }), "projectSessionDispatchable");
  assert.equal(dispatch.facts.occupantLive, true, "a terminal state alone never proves the slot is free");
  assert.equal(dispatch.state, "blocked");
  assert.match(dispatch.reason!, /belongs to no-closure/);
});

test("an occupant that is still working keeps blocking and reports its state", async t => {
  const fx = fixture(t); occupyClosed(fx.dbFile, "still-running", "working");
  const dispatch = fx.layer(await fx.report({ probes: readyProbes }), "projectSessionDispatchable");
  assert.equal(dispatch.facts.occupantLive, true);
  assert.equal(dispatch.facts.occupantTaskState, "working");
  assert.equal(dispatch.state, "blocked");
  assert.match(dispatch.reason!, /belongs to still-running/);
});

test("a missing capacity table is blocked, never free", async t => {
  const fx = fixture(t);
  const db = new DatabaseSync(fx.dbFile); db.exec("DROP TABLE workflow_capacity"); db.close();
  const dispatch = fx.layer(await fx.report(), "projectSessionDispatchable");
  assert.equal(dispatch.state, "blocked");
  assert.ok(dispatch.missing.includes("workflow_capacity"));
  assert.match(dispatch.reason!, /workflow_capacity/);
});

test("an unreadable session store is unknown, not an absence of sessions", async t => {
  const fx = fixture(t);
  const dispatch = fx.layer(await fx.report({ env: { ...fx.env, WORKBUDDY_CONFIG_DIR: path.join(fx.root, "missing-native") } }), "projectSessionDispatchable");
  assert.equal(dispatch.state, "unknown");
  assert.equal(dispatch.facts.sessions, "unreadable");
});

test("no registered project session blocks dispatch", async t => {
  const fx = fixture(t);
  const db = new DatabaseSync(path.join(fx.configDir, "workbuddy.db")); db.exec("DELETE FROM sessions"); db.close();
  const dispatch = fx.layer(await fx.report(), "projectSessionDispatchable");
  assert.equal(dispatch.state, "blocked");
  assert.ok(dispatch.missing.includes("project_session"));
});

test("dispatch stays blocked until it is explicitly enabled", async t => {
  const fx = fixture(t); fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const report = await fx.report({ env: { ...fx.env, WORKBUDDY_DESKTOP_DISPATCH_ENABLED: undefined }, probes: { tool: async () => ({ responsive: true }), native: async () => ({ bridgeReady: true }) } });
  const dispatch = fx.layer(report, "projectSessionDispatchable");
  assert.equal(dispatch.state, "blocked");
  assert.ok(dispatch.missing.includes("dispatch_enabled"));
  assert.match(report.nextAction!.action, /WORKBUDDY_DESKTOP_DISPATCH_ENABLED/);
});

test("a free slot, a project session and dispatch produce a ready layer", async t => {
  const fx = fixture(t);
  const dispatch = fx.layer(await fx.report(), "projectSessionDispatchable");
  assert.equal(dispatch.state, "ready");
  assert.equal(dispatch.facts.capacityState, "free");
});

test("an absent desktop window is reported as absent with a reason", async t => {
  const fx = fixture(t);
  const desktop = fx.layer(await fx.report(), "desktopPageReady");
  assert.equal(desktop.state, "absent");
  assert.ok(desktop.missing.includes("desktop_window"));
});

test("a hung window names the awaited stage and never reads as cancelled or stopped", async t => {
  const fx = fixture(t); fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const observation: DesktopWindowObservation = { reachable: true, snapshot: { status: "running", pid: 4000, ready: false, page: "http://127.0.0.1:62997/workbench/", startupStage: "webview_environment", failureCode: "timeout:webview_environment", startup: { outcome: "timeout", startupStage: "webview_environment", stageElapsedMs: 30000, awaitingStage: "webview_environment", awaitingMs: 30007, awaitingBoundedMs: 30000, failureCode: "timeout:webview_environment", transitions: [] } } };
  const report = await fx.report({ desktopObservation: observation, probes: readyProbes });
  const desktop = fx.layer(report, "desktopPageReady");
  assert.equal(desktop.state, "blocked");
  assert.equal(desktop.facts.awaitingStage, "webview_environment");
  assert.equal(desktop.facts.awaitingBoundedMs, 30000);
  assert.match(desktop.reason!, /timeout/);
  assert.doesNotMatch(desktop.reason!, /cancel|stop/i);
  assert.match(report.nextAction!.action, /webview_environment/);
});

test("a shell without startup diagnostics asks for a rebuild instead of guessing", async t => {
  const fx = fixture(t);
  const desktop = fx.layer(await fx.report({ desktopObservation: { reachable: true, snapshot: { status: "running", ready: false, page: "http://127.0.0.1:62997/workbench/" } } }), "desktopPageReady");
  assert.equal(desktop.state, "blocked");
  assert.ok(desktop.missing.includes("startup_diagnostics"));
  assert.match(desktop.reason!, /rebuild/);
});

test("a loaded workbench page is the only path to a ready desktop layer", async t => {
  const fx = fixture(t);
  assert.equal(fx.layer(await fx.report({ desktopObservation: readyObservation() }), "desktopPageReady").state, "ready");
  const wrongPage = fx.layer(await fx.report({ desktopObservation: readyObservation("http://127.0.0.1:62997/other/") }), "desktopPageReady");
  assert.equal(wrongPage.state, "blocked");
});

test("tool and native probes distinguish ready from blocked", async t => {
  const fx = fixture(t);
  const good = await fx.report({ probes: { tool: async () => ({ responsive: true }), native: async () => ({ bridgeReady: true }) } });
  assert.equal(fx.layer(good, "toolResponsive").state, "ready");
  assert.equal(fx.layer(good, "nativeOnline").state, "ready");
  const bad = await fx.report({ probes: { tool: async () => ({ responsive: false }), native: async () => ({ bridgeReady: false, detail: "bridge missing" }) } });
  assert.equal(fx.layer(bad, "toolResponsive").state, "blocked");
  assert.equal(fx.layer(bad, "nativeOnline").state, "blocked");
  assert.equal(fx.layer(bad, "nativeOnline").reason, "bridge missing");
});

test("a fresh heartbeat is unverified without a probe and stale without freshness", async t => {
  const fx = fixture(t); fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const unverified = fx.layer(await fx.report(), "toolResponsive");
  assert.equal(unverified.state, "unverified");
  assert.ok(unverified.missing.includes("tool_probe"));
  const stale = fx.layer(await fx.report({ now: () => new Date(Date.now() + 10 * 60_000) }), "toolResponsive");
  assert.equal(stale.state, "unknown");
});

test("a missing application is absent, not unverified", async t => {
  const fx = fixture(t);
  const report = await fx.report({ env: { ...fx.env, WORKBUDDY_CLI_ELECTRON: path.join(fx.root, "nope.exe") } });
  const native = fx.layer(report, "nativeOnline");
  assert.equal(native.state, "absent");
  assert.ok(native.missing.includes("application"));
  const dispatch = fx.layer(report, "projectSessionDispatchable");
  assert.equal(dispatch.state, "unknown");
  assert.ok(dispatch.missing.includes("native_online"));
});

test("two native data directories are an ambiguity with candidates, not a hang", async t => {
  const fx = fixture(t);
  const home = path.join(fx.root, "home");
  for (const name of [".workbuddy-ai", ".workbuddy"]) {
    fs.mkdirSync(path.join(home, name), { recursive: true });
    const db = new DatabaseSync(path.join(home, name, "workbuddy.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at TEXT)");
    db.close();
  }
  const env: NodeJS.ProcessEnv = { ...fx.env }; delete env.WORKBUDDY_CONFIG_DIR;
  const report = await fx.report({ env, home, config: undefined, configError: "Multiple WorkBuddy installations or data directories found; set WORKBUDDY_CLI_ELECTRON and WORKBUDDY_CONFIG_DIR explicitly." });
  assert.equal(report.selection.state, "ambiguous");
  assert.equal(report.selection.config.state, "ambiguous");
  assert.equal(report.selection.config.candidates.length, 2);
  assert.ok(report.selection.config.candidates.every(candidate => candidate.startsWith("%USERPROFILE%")));
  assert.ok(report.selection.suggested.some(command => command.includes("WORKBUDDY_CONFIG_DIR")));
  assert.equal(fx.layer(report, "projectSessionDispatchable").state, "unknown");
  assert.equal(report.nextAction!.layer, "selection");
  assert.match(report.nextAction!.action, /WORKBUDDY_CONFIG_DIR/);
});

test("an unresolvable config is unknown, never read as a fresh install", async t => {
  const fx = fixture(t);
  const report = await fx.report({ config: undefined, configError: "Multiple WorkBuddy installations or data directories found" });
  const dispatch = fx.layer(report, "projectSessionDispatchable");
  assert.equal(dispatch.state, "unknown");
  assert.ok(dispatch.missing.includes("config"));
  assert.match(dispatch.reason!, /Multiple WorkBuddy installations/);
  assert.ok(report.notes.some(note => note.startsWith("config: ")));
  assert.match(report.nextAction!.action, /WORKBUDDY_CONFIG_DIR/);
});

test("every layer is timestamped and the report carries one action", async t => {
  const fx = fixture(t);
  const report = await fx.report();
  assert.equal(report.schema, "workbuddy-readiness/v1");
  assert.equal(report.readOnly, true);
  assert.equal(report.layers.length, 5);
  for (const item of report.layers) assert.match(item.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(report.nextAction);
  assert.equal(report.layers.filter(item => item.state !== "ready")[0]!.layer, report.nextAction!.layer);
});

test("all five layers ready point at dispatch instead of inventing work", async t => {
  const fx = fixture(t); fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const report = await fx.report({ probes: { tool: async () => ({ responsive: true }), native: async () => ({ bridgeReady: true }) }, desktopObservation: readyObservation() });
  assert.deepEqual(report.layers.map(item => item.state), ["ready", "ready", "ready", "ready", "ready"]);
  assert.equal(report.nextAction!.layer, "dispatch");
});

test("the runtime summary only trusts a well-formed record", async t => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.root, "data"), { recursive: true });
  fs.writeFileSync(path.join(fx.root, "data", "persistent-service-status.json"), "{not json");
  assert.equal(readRuntimeSummary(fx.root).found, false);
  fs.writeFileSync(path.join(fx.root, "data", "persistent-service-status.json"), JSON.stringify({ updatedAt: "2026-11-07T00:00:00.000Z" }));
  assert.equal(readRuntimeSummary(fx.root).found, false);
});

test("the install key mirrors the shell derivation and separates installs", () => {
  const base = { gatewayDir: "C:\\gateway", database: "C:\\data\\tasks.sqlite", runsDir: "C:\\data\\runs" };
  const key = desktopInstanceKey(base);
  assert.match(key, /^[A-F0-9]{24}$/);
  assert.equal(key, desktopInstanceKey({ gatewayDir: "c:\\gateway", database: "c:\\data\\tasks.sqlite", runsDir: "c:\\data\\runs" }));
  assert.notEqual(key, desktopInstanceKey({ ...base, database: "C:\\data\\other.sqlite" }));
});

test("a status read of a missing window resolves instead of hanging", async () => {
  const observation = await observeDesktopWindow(`WorkBuddy.Workbench.${"A".repeat(24)}`, 400);
  assert.equal(observation.reachable, false);
  assert.ok(observation.reason);
});

test("the human summary stays one line per layer", async t => {
  const fx = fixture(t);
  const lines = describeReadiness(await fx.report());
  assert.equal(lines.length, 5);
  for (const line of lines) assert.match(line, /^(ready|unverified|blocked|absent|unknown)\s{2}/);
});

test("code hashing skips non-javascript files and survives a missing tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hash-"));
  try {
    fs.writeFileSync(path.join(root, "a.js"), "1");
    fs.writeFileSync(path.join(root, "b.txt"), "2");
    const first = codeHashOf(root);
    assert.match(first!, /^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(root, "b.txt"), "3");
    assert.equal(codeHashOf(root), first);
    fs.writeFileSync(path.join(root, "a.js"), "1");
    assert.equal(codeHashOf(path.join(root, "missing")), undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- WB06: the report names its observer, and only a probe from this process may say ready ----

test("the report names the process that observed it and which probes ran", async t => {
  const fx = fixture(t);
  const report = await fx.report({ origin: "test/readiness.test.ts" });
  assert.equal(report.observer.origin, "test/readiness.test.ts");
  assert.equal(report.observer.pid, process.pid);
  assert.equal(report.observer.platform, "win32");
  assert.equal(report.observer.root, fx.root);
  assert.equal(report.observer.dataRoot, path.dirname(fx.dbFile));
  assert.deepEqual(report.observer.probes, { tool: "not_observed", native: "not_observed" });
  assert.ok(report.notes.some(note => note.startsWith("tool: ") && note.includes("没有注入 tool probe")));
  assert.ok(report.notes.some(note => note.startsWith("native: ")));
});

test("an unrecognized observer is named instead of being left blank", async t => {
  const fx = fixture(t);
  assert.equal((await fx.report()).observer.origin, "observeReadiness");
});

test("a tool probe from this process is what makes toolResponsive ready", async t => {
  const fx = fixture(t);
  fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const withProbe = fx.layer(await fx.report({ probes: { tool: async () => ({ responsive: true, detail: "workbuddy_health answered" }) } }), "toolResponsive");
  assert.equal(withProbe.state, "ready");
  assert.equal(withProbe.facts.toolProbe, true);
  assert.equal(withProbe.reason, "workbuddy_health answered");

  const withoutProbe = fx.layer(await fx.report(), "toolResponsive");
  assert.notEqual(withoutProbe.state, "ready");
  assert.ok(withoutProbe.missing.includes("tool_probe"));
});

test("a probe that fails blocks the layer with its reason instead of reporting unknown", async t => {
  const fx = fixture(t);
  const tool = fx.layer(await fx.report({ probes: { tool: async () => { throw new Error("spawn EACCES"); } } }), "toolResponsive");
  assert.equal(tool.state, "blocked");
  assert.match(String(tool.reason), /the tool probe failed/);
  const native = fx.layer(await fx.report({ probes: { native: async () => ({ bridgeReady: false, detail: "bridge not reachable" }) } }), "nativeOnline");
  assert.equal(native.state, "blocked");
  assert.equal(native.facts.bridgeReady, false);
});

test("a runtime summary from another data directory cannot prove this install is running", async t => {
  const fx = fixture(t);
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-data-"));
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fx.root, "data", "persistent-service-status.json"), JSON.stringify({ pid: process.pid, dataRoot: foreign, updatedAt: new Date().toISOString(), runtime: { codeHash: hashOfDist(path.join(fx.root, "dist")) } }));
  const deployed = fx.layer(await fx.report(), "candidateDeployed");
  assert.equal(deployed.state, "blocked");
  assert.match(String(deployed.reason), /another data directory/);
  assert.equal(deployed.facts.runtimeDataRoot, foreign);
  assert.equal(deployed.facts.observedDataRoot, path.dirname(fx.dbFile));
});

test("a summary written before the binding fields stays readable but cannot be ready", async t => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.root, "data", "persistent-service-status.json"), JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), runtime: { codeHash: hashOfDist(path.join(fx.root, "dist")) } }));
  const report = await fx.report();
  const deployed = fx.layer(report, "candidateDeployed");
  assert.equal(deployed.state, "unverified");
  assert.ok(deployed.missing.includes("runtime_data_root"));
  assert.equal(deployed.facts.runtimeStartedAt, null);
  assert.match(String(deployed.reason), /predates dataRoot/);
});

test("the heartbeat carries the data root and the start time it belongs to", async t => {
  const fx = fixture(t);
  fx.writeSummary({ codeHash: hashOfDist(path.join(fx.root, "dist")) });
  const summary = readRuntimeSummary(fx.root);
  assert.equal(summary.summary?.dataRoot, path.dirname(fx.dbFile));
  assert.ok(summary.summary?.startedAt);
});

test("the memoized probe pair asks once per window and marks a cached answer", async () => {
  let calls = 0;
  let clock = 1_000;
  const probes = createReadinessProbes({
    ttlMs: 5_000, now: () => clock,
    probe: async () => { calls += 1; return { responsive: true, detail: "answered", native: { bridgeReady: true, detail: "bridge" } }; },
  });
  assert.deepEqual(await probes.tool!(), { responsive: true, detail: "answered" });
  clock += 1_000;
  const cached = await probes.tool!();
  assert.equal(calls, 1);
  assert.match(String(cached.detail), /\(cached 1000ms\)/);
  clock += 10_000;
  await probes.tool!();
  assert.equal(calls, 2);
  const native = await probes.native!();
  assert.equal(native.bridgeReady, true);
});

test("a probe answer without a bridge status never claims the bridge is ready", async () => {
  const probes = createReadinessProbes({ probe: async () => ({ responsive: true, detail: "answered" }) });
  const native = await probes.native!();
  assert.equal(native.bridgeReady, false);
  assert.match(String(native.detail), /no bridge status/);
});
