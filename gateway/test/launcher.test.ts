import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// bin/workbuddy-* are #!/bin/sh launchers executed with chmod 0755 and a
// PATH without node: Windows has neither a shebang interpreter for an
// extensionless file nor POSIX execute bits.
const posixLaunchers = process.platform === "win32"
  ? "POSIX-only: bin/workbuddy-* are #!/bin/sh launchers run with chmod 0755 and PATH=/usr/bin:/bin. Run on Linux or macOS."
  : false;

// A shebang line is an interpreter only up to the newline, so a CR there turns
// "#!/bin/sh" into "/bin/sh\r" and exec fails ENOENT; the same CR also survives
// into every value the launchers source from .env. The bytes are identical in
// every checkout, so this guard runs on Windows too instead of only where the
// launchers can execute.
test("shipped POSIX entry points and the sourced example config use LF line endings", async () => {
  const entries = [
    ".env.example",
    ...(await fs.readdir(path.join(source, "bin"))).filter(name => !name.endsWith(".cmd")).map(name => `bin/${name}`),
    ...(await fs.readdir(path.join(source, "scripts"))).filter(name => name.endsWith(".mjs")).map(name => `scripts/${name}`),
  ];
  for (const entry of entries) {
    const bytes = await fs.readFile(path.join(source, entry));
    const carriage = bytes.indexOf(0x0d);
    assert.equal(carriage, -1, `${entry} must keep LF line endings; found a CR at byte ${carriage}`);
  }
});

test("all Node launchers load the shipped example config even without node on desktop PATH", { skip: posixLaunchers }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-launcher-"));
  const root = path.join(temporary, "fresh install with spaces");
  try {
    await fs.mkdir(path.join(root, "bin"), { recursive: true });
    await fs.mkdir(path.join(root, "dist"));
    const nodePath = path.join(temporary, "node with spaces");
    await fs.symlink(process.execPath, nodePath);
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(path.join(root, ".env"), (await fs.readFile(path.join(source, ".env.example"), "utf8")) + `\nWORKBUDDY_NODE_BIN=${quote(nodePath)}\n`);
    for (const [launcher, script] of [["gateway", "server"], ["worker", "desktop-worker-cli"], ["doctor", "doctor"], ["service", "service-cli"]]) {
      const filename = path.join(root, "bin", `workbuddy-${launcher}`);
      await fs.copyFile(path.join(source, "bin", `workbuddy-${launcher}`), filename);
      await fs.chmod(filename, 0o755);
      await fs.writeFile(path.join(root, "dist", `${script}.js`), "console.log(JSON.stringify({backend:process.env.WORKBUDDY_BACKEND,scopes:process.env.WORKBUDDY_OAUTH_SCOPES,cwd:process.cwd(),args:process.argv.slice(2)}));\n");
      const args = launcher === "worker" ? ["claim", "--session-id", "test-session"] : launcher === "service" ? ["status", "--config", path.join(root, "data", "persistent-service.json")] : [];
      const result = await execute(filename, args, { cwd: temporary, env: { PATH: "/usr/bin:/bin" } });
      const actual = JSON.parse(result.stdout);
      assert.equal(actual.backend, "desktop-queue");
      assert.equal(actual.scopes, "user.localassistant.invokable user.localassistant.readable");
      assert.equal(actual.cwd, await fs.realpath(root));
      assert.deepEqual(actual.args, args);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
