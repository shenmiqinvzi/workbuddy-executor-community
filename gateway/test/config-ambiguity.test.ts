import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverDesktopPaths, runningWorkBuddyExecutables } from "../src/deployment-paths.js";
import { ambiguityMessage } from "../src/config.js";

/**
 * Two WorkBuddy layouts on one machine is a real state, not a preference. The
 * service refuses instead of picking one, but the refusal has to be usable: it
 * must name what it found and the exact variable that resolves it, and it must
 * not promise a guess or a rollback it does not perform.
 */
function home(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-ambiguity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("two detected data directories are reported as ambiguous, never as a choice", t => {
  const root = home(t);
  for (const name of [".workbuddy-ai", ".workbuddy"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "workbuddy.db"), "");
  }
  const desktop = discoverDesktopPaths({ env: {}, home: root, platform: "win32", runningExecutables: () => [] });
  assert.equal(desktop.config.source, "ambiguous");
  assert.equal(desktop.executable.source, "missing", "a missing executable is distinct from an ambiguous one");
  assert.deepEqual([...desktop.config.candidates].sort(), [path.join(root, ".workbuddy"), path.join(root, ".workbuddy-ai")].sort());
});

test("one detected data directory is detected, and an explicit variable wins over discovery", t => {
  const root = home(t);
  fs.mkdirSync(path.join(root, ".workbuddy-ai"), { recursive: true });
  fs.writeFileSync(path.join(root, ".workbuddy-ai", "workbuddy.db"), "");
  const single = discoverDesktopPaths({ env: {}, home: root, platform: "win32", runningExecutables: () => [] });
  assert.equal(single.config.source, "detected");
  assert.equal(single.config.value, path.join(root, ".workbuddy-ai"));
  const explicit = discoverDesktopPaths({ env: { WORKBUDDY_CONFIG_DIR: path.join(root, "chosen") }, home: root, platform: "win32", runningExecutables: () => [] });
  assert.equal(explicit.config.source, "environment");
  assert.equal(explicit.config.value, path.join(root, "chosen"));
  assert.deepEqual(explicit.config.candidates, []);
});

test("the ambiguity refusal names every candidate and the variable that resolves it", t => {
  const root = home(t);
  for (const name of [".workbuddy-ai", ".workbuddy"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "workbuddy.db"), "");
  }
  const desktop = discoverDesktopPaths({ env: {}, home: root, platform: "win32", runningExecutables: () => [] });
  const message = ambiguityMessage(desktop);
  for (const candidate of desktop.config.candidates) assert.ok(message.includes(candidate), `the message names ${candidate}`);
  assert.match(message, /WORKBUDDY_CONFIG_DIR/);
  assert.match(message, /WORKBUDDY_CLI_ELECTRON/);
  assert.match(message, /不会替你挑选/, "the refusal is explicit that no directory is chosen for the user");
  assert.match(message, /不会回退/, "the refusal does not promise a silent fallback");
});

test("an ambiguous executable alone is enough to refuse, and the message stays about the executable", () => {
  const message = ambiguityMessage({
    executable: { source: "ambiguous", candidates: ["C:\\A\\WorkBuddy.exe", "C:\\B\\WorkBuddyAI.exe"] },
    config: { source: "detected", value: "C:\\Users\\example\\.workbuddy-ai", candidates: ["C:\\Users\\example\\.workbuddy-ai"] },
  });
  assert.match(message, /C:\\A\\WorkBuddy\.exe/);
  assert.match(message, /C:\\B\\WorkBuddyAI\.exe/);
  assert.doesNotMatch(message, /配置目录候选/, "a detected config directory is not reported as a conflict");
});

/**
 * F-DEPLOY-1: readiness reported `executable: missing` on a machine where the
 * app was installed under a non-ASCII directory and running. Hidden Windows
 * PowerShell writes its output in the system legacy code page, so decoding it
 * as UTF-8 turned `新建文件夹 (2)` into replacement characters; the discovered
 * path then failed the is-a-file check and the executable was reported absent.
 * A path that cannot be read is not the same finding as an app that is absent.
 */
test("a non-ASCII install path is discovered, not reported as a missing executable", t => {
  const root = home(t);
  const install = path.join(root, "新建文件夹 (2)", "WorkBuddy");
  fs.mkdirSync(install, { recursive: true });
  const exe = path.join(install, "WorkBuddyAI.exe");
  fs.writeFileSync(exe, "");
  const desktop = discoverDesktopPaths({ env: {}, home: root, platform: "win32", runningExecutables: () => [exe] });
  assert.equal(desktop.executable.source, "detected");
  assert.equal(desktop.executable.value, exe);
});

test("every executable the process query reports is a real file, never a mangled path", { skip: process.platform !== "win32" }, () => {
  const discovered = runningWorkBuddyExecutables();
  for (const file of discovered) {
    assert.ok(path.isAbsolute(file), `a discovered path must be absolute: ${file}`);
    assert.doesNotMatch(file, /\uFFFD/, `a discovered path must survive decoding: ${file}`);
    assert.ok(fs.statSync(file).isFile(), `a discovered executable must exist: ${file}`);
  }
});
