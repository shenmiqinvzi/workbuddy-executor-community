import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SKILL_FILES, inspectSkillCopies, updatePlan, writeBundledCopy } from "../scripts/sync-skill.mjs";
import { parseCommandSpec } from "../src/command-spec.js";

/**
 * WB07: the six skill files at the repository root are the only source; the copy
 * under `gateway/skills/workbuddy-executor` is generated from them and is what the
 * release zip packs. These tests prove drift is detected, that regeneration only
 * touches what changed, and that the shipped CommandSpec example actually parses.
 */

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(gatewayRoot, "..");

function copySkill(directory) {
  for (const name of SKILL_FILES) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, name), target);
  }
}

function tempRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skill-copy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a copy that matches the source is in sync, a changed byte is drift", async t => {
  const source = tempRoot(t);
  const bundled = tempRoot(t);
  copySkill(source);
  copySkill(bundled);
  assert.equal((await inspectSkillCopies({ source, bundled })).inSync, true);

  fs.appendFileSync(path.join(bundled, "references/dispatch.md"), "\nlocal edit\n");
  const report = await inspectSkillCopies({ source, bundled });
  assert.equal(report.inSync, false);
  assert.deepEqual(report.drifted, ["bundled"]);
  assert.deepEqual(report.copies.bundled.drift, ["references/dispatch.md"]);
});

test("a missing file is reported as drift instead of being ignored", async t => {
  const source = tempRoot(t);
  const bundled = tempRoot(t);
  copySkill(source);
  copySkill(bundled);
  fs.rmSync(path.join(bundled, "agents/openai.yaml"));
  const report = await inspectSkillCopies({ source, bundled });
  assert.equal(report.copies.bundled.entries["agents/openai.yaml"].state, "missing");
  assert.equal(report.inSync, false);
});

test("the update plan names the generator for the copy and the installer with its backup for installs", async t => {
  const source = tempRoot(t);
  const bundled = tempRoot(t);
  const installed = tempRoot(t);
  copySkill(source);
  copySkill(bundled);
  copySkill(installed);
  fs.appendFileSync(path.join(bundled, "SKILL.md"), "\nedit\n");
  fs.appendFileSync(path.join(installed, "SKILL.md"), "\nedit\n");
  const report = await inspectSkillCopies({ source, bundled, installed: { codex: { directory: installed, files: SKILL_FILES } } });
  const plan = updatePlan(report, { codexHome: "C:/codex-home" });
  assert.equal(plan.length, 2);
  assert.match(plan[0].action, /sync-skill\.mjs --write/);
  assert.match(plan[1].action, /install-skill\.mjs/);
  assert.match(plan[1].note, /skill-backups\/workbuddy-executor-/);
  assert.match(plan[1].note, /回退/);
});

test("a derived variant is compared with its own source, not with the canonical skill", async t => {
  const source = tempRoot(t);
  const bundled = tempRoot(t);
  const variantSource = tempRoot(t);
  const installed = tempRoot(t);
  copySkill(source);
  copySkill(bundled);
  copySkill(variantSource);
  fs.writeFileSync(path.join(variantSource, "SKILL.md"), "variant front matter\n");
  fs.mkdirSync(path.join(installed, "references"), { recursive: true });
  fs.writeFileSync(path.join(installed, "SKILL.md"), "variant front matter\n");
  fs.copyFileSync(path.join(variantSource, "references/setup.md"), path.join(installed, "references/setup.md"));
  const dshFiles = ["SKILL.md", "references/setup.md"];
  const inSync = await inspectSkillCopies({ source, bundled, installed: { dsh: { directory: installed, files: dshFiles, source: variantSource } } });
  assert.equal(inSync.copies.dsh.inSync, true, "the variant matches its own source");
  assert.equal(inSync.copies.dsh.source, variantSource);

  fs.appendFileSync(path.join(installed, "SKILL.md"), "\nstale\n");
  const drifted = await inspectSkillCopies({ source, bundled, installed: { dsh: { directory: installed, files: dshFiles, source: variantSource } } });
  assert.deepEqual(drifted.drifted, ["dsh"]);
  assert.deepEqual(drifted.copies.dsh.drift, ["SKILL.md"]);
  const step = updatePlan(drifted, {}).find(entry => entry.copy === "dsh");
  assert.ok(step, "the plan names the variant copy");
  assert.match(step.action, /install-deepseek-skill\.mjs/, "the plan still names the variant installer");
});

