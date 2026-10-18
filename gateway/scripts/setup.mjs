#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js >=22.13.0 is required.'); process.exit(1);
}
try { await (await import('../dist/setup.js')).runSetup(); }
catch (error) { console.error(error?.message ?? 'Setup failed. Run npm ci and npm run build first.'); process.exitCode = 1; }
