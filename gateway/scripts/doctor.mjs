#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js >=22.13.0 is required.'); process.exit(1);
}
try { await (await import('../dist/doctor.js')).runDoctor(); }
catch { console.error('Diagnosis could not load. Run npm ci and npm run build; check local configuration.'); process.exitCode = 1; }
