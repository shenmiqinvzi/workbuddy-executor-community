#!/usr/bin/env node
// Read-only readiness: five separate answers instead of one "is it working?".
// It prepares no model, starts no service and mutates no session.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js >=22.13.0 is required.'); process.exit(1);
}
try {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  if (args.some(argument => argument !== '--json')) throw new Error('Usage: node scripts/readiness.mjs [--json]');
  const { loadDotEnv } = await import('../dist/env.js');
  loadDotEnv();
  const { loadConfig } = await import('../dist/config.js');
  const { observeReadiness, describeReadiness } = await import('../dist/readiness.js');
  // A config that cannot be resolved is reported as unknown; it is never repaired here.
  let config, configError;
  try { config = loadConfig(); } catch (error) { configError = error.message; }
  const report = await observeReadiness({ config, configError });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    const { selection } = report;
    const list = values => values.length ? ` [${values.join(", ")}]` : '';
    console.log(`backend: ${selection.backend} | config: ${selection.config.state}${list(selection.config.candidates)} | executable: ${selection.executable.state}${list(selection.executable.candidates)}`);
    for (const line of describeReadiness(report)) console.log(line);
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
