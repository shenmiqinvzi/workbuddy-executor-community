import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planInstallationBootstrap, runInstallationBootstrap } from "../src/installation-bootstrap.js";

function fixture(t: test.TestContext, options: { dist?: boolean; lockfile?: boolean; buildScript?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-bootstrap-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "gateway", version: "0.7.1", ...(options.buildScript === false ? {} : { scripts: { build: "tsc -p tsconfig.json" } }) }, null, 2));
  if (options.lockfile !== false) fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "gateway", lockfileVersion: 3, packages: {} }));
  if (options.dist) { fs.mkdirSync(path.join(root, "dist"), { recursive: true }); fs.writeFileSync(path.join(root, "dist", "server.js"), "export {};\n"); }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function recorder(answer: (command: string, args: string[]) => { code: number | null; stdout?: string; stderr?: string; error?: string } = () => ({ code: 0 })) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const run = (command: string, args: string[], options: { cwd: string }) => { calls.push({ command, args, cwd: options.cwd }); return answer(command, args); };
  return { calls, run };
}

test("a plan names the lockfile commands and runs nothing", t => {
  const root = fixture(t);
  const { calls, run } = recorder();
  const report = runInstallationBootstrap({ installRoot: root, run, nodeVersion: "22.13.0", platform: "win32" });
  assert.equal(report.apply, false);
  assert.equal(report.blockers.length, 0);
  assert.deepEqual(report.steps.map(step => step.id), ["npm_ci", "npm_build"]);
  assert.ok(report.steps.every(step => step.status === "planned"));
  assert.deepEqual(report.steps[0]!.args, ["ci"]);
  assert.equal(calls.length, 0);
});

test("a root that already carries dist installs production dependencies only", t => {
  const root = fixture(t, { dist: true });
  const { calls, run } = recorder();
  const report = runInstallationBootstrap({ installRoot: root, run, apply: true, nodeVersion: "22.13.0", platform: "win32" });
  assert.deepEqual(report.steps.map(step => step.id), ["npm_ci"]);
  assert.deepEqual(report.steps[0]!.args, ["ci", "--omit=dev"]);
  assert.equal(report.steps[0]!.status, "ok");
  assert.deepEqual(calls[0]!.args, ["ci", "--omit=dev"]);
  assert.equal(calls[0]!.cwd, path.resolve(root));
});

test("a missing lockfile blocks instead of guessing versions", t => {
  const root = fixture(t, { lockfile: false });
  const { calls, run } = recorder();
  const report = runInstallationBootstrap({ installRoot: root, run, apply: true, nodeVersion: "22.13.0", platform: "win32" });
  assert.ok(report.blockers.some(blocker => blocker.id === "package_lock"));
  assert.equal(report.ok, false);
  assert.ok(report.steps.every(step => step.status === "skipped"));
  assert.equal(calls.length, 0);
});

test("an old Node blocks before any command is planned to run", t => {
  const root = fixture(t);
  const { calls, run } = recorder();
  const report = runInstallationBootstrap({ installRoot: root, run, apply: true, nodeVersion: "22.12.9", platform: "win32" });
  assert.ok(report.blockers.some(blocker => blocker.id === "node_version"));
  assert.equal(calls.length, 0);
});

test("a failed install stops the build and names the command", t => {
  const root = fixture(t);
  const { calls, run } = recorder(() => ({ code: 1, stderr: "npm ERR! network unreachable" }));
  const report = runInstallationBootstrap({ installRoot: root, run, apply: true, nodeVersion: "22.13.0", platform: "win32" });
  assert.equal(report.ok, false);
  assert.equal(report.steps[0]!.status, "failed");
  assert.equal(report.steps[0]!.exitCode, 1);
  assert.equal(report.steps[0]!.output, "npm ERR! network unreachable");
  assert.equal(report.steps[1]!.status, "skipped");
  assert.equal(calls.length, 1);
  assert.ok(report.next.some(line => line.includes("Fix npm_ci") && line.includes("exit 1")));
});

test("a missing npm is reported as such, not as an empty failure", t => {
  const root = fixture(t);
  const { run } = recorder(() => ({ code: null, error: "npm.cmd was not found on PATH" }));
  const report = runInstallationBootstrap({ installRoot: root, run, apply: true, nodeVersion: "22.13.0", platform: "win32" });
  assert.equal(report.steps[0]!.status, "failed");
  assert.match(report.steps[0]!.error ?? "", /was not found on PATH/);
});

test("the plan points at setup and readiness without writing configuration", t => {
  const root = fixture(t);
  const plan = planInstallationBootstrap({ installRoot: root, nodeVersion: "22.13.0", platform: "win32" });
  assert.ok(plan.next.some(line => line.includes("setup.mjs plan")));
  assert.ok(plan.next.some(line => line.includes("readiness.mjs")));
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});
