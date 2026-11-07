#!/usr/bin/env node
// Reproducible dependency install for one installation root.
//   node scripts/bootstrap.mjs --install-root <abs> [--apply] [--json] [--report FILE]
// Without --apply it only prints the exact commands. It never defaults to an
// installation root, never configures WorkBuddy and never writes outside the root.
//
// A source archive carries no dist/, so the first run cannot import the planner
// in ../dist/installation-bootstrap.js. That first run is the one case handled
// here: install from the lockfile, build, and only then delegate to the planner
// for the bounded step report and the dependency diagnosis.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [major, minor] = process.versions.node.replace(/^v/, "").split(".").map(Number);
if (!(major > 22 || (major === 22 && (minor ?? 0) >= 13))) {
  console.error(`Node ${process.versions.node} is older than 22.13.0; the bootstrap cannot run.`);
  process.exit(2);
}

const values = new Map();
const flags = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (!item.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) { values.set(item.slice(2), next); index += 1; }
  else flags.add(item.slice(2));
}

const installRoot = values.get("install-root");
if (!installRoot) {
  console.error("--install-root is required; this command never guesses an installation root.");
  process.exit(2);
}
const root = path.resolve(installRoot);
const apply = flags.has("apply");
const npm = values.get("npm") ?? (process.platform === "win32" ? "npm.cmd" : "npm");
const timeoutMs = values.get("timeout-ms") ? Number(values.get("timeout-ms")) : 15 * 60 * 1000;

function npmRun(args, budget = timeoutMs) {
  const started = Date.now();
  const file = process.platform === "win32" && /\.(cmd|bat)$/i.test(npm) ? process.env.ComSpec ?? "cmd.exe" : npm;
  const argv = file === npm ? args : ["/d", "/s", "/c", [npm, ...args].join(" ")];
  const outcome = spawnSync(file, argv, { cwd: root, stdio: "inherit", timeout: budget, windowsHide: true });
  return { status: outcome.status, durationMs: Date.now() - started };
}

const planner = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "dist", "installation-bootstrap.js");
const hasPlanner = fs.existsSync(planner);

if (!hasPlanner) {
  const manifest = path.join(root, "package.json");
  const lockfile = path.join(root, "package-lock.json");
  if (!fs.existsSync(manifest) || !fs.existsSync(lockfile)) {
    console.error(`blocked  ${!fs.existsSync(manifest) ? "package_json" : "package_lock"}: ${root} is not a complete gateway root.`);
    console.error("Nothing was installed. Point --install-root at the unpacked gateway directory that carries package.json and package-lock.json.");
    process.exit(1);
  }
  const steps = [["npm_ci", ["ci"], "Install the full dependency set from package-lock.json before building."], ["npm_build", ["run", "build", "--if-present"], "Build dist/ because the source archive carries no build output."]];
  for (const [id, args, reason] of steps) {
    console.log(`${apply ? "run" : "planned"}`.padEnd(8) + ` ${id}: ${npm} ${args.join(" ")}${apply ? "" : ` — ${reason}`}`);
  }
  if (!apply) { console.log(`install root: ${root} (first run; add --apply to install from the lockfile and build)`); process.exit(1); }
  for (const [id, args] of steps) {
    const outcome = npmRun(args);
    console.log(`${outcome.status === 0 ? "ok" : "failed"}`.padEnd(8) + ` ${id}: ${npm} ${args.join(" ")} (${outcome.durationMs}ms)${outcome.status === 0 ? "" : ` → exit ${outcome.status ?? "unknown"}`}`);
    if (outcome.status !== 0) {
      console.error(`Fix ${id} and re-run: ${npm} ${args.join(" ")}. Nothing outside ${root} was touched.`);
      process.exit(1);
    }
  }
}

try {
  const { runInstallationBootstrap } = await import(`file://${planner.replaceAll("\\", "/")}`);
  const report = runInstallationBootstrap({
    installRoot: root,
    apply,
    ...(values.get("npm") ? { npmExecutable: values.get("npm") } : {}),
    ...(values.get("timeout-ms") ? { timeoutMs } : {}),
  });
  if (values.get("report")) fs.writeFileSync(path.resolve(values.get("report")), `${JSON.stringify(report, null, 2)}\n`);
  if (flags.has("json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`install root: ${report.installRoot}${report.apply ? "" : " (plan only; add --apply to run)"}`);
    for (const blocker of report.blockers) console.log(`blocked  ${blocker.id}: ${blocker.detail} → ${blocker.remediation}`);
    for (const step of report.steps) console.log(`${step.status.padEnd(8)} ${step.id}: ${step.command} ${step.args.join(" ")}${step.durationMs ? ` (${step.durationMs}ms)` : ""}${step.error ? ` → ${step.error}` : ""}`);
    for (const line of report.next) console.log(`next     ${line}`);
  }
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(`Bootstrap could not run: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Nothing was installed beyond ${root}.`);
  process.exit(2);
}
