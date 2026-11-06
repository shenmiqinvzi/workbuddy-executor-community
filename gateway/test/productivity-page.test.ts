/**
 * L06 page formatter tests.
 *
 * The productivity page is plain ESM whose rendering helpers are pure functions
 * over server views. These tests import the module without a DOM and assert the
 * presentation rules the acceptance line asks for: an unmeasured value is never
 * printed as zero, an unknown reason is never guessed, and the view never
 * creates markup from user text.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REASON_LABELS,
  exportSummaryLines,
  formatBytes,
  limitationLines,
  reasonLabel,
  templateKindLabel,
  templateLine,
} from "../workbench/productivity.mjs";

test("productivity page: unmeasured numbers render as NA, never as 0", () => {
  assert.equal(formatBytes(null), "NA");
  assert.equal(formatBytes(undefined), "NA");
  assert.equal(formatBytes(Number.NaN), "NA");
  assert.equal(formatBytes(-1), "NA");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.00 MiB");
});

test("productivity page: every stored reason has a label, and an unknown code is shown as-is", () => {
  assert.deepEqual(Object.keys(REASON_LABELS).sort(), ["deadline", "failed", "input_requested", "needs_review"]);
  assert.equal(reasonLabel("input_requested"), "等待用户信息");
  assert.equal(reasonLabel("needs_review"), "停止待验收");
  assert.equal(reasonLabel("something_new"), "something_new");
  assert.equal(reasonLabel(null), "NA");
  assert.equal(templateKindLabel("manual"), "手动模板");
  assert.equal(templateKindLabel("policy-suggestion"), "政策建议（未启用）");
  assert.equal(templateKindLabel("auto"), "NA");
});

test("productivity page: a template line names its version, kind, checks and archival", () => {
  const line = templateLine({ name: "前端小修", templateVersion: 2, kind: "manual", checks: 3, archivedAt: null });
  assert.equal(line, "前端小修 · v2 · 手动模板 · 3 项检查");
  const archived = templateLine({ name: "旧模板", templateVersion: 1, kind: "policy-suggestion", checks: 0, archivedAt: "2026-11-05T12:00:00.000Z" });
  assert.equal(archived, "旧模板 · v1 · 政策建议（未启用） · 0 项检查 · 已归档");
  assert.equal(templateLine(null), "NA");
});

test("productivity page: the export preview states size, whitelist and redactions", () => {
  const lines = exportSummaryLines({
    taskId: "task-1",
    digest: "a".repeat(64),
    bytes: 2048,
    bytesLimit: 4 * 1024 * 1024,
    whitelist: ["task", "contract"],
    evidenceTypes: ["attempt", "check:command"],
    redactionCount: 2,
  });
  assert.equal(lines.length, 6);
  assert.ok(lines[0]?.includes("task-1"));
  assert.ok(lines[1]?.includes("a".repeat(64)));
  assert.ok(lines[2]?.includes("2.0 KiB") && lines[2].includes("4.00 MiB"));
  assert.ok(lines[3]?.includes("2"));
  assert.ok(lines[4]?.includes("attempt"));
  assert.ok(lines[5]?.includes("2"));

  const missing = exportSummaryLines({ taskId: "task-2" });
  assert.ok(missing[0]?.includes("task-2"));
  assert.ok(missing[1]?.includes("NA"));
  assert.ok(missing[2]?.includes("NA"));
  assert.equal(exportSummaryLines(null)[0], "NA");
});

test("productivity page: an empty limitation list says so instead of implying there are none", () => {
  const empty = limitationLines({ limitations: [] });
  assert.equal(empty.length, 1);
  assert.match(empty[0], /不等于没有限制/);
  assert.deepEqual(limitationLines({ limitations: ["白名单字段", "同一份快照"] }), ["白名单字段", "同一份快照"]);
  assert.equal(limitationLines(null).length, 1);
});

test("productivity page: rendering never builds markup from user text", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "workbench", "productivity.mjs"), "utf8");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), false);
  // The one HTML sink a page could use is `text`, which sets textContent.
  assert.match(source, /node\.textContent = String\(value\)/);
});
