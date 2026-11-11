#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * WB07: the six skill files at the repository root are the single source. This
 * script compares every copy against them and can regenerate the bundled copy
 * inside `gateway/skills/workbuddy-executor`, which is what `scripts/package.mjs`
 * zips. It never writes an installed location: installing is `install-skill.mjs`
 * (it stages, backs up the previous directory and reports the backup path).
 *
 * Usage:
 *   node scripts/sync-skill.mjs --check            # drift report, exit 1 on drift
 *   node scripts/sync-skill.mjs --check --json     # same, machine readable
 *   node scripts/sync-skill.mjs --write            # regenerate the bundled copy
 *
 * Locations reported:
 *   source    <repo>/SKILL.md, agents/, references/   (canonical)
 *   bundled   <repo>/gateway/skills/workbuddy-executor (packed by package.mjs)
 *   codex     <CODEX_HOME|~/.codex>/skills/workbuddy-executor (installed)
 *   dsh       <CODEX_HOME|~/.codex>/skills/deepseek-executor (installed; a derived
 *             two-file variant whose own source is gateway/skills/deepseek-executor)
 */

export const SKILL_FILES = ["SKILL.md", "agents/openai.yaml", "references/setup.md", "references/execution.md", "references/dispatch.md", "references/agent-hub.md"];
const DSH_FILES = ["SKILL.md", "references/setup.md"];

/** Hash one file, or report why it cannot be read. Missing files are data, not errors. */
export async function hashFile(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile()) return { state: "not_a_file" };
    const bytes = await fs.readFile(filename);
    return { state: "present", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", error: String(error?.code ?? error) };
  }
}

/** Read one copy of the skill, keyed by relative name. */
export async function readCopy(directory, files = SKILL_FILES) {
  const entries = {};
  for (const name of files) entries[name] = await hashFile(path.join(directory, name));
  return entries;
}

function sameAs(sourceEntries, entries) {
  return Object.keys(entries).every(name => sourceEntries[name]?.state === "present" && entries[name]?.state === "present" && sourceEntries[name].sha256 === entries[name].sha256);
}

/**
 * Compare every known location with the canonical files. `sources` lets a test
 * point the comparison at temporary directories instead of the real machine.
 */
export async function inspectSkillCopies(sources) {
  const canonical = await readCopy(sources.source);
  // A packaged installation carries no repository root: the bundled copy is the
  // only source it has. Comparing it with the missing checkout would report a
  // drift that no command inside that installation could ever remove, so the
  // bundled copy becomes the reference there.
  const packed = canonical["SKILL.md"]?.state === "missing";
  const reference = packed ? await readCopy(sources.bundled) : canonical;
  const bundled = await readCopy(sources.bundled);
  const report = {
    source: sources.source,
    bundled: sources.bundled,
    sourceMode: packed ? "bundled" : "repository",
    files: reference,
    copies: {
      bundled: { directory: sources.bundled, inSync: packed || sameAs(canonical, bundled), drift: packed ? [] : Object.keys(bundled).filter(name => canonical[name]?.sha256 !== bundled[name]?.sha256), entries: bundled },
    },
  };
  for (const [label, entry] of Object.entries(sources.installed ?? {})) {
    const directory = typeof entry === "string" ? entry : entry.directory;
    const files = typeof entry === "string" ? SKILL_FILES : entry.files ?? SKILL_FILES;
    // The DSH skill is a derived variant with its own source; comparing it to the
    // Codex skill would report drift that no installer can ever remove.
    const ownSource = typeof entry === "string" ? null : entry.source ?? null;
    const expected = ownSource ? await readCopy(ownSource, files) : reference;
    const entries = await readCopy(directory, files);
    report.copies[label] = {
      directory,
      source: ownSource ?? sources.source,
      inSync: sameAs(expected, entries),
      drift: Object.keys(entries).filter(name => expected[name]?.sha256 !== entries[name]?.sha256),
      entries,
    };
  }
  const drifted = Object.entries(report.copies).filter(([, copy]) => !copy.inSync).map(([label]) => label);
  report.inSync = drifted.length === 0;
  report.drifted = drifted;
  return report;
}

