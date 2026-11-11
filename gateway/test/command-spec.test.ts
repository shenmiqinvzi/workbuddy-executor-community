import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskStore } from "../src/task-store.js";
import { COMMAND_SPEC_EXAMPLE, admitCommandSpecs, commandSpecAdmissionMessage, insideDirectory, parseCommandSpec } from "../src/command-spec.js";
import { SelectedModelClient as WorkBuddyClient } from "./support/selected-model-client.js";
import { commandSpec } from "./support/command-spec.js";

const workspace = path.resolve("C:/sandbox/project");
const base = { executable: process.execPath, args: ["-p", "process.version"], cwd: workspace, timeoutSeconds: 60, inputs: ["RESULT.md"] };

function rejection(definition: unknown, root: string | null = workspace) {
  const admission = parseCommandSpec(definition, { workspaceRoot: root, position: "acceptanceCommands[0]" });
  assert.equal(admission.ok, false, `expected a rejection for ${JSON.stringify(definition)}`);
  return admission.rejection;
}

test("a five-field CommandSpec is the only accepted form and parses to exact values", () => {
  const admission = parseCommandSpec(JSON.stringify(base), { workspaceRoot: workspace, position: "acceptanceCommands[0]" });
  assert.equal(admission.ok, true);
  if (!admission.ok) return;
  assert.deepEqual(admission.spec, base);
  const nested = parseCommandSpec(JSON.stringify({ ...base, args: ["--name", "含 空格 与 \"引号\"", "-p"], inputs: ["src/a.js", "test/a b.test.js"] }), { workspaceRoot: workspace });
  assert.equal(nested.ok, true);
  // A stored check may name the same file absolutely; containment still applies.
  const absoluteInput = parseCommandSpec(JSON.stringify({ ...base, inputs: [path.join(workspace, "RESULT.md")] }), { workspaceRoot: workspace });
  assert.equal(absoluteInput.ok, true);
});

test("free text, bare command lines and non-JSON are never admitted", () => {
  for (const definition of ["", "   "]) {
    const rejected = rejection(definition);
    assert.equal(rejected.code, "COMMAND_SPEC_REQUIRED");
    assert.match(rejected.reason, /empty value/);
    assert.equal(rejected.example, COMMAND_SPEC_EXAMPLE);
  }
  for (const definition of ["npm test", "node --test", "inspect the exported media", "{not json"]) {
    const rejected = rejection(definition);
    assert.equal(rejected.code, "COMMAND_SPEC_REQUIRED");
    assert.match(rejected.reason, /never executed/);
    assert.equal(rejected.example, COMMAND_SPEC_EXAMPLE);
  }
  for (const definition of ["[1,2,3]", 42, null, undefined, { ...base }]) {
    const rejected = rejection(definition);
    assert.equal(rejected.code, "COMMAND_SPEC_REQUIRED");
    assert.match(rejected.reason, /must be a JSON object|must be JSON CommandSpec text/);
    assert.equal(rejected.example, COMMAND_SPEC_EXAMPLE);
  }
});

test("every field is required with its own position, type and range", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["executable", { ...base, executable: undefined }],
    ["args", { ...base, args: undefined }],
    ["cwd", { ...base, cwd: undefined }],
    ["timeoutSeconds", { ...base, timeoutSeconds: undefined }],
    ["inputs", { ...base, inputs: undefined }],
  ];
  for (const [field, value] of cases) {
    const rejected = rejection(JSON.stringify(value));
    assert.equal(rejected.code, "COMMAND_SPEC_MISSING_FIELD");
    assert.equal(rejected.field, field);
    assert.equal(rejected.position, `acceptanceCommands[0].${field}`);
  }
  const invalid: Array<[string, Record<string, unknown>, string, RegExp]> = [
    ["executable", { ...base, executable: "node" }, "COMMAND_SPEC_PATH", /absolute/],
    ["executable", { ...base, executable: "  " }, "COMMAND_SPEC_INVALID_VALUE", /non-empty/],
    ["executable", { ...base, executable: `${process.execPath}\nagain` }, "COMMAND_SPEC_INVALID_VALUE", /single-line/],
    ["args", { ...base, args: "npm test" }, "COMMAND_SPEC_INVALID_VALUE", /array/],
    ["args", { ...base, args: ["ok", 1] }, "COMMAND_SPEC_INVALID_VALUE", /must be a string/],
    ["args", { ...base, args: ["bad\u0000arg"] }, "COMMAND_SPEC_INVALID_VALUE", /NUL/],
    ["cwd", { ...base, cwd: "relative/dir" }, "COMMAND_SPEC_PATH", /absolute/],
    ["timeoutSeconds", { ...base, timeoutSeconds: 0 }, "COMMAND_SPEC_INVALID_VALUE", /between/],
    ["timeoutSeconds", { ...base, timeoutSeconds: 86401 }, "COMMAND_SPEC_INVALID_VALUE", /between/],
    ["timeoutSeconds", { ...base, timeoutSeconds: 1.5 }, "COMMAND_SPEC_INVALID_VALUE", /whole number/],
    ["inputs", { ...base, inputs: [] }, "COMMAND_SPEC_INVALID_VALUE", /at least one workspace file/],
    ["inputs", { ...base, inputs: ["ok", ""] }, "COMMAND_SPEC_PATH", /name a file the command reads/],
  ];
  for (const [field, value, code, shape] of invalid) {
    const rejected = rejection(JSON.stringify(value));
    assert.equal(rejected.code, code, `${field} must be rejected as ${code}`);
    assert.equal(rejected.field, field);
    assert.match(rejected.reason, shape);
  }
});

