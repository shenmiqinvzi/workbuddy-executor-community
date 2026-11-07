import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativeDesktopRpcTrigger, type NativeDesktopProcessControl } from "../src/native-desktop-trigger.js";
import { readOnlyWorkbuddyCatalog } from "../src/read-only-catalog.js";
import { readOnlyCatalogReaders } from "../src/desktop-dispatch-runtime.js";
import type { Config } from "../src/config.js";

/**
 * R1 — the observation-only catalog read.
 *
 * An unarmed `evaluate` (and the workbench probe) must be able to look at the model catalog without
 * starting WorkBuddy, without restarting a running one to enable its port, and without writing the
 * renderer bridge. These cases drive the real trigger with a substituted process table: the
 * substitute records every command, so "nothing was launched" is an observed fact, not a claim.
 */
function fixture(t: { after(fn: () => void): void }): { root: string; config: Config } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-readonly-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    backend: "desktop-queue",
    dbFile: path.join(root, "tasks.db"),
    runsDir: path.join(root, "runs"),
    workbuddyConfigDir: path.join(root, "workbuddy"),
    cliElectronPath: path.join(root, "WorkBuddyAI.exe"),
    serviceConfigFile: path.join(root, "persistent-service.json"),
    maxTaskAttempts: 3,
  } as unknown as Config;
  return { root, config };
}

interface Recording {
  commands: string[];
  launched: string[];
  control: NativeDesktopProcessControl;
}

function recording(options: { listeners?: string; executable?: string } = {}): Recording {
  const commands: string[] = [];
  const launched: string[] = [];
  const control: NativeDesktopProcessControl = {
    run: (file) => {
      commands.push(file);
      if (file === "netstat") return options.listeners ?? "";
      if (file === "powershell") return options.executable ?? "";
      return "";
    },
    launch: (executable) => { launched.push(executable); },
    pause: async () => undefined,
  };
  return { commands, launched, control };
}

test("R1 a missing native port refuses the read instead of launching WorkBuddy", async (t) => {
  const { config } = fixture(t);
  const recorder = recording();

  await assert.rejects(
    readOnlyWorkbuddyCatalog(config, { createObserver: (bound, port) => new NativeDesktopRpcTrigger(bound, port, false, recorder.control) }),
    /Native desktop is offline/,
  );

  assert.deepEqual(recorder.launched, [], "no launch was attempted");
  assert.ok(!recorder.commands.includes("taskkill"), `no quit was attempted: ${recorder.commands.join(",")}`);
  assert.ok(!recorder.commands.includes("powershell") || recorder.commands.length === 1, "the read only asked the port table");
});

test("R1 a port that is up is inspected without launching, quitting or writing the bridge", async (t) => {
  const { config } = fixture(t);
  const port = 18491;
  const recorder = recording({
    listeners: `  TCP    127.0.0.1:${port}      0.0.0.0:0      LISTENING       4242`,
    executable: config.cliElectronPath,
  });

  await assert.rejects(
    readOnlyWorkbuddyCatalog(config, { createObserver: (bound, cdpPort) => new NativeDesktopRpcTrigger(bound, cdpPort, false, recorder.control) }),
    (error: unknown) => {
      // The port belongs to this app, so the read gets as far as the renderer and stops there: no
      // WebSocket is opened against a closed port, and nothing is reconfigured.
      assert.ok(!/Native desktop is offline/.test(String((error as Error).message)), String((error as Error).message));
      return true;
    },
  );

  assert.deepEqual(recorder.launched, []);
  assert.ok(!recorder.commands.includes("taskkill"));
});

test("R1 an existing bridge is read and the observer is always closed", async (t) => {
  const { config } = fixture(t);
  const observed: string[] = [];
  const models = await readOnlyWorkbuddyCatalog(config, {
    createObserver: () => ({
      diagnoseReadOnly: async () => { observed.push("diagnoseReadOnly"); return { bridgeReady: true, models: [{ id: "synthetic-model", credits: "x0.00" }] }; },
      close: () => { observed.push("close"); },
    }),
  });

  assert.deepEqual(models.models, [{ id: "synthetic-model", credits: "x0.00" }]);
  assert.deepEqual(observed, ["diagnoseReadOnly", "close"], "the read used the diagnosis entry and closed the observer");
});

test("R1 an absent bridge is reported as unavailable instead of being prepared", async (t) => {
  const { config } = fixture(t);
  const observed: string[] = [];
  await assert.rejects(
    readOnlyWorkbuddyCatalog(config, {
      createObserver: () => ({
        diagnoseReadOnly: async () => { observed.push("diagnoseReadOnly"); return { bridgeReady: false }; },
        close: () => { observed.push("close"); },
      }),
    }),
    /bridge is not ready/,
  );
  assert.deepEqual(observed, ["diagnoseReadOnly", "close"]);
});

test("R1 the observation-only readers are the ones the unarmed entry points use", async (t) => {
  fixture(t);
  assert.equal(readOnlyCatalogReaders().workbuddy, readOnlyWorkbuddyCatalog, "the read-only reader set does not fall back to the launching one");
  const root = path.resolve(import.meta.dirname, "..");
  const cli = fs.readFileSync(path.join(root, "src/automation-cli.ts"), "utf8");
  const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
  for (const [name, source] of [["automation-cli.ts", cli], ["server.ts", server]] as const) {
    assert.match(source, /readOnlyCatalogReaders\(\)/, `${name} must read the catalog through the read-only reader set`);
    assert.ok(!/desktopModelCatalog\(config, process\.env\)/.test(source), `${name} must not call desktopModelCatalog with the launching default readers`);
  }
});
