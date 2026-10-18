import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { windowsProcessTable, windowsPowerShellPath } from "../src/native-process.js";

test("Windows ancestry uses the absolute OS PowerShell, never PATH or a shell shim", () => {
  let calls = 0;
  const run = ((file: string, args: string[], options: { windowsHide?: boolean; timeout?: number }) => {
    calls++;
    assert.equal(file, windowsPowerShellPath());
    assert.equal(path.win32.isAbsolute(file), true);
    assert.match(file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    assert.ok(args.includes("-NonInteractive"));
    assert.ok(args.includes("-NoProfile"));
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 30_000);
    return JSON.stringify([{ ProcessId: 123, ParentProcessId: 45, ExecutablePath: "C:\\WorkBuddy.exe" }, { ProcessId: -1 }]);
  }) as typeof execFileSync;
  assert.deepEqual(windowsProcessTable(run), [{ pid: 123, ppid: 45, exe: "C:\\WorkBuddy.exe", commandLine: undefined }]);
  assert.equal(calls, 1);
});

test("failed ancestry inspection propagates the error without an unsafe fallback or retry loop", () => {
  let calls = 0;
  const run = (() => { calls++; throw Object.assign(new Error("EBUSY fixture"), { code: "EBUSY" }); }) as typeof execFileSync;
  assert.throws(() => windowsProcessTable(run), /EBUSY/);
  assert.equal(calls, 1);
});
