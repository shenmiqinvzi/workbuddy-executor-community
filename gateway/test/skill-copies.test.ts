import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repository keeps the readable skill at its root and the copy that
// install-skill.mjs ships under gateway/skills. CI compares them in
// "Verify executor skill copies", but that step only runs on a push; editing
// one side and testing locally stays green until CI speaks. This test makes the
// drift fail where it is introduced.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const bundled = path.resolve(here, "..", "skills", "workbuddy-executor");
const files = ["SKILL.md", "agents/openai.yaml", "references/setup.md", "references/execution.md", "references/dispatch.md", "references/agent-hub.md"];

const read = (base, name) => {
  try { return fs.readFileSync(path.join(base, name), "utf8").replaceAll("\r\n", "\n"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

test("the bundled skill copies match the repository root", async t => {
  const missing = files.filter(name => read(root, name) === null);
  if (missing.length > 0) {
    t.skip(`repository root skill files are absent (${missing.join(", ")}); this checkout is not the source tree`);
    return;
  }
  for (const name of files) {
    const source = read(root, name);
    const copy = read(bundled, name);
    assert.notEqual(copy, null, `Bundled skill copy is missing: ${name}`);
    assert.equal(copy, source, `Bundled skill copy differs from the root file: ${name}`);
  }
});
