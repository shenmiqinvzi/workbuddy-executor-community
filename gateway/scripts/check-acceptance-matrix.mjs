#!/usr/bin/env node
// Structural check for the unified acceptance matrix (WB01).
//
// It does not decide whether a scenario passed. It only proves the matrix still
// speaks the original design's language: 53 unique ids, scenario and criterion
// text identical to docs/ACCEPTANCE.md / docs/FRONTEND_TASK_PANEL_DESIGN.md,
// every one of the 31 original tasks mapped, enum-only modes and results, and
// docs/forward/SCENARIO_INDEX.md not renaming a scenario.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MATRIX_MODES = ["prototype", "read-only", "manual", "recommend", "automatic"];
export const MATRIX_RESULTS = ["passed", "failed", "unknown", "blocked", "not_run"];
export const ORIGINAL_TASKS = [
  "D0-01", "D0-02", "D0-03",
  "D1-01", "D1-02", "D1-03", "D1-04",
  "D2-01", "D2-02", "D2-03", "D2-04",
  "D3-01", "D3-02", "D3-03", "D3-04",
  "D4-01", "D4-02", "D4-03",
  "D5-01", "D5-02", "D5-03",
  "D6-01", "D6-02", "D6-03", "D6-04", "D6-05",
  "D7-01", "D7-02", "D7-03", "D7-04", "D7-05",
];

