import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The skill and the desktop composer describe one product: the same three
 * decisions, the same two executor identities and the same "nothing is picked
 * for you" rule. This guard fails when one side drifts, so a change in one
 * surface cannot silently rename the other.
 */
const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(gatewayRoot, "..");
const read = (...segments: string[]) => readFileSync(path.join(...segments), "utf8");

const decisionLabels = ["建议直接处理", "暂不派工", "建议交给执行器"];

test("the skill and the desktop composer name the same three decisions", () => {
  const skill = read(repoRoot, "SKILL.md");
  const bundled = read(gatewayRoot, "skills", "workbuddy-executor", "SKILL.md");
  // The skill speaks to the model in decision codes; the composer speaks to the
  // user in labels. Both must cover the same three cases.
  for (const code of ["`direct`", "`delegate`", "`wait`"]) {
    assert.ok(skill.includes(code), `root SKILL.md names ${code}`);
    assert.ok(bundled.includes(code), `bundled SKILL.md names ${code}`);
  }
  const evaluator = read(gatewayRoot, "src", "recommendation.ts");
  assert.match(
    evaluator,
    /export type RecommendationDecision = "direct" \| "delegate" \| "wait";/,
    "the evaluator exposes exactly the three decisions the panels render",
  );
  const composer = read(gatewayRoot, "workbench", "dispatch.mjs");
  for (const label of decisionLabels) assert.ok(composer.includes(label), `composer renders ${label}`);
});

test("both surfaces promise that nothing is chosen for the user", () => {
  const skill = read(repoRoot, "SKILL.md");
  assert.match(skill, /不自动选最新/, "the skill promises no newest-model default");
  assert.match(skill, /不准备模型/, "reading the catalog prepares no model");
  const composer = read(gatewayRoot, "workbench", "dispatch.mjs");
  assert.match(composer, /读取可用目录不会准备或切换模型/, "the composer states the same rule");
  assert.match(composer, /本页只准备约定/, "the composer prepares a contract, never a dispatch");
  const assignments = [...composer.matchAll(/controls\.(model|effort)\.value\s*=\s*([^;]+)/g)];
  assert.ok(assignments.length >= 3, "the composer does restore and apply explicit selections");
  for (const [, field, value] of assignments) {
    assert.match(
      value ?? "",
      /^(previous\.|previous\.contract\.execution\.|execution\.)/,
      `controls.${field} is only ever set from the user's own earlier choice or an explicit selection, not from a ranking`,
    );
  }
});

test("both surfaces use the same two executor identities", () => {
  const skill = read(repoRoot, "SKILL.md");
  assert.match(skill, /`workbuddy`/, "the skill names the native executor");
  assert.match(skill, /`dsh`/, "the skill names the DSH executor");
  const composer = read(gatewayRoot, "workbench", "dispatch.mjs");
  assert.match(composer, /executorId === 'workbuddy'/, "the composer groups the native executor");
  assert.match(composer, /DSH · \$\{e\.pro/, "the composer groups the DSH executor");
  const contract = read(gatewayRoot, "src", "task-contract.ts");
  assert.match(contract, /executorId: "workbuddy" \| "dsh"/, "the contract accepts only these two");
});
