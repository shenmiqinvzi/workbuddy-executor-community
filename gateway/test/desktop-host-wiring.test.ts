import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The window is the only place an operator sees "nothing is dispatchable" without a terminal,
 * so its own host has to answer the same read-only diagnosis the CLI prints. This asserts the
 * wiring, not the route: the route itself is covered by test/workbench-readiness-route.test.ts,
 * and the live proof is a probe against the running host (see post-final8 evidence).
 */
test("the desktop host wires the five-layer diagnosis into its read-only server", () => {
  const source = fs.readFileSync(path.join(gatewayRoot, "scripts", "workbench-desktop-host.mjs"), "utf8");
  assert.match(source, /import \{ observeReadiness \} from '\.\.\/dist\/readiness\.js';/);
  // WB06: the host that draws the window must answer the first two layers itself,
  // through a memoized probe pair, and must name its own origin in the report.
  assert.match(source, /import \{ createReadinessProbes \} from '\.\.\/dist\/readiness-probes\.js';/);
  assert.match(source, /const readinessProbes = createReadinessProbes\(\{ moduleUrl: import\.meta\.url \}\);/);
  assert.match(source, /new WorkbenchHttpServer\(\{[\s\S]*?readiness: \{ observe: \(\) => observeReadiness\(\{ config, origin: 'scripts\/workbench-desktop-host\.mjs', probes: readinessProbes \}\) \},[\s\S]*?\}\);/);
});

/**
 * A host that opened the window must not start writing task state to answer a diagnosis.
 * The route is read-only by construction; this keeps the wiring from growing a writer.
 */
test("the desktop host never builds the diagnosis from a writable surface", () => {
  const source = fs.readFileSync(path.join(gatewayRoot, "scripts", "workbench-desktop-host.mjs"), "utf8");
  const readinessBlock = source.slice(source.indexOf("readiness: {"));
  assert.doesNotMatch(readinessBlock.slice(0, 200), /dispatch|send\(|automation|close\(/);
});
