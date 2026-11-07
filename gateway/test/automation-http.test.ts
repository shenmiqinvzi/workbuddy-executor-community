import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { workbenchHealth, WorkbenchHttpServer } from "../src/workbench-http.js";
import { automationPaths } from "../src/automation-http.js";
import { automationFixture } from "./support/automation-fixture.js";

const operator = { actor: "synthetic-operator", source: "user:synthetic-operator" };

function request(port: number, options: { method?: string; path: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: { host: `127.0.0.1:${port}` } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function start(t: { after(fn: () => void): void }, fixture: ReturnType<typeof automationFixture>, withAutomation = true, automation?: ReturnType<typeof automationFixture>["service"]["automation"]) {
  const server = new WorkbenchHttpServer({
    service: fixture.service,
    ...(withAutomation ? { automation: automation ?? fixture.service.automation } : {}),
    health: () => workbenchHealth({ runtime: { release: "test", packageVersion: "0.0.0", startedAt: "2026-11-05T00:00:00.000Z" } }),
  });
  const port = await server.listen(0);
  t.after(async () => { await server.close(); });
  return port;
}

const json = (body: string) => JSON.parse(body) as Record<string, unknown>;

test("the automation projection is readable and read-only", async (t) => {
  const fixture = automationFixture(t);
  const saved = fixture.savePolicy(fixture.automation());
  const port = await start(t, fixture);

  const root = await request(port, { path: "/workbench/v1/automation" });
  assert.equal(root.status, 200);
  const body = json(root.body);
  assert.equal(body.httpWrites, false);
  assert.equal(body.writeEntry, "local_cli_only");
  assert.equal(body.armed, false);
  assert.equal(body.enabled, false);
  assert.equal(body.snapshotOnly, true);
  assert.equal((body.policies as unknown[]).length, 1);

  const policies = await request(port, { path: "/workbench/v1/automation/policies" });
  assert.equal(policies.status, 200);
  assert.equal(((json(policies.body).policies as unknown[])[0] as { policy: { policyId: string } }).policy.policyId, saved.policy.policyId);

  const detail = await request(port, { path: `/workbench/v1/automation/policies/${encodeURIComponent(saved.policy.policyId)}` });
  assert.equal(detail.status, 200);
  const record = json(detail.body);
  assert.equal(record.status, "active");
  assert.equal((record.revisions as unknown[]).length, 1);
  assert.equal((record.policy as { authorizationSource: string }).authorizationSource, "user:synthetic-operator");
  fixture.close();
});

test("unknown policy and decision identifiers are not fabricated", async (t) => {
  const fixture = automationFixture(t);
  const port = await start(t, fixture);
  const policy = await request(port, { path: "/workbench/v1/automation/policies/policy-missing" });
  assert.equal(policy.status, 404);
  assert.equal((json(policy.body).error as { code: string }).code, "POLICY_MISSING");
  const decision = await request(port, { path: "/workbench/v1/automation/decisions/decision-missing" });
  assert.equal(decision.status, 404);
  assert.equal((json(decision.body).error as { code: string }).code, "DECISION_NOT_FOUND");
  fixture.close();
});

test("recorded decisions and their audit trail are visible without dispatching", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation({ probe: () => fixture.probe() });
  const saved = fixture.savePolicy(service);
  const decision = await service.decide({ proposal: fixture.proposal("auto-http"), policyId: saved.policy.policyId }, "codex");
  const port = await start(t, fixture);

  const decisions = await request(port, { path: "/workbench/v1/automation/decisions" });
  assert.equal(decisions.status, 200);
  assert.equal(((json(decisions.body).decisions as unknown[])[0] as { decisionId: string }).decisionId, decision.decisionId);

  const detail = await request(port, { path: `/workbench/v1/automation/decisions/${encodeURIComponent(decision.decisionId)}` });
  assert.equal(detail.status, 200);
  const stored = json(detail.body).decision as { status: string; operationId: string | null };
  assert.equal(stored.status, "pending");
  assert.equal(stored.operationId, null);

  const audit = await request(port, { path: "/workbench/v1/automation/audit" });
  assert.equal(audit.status, 200);
  assert.ok((json(audit.body).audit as Array<{ action: string }>).some((entry) => entry.action === "decision_pending"));
  assert.equal(fixture.store.listTasks().length, 0);
  fixture.close();
});

test("every automation route refuses a write with 405, not 404", async (t) => {
  const fixture = automationFixture(t);
  fixture.savePolicy(fixture.automation());
  const port = await start(t, fixture);
  for (const path of automationPaths()) {
    const concrete = path.replace(":policyId", "policy-synthetic").replace(":decisionId", "decision-synthetic");
    const response = await request(port, { method: "POST", path: concrete });
    assert.equal(response.status, 405, `${concrete} must not accept a write`);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
  const rejected = await request(port, { method: "DELETE", path: "/workbench/v1/automation/policies" });
  assert.equal(rejected.status, 405);
  fixture.close();
});

test("without the option the automation routes do not exist", async (t) => {
  const fixture = automationFixture(t);
  fixture.savePolicy(fixture.automation());
  const port = await start(t, fixture, false);
  const response = await request(port, { path: "/workbench/v1/automation" });
  assert.equal(response.status, 404);
  const post = await request(port, { method: "POST", path: "/workbench/v1/automation" });
  assert.equal(post.status, 405);
  fixture.close();
});

test("revoking a policy is visible as a status, not an error", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation();
  const saved = fixture.savePolicy(service);
  service.revokePolicy(saved.policy.policyId, saved.policy.revision, "Synthetic withdrawal", operator);
  const port = await start(t, fixture);
  const detail = await request(port, { path: `/workbench/v1/automation/policies/${encodeURIComponent(saved.policy.policyId)}` });
  assert.equal(detail.status, 200);
  assert.equal(json(detail.body).status, "revoked");
  assert.equal((json(detail.body).policy as { revocationReason: string }).revocationReason, "Synthetic withdrawal");
  fixture.close();
});

test("the read page receives the layers, the observation time and the requesting identity, and nothing else", async (t) => {
  const fixture = automationFixture(t);
  const service = fixture.automation({ probe: () => fixture.probe(), probeKind: "read_only_local" });
  const saved = fixture.savePolicy(service);
  const decision = await service.decide({ proposal: fixture.proposal("auto-http-page"), policyId: saved.policy.policyId }, "synthetic-operator");
  const port = await start(t, fixture, true, service);

  const root = json((await request(port, { path: "/workbench/v1/automation" })).body);
  assert.equal(root.readOnly, true);
  assert.equal(root.probeKind, "read_only_local");
  const layers = root.layers as Record<string, { layer: string }>;
  assert.deepEqual(Object.values(layers).map((entry) => entry.layer), [
    "installation_enabled", "process_armed", "policy_authorization", "per_task_selection", "recorded_decision", "actual_dispatch",
  ]);

  const rows = (root.decisions as Array<{ decisionId: string; requestedBy: string | null; probeObservedAt: string | null; probe: unknown }>);
  const row = rows.find((item) => item.decisionId === decision.decisionId);
  assert.ok(row, "the decision is part of the read projection");
  assert.equal(row!.requestedBy, "synthetic-operator");
  assert.equal(row!.probeObservedAt, fixture.probe().observedAt);
  assert.ok(row!.probe, "the page can show which observation the decision used");

  // The projection never carries the task body or a credential.
  const serialised = JSON.stringify(root);
  assert.equal(serialised.includes(fixture.proposal().objective), false, "the objective text is not published");
  assert.equal(serialised.includes("\"credentials\":"), false);
  fixture.close();
});
