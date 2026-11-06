/**
 * R3: the trusted local CLI is the product composition root for saved
 * automation policies. These tests run the real `runAutomationCli` entry (not a
 * module-level fake) against a synthetic installation, so they prove the
 * dispatcher seam is wired while still refusing by default.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const KEYS = ["WORKBUDDY_DB_FILE", "WORKBUDDY_RUNS_DIR", "WORKBUDDY_CLI_ELECTRON", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_BACKEND", "WORKBUDDY_DSH_ENABLED", "NO_PROXY"] as const;

function withCliEnvironment(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-cli-unit-"));
  const configDir = path.join(dir, "workbuddy-config");
  fs.mkdirSync(configDir);
  const application = path.join(dir, "WorkBuddyAI.exe");
  fs.writeFileSync(application, "synthetic application marker");
  const saved = new Map<string, string | undefined>(KEYS.map(key => [key, process.env[key]]));
  process.env.WORKBUDDY_DB_FILE = path.join(dir, "tasks.sqlite");
  process.env.WORKBUDDY_RUNS_DIR = path.join(dir, "runs");
  process.env.WORKBUDDY_CLI_ELECTRON = application;
  process.env.WORKBUDDY_CONFIG_DIR = configDir;
  process.env.WORKBUDDY_BACKEND = "desktop-queue";
  process.env.WORKBUDDY_DSH_ENABLED = "0";
  process.env.NO_PROXY = "127.0.0.1,localhost";
  t.after(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { dir };
}

async function runCli(argv: string[]): Promise<Record<string, unknown>> {
  const { runAutomationCli } = await import("../src/automation-cli.js");
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await runAutomationCli(argv);
  } finally {
    process.stdout.write = original;
    process.exitCode = 0;
  }
  return JSON.parse(lines.join("")) as Record<string, unknown>;
}

test("the CLI composition root wires the guarded dispatcher and still defaults to unarmed", async (t) => {
  withCliEnvironment(t);
  const report = await runCli(["status"]) as { dispatcherWired: boolean; armed: boolean; httpWrites: boolean; writeEntry: string };
  assert.equal(report.dispatcherWired, true, "the local CLI is a real composition root now");
  assert.equal(report.armed, false, "wiring the seam does not arm dispatch");
  assert.equal(report.httpWrites, false, "no HTTP route may dispatch automatically");
  assert.equal(report.writeEntry, "local_cli_only");

  const armed = await runCli(["status", "--enable-dispatch"]) as { armed: boolean };
  assert.equal(armed.armed, true);
});

test("an armed CLI reaches the guarded service instead of stopping at the unwired check", async (t) => {
  withCliEnvironment(t);
  const refused = await runCli(["execute", "decision-missing", "--operation-id", "11111111-2222-4333-8444-555555555555"]) as { ok: boolean; code?: string };
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "AUTOMATION_NOT_ARMED", "without --enable-dispatch the process still refuses");

  const disabled = await runCli(["execute", "decision-missing", "--operation-id", "11111111-2222-4333-8444-555555555555", "--enable-dispatch"]) as { ok: boolean; code?: string; message?: string };
  assert.equal(disabled.code, "AUTOMATION_NOT_ENABLED", "the installation policy is still off by default");

  const enabled = await runCli(["enable", "--source", "user:synthetic-operator"]) as { ok: boolean; enabled: boolean };
  assert.equal(enabled.enabled, true);
  const reached = await runCli(["execute", "decision-missing", "--operation-id", "11111111-2222-4333-8444-555555555555", "--enable-dispatch"]) as { ok: boolean; code?: string; message?: string };
  assert.equal(reached.ok, false);
  assert.equal(reached.code, "DECISION_NOT_FOUND", "the armed CLI reads the saved decision through the shared service");
  assert.doesNotMatch(String(reached.message), /No guarded dispatcher is wired/);
});
