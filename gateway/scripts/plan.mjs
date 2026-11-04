#!/usr/bin/env node
// Trusted local planning seam: register a workspace, create a vnext-2 plan,
// authorize it with an explicit source. Kept off MCP and HTTP on purpose — an
// agent may assemble the proposal, but only this local command authorizes it.
try { (await import('../dist/plan.js')).runPlanCli(); }
catch (error) { console.error(error?.message ?? 'Plan tooling requires npm ci and npm run build first.'); process.exitCode = 1; }
