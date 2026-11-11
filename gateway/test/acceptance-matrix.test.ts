// WB01: the acceptance matrix must keep speaking the original design's language.
//
// The checker is the deliverable; this test proves it actually fails when the
// matrix drifts, so "structure validated" is not a claim resting on a script
// that can only say ok.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const gatewayRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(gatewayRoot, "..");
const script = path.join(gatewayRoot, "scripts", "check-acceptance-matrix.mjs");

function run(root) {
  // The checker derives its root from its own location, so a temp repository
  // must run its own copy — running the repository script would re-check the
  // real docs and make every negative case pass for the wrong reason.
  const local = path.join(root, "gateway", "scripts", "check-acceptance-matrix.mjs");
  const result = spawnSync(process.execPath, [root === repoRoot ? script : local], { cwd: root, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-acceptance-"));
  for (const relative of [
    "docs/ACCEPTANCE.md",
    "docs/FRONTEND_TASK_PANEL_DESIGN.md",
    "docs/forward/ACCEPTANCE_MATRIX.md",
    "docs/forward/SCENARIO_INDEX.md",
  ]) {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    cpSync(path.join(repoRoot, relative), path.join(dir, relative));
  }
  mkdirSync(path.join(dir, "gateway", "scripts"), { recursive: true });
  cpSync(script, path.join(dir, "gateway", "scripts", "check-acceptance-matrix.mjs"));
  return dir;
}

test("the repository matrix matches the original design and maps all 31 tasks", () => {
  const result = run(repoRoot);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /53 scenarios, 31 original tasks mapped/);
});

test("a renamed scenario is caught", () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, "docs", "forward", "ACCEPTANCE_MATRIX.md");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace("| F06 | 原生等待 |", "| F06 | 实窗渲染 |"));
    const result = run(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /F06: scenario drifted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rewritten criterion is caught", () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, "docs", "forward", "ACCEPTANCE_MATRIX.md");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace("HTML/脚本字符串只作为文字，无脚本执行、命令或本机路径打开。", "HTML 需要被转义。"));
    const result = run(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /F14: criterion drifted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or duplicated scenario is caught", () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, "docs", "forward", "ACCEPTANCE_MATRIX.md");
    const lines = readFileSync(file, "utf8").split("\n");
    const withoutC17 = lines.filter((line) => !line.startsWith("| C17 |"));
    assert.equal(withoutC17.length, lines.length - 1, "the fixture must contain exactly one C17 row");
    writeFileSync(file, withoutC17.join("\n"));
    const result = run(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /C17: missing from the matrix/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invented original task id is caught", () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, "docs", "forward", "ACCEPTANCE_MATRIX.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("| D7-05 | F15 |", "| D7-05 | F15, D8-01 |"));
    const result = run(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /D8-01/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a result outside the enum is caught", () => {
  const dir = tempRepo();
  try {
    const file = path.join(dir, "docs", "forward", "ACCEPTANCE_MATRIX.md");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace("| V13 | Windows 安装、构建及版本切换 |", "| V13 | Windows 安装、构建及版本切换 |"));
    const patched = readFileSync(file, "utf8").split("\n").map((line) => (
      line.startsWith("| V13 |") ? line.replace("| blocked |", "| 已验收 |") : line
    ));
    writeFileSync(file, patched.join("\n"));
    const result = run(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /V13: result "已验收"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
