#!/usr/bin/env node
// Trusted local automation-policy seam (D5-01/02/03). Kept off MCP and HTTP on purpose:
// an agent may propose a policy or a decision, but only this local command saves, revokes,
// enables or executes one. Dispatch also needs --enable-dispatch and an enabled installation.
try { await (await import('../dist/automation-cli.js')).runAutomationCli(); }
catch (error) { console.error(error?.message ?? 'Automation tooling requires npm ci and npm run build first.'); process.exitCode = 1; }
