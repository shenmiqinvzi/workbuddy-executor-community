import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReadinessProbes, probeEnvironment, probeToolStdio, type ProbeConfig } from "../src/readiness-probes.js";
import { observeReadiness } from "../src/readiness.js";

/**
 * R2/R3: asking "is this ready?" must not change the instance it asks about, and
 * the answer must be about the instance the caller selected.
 *
 * These tests drive the real probe against the real read-only entry, because the
 * defect was in the composition root: a unit stub would have passed while
 * `dist/server.js` created and migrated a database on every GET.
 */

const gatewayRoot = path.resolve(import.meta.dirname, "..");
const built = fs.existsSync(path.join(gatewayRoot, "dist", "health-entry.js"));

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function probeConfig(directory: string, overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    backend: "desktop-queue",
    dbFile: path.join(directory, "tasks.sqlite"),
    serviceConfigFile: path.join(directory, "persistent-service.json"),
    workbuddyConfigDir: directory,
    gatewayUrl: "http://127.0.0.1:0",
    ...overrides,
  };
}

function files(directory: string): string[] {
  try { return fs.readdirSync(directory).sort(); } catch { return []; }
}

test("a readiness probe answers without creating a task database", { skip: !built && "dist/health-entry.js is not built" }, async () => {
  const directory = scratch("wb-probe-ro-");
  try {
    const config = probeConfig(directory);
    const answer = await probeToolStdio({ gatewayRoot, config });
    assert.equal(answer.responsive, true, answer.detail);
    assert.equal(fs.existsSync(config.dbFile), false, "the probe created the task database it was asked to inspect");
    assert.deepEqual(files(directory).filter(name => name.endsWith(".sqlite")), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a readiness probe leaves an unusable database exactly as it found it", { skip: !built && "dist/health-entry.js is not built" }, async () => {
  const directory = scratch("wb-probe-legacy-");
  try {
    const config = probeConfig(directory);
    // Not a SQLite file at all: opening it would either migrate or fail loudly.
    const before = Buffer.from("not a database\n");
    fs.writeFileSync(config.dbFile, before);
    const answer = await probeToolStdio({ gatewayRoot, config });
    assert.equal(answer.responsive, true, answer.detail);
    assert.deepEqual(fs.readFileSync(config.dbFile), before, "the probe rewrote a database it only meant to read");
    assert.deepEqual(files(directory), ["tasks.sqlite"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("the probe reports the data directory it actually observed", { skip: !built && "dist/health-entry.js is not built" }, async () => {
  const first = scratch("wb-probe-a-");
  const second = scratch("wb-probe-b-");
  try {
    const a = await probeToolStdio({ gatewayRoot, config: probeConfig(first) });
    const b = await probeToolStdio({ gatewayRoot, config: probeConfig(second) });
    assert.equal(a.responsive, true, a.detail);
    assert.equal(b.responsive, true, b.detail);
    assert.equal(path.resolve(a.identity?.dataRoot ?? ""), path.resolve(first));
    assert.equal(path.resolve(b.identity?.dataRoot ?? ""), path.resolve(second));
    assert.notEqual(a.identity?.pid, b.identity?.pid, "two probes shared one process; the answer would not identify a run");
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("the environment handed to the child names the selected instance", () => {
  const directory = scratch("wb-probe-env-");
  try {
    const config = probeConfig(directory, { runsDir: path.join(directory, "runs"), cliElectronPath: "C:/app/WorkBuddy.exe" });
    const env = probeEnvironment({ config, env: { WORKBUDDY_READINESS_PROBE: "1" } });
    assert.equal(env.WORKBUDDY_BACKEND, "desktop-queue");
    assert.equal(path.resolve(env.WORKBUDDY_DB_FILE), path.resolve(config.dbFile));
    assert.equal(path.resolve(env.WORKBUDDY_RUNS_DIR), path.resolve(path.join(directory, "runs")));
    assert.equal(path.resolve(env.WORKBUDDY_SERVICE_CONFIG), path.resolve(config.serviceConfigFile));
    assert.equal(path.resolve(env.WORKBUDDY_CONFIG_DIR), path.resolve(directory));
    assert.equal(env.WORKBUDDY_GATEWAY_URL, "http://127.0.0.1:0");
    assert.equal(env.WORKBUDDY_CLI_ELECTRON, "C:/app/WorkBuddy.exe");
    assert.equal(env.WORKBUDDY_READINESS_PROBE, "1");
    // A parent shell value for an unselected variable must not leak through.
    assert.equal(env.WORKBUDDY_QUOTA_SOURCE_URL, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("an answer from another data directory blocks the tool layer", async () => {
  const directory = scratch("wb-probe-foreign-");
  try {
    const config = probeConfig(directory);
    const probes = createReadinessProbes({
      gatewayRoot,
      config,
      probe: async () => ({ responsive: true, detail: "answered elsewhere", native: { bridgeReady: true }, identity: { pid: 4242, dataRoot: path.join(directory, "elsewhere"), codeHash: "x" } }),
    });
    const report = await observeReadiness({ config: { dbFile: config.dbFile } as never, origin: "test", probes });
    const tool = report.layers.find(entry => entry.layer === "toolResponsive");
    assert.equal(tool?.state, "blocked");
    assert.match(tool?.reason ?? "", /another data directory/);
    assert.ok(tool?.missing.includes("tool_probe_data_root"), "the report must name why it cannot prove readiness");
    assert.equal(tool?.facts.probeDataRootMatchesObserver, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("concurrent readiness reads share one probe instead of racing children", async () => {
  let calls = 0;
  const probes = createReadinessProbes({
    gatewayRoot,
    config: probeConfig(os.tmpdir()),
    probe: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { responsive: true, detail: "once", native: { bridgeReady: true }, identity: { dataRoot: os.tmpdir() } }; },
  });
  const [first, second, third] = await Promise.all([probes.tool(), probes.native(), probes.identity()]);
  assert.equal(calls, 1, "three concurrent readers started three probe processes");
  assert.equal(first.responsive, true);
  assert.equal(second.bridgeReady, true);
  assert.equal(path.resolve(third?.dataRoot ?? ""), path.resolve(os.tmpdir()));
});

test("the CLI composition root writes nothing beside the database it inspects", { skip: !built && "dist/health-entry.js is not built" }, () => {
  const directory = scratch("wb-probe-cli-");
  try {
    const config = probeConfig(directory);
    const result = spawnSync(process.execPath, [path.join(gatewayRoot, "scripts", "readiness.mjs"), "--json"], {
      cwd: gatewayRoot,
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        WORKBUDDY_BACKEND: config.backend,
        WORKBUDDY_DB_FILE: config.dbFile,
        WORKBUDDY_SERVICE_CONFIG: config.serviceConfigFile,
        WORKBUDDY_CONFIG_DIR: config.workbuddyConfigDir,
        WORKBUDDY_GATEWAY_URL: config.gatewayUrl,
      },
    });
    assert.ok(result.status === 0 || result.status === 1, `unexpected exit ${result.status}: ${result.stderr}`);
    const report = JSON.parse(result.stdout) as { layers: Array<{ layer: string; state: string; missing: string[] }> };
    const tool = report.layers.find(entry => entry.layer === "toolResponsive");
    assert.equal(tool?.state, "ready", `the CLI reported ${tool?.state} instead of probing: ${result.stdout.slice(0, 400)}`);
    assert.deepEqual(files(directory).filter(name => name.endsWith(".sqlite")), [], "the CLI diagnosis created a database");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
