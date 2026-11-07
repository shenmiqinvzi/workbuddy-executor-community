#!/usr/bin/env node
// Reproducible dependency install for one installation root.
//   node scripts/bootstrap.mjs --install-root <abs> [--apply] [--json] [--report FILE]
// Without --apply it only prints the exact commands. It never defaults to an
// installation root, never configures WorkBuddy and never writes outside the root.
import fs from "node:fs";
import path from "node:path";

if (!(Number(process.versions.node.split(".")[0]) > 22 || (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1] ?? 0) >= 13))) {
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

try {
  const { runInstallationBootstrap } = await import("../dist/installation-bootstrap.js");
  const report = runInstallationBootstrap({
    installRoot: path.resolve(installRoot),
    apply: flags.has("apply"),
    ...(values.get("npm") ? { npmExecutable: values.get("npm") } : {}),
    ...(values.get("timeout-ms") ? { timeoutMs: Number(values.get("timeout-ms")) } : {}),
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
  console.error("Nothing was installed. Build the gateway first (npm run build) so dist/installation-bootstrap.js exists.");
  process.exit(2);
}