const expectedIds = () => [
  ...Array.from({ length: 15 }, (_, i) => `V${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 18 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 20 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
];

function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function tableRows(text, idPattern) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const parts = cells(line);
    if (!parts.length || !new RegExp(`^${idPattern}$`).test(parts[0] ?? "")) continue;
    rows.push(parts);
  }
  return rows;
}

/** Inputs the check reads. A layout is accepted only when all of them are present. */
export const MATRIX_INPUTS = [
  "docs/ACCEPTANCE.md",
  "docs/FRONTEND_TASK_PANEL_DESIGN.md",
  "docs/forward/ACCEPTANCE_MATRIX.md",
  "docs/forward/SCENARIO_INDEX.md",
];

/**
 * Locate the tree that holds the frozen acceptance inputs. The same script runs
 * in two layouts: a source checkout (`<repo>/gateway/scripts/…`, inputs under
 * `<repo>/docs`) and an installed package (`<install>/scripts/…`, inputs under
 * `<install>/docs`). Guessing "two levels up" is wrong in the second one, and a
 * missing input must name itself instead of surfacing as a bare ENOENT.
 */
export function locateInputs(scriptFile) {
  const scriptDir = path.dirname(path.resolve(scriptFile));
  const installRoot = path.resolve(scriptDir, "..");
  const checkoutRoot = path.resolve(installRoot, "..");
  const candidates = [checkoutRoot, installRoot];
  for (const root of candidates) {
    const present = MATRIX_INPUTS.filter(relative => existsSync(path.join(root, relative)));
    if (present.length === MATRIX_INPUTS.length) return { root, missing: [] };
  }
  const root = candidates[0];
  return { root, missing: MATRIX_INPUTS.filter(relative => !existsSync(path.join(root, relative))) };
}

export function readOriginals(root) {
  const originals = new Map();
  const acceptance = readFileSync(path.join(root, "docs", "ACCEPTANCE.md"), "utf8");
  for (const row of tableRows(acceptance, "[VC]\\d\\d")) {
    // V rows: | 编号 | 场景 | 必须观察到的结果 |
    // C rows: | 编号 | 阶段 | 场景 | 必须观察到的结果 |
    const [scenario, criterion] = row.length >= 4 ? [row[2], row[3]] : [row[1], row[2]];
    if (!scenario || !criterion) continue;
    originals.set(row[0], { scenario, criterion, source: "docs/ACCEPTANCE.md" });
  }
  const frontend = readFileSync(path.join(root, "docs", "FRONTEND_TASK_PANEL_DESIGN.md"), "utf8");
  for (const row of tableRows(frontend, "F\\d\\d")) {
    // | F01 | 环境独立 | WorkBuddy关闭… |
    if (row.length < 3) continue;
    originals.set(row[0], { scenario: row[1], criterion: row[2], source: "docs/FRONTEND_TASK_PANEL_DESIGN.md" });
  }
  return originals;
}

export function checkMatrix(root) {
  const problems = [];
  const originals = readOriginals(root);
  const matrixPath = path.join(root, "docs", "forward", "ACCEPTANCE_MATRIX.md");
  const matrix = readFileSync(matrixPath, "utf8");
  const rows = tableRows(matrix, "[VCF]\\d\\d").filter((row) => row.length === 9);

  const seen = new Map();
  for (const row of rows) {
    // | 编号 | 场景 | 判据 | 子断言 | 模式 | 原任务 | 结果 | 证据 | 下一任务 |
    if (row.length !== 9) {
      problems.push(`${row[0]}: expected 9 columns, found ${row.length}`);
      continue;
    }
    const [id, scenario, criterion, claims, modes, tasks, result, evidence, next] = row;
    if (!expectedIds().includes(id)) continue;
    if (seen.has(id)) problems.push(`${id}: duplicate row`);
    seen.set(id, { scenario, criterion, modes, tasks, result });

    const original = originals.get(id);
    if (!original) {
      problems.push(`${id}: not defined by the original design`);
      continue;
    }
    if (scenario !== original.scenario) {
      problems.push(`${id}: scenario drifted from ${original.source}\n  original: ${original.scenario}\n  matrix:   ${scenario}`);
    }
    if (criterion !== original.criterion) {
      problems.push(`${id}: criterion drifted from ${original.source}\n  original: ${original.criterion}\n  matrix:   ${criterion}`);
    }
    if (!claims) problems.push(`${id}: no observable sub-assertions`);
    if (!next) problems.push(`${id}: no next task for the remaining gap`);

    const modeList = modes.split(",").map((mode) => mode.trim()).filter(Boolean);
    if (!modeList.length) problems.push(`${id}: no applicable mode`);
    for (const mode of modeList) {
      if (!MATRIX_MODES.includes(mode)) problems.push(`${id}: unknown mode "${mode}"`);
    }

    const taskList = tasks.split(",").map((task) => task.trim()).filter(Boolean);
    if (!taskList.length) problems.push(`${id}: no original task mapping`);
    for (const task of taskList) {
      if (!ORIGINAL_TASKS.includes(task)) problems.push(`${id}: "${task}" is not one of the 31 original tasks`);
    }

    if (!MATRIX_RESULTS.includes(result)) problems.push(`${id}: result "${result}" is not one of ${MATRIX_RESULTS.join("/")}`);
    if (!evidence) problems.push(`${id}: no evidence cell`);
    if (result === "passed" && /^—$/.test(evidence)) problems.push(`${id}: passed without evidence`);
  }

  for (const id of expectedIds()) {
    if (!seen.has(id)) problems.push(`${id}: missing from the matrix`);
  }
  for (const id of seen.keys()) {
    if (!expectedIds().includes(id)) problems.push(`${id}: unexpected id`);
  }

  const covered = new Set();
  for (const row of seen.values()) {
    for (const task of row.tasks.split(",").map((task) => task.trim())) covered.add(task);
  }
  for (const task of ORIGINAL_TASKS) {
    if (!covered.has(task)) problems.push(`${task}: original task not mapped by any scenario`);
  }

  const mapping = tableRows(matrix, "D\\d-\\d\\d");
  if (mapping.length !== ORIGINAL_TASKS.length) {
    problems.push(`the 31-task mapping table has ${mapping.length} rows, expected ${ORIGINAL_TASKS.length}`);
  }
  for (const row of mapping) {
    if (!ORIGINAL_TASKS.includes(row[0])) problems.push(`${row[0]}: mapping row is not an original task`);
    const scenes = (row[1] ?? "").split(/[、,]/).map((scene) => scene.trim()).filter(Boolean);
    if (!scenes.length) problems.push(`${row[0]}: mapping names no scenario`);
    for (const scene of scenes) {
      if (!seen.has(scene)) problems.push(`${row[0]}: mapping names unknown scenario "${scene}"`);
    }
  }

  const index = readFileSync(path.join(root, "docs", "forward", "SCENARIO_INDEX.md"), "utf8");
  for (const row of tableRows(index, "[VCF]\\d\\d")) {
    const id = row[0];
    const original = originals.get(id);
    if (!original) continue;
    // | 项 | 场景 | 本轮变化 | 等级 | 遗留 |
    const scenario = row[1] ?? "";
    if (scenario !== original.scenario) {
      problems.push(`SCENARIO_INDEX ${id}: renames the scenario (expected "${original.scenario}", found "${scenario}")`);
    }
  }

  return { ok: problems.length === 0, checked: seen.size, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const located = locateInputs(fileURLToPath(import.meta.url));
  if (located.missing.length) {
    for (const relative of located.missing) console.error(`- missing input: ${path.join(located.root, relative)}`);
    console.error(`acceptance matrix: ${located.missing.length} input(s) are not in this tree;`);
    console.error("  the matrix reads the design documents, so it runs in a source checkout or in a release archive that ships them.");
    process.exit(1);
  }
  const root = located.root;
  const result = checkMatrix(root);
  const json = process.argv.includes("--json");
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    console.log(`acceptance matrix ok: ${result.checked} scenarios, 31 original tasks mapped`);
  } else {
    for (const problem of result.problems) console.error(`- ${problem}`);
    console.error(`acceptance matrix: ${result.problems.length} problem(s)`);
  }
  process.exit(result.ok ? 0 : 1);
}
