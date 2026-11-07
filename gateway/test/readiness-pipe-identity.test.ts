import assert from "node:assert/strict";
import test from "node:test";
import { desktopInstanceKey, desktopWindowPaths } from "../src/readiness.js";

// The launcher passes the gateway directory without a trailing separator; the module root
// carries one. Both describe the same install, so both have to reach the same window pipe.
test("a trailing separator does not change the desktop window identity", () => {
  const base = {
    gatewayDir: "C:\\installs\\gateway",
    database: "C:\\installs\\gateway\\data\\tasks.sqlite",
    runsDir: "C:\\installs\\gateway\\data\\runs",
  };
  const withTrailing = { ...base, gatewayDir: "C:\\installs\\gateway\\" };
  assert.equal(desktopInstanceKey(withTrailing), desktopInstanceKey(base));
  assert.equal(desktopInstanceKey({ ...base, runsDir: "C:\\installs\\gateway\\data\\runs\\" }), desktopInstanceKey(base));
});

// Mixed separators and case are the same install on Windows.
test("separators and case do not split one install into two windows", () => {
  assert.equal(
    desktopInstanceKey({ gatewayDir: "C:/installs/Gateway", database: "c:\\installs\\GATEWAY\\data\\tasks.sqlite", runsDir: "C:\\installs\\gateway\\data\\runs" }),
    desktopInstanceKey({ gatewayDir: "C:\\installs\\gateway\\", database: "C:\\installs\\gateway\\data\\tasks.sqlite", runsDir: "C:\\installs\\gateway\\data\\runs" }),
  );
});

// Two different installs must still be distinguishable, otherwise one window would answer for another.
test("different installs keep different identities", () => {
  const a = desktopInstanceKey({ gatewayDir: "C:\\a\\gateway", database: "C:\\a\\gateway\\data\\tasks.sqlite", runsDir: "C:\\a\\gateway\\data\\runs" });
  const b = desktopInstanceKey({ gatewayDir: "C:\\b\\gateway", database: "C:\\b\\gateway\\data\\tasks.sqlite", runsDir: "C:\\b\\gateway\\data\\runs" });
  assert.notEqual(a, b);
  const differentDatabase = desktopInstanceKey({ gatewayDir: "C:\\a\\gateway", database: "C:\\elsewhere\\tasks.sqlite", runsDir: "C:\\a\\gateway\\data\\runs" });
  assert.notEqual(a, differentDatabase);
});

// The window paths carry the identity through to the pipe name the shell actually creates.
test("the window path keeps the normalised gateway directory", () => {
  const config = { dbFile: "C:\\installs\\gateway\\data\\tasks.sqlite" } as never;
  const paths = desktopWindowPaths(config, "C:\\installs\\gateway\\");
  assert.equal(paths.gatewayDir.endsWith("\\"), false);
  assert.equal(paths.pipeName, `WorkBuddy.Workbench.${desktopInstanceKey(paths)}`);
});
