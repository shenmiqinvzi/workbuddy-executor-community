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

// npm ci deletes whatever node_modules points at. When that path is a link, npm
// follows it and empties the target — possibly another checkout's dependencies.
// The compiled planner refuses the same way; this first-run branch has to check
// on its own because it runs before dist/ exists.
function nodeModulesEntry() {
  const target = path.join(root, "node_modules");
  let stat;
  try {
    stat = fs.lstatSync(target); // does not follow the link, so junctions show up here
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: "absent", target: null };
    return { state: "unverifiable", target: null, detail: `${error && error.code ? error.code : "unknown"}` };
  }
  if (stat.isSymbolicLink()) {
    let resolved = null;
    try { resolved = fs.realpathSync.native(target); } catch { resolved = null; }
    let readable = resolved;
    if (!readable) { try { readable = fs.readlinkSync(target); } catch { readable = null; } }
    return { state: resolved && fs.existsSync(resolved) ? "link" : "link_dangling", target: readable };
  }
  if (stat.isDirectory()) return { state: "directory", target: null };
  return { state: "unverifiable", target: null, detail: "node_modules is neither a directory nor a link" };
}

function refuseLinkedNodeModules(entry) {
  if (entry.state === "directory" || entry.state === "absent") return;
  const where = entry.target ?? "an unreadable target";
  const id = entry.state === "link" ? "node_modules_link" : entry.state === "link_dangling" ? "node_modules_link_dangling" : "node_modules_unverifiable";
  console.error(`blocked  ${id}: ${path.join(root, "node_modules")} is ${entry.state === "link" ? `a link to ${where}` : entry.state === "link_dangling" ? `a link whose target ${where} does not exist` : `not verifiable (${entry.detail ?? "unknown reason"})`}.`);
  console.error(`Refusing to run npm ci through it: npm ci empties that path, so a link would empty its target instead of installing into ${root}.`);
  console.error(`Remove or rename ${path.join(root, "node_modules")} (keep ${where} untouched) and run again; this root gets its own dependency directory.`);
  console.error(`Nothing was installed.`);
  process.exit(1);
}

const nodeModules = nodeModulesEntry();
if (!hasPlanner) refuseLinkedNodeModules(nodeModules);

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
