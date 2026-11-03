import assert from "node:assert/strict";
import test from "node:test";
import { installAutostartIfNeeded } from "../src/workspace-manager.js";

// The auto-start entry is a convenience, not part of the dispatch effect
// boundary. A login-item or profile failure must stay a reported limitation:
// an already prepared native session may not be turned into an unknown outcome.

test("an existing registration is reused without touching the login item", () => {
  let called = 0;
  const result = installAutostartIfNeeded({ version: 1 }, () => { called += 1; });
  assert.deepEqual(result, { installed: false, reused: true });
  assert.equal(called, 0);
});

test("a successful installation is reported as installed", () => {
  let called = 0;
  const result = installAutostartIfNeeded(undefined, () => { called += 1; });
  assert.deepEqual(result, { installed: true, reused: false });
  assert.equal(called, 1);
});

test("a refused login-item write is reported, not thrown", () => {
  const refusal = Object.assign(new Error("EPERM: operation not permitted, open 'C:\\Startup\\service.vbs'"), { code: "EPERM" });
  const result = installAutostartIfNeeded(undefined, () => { throw refusal; });
  assert.equal(result.installed, false);
  assert.equal(result.reused, false);
  assert.match(result.error ?? "", /^EPERM: /);
  assert.match(result.error ?? "", /service\.vbs/);
});

test("a non-errno failure still yields a bounded reason", () => {
  const result = installAutostartIfNeeded(undefined, () => { throw new Error("scheduled task registration failed"); });
  assert.equal(result.installed, false);
  assert.match(result.error ?? "", /scheduled task registration failed/);
});
