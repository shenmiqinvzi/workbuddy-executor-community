import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { ProcessTableUnavailableError, windowsProcessTable, windowsPowerShellPath } from "../src/native-process.js";

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

test("a failed process inspection is retried a bounded number of times, then fails by name instead of falling back to no processes", () => {
  let calls = 0;
  const run = (() => { calls++; throw Object.assign(new Error("EBUSY fixture"), { code: "EBUSY" }); }) as typeof execFileSync;
  assert.throws(
    () => windowsProcessTable(run, { attempts: 3, backoffMs: 0 }),
    (error: unknown) => error instanceof ProcessTableUnavailableError
      && /could not be read after 3 attempts/.test(error.message)
      && /nothing was assumed about any process/.test(error.message),
  );
  // Three attempts, and the failure is never turned into an empty table: an
  // unreadable process table is not the same fact as "no process is running".
  assert.equal(calls, 3);
});

test("a transient WMI failure is absorbed by the retry instead of aborting the operation", () => {
  let calls = 0;
  const run = (() => {
    calls += 1;
    // WMI answers 0x80004005 (an unspecified error) under contention.
    if (calls < 3) throw new Error("Get-CimInstance : 未指定的错误 HRESULT 0x80004005");
    return JSON.stringify([{ ProcessId: 321, ParentProcessId: 12, ExecutablePath: "C:\\WorkBuddy.exe" }]);
  }) as typeof execFileSync;
  const rows = windowsProcessTable(run, { attempts: 3, backoffMs: 0 });
  assert.deepEqual(rows, [{ pid: 321, ppid: 12, exe: "C:\\WorkBuddy.exe", commandLine: undefined }]);
  assert.equal(calls, 3);
});

test("hidden Windows process inspection preserves Chinese executable paths with a legacy console encoding", { skip: process.platform !== "win32" }, () => {
  const executable = "C:\\Users\\测试用户\\AppData\\Local\\Programs\\WorkBuddyAI\\WorkBuddyAI.exe";
  const query = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 3";
  const fixture = JSON.stringify([{ ProcessId: 42420, ParentProcessId: 1, ExecutablePath: executable, CommandLine: `\"${executable}\"` }]);
  const run = ((file: string, args: string[], options: object) => {
    const commandIndex = args.indexOf("-Command") + 1;
    assert.ok(commandIndex > 0);
    assert.ok(args[commandIndex]!.includes(query));
    const synthetic = args[commandIndex]!.replace(query, `Write-Output '${fixture.replaceAll("'", "''")}'`);
    const actualArgs = [...args];
    actualArgs[commandIndex] = "[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); " + synthetic;
    return execFileSync(file, actualArgs, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  }) as typeof execFileSync;
  const rows = windowsProcessTable(run);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exe, executable);
  assert.equal(rows[0]!.commandLine, `\"${executable}\"`);
});
