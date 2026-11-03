/**
 * Workbench asset reachability guard.
 *
 * A module imported by `workbench/app.mjs` that is missing from the HTTP
 * allowlist fails to load in the browser, and one missing from the release
 * collector never ships at all. Both failures are silent: the server still
 * answers 200 for the page, the package still builds, and no existing test
 * notices. This test walks the runtime files under `workbench/` and asserts
 * that each one is both served and shipped.
 *
 * The two allowlists are read as text because the HTTP map is a property of
 * `src/workbench-assets.ts` and the release collector is a script that runs on
 * import; neither can be imported here without side effects.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbenchRoot = new URL("../workbench/", import.meta.url);

/** Runtime files only: `workbench/test/` holds the fixture tests themselves. */
function runtimeFiles(dir: URL, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (name === "test") continue;
      found.push(...runtimeFiles(new URL(`${entry.name}/`, dir), `${name}/`));
      continue;
    }
    if (/\.(?:mjs|css|html)$/.test(entry.name)) found.push(name);
  }
  return found.sort();
}

const files = runtimeFiles(workbenchRoot);

test("the workbench runtime file list is not empty", () => {
  assert.ok(files.includes("app.mjs"), "workbench/app.mjs should be discovered");
  assert.ok(files.length >= 10, `expected the full workbench runtime, found ${files.length} files`);
});

test("every workbench runtime file is served by the HTTP allowlist", () => {
  const source = fs.readFileSync(new URL("../src/workbench-assets.ts", import.meta.url), "utf8");
  for (const relative of files) {
    // index.html is served by the "/workbench/" directory entry.
    const needle = relative === "index.html" ? '"/workbench/"' : `["${relative}"`;
    assert.ok(source.includes(needle), `src/workbench-assets.ts does not serve workbench/${relative}: the page will fail to load it`);
  }
});

test("every workbench runtime file ships in the release package", () => {
  const source = fs.readFileSync(new URL("../scripts/package.mjs", import.meta.url), "utf8");
  for (const relative of files) {
    assert.ok(source.includes(`"${relative}"`), `scripts/package.mjs does not ship workbench/${relative}`);
  }
});
