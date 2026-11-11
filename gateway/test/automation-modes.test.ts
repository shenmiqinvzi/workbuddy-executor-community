import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AdmissionError } from "../src/collaboration.js";
import { automationFixture } from "./support/automation-fixture.js";

/**
 * ADR-01 (docs/forward/ADR-01_AUTOMATION_MODES.md) says two layers exist and exactly one of them
 * is in force: `per_task_confirmed`. These tests hold the *decision*, not just the prose — they read
 * the running service and the source tree, so a later edit that quietly implements the second layer
 * fails here before it can dispatch anything.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(repoRoot, "gateway", "src");
const adrPath = path.join(repoRoot, "docs", "forward", "ADR-01_AUTOMATION_MODES.md");
const operator = { actor: "synthetic-operator", source: "user:synthetic-operator" };

const code = (error: unknown) => (error instanceof AdmissionError ? error.code : String(error));

/** Every TypeScript source file under gateway/src, so a new file cannot slip past the scan. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(target));
    else if (entry.name.endsWith(".ts")) found.push(target);
  }
  return found;
}

test("the running service reports the per-task mode and never claims the second layer", (t) => {
  const fixture = automationFixture(t);
  const service = fixture.armed();
  const described = service.describe() as Record<string, unknown>;
  const layers = described.layers as Record<string, Record<string, unknown>>;

  assert.equal(layers.taskSelection.mode, "per_task_confirmed");
  assert.match(String(layers.taskSelection.note), /never chooses a model for a future task/);

  // enabled/armed/authorized are separate facts; none of them may be read as "a model was chosen".
  assert.equal(layers.installation.layer, "installation_enabled");
  assert.equal(layers.process.layer, "process_armed");
  assert.equal(layers.authorization.layer, "policy_authorization");
  assert.equal(layers.dispatch.layer, "actual_dispatch");

  const limits = described.limits as string[];
  assert.ok(limits.some((line) => /each new real task still needs its own executor\/model\/reasoning selection confirmed/.test(line)));
  fixture.close();
});

test("an enabled installation does not arm dispatch and creates no plan", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation(); // same store, but this process is not armed
  service.setEnabled(true, operator);
  const saved = fixture.savePolicy(service);

  const described = service.describe() as Record<string, unknown>;
  assert.equal(described.enabled, true);
  assert.equal(described.armed, false);

  let blockedBy = "";
  try {
    const decision = await service.decide({ proposal: fixture.proposal("auto-unarmed"), policyId: saved.policy.policyId }, "codex");
    await service.execute(decision.decisionId, { operationId: randomUUID(), actor: "synthetic-operator" });
  } catch (error) {
    blockedBy = code(error);
  }
  assert.equal(blockedBy, "AUTOMATION_NOT_ARMED", "an enabled installation must still refuse to dispatch before it is armed");
  assert.equal(fixture.store.get("auto-unarmed"), undefined);
  const plans = fixture.row<{ total: number }>("SELECT COUNT(*) AS total FROM collaboration_plans");
  assert.equal(Number(plans?.total ?? 0), 0);
  fixture.close();
});

test("no source file implements the preauthorized policy layer", () => {
  const offenders = sourceFiles(srcRoot).filter((file) => /preauthorized_policy/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((file) => path.relative(repoRoot, file)), [], "the second layer may exist only in design text until the user changes the rule");
});

test("the decision record exists and states which layer is in force", () => {
  assert.ok(fs.existsSync(adrPath), "ADR-01 must be committed alongside the code it governs");
  const text = fs.readFileSync(adrPath, "utf8");
  for (const heading of ["## 2. 决定：两层，只有一层生效", "## 3. 授权记录 schema（草案，未接线）", "## 5. 发行范围声明", "## 7. 要启用第二层，需要用户做的决定"]) {
    assert.ok(text.includes(heading), `ADR-01 is missing "${heading}"`);
  }
  assert.match(text, /`per_task_confirmed` \| \*\*唯一生效模式\*\*/);
  assert.match(text, /`preauthorized_policy` \| \*\*提案，未启用\*\*/);
  // The release statement must not shrink the product to make the missing layer look finished.
  assert.match(text, /产品保留资源查看、用量统计、模型推荐、自动模式四块能力/);
});
