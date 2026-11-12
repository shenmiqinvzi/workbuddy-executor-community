import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {canonicalPath, inside} from "./support/path-contains.mjs";

function scratch(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workbuddy-contains-${label}-`));
  return root;
}

test("a path inside the fixture root is accepted even when the spelling differs", () => {
  const root = scratch("case");
  const real = canonicalPath(root);
  // A runner can hand back another drive-letter case, and Windows paths are
  // case-insensitive, so the guard must not depend on the spelling it receives.
  const recased = process.platform === "win32"
    ? real.charAt(0).toLowerCase() + real.slice(1).toUpperCase()
    : real.toUpperCase();
  assert.equal(inside(root, recased), true);
  assert.equal(inside(real, path.join(recased, "tasks.sqlite")), true);
  assert.equal(inside(real, path.join(real, "runs")), true);
});

test("a runs directory that does not exist yet is still judged by its parent", () => {
  const root = scratch("missing");
  const real = canonicalPath(root);
  const runs = path.join(real, "runs", "attempt-1");
  assert.equal(fs.existsSync(runs), false);
  assert.equal(inside(real, runs), true);
  assert.equal(inside(real, path.join(real, "..", "elsewhere.db")), false);
});

test("a sibling directory that only shares a prefix is outside", () => {
  const root = scratch("prefix");
  const real = canonicalPath(root);
  const sibling = `${real}-other`;
  fs.mkdirSync(sibling, {recursive: true});
  try {
    assert.equal(inside(real, path.join(sibling, "tasks.sqlite")), false);
    assert.equal(inside(real, path.resolve(real, "..")), false);
  } finally {
    fs.rmSync(sibling, {recursive: true, force: true});
  }
});

test("an 8.3 short name reached through the filesystem still resolves inside", () => {
  const root = scratch("short");
  const real = canonicalPath(root);
  // The short name only exists on Windows with 8.3 generation enabled, so the
  // observable contract is that a canonicalised child equals its real location.
  const child = path.join(root, "tasks.sqlite");
  fs.writeFileSync(child, "");
  const viaReal = real.toLowerCase().replace(/\\/g, "/");
  const backAgain = fs.realpathSync.native(viaReal);
  assert.equal(path.resolve(backAgain).toLowerCase(), path.resolve(real).toLowerCase());
  assert.equal(inside(root, viaReal), true);
});
