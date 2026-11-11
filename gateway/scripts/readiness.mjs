#!/usr/bin/env node
// Read-only readiness: five separate answers instead of one "is it working?".
// It prepares no model, starts no desktop app and mutates no session. It does
// start one short-lived MCP process to answer the first two layers from here;
// when that probe cannot run, those layers say so instead of claiming ready.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js >=22.13.0 is required.'); process.exit(1);
}
const ORIGIN = 'scripts/readiness.mjs';
try {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const noProbe = args.includes('--no-probe');
  if (args.some(argument => argument !== '--json' && argument !== '--no-probe')) throw new Error('Usage: node scripts/readiness.mjs [--json] [--no-probe]');
  const { loadDotEnv } = await import('../dist/env.js');
  loadDotEnv();
  const { loadConfig } = await import('../dist/config.js');
  const { observeReadiness, describeReadiness } = await import('../dist/readiness.js');
  const { createReadinessProbes } = await import('../dist/readiness-probes.js');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  // A config that cannot be resolved is reported as unknown; it is never repaired here.
  let config, configError;
  try { config = loadConfig(); } catch (error) { configError = error.message; }
  // --no-probe exists for a machine where spawning anything is not allowed; the
  // report then records that no probe ran, so nobody reads it as verified.
  // The probe child is given the configuration resolved here, so the diagnosis
  // describes the instance this command selected rather than the parent shell's.
  const probes = noProbe ? undefined : createReadinessProbes({ gatewayRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))), config });
  const report = await observeReadiness({ config, configError, origin: ORIGIN, probes });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    const { selection, observer } = report;
    const list = values => values.length ? ` [${values.join(", ")}]` : '';
    console.log(`observed by ${observer.origin} (pid ${observer.pid}) | probes: tool ${observer.probes.tool}, native ${observer.probes.native}`);
    console.log(`backend: ${selection.backend} | config: ${selection.config.state}${list(selection.config.candidates)} | executable: ${selection.executable.state}${list(selection.executable.candidates)}`);
    for (const line of describeReadiness(report)) console.log(line);
    for (const note of report.notes) console.log(`note: ${note}`);
    if (report.nextAction) console.log(`\nNext action (${report.nextAction.layer}): ${report.nextAction.action}`);
    if (selection.suggested.length) {
      console.log(`\nSuggested (set them yourself; nothing was written to any config file):`);
      for (const command of selection.suggested) console.log(`  ${command}`);
    }
  }
  process.exitCode = report.layers.every(item => item.state === 'ready') ? 0 : 1;
} catch {
  console.error('Readiness could not be observed. Run npm ci and npm run build; check local configuration.');
  process.exitCode = 1;
}
