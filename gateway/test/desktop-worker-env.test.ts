import test from "node:test";
import assert from "node:assert/strict";
import { withWorkerEnv, workerEnvPrefix } from "../src/desktop-queue.js";
import type { Config } from "../src/config.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    dbFile: "D:\\state\\run-03\\workbuddy.db",
    runsDir: "D:\\state\\run-03\\runs",
    cliElectronPath: "C:\\Program Files\\工作区\\WorkBuddyAI.exe",
    workbuddyConfigDir: "D:\\state\\workbuddy-config",
    ...overrides,
  } as Config;
}

test("the generated worker command pins its own configuration", () => {
  const prefix = workerEnvPrefix(config());
  assert.equal(prefix, "WORKBUDDY_CLI_ELECTRON='C:/Program Files/工作区/WorkBuddyAI.exe' WORKBUDDY_CONFIG_DIR='D:/state/workbuddy-config' WORKBUDDY_DB_FILE='D:/state/run-03/workbuddy.db' WORKBUDDY_RUNS_DIR='D:/state/run-03/runs' ");
  // A Windows path with a quote inside stays shell-safe.
  assert.equal(workerEnvPrefix(config({ dbFile: "E:\\we'ird\\db.sqlite" as never })), "WORKBUDDY_CLI_ELECTRON='C:/Program Files/工作区/WorkBuddyAI.exe' WORKBUDDY_CONFIG_DIR='D:/state/workbuddy-config' WORKBUDDY_DB_FILE='E:/we'\\''ird/db.sqlite' WORKBUDDY_RUNS_DIR='D:/state/run-03/runs' ");
});

test("the pinned configuration is applied to the command, never to the directory change", () => {
  const prefix = workerEnvPrefix(config());
  const claim = withWorkerEnv("cd 'E:/work/run-03' && 'F:/node.exe' 'E:/gateway/dist/desktop-worker-cli.js'", prefix);
  assert.ok(claim.startsWith("cd 'E:/work/run-03' && WORKBUDDY_CLI_ELECTRON="), claim);
  assert.ok(claim.endsWith("'E:/gateway/dist/desktop-worker-cli.js'"), claim);
  assert.ok(claim.includes("WORKBUDDY_DB_FILE='D:/state/run-03/workbuddy.db'"), claim);
});

test("a command without a directory change still receives the pinned configuration", () => {
  const prefix = workerEnvPrefix(config());
  assert.equal(withWorkerEnv("'F:/node.exe' 'helper.js'", prefix), `${prefix}'F:/node.exe' 'helper.js'`);
});

test("the runs directory is always pinned, falling back to the resolved default", () => {
  const prefix = workerEnvPrefix(config({ runsDir: undefined }));
  const pinned = /WORKBUDDY_RUNS_DIR='([^']+)'/.exec(prefix);
  assert.ok(pinned, prefix);
  assert.ok(pinned![1]!.length > 0, prefix);
  assert.ok(prefix.includes("WORKBUDDY_DB_FILE="), prefix);
});