test("unknown fields are named instead of silently ignored", () => {
  const rejected = rejection(JSON.stringify({ ...base, shell: true, environment: { PATH: "x" } }));
  assert.equal(rejected.code, "COMMAND_SPEC_UNKNOWN_FIELD");
  assert.equal(rejected.field, "shell");
  assert.equal(rejected.position, "acceptanceCommands[0].shell");
  assert.match(rejected.reason, /Only executable, args, cwd, timeoutSeconds, inputs are accepted/);
});

test("cwd and inputs must stay inside the declared workspace", () => {
  const outside = rejection(JSON.stringify({ ...base, cwd: path.resolve("C:/elsewhere") }));
  assert.equal(outside.code, "COMMAND_SPEC_PATH");
  assert.equal(outside.field, "cwd");
  for (const input of ["../secrets.txt", "src/../../secrets.txt", "C:/Windows/win.ini", "/etc/passwd", "..\\secrets.txt"]) {
    const rejected = rejection(JSON.stringify({ ...base, inputs: [input] }));
    assert.equal(rejected.code, "COMMAND_SPEC_PATH", input);
    assert.equal(rejected.field, "inputs");
  }
  assert.equal(insideDirectory(workspace, path.join(workspace, "RESULT.md")), true);
  assert.equal(insideDirectory(workspace, path.dirname(workspace)), false);
  assert.equal(insideDirectory(workspace, path.resolve(workspace, "..")), false);
});

test("without a known workspace root only structure is checked and rejection messages stay copyable", () => {
  const structural = parseCommandSpec(JSON.stringify({ ...base, cwd: path.resolve("C:/unresolved") }), { workspaceRoot: null, position: "acceptanceCommands[2]" });
  assert.equal(structural.ok, true);
  const message = commandSpecAdmissionMessage(rejection(JSON.stringify({ ...base, inputs: [] })));
  assert.match(message, /^acceptanceCommands\[0\]\.inputs: /);
  assert.match(message, /\[COMMAND_SPEC_INVALID_VALUE\]/);
  assert.match(message, /Expected e\.g\. \{/);
  const first = admitCommandSpecs([commandSpec(workspace), JSON.stringify({ ...base, inputs: [] }), "npm test"], { workspaceRoot: workspace, field: "acceptanceCommands" });
  assert.equal(first?.position, "acceptanceCommands[1].inputs");
  assert.equal(admitCommandSpecs(undefined, { workspaceRoot: workspace, field: "acceptanceCommands" }), null);
  assert.equal(admitCommandSpecs([commandSpec(workspace)], { workspaceRoot: workspace, field: "acceptanceCommands" }), null);
});

class RefusingClient extends WorkBuddyClient {
  readonly sent: Array<unknown> = [];
  override async sendMessage(...args: Parameters<WorkBuddyClient["sendMessage"]>) {
    this.sent.push(args);
    return { messageId: "unexpected", raw: { code: 0, data: { message_id: "unexpected" } } };
  }
  override async messages() { return []; }
}

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-command-spec-"));
  const config: Config = { ...loadConfig(), backend: "desktop-acp", dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs"), tokenFile: path.join(dir, "unused-credentials.json"), workbuddyConfigDir: path.join(dir, "fake-workbuddy") };
  const store = new TaskStore(config.dbFile);
  const client = new RefusingClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, client, coordinator };
}

test("an unadmittable check blocks send and rework before any native request or task row exists", async (t) => {
  const f = fixture(t);
  const invalid = [
    "npm test",
    JSON.stringify({ ...base, cwd: f.dir, inputs: [] }),
    JSON.stringify({ ...base, cwd: path.dirname(f.dir), inputs: ["RESULT.md"] }),
    JSON.stringify({ ...base, cwd: f.dir, inputs: ["../escape.txt"] }),
    JSON.stringify({ ...base, cwd: f.dir, timeoutSeconds: 0 }),
    JSON.stringify({ ...base, cwd: f.dir, unknown: true }),
  ];
  for (const definition of invalid) {
    await assert.rejects(f.coordinator.send({ model: "synthetic-user-choice", taskId: "blocked", objective: "do work", workspace: f.dir, sessionId: "session", acceptanceCommands: [commandSpec(f.dir), definition] }),
      (error: Error & { code?: string }) => {
        assert.match(String(error.code), /^COMMAND_SPEC_/);
        assert.match(error.message, /acceptanceCommands\[1\]/);
        return true;
      });
    assert.equal(f.client.sent.length, 0, "no native request may be prepared");
    assert.equal(f.store.get("blocked"), undefined, "no task row may be reserved");
  }
  // A valid spec still dispatches, and a later rework cannot smuggle free text into the check list.
  const sent = await f.coordinator.send({ model: "synthetic-user-choice", taskId: "allowed", objective: "do work", workspace: f.dir, sessionId: "session", acceptanceCommands: [commandSpec(f.dir)] });
  assert.equal(sent.created, true);
  assert.equal(f.client.sent.length, 1);
  await assert.rejects(f.coordinator.continue({ taskId: "allowed", feedback: "tighten it", acceptanceCommands: ["inspect again"] }), /COMMAND_SPEC_REQUIRED/);
  assert.equal(f.store.get("allowed")?.attempt, 1);
  assert.equal(f.client.sent.length, 1);
});
