import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { windowsStartupScript } from "../src/service-cli.js";

test("Windows Startup script has a UTF-16LE BOM and preserves non-ASCII paths", () => {
  const projectDir = path.resolve("fixture", "中文 用户", "gateway");
  const nodeBin = path.resolve("Program Files", "nodejs", "node.exe");
  const configFile = path.join(projectDir, "data", "persistent-service.json");
  const bytes = windowsStartupScript(projectDir, nodeBin, configFile);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  const text = bytes.subarray(2).toString("utf16le");
  assert.equal(text.split("\r\n")[1], `shell.CurrentDirectory = "${projectDir}"`);
  assert.equal(text.includes("\ufffd"), false);
  assert.equal(text.split("\r\n").filter(Boolean).length, 3);
  assert.match(text, /, 0, False\r\n$/);
});

test("Windows Startup encoding leaves the existing quoted invocation unchanged", () => {
  const projectDir = path.resolve("fixture", '中文 "quoted"', "gateway");
  const nodeBin = path.resolve("Program Files", "nodejs", "node.exe");
  const configFile = path.join(projectDir, "data", "persistent-service.json");
  const text = windowsStartupScript(projectDir, nodeBin, configFile).subarray(2).toString("utf16le");
  const lines = text.split("\r\n");
  assert.equal(lines[0], 'Set shell = CreateObject("WScript.Shell")');
  assert.equal(lines[1], `shell.CurrentDirectory = "${projectDir.replaceAll('"', '""')}"`);
  const command = `"${nodeBin}" "${path.join(projectDir, "dist", "service-cli.js")}" run --config "${configFile}"`;
  assert.equal(lines[2], `shell.Run "${command.replaceAll('"', '""')}", 0, False`);
});