/** The update plan a person can follow without guessing: what to run and where the backup lands. */
export function updatePlan(report, options = {}) {
  const steps = [];
  if (!report.copies.bundled.inSync) {
    steps.push({ copy: "bundled", action: "node gateway/scripts/sync-skill.mjs --write", note: "以仓库根六文件重生成网关副本；改动留在仓库里，走正常提交审阅。" });
  }
  for (const [label, copy] of Object.entries(report.copies)) {
    if (label === "bundled" || copy.inSync) continue;
    const installer = label === "dsh" ? "install-deepseek-skill.mjs" : "install-skill.mjs";
    const backupRoot = label === "dsh" ? "<CODEX_HOME>/skill-backups/deepseek-executor-*" : "<CODEX_HOME>/skill-backups/workbuddy-executor-*";
    steps.push({ copy: label, action: `node gateway/scripts/${installer}${options.codexHome ? `   # CODEX_HOME=${options.codexHome}` : ""}`, note: `安装位 ${label} 与它的源 ${copy.source} 不一致：安装脚本会先把旧目录移到 ${backupRoot}，再原子替换；要回退就把该备份目录移回 ${copy.directory}。` });
  }
  return steps;
}

async function defaultSources() {
  const gateway = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repo = path.resolve(gateway, "..");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sources = {
    source: repo,
    bundled: path.join(gateway, "skills", "workbuddy-executor"),
    installed: {
      codex: { directory: path.join(codexHome, "skills", "workbuddy-executor"), files: SKILL_FILES },
      dsh: { directory: path.join(codexHome, "skills", "deepseek-executor"), files: DSH_FILES, source: path.join(gateway, "skills", "deepseek-executor") },
    },
    codexHome,
  };
  return sources;
}

/** Copy the canonical files over the bundled copy through a staging directory. */
export async function writeBundledCopy(report) {
  const written = [];
  for (const name of SKILL_FILES) {
    const from = path.join(report.source, name);
    const to = path.join(report.bundled, name);
    const bytes = await fs.readFile(from);
    const existing = await hashFile(to);
    if (existing.state === "present" && existing.sha256 === crypto.createHash("sha256").update(bytes).digest("hex")) continue;
    const stage = `${to}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(stage, bytes, { mode: 0o644 });
    await fs.rename(stage, to);
    written.push(name);
  }
  return written;
}

function render(report, plan) {
  const lines = [];
  lines.push(`source  ${report.source}`);
  for (const [label, copy] of Object.entries(report.copies)) {
    lines.push(`${label.padEnd(8)}${copy.inSync ? "in sync " : "DRIFT   "}${copy.directory}${copy.inSync ? "" : `  (${copy.drift.join(", ")})`}`);
  }
  for (const step of plan) lines.push(`fix     ${step.copy}: ${step.action}`);
  lines.push(report.inSync ? "six files agree in every location that exists" : `drift: ${report.drifted.join(", ")}`);
  return lines.join("\n");
}

async function main(argv) {
  const json = argv.includes("--json");
  const write = argv.includes("--write");
  const check = argv.includes("--check") || !write;
  const sources = await defaultSources();
  const report = await inspectSkillCopies(sources);
  const plan = updatePlan(report, { codexHome: sources.codexHome });
  if (write) {
    const written = await writeBundledCopy(report);
    const after = await inspectSkillCopies(sources);
    const output = { written, bundled: after.copies.bundled, inSync: after.inSync, drifted: after.drifted };
    if (json) console.log(JSON.stringify(output, null, 2));
    else console.log(`wrote ${written.length} file(s): ${written.join(", ") || "(none)"}\n${render(after, updatePlan(after, { codexHome: sources.codexHome }))}`);
    if (!after.copies.bundled.inSync) process.exit(1);
    return;
  }
  if (json) console.log(JSON.stringify({ ...report, plan }, null, 2));
  else console.log(render(report, plan));
  if (check && !report.inSync) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  await main(process.argv.slice(2));
}