test("regenerating the bundled copy rewrites only the files that differ", async t => {
  const source = tempRoot(t);
  const bundled = tempRoot(t);
  copySkill(source);
  copySkill(bundled);
  fs.writeFileSync(path.join(bundled, "SKILL.md"), "stale\n");
  const before = await inspectSkillCopies({ source, bundled });
  const written = await writeBundledCopy(before);
  assert.deepEqual(written, ["SKILL.md"]);
  assert.equal((await inspectSkillCopies({ source, bundled })).inSync, true);
  assert.deepEqual(await writeBundledCopy(await inspectSkillCopies({ source, bundled })), []);
});

test("the shipped skill copy is generated from this repository, and --check says so", () => {
  const result = spawnSync(process.execPath, [path.join(gatewayRoot, "scripts", "sync-skill.mjs"), "--check", "--json"], { cwd: gatewayRoot, encoding: "utf8", timeout: 60_000 });
  const report = JSON.parse(result.stdout);
  assert.equal(report.copies.bundled.inSync, true, `bundled copy drifted: ${report.copies.bundled.drift.join(", ")}`);
  assert.equal(report.source, repoRoot);
});

/**
 * The example shipped to users is the one part of the spec a person copies by hand.
 * It must parse once the two documented placeholders are substituted, and it must
 * be rejected while they are still in place — otherwise a placeholder path would
 * silently become a command nobody can run.
 */
const EXAMPLE_FILES = ["SKILL.md", "references/dispatch.md", "gateway/skills/workbuddy-executor/SKILL.md", "gateway/skills/workbuddy-executor/references/dispatch.md"];

function examplesIn(filename) {
  const text = fs.readFileSync(path.join(repoRoot, filename), "utf8");
  const blocks = [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(match => match[1].trim());
  return blocks.flatMap(block => {
    const trimmed = block.trim();
    if (trimmed.startsWith('"acceptanceCommands"')) {
      const parsed = JSON.parse(`{${trimmed}}`);
      return parsed.acceptanceCommands;
    }
    if (trimmed.startsWith("{")) return [trimmed];
    return [];
  }).filter(item => item.includes('"executable"'));
}

test("a packaged installation compares installed copies with its bundled skill", async t => {
  // The release zip ships `skills/workbuddy-executor` but not the repository root,
  // so `npm run skill:check` inside an installation must treat the bundled copy as
  // the reference. Otherwise every installed copy reports drift that no command in
  // that installation could ever remove.
  const source = tempRoot(t);
  const bundled = tempRoot(t);
  const installed = tempRoot(t);
  copySkill(bundled);
  copySkill(installed);
  const packed = await inspectSkillCopies({ source, bundled, installed: { codex: { directory: installed } } });
  assert.equal(packed.sourceMode, "bundled");
  assert.equal(packed.copies.bundled.inSync, true, "the bundled copy is the reference, not drift");
  assert.equal(packed.copies.codex.inSync, true, "an installed copy matching the bundled skill is in sync");
  assert.equal(packed.inSync, true);

  fs.appendFileSync(path.join(installed, "SKILL.md"), "extra\n");
  const drifted = await inspectSkillCopies({ source, bundled, installed: { codex: { directory: installed } } });
  assert.deepEqual(drifted.copies.codex.drift, ["SKILL.md"]);
  assert.equal(drifted.inSync, false);
});

test("every shipped CommandSpec example parses after the documented substitutions", t => {
  const workspace = tempRoot(t);
  fs.writeFileSync(path.join(workspace, "RESULT.md"), "done\n");
  for (const filename of EXAMPLE_FILES) {
    const examples = examplesIn(filename);
    assert.ok(examples.length > 0, `${filename} lost its CommandSpec example`);
    for (const example of examples) {
      assert.equal(parseCommandSpec(example, { workspaceRoot: workspace }).ok, false, `${filename} example parses before substituting its placeholders`);
      const filled = example.replaceAll("<node>", process.execPath.replaceAll("\\", "/")).replaceAll("<工作区绝对路径>", workspace.replaceAll("\\", "/"));
      const admission = parseCommandSpec(filled, { workspaceRoot: workspace });
      assert.equal(admission.ok, true, `${filename}: ${admission.ok ? "" : admission.rejection.reason}`);
    }
  }
});

test("the skill no longer ships a machine-bound Node path", () => {
  for (const filename of ["SKILL.md", "references/dispatch.md", "gateway/skills/workbuddy-executor/SKILL.md", "gateway/skills/workbuddy-executor/references/dispatch.md"]) {
    const text = fs.readFileSync(path.join(repoRoot, filename), "utf8");
    assert.doesNotMatch(text, /F:\/node\.exe/, `${filename} still binds the example to one machine`);
    assert.match(text, /process\.execPath/, `${filename} must tell the reader how to find their own Node`);
  }
});
