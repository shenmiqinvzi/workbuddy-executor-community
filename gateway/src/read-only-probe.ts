/**
 * The read-only observation seam the MCP process uses.
 *
 * The automation module is where policies are stored and where a decision could
 * one day dispatch on its own. The MCP tool surface must never be able to reach
 * that module, so it depends on this narrow facade instead: the only thing it can
 * obtain here is a probe that reads local state and can never dispatch, arm or
 * write. Keeping the re-export in its own file keeps the constraint visible in
 * one place — see `test/automation-policy.test.ts`, which asserts that the MCP
 * entry points never mention the automation module by name.
 */
export { createReadOnlyProbe } from "./automation.js";
export type { AutomationProbeReport, AutomationProbeResult } from "./automation.js";
