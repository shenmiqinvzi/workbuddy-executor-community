import assert from "node:assert/strict";
import test from "node:test";
import { desktopCommandHandler } from "../scripts/workbench-desktop-commands.mjs";
import { validateProjectTemplate, type ProjectTemplate } from "../src/project-template.js";

const NOW = new Date("2026-11-07T09:00:00.000Z");

function templateInput(): Record<string, unknown> {
  return {
    name: "front-end copy fix",
    description: "a synthetic template",
    kind: "manual",
    project: {
      titleTemplate: "rewrite one heading",
      objectiveTemplate: "Split the sample page heading into two lines.",
      scope: { allowedChanges: ["src/app.ts"], permittedMetadata: ["package.json"] },
      requiredChecks: [{ id: "typecheck", kind: "command", definition: "npm run typecheck" }],
      timeoutSeconds: 900,
      maxAttempts: 2,
    },
    selectionSuggestion: { executorId: "dsh", connectionId: "conn-1", providerId: "prov-1", modelId: "model-a", reasoningEffort: "medium" },
  };
}

function built(): ProjectTemplate {
  const result = validateProjectTemplate(templateInput(), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.template;
}

/** A session that reports one stored policy row, exactly like the host does. */
function handler(template: ProjectTemplate | null, maxTimeoutSeconds = 300) {
  const session = { catalog: async () => ({ policy: { maxAttempts: 3, maxTimeoutSeconds } }) };
  const productivity = { sources: { templates: { versions: () => (template ? [template] : []) } } };
  return desktopCommandHandler(session as never, null, null, null, null, productivity as never);
}

type Draft = { draft: { contract: { timeoutSeconds: number }; budget: { timeout: { clamped: boolean } } } };

test("template instantiation reads the deadline ceiling from the stored policy, not the request", async () => {
  const template = built();
  const draft = await (handler(template))("productivity_template_instantiate", { templateId: template.templateId, workspaceId: "ws-1" }) as Draft;
  assert.equal(draft.draft.contract.timeoutSeconds, 300, "a 900-second preset is clamped to the 300-second policy");
  assert.equal(draft.draft.budget.timeout.clamped, true);
});

test("a template preset below the policy is kept as written", async () => {
  const template = built();
  const draft = await (handler(template, 1200))("productivity_template_instantiate", { templateId: template.templateId, workspaceId: "ws-1" }) as Draft;
  assert.equal(draft.draft.contract.timeoutSeconds, 900);
});

test("an unknown template identity is refused instead of inventing a draft", async () => {
  await assert.rejects(() => (handler(null))("productivity_template_instantiate", { templateId: "tmpl-unknown-0001", workspaceId: "ws-1" }),
    (error: { code?: string }) => error.code === "TEMPLATE_NOT_FOUND");
});

test("the request cannot carry its own deadline or policy override", async () => {
  const template = built();
  await assert.rejects(() => (handler(template))("productivity_template_instantiate", {
    templateId: template.templateId, workspaceId: "ws-1", policyMaxTimeoutSeconds: 86_400, timeoutSeconds: 86_400,
  }));
});

test("a malformed workspace or template identity is refused before any read", async () => {
  const template = built();
  await assert.rejects(() => (handler(template))("productivity_template_instantiate", { templateId: "not-a-template", workspaceId: "ws-1" }));
  await assert.rejects(() => (handler(template))("productivity_template_instantiate", { templateId: template.templateId, workspaceId: "" }));
});
