#!/usr/bin/env node
try { await (await import('../dist/deployment-acceptance.js')).runDeploymentCheck(); }
catch { console.error('Deployment check failed. Build the gateway, verify arguments and use a new output filename.'); process.exitCode=1; }
