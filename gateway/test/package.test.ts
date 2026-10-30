import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { readZip } from "./support/read-zip.mjs";
import { collectReleaseFiles, createPackage, createSkillPackage } from "../scripts/package.mjs";
import { createDesktopPackage } from "../scripts/package-desktop.mjs";


async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-package-test-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  const files: Record<string, string> = {
    "README.md": "# Fixture\n",
    ".env.example": "WORKBUDDY_BACKEND=desktop-acp\nWORKBUDDY_GATEWAY_PASSWORD=\n",
    ".gitignore": "data/\n.env\n",
    "package.json": JSON.stringify({ name: "codex-workbuddy-gateway", version: "0.2.0" }),
    "package-lock.json": "{}\n",
    "tsconfig.json": "{}\n",
    "src/server.ts": "export {};\n",
    "src/persistent-service.ts": "export {};\n",
    "src/service-cli.ts": "export {};\n",
    "src/native-desktop-trigger.ts": "export {};\n",
    "dist/server.js": "export {};\n",
    "dist/desktop-worker-cli.js": "export {};\n",
    "dist/persistent-service.js": "export {};\n",
    "dist/service-cli.js": "export {};\n",
    "dist/native-desktop-trigger.js": "export {};\n",
    "bin/workbuddy-gateway": "#!/bin/sh\nexit 0\n",
    "bin/workbuddy-worker": "#!/bin/sh\nexit 0\n",
    "bin/workbuddy-service": "#!/bin/sh\nexit 0\n",
    "docs/QUEUE_WORKER.md": "# Queue\n",
    "docs/USER_ACCEPTANCE.md": "# Pending\n",
    "docs/CODEX_WORKFLOW.md": "# Supervision\n",
    "docs/native-stop-verification.json": '{"scope":"Synthetic public validation fixture"}\n',
    "scripts/bounded-job.ps1": "# owned job runner fixture\n",
    "scripts/package.mjs": "// Fixture packaging source\n",
    "scripts/install-skill.mjs": "// Fixture installer\n",
    "scripts/agent-hub-call.mjs": "// Hub MCP client\n",
    "skills/workbuddy-executor/SKILL.md": "---\nname: workbuddy-executor\ndescription: Delegate to desktop WorkBuddy.\n---\n# Skill\n",
    "skills/workbuddy-executor/agents/openai.yaml": "interface:\n  display_name: WorkBuddy\n",
    "skills/workbuddy-executor/references/execution.md": "# Execution\n",
    "skills/workbuddy-executor/references/dispatch.md": "# Dispatch\n",
    "skills/workbuddy-executor/references/setup.md": "# Setup\n",
    "skills/workbuddy-executor/references/agent-hub.md": "# Hub\n",
    "skills/workbuddy-executor/private-log.md": "private task history\n",
    "skills/unrelated/SKILL.md": "unrelated personal skill\n",
    "bin/deepseek-gateway": "#!/bin/sh\nexit 0\n",
    "docs/DEEPSEEK.md": "# Harness bridge\n",
    "scripts/install-deepseek-skill.mjs": "// Skill installer\n",
    "scripts/install-deepseek-plugin.mjs": "// Native plugin installer\n",
    "scripts/deepseek-call.mjs": "// Real MCP client\n",
    "skills/deepseek-executor/SKILL.md": "---\nname: deepseek-executor\ndescription: Delegate to Harness.\n---\n# Skill\n",
    "skills/deepseek-executor/references/setup.md": "# Setup\n",
    "skills/deepseek-executor/private-log.md": "private history\n",
    "deepseek-plugin/private-registration.json": "private connection data\n",
    ".env": "private configuration\n",
    "data/tasks.sqlite": "private database\n",
    "data/runs/run.json": "private execution events\n",
    "data/persistent-service.json": "private worker session registration\n",
    "data/persistent-service-status.json": "private daemon heartbeat\n",
    "data/service-logs/stdout.log": "private daemon logs\n",
    "docs/private-log.md": "private notes\n",
    "src/private.log": "private log\n",
    "outputs/old.zip": "private archive\n",
    "node_modules/private/index.js": "private dependency\n",
  };
  for (const name of ["server", "client", "store", "coordinator", "evidence"]) {
    files[`src/deepseek-${name}.ts`] = "export {};\n";
    files[`dist/deepseek-${name}.js`] = "export {};\n";
  }
  for (const name of ["operation-recovery", "recovery-console", "recovery-cli", "run-evidence"]) { files[`src/${name}.ts`] = "export {};\n"; files[`dist/${name}.js`] = "export {};\n"; }
  files["bin/workbuddy-recovery.cmd"] = "@echo off\n"; files["docs/OPERATION_RECOVERY.md"] = "Recovery guide\n";
  files["src/workspace-protection.ts"] = "export {};\n"; files["dist/workspace-protection.js"] = "export {};\n"; files["dist/workspace-protection.d.ts"] = "export {};\n";
  files["scripts/dsh-host-check.mjs"] = "// isolated host verification fixture\n";
  for (const name of ["dsh-bindings", "dsh-client", "dsh-coordinator", "dsh-runtime", "dsh-rate-verifier", "dsh-inspect"]) { files[`src/${name}.ts`] = "export {};\n"; files[`dist/${name}.js`] = "export {};\n"; files[`dist/${name}.d.ts`] = "export {};\n"; }
  for (const name of ["desktop-dispatch", "desktop-dispatch-journal", "desktop-dispatch-runtime"]) { files[`src/${name}.ts`] = "export {};\n"; files[`dist/${name}.js`] = "export {};\n"; files[`dist/${name}.d.ts`] = "export {};\n"; }
  for (const name of ["contracts", "store", "workbuddy", "engine", "http", "client", "ui", "cli", "mcp"]) {
    files[`src/platform/${name}.ts`] = "export {};\n";
    files[`dist/platform/${name}.js`] = "export {};\n";
    files[`dist/platform/${name}.d.ts`] = "export {};\n";
  }
  for (const name of ["bin/agent-hub", "bin/agent-hub-mcp", "docs/AGENT_HUB.md", "docs/AGENT_HUB_DESIGN.md"]) files[name] = "fixture\n";
  files["data/platform/api-token"] = "private platform token fixture\n";
  for(const name of ["WINDOWS_ENV.example","RESTORE.md","scripts/zip.mjs","scripts/verify-release.mjs","scripts/setup.mjs","scripts/doctor.mjs","scripts/deployment-check.mjs","scripts/workbuddy-inspect.mjs","bin/workbuddy-gateway.cmd","docs/INSTALL_WINDOWS.md","docs/DEPLOYMENT_ACCEPTANCE.md","test/support/typescript-loader.mjs","test/support/read-zip.mjs","test/support/selected-model-client.ts",
    ...["deployment-paths","deployment-safety","deployment-acceptance","setup","doctor","inspect-task"].flatMap(name=>[`src/${name}.ts`,`dist/${name}.js`])])files[name]="fixture\n";
  files["dist/platform/client.d.ts"] = "export {};\n";
  for (const name of ["index.mjs", "adapter.mjs", "events.mjs", "transport.mjs", "private-path.mjs", "private-path.d.mts", "package.json", "cordis.patch.yml", "README.md", "test/adapter.test.mjs", "test/events.test.mjs", "test/transport.test.mjs"]) files[`deepseek-plugin/${name}`] = "fixture\n";
  for (const name of ["index.html", "style.css", "app.mjs", "model.mjs", "task-link.mjs", "dispatch.mjs", "dispatch.css", "http-source.mjs", "demo-source.mjs", "fonts/plex-sans.woff2", "fonts/plex-mono.woff2", "fonts/ibmplexsans-OFL.txt", "fonts/ibmplexmono-OFL.txt"]) files[`workbench/${name}`] = "synthetic workbench asset\n";
  for (const name of ["workbench-assets", "workbench-panel"]) for (const suffix of ["src/", "dist/"]) files[`${suffix}${name}.${suffix === "src/" ? "ts" : "js"}`] = "export {};\n";
  for (const name of ["WorkBuddy.Workbench.csproj","Program.cs","DesktopPolicy.cs","DesktopCommands.cs","DesktopControlPolicy.cs","app.manifest","workbench.ico","packages.lock.json","WEBVIEW2-LICENSE.txt","test/PolicyTests.csproj","test/Program.cs"]) files[`desktop/${name}`] = "synthetic desktop source fixture\n";
  for (const name of ["build-desktop", "open-workbench", "workbench-desktop-host", "workbench-desktop-commands", "workbench-dispatch-worker", "workbench-read-store", "package-desktop"]) files[`scripts/${name}.mjs`] = "export {};\n";
  files["desktop/app/private.dll"] = "must not enter the source gateway archive";
  files["workbench/private-notes.mjs"] = "private notes that must not ship\n";
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(source, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { root, source, output };
}

test("release archive uses a file allowlist and hashes every included file", async () => {
  const value = await fixture();
  try {
    const selected = await collectReleaseFiles(value.source);
    assert.ok(selected.includes("docs/native-stop-verification.json"), "the public validation summary linked by the install guide belongs in the archive");
    assert.ok(selected.includes("src/server.ts"));
    for (const name of ["bin/workbuddy-recovery.cmd", "docs/OPERATION_RECOVERY.md", "dist/operation-recovery.js", "dist/recovery-cli.js"]) assert.ok(selected.includes(name), name);
    for(const name of ["WINDOWS_ENV.example","scripts/setup.mjs","scripts/doctor.mjs","scripts/deployment-check.mjs","scripts/zip.mjs","bin/workbuddy-gateway.cmd","docs/INSTALL_WINDOWS.md","docs/DEPLOYMENT_ACCEPTANCE.md"])assert.ok(selected.includes(name),name);
    assert.ok(selected.includes(".env.example"));
    assert.ok(selected.includes("docs/CODEX_WORKFLOW.md"));
    assert.ok(selected.includes("bin/workbuddy-worker"));
    assert.ok(selected.includes("dist/desktop-worker-cli.js"));
    for (const filename of ["bin/workbuddy-service", "dist/persistent-service.js", "dist/service-cli.js", "dist/native-desktop-trigger.js"]) assert.ok(selected.includes(filename));
    assert.ok(selected.includes("docs/QUEUE_WORKER.md"));
    for (const name of ["bin/agent-hub", "bin/agent-hub-mcp", "docs/AGENT_HUB.md", "src/platform/engine.ts", "dist/platform/cli.js", "dist/platform/ui.js"]) assert.ok(selected.includes(name), name);
    assert.ok(!selected.some((name: string) => /^(?:data|outputs|node_modules)\//.test(name)));
    assert.ok(!selected.includes(".env"));
    for (const file of ["workbench/index.html", "workbench/fonts/plex-sans.woff2", "workbench/fonts/ibmplexsans-OFL.txt", "dist/workbench-assets.js", "dist/workbench-panel.js"]) assert.ok(selected.includes(file), file);
    assert.ok(!selected.includes("workbench/private-notes.mjs"));
    assert.ok(!selected.includes("desktop/app/private.dll"));
    assert.ok(selected.includes("scripts/workbench-read-store.mjs"));
    assert.ok(selected.includes("desktop/packages.lock.json"));
    assert.ok(!selected.includes("docs/private-log.md"));
    assert.ok(!selected.includes("src/private.log"));
    assert.ok(selected.includes("skills/workbuddy-executor/SKILL.md"));
    assert.ok(!selected.includes("skills/workbuddy-executor/private-log.md"));
    assert.ok(!selected.includes("skills/unrelated/SKILL.md"));

    const result = await createPackage(value.source, value.output, "0.2.0");
    const listing = [...(await readZip(result.archive)).keys()];
    const prefix = "codex-workbuddy-gateway-v0.2.0/";
    const files = listing.filter((name) => name && !name.endsWith("/")).map((name) => name.slice(prefix.length));
    assert.deepEqual(files.sort(), [...selected, "RELEASE_MANIFEST.json"].sort());
    const manifest = JSON.parse(await fs.readFile(result.manifest, "utf8"));
    assert.equal(manifest.videoAcceptance, "pending_user_verification");
    for (const entry of manifest.files) {
      const bytes = await fs.readFile(path.join(value.source, entry.path));
      assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
      assert.equal(entry.bytes, bytes.length);
    }
    const digest = crypto.createHash("sha256").update(await fs.readFile(result.archive)).digest("hex");
    assert.equal(result.sha256, digest);
    assert.equal(await fs.readFile(result.checksum, "utf8"), `${digest}  ${path.basename(result.archive)}\n`);
    await assert.rejects(createPackage(value.source, value.output, "0.2.0"), /overwrite/);
    assert.ok((await fs.stat(result.archive)).size > 0);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release collection requires the persistent service wrapper and complete native runtime", async () => {
  const value = await fixture();
  try {
    for (const relative of ["bin/workbuddy-service", "dist/persistent-service.js", "dist/service-cli.js", "dist/native-desktop-trigger.js"]) {
      const filename = path.join(value.source, relative);
      const content = await fs.readFile(filename);
      await fs.rm(filename);
      await assert.rejects(collectReleaseFiles(value.source), new RegExp(`Missing release file ${relative.replaceAll(".", "\\.")}`));
      await fs.writeFile(filename, content);
    }
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("standalone skill archive contains only the portable instruction files", async () => {
  const value = await fixture();
  try {
    const result = await createSkillPackage(value.source, value.output, "0.3.1");
    const listing = [...(await readZip(result.archive)).keys()];
    assert.deepEqual(listing.sort(), ["workbuddy-executor/SKILL.md", "workbuddy-executor/agents/openai.yaml", "workbuddy-executor/references/setup.md", "workbuddy-executor/references/agent-hub.md", "workbuddy-executor/references/execution.md", "workbuddy-executor/references/dispatch.md"].sort());
    assert.equal(result.sha256, crypto.createHash("sha256").update(await fs.readFile(result.archive)).digest("hex"));
    await assert.rejects(createSkillPackage(value.source, value.output, "0.3.1"), /overwrite/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("complete release includes every Harness component but excludes private plugin files", async () => {
  const value = await fixture();
  try {
    const selected = await collectReleaseFiles(value.source);
    for (const name of ["bin/deepseek-gateway", "src/deepseek-evidence.ts", "dist/deepseek-server.js", "scripts/install-deepseek-plugin.mjs", "scripts/deepseek-call.mjs", "skills/deepseek-executor/SKILL.md", "docs/DEEPSEEK.md", "deepseek-plugin/index.mjs", "deepseek-plugin/test/adapter.test.mjs"]) assert.ok(selected.includes(name), name);
    assert.ok(!selected.includes("deepseek-plugin/private-registration.json"));
    assert.ok(!selected.includes("skills/deepseek-executor/private-log.md"));
    await fs.rm(path.join(value.source, "deepseek-plugin/adapter.mjs"));
    await assert.rejects(collectReleaseFiles(value.source), /Missing release file deepseek-plugin\/adapter.mjs/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("standalone Harness skill archive includes instructions only and refuses unknown skills", async () => {
  const value = await fixture();
  try {
    const result = await createSkillPackage(value.source, value.output, "0.5.0", "deepseek-executor");
    const names = [...(await readZip(result.archive)).keys()];
    assert.deepEqual(names.sort(), ["deepseek-executor/SKILL.md", "deepseek-executor/references/setup.md"].sort());
    assert.equal(result.files, 2);
    assert.equal(result.sha256, crypto.createHash("sha256").update(await fs.readFile(result.archive)).digest("hex"));
    await assert.rejects(createSkillPackage(value.source, value.output, "0.5.0", "unrelated"), /Unknown distributable skill/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release collection rejects symlinks so files cannot escape the allowlist", async () => {
  const value = await fixture();
  try {
    await fs.symlink(path.join(value.source, ".env"), path.join(value.source, "src", "leak.ts"));
    await assert.rejects(collectReleaseFiles(value.source), /symbolic link/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release refuses a populated example secret and removes partial output", async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.source, ".env.example"), "WORKBUDDY_GATEWAY_PASSWORD=private-value\n");
    await assert.rejects(createPackage(value.source, value.output, "0.2.0"), /Nonempty secret/);
    assert.deepEqual(await fs.readdir(value.output), []);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("release refuses token-like content in an allowed source file", async () => {
  const value = await fixture();
  try {
    const token = ["ghp", "x".repeat(30)].join("_");
    await fs.writeFile(path.join(value.source, "src/server.ts"), `export const example = "${token}";\n`);
    await assert.rejects(createPackage(value.source, value.output, "0.2.0"), /Possible access token/);
    assert.deepEqual(await fs.readdir(value.output), []);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("desktop ZIP includes only fixed native artifacts and omits profiles and unlisted DLLs", async () => {
  const value = await fixture();
  try {
    for (const name of ["WorkBuddy.Workbench.exe", "WorkBuddy.Workbench.dll", "WorkBuddy.Workbench.deps.json", "WorkBuddy.Workbench.runtimeconfig.json", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "runtimes/win-x64/native/WebView2Loader.dll", "WEBVIEW2-LICENSE.txt", "profile/private-cookie.txt", "private.dll"]) {
      const target = path.join(value.source, "desktop/app", name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "synthetic artifact");
    }
    const result = await createDesktopPackage(value.source, value.output, "0.0.0-test");
    const zip = await readZip(result.archive);
    const names = [...zip.keys()];
    assert.ok(names.some(name => name.endsWith("/gateway/desktop/app/WorkBuddy.Workbench.exe")));
    assert.ok(names.some(name => name.endsWith("/gateway/desktop/app/WEBVIEW2-LICENSE.txt")));
    assert.ok(!names.some(name => /private-cookie|private\.dll|\/\.env$/.test(name)));
    const manifest = JSON.parse(zip.get(names.find(name => name.endsWith("/RELEASE_MANIFEST.json"))!)!.toString());
    for (const entry of manifest.files) {
      const data = zip.get("workbuddy-desktop-v0.0.0-test/" + entry.path)!;
      assert.equal(crypto.createHash("sha256").update(data).digest("hex"), entry.sha256);
    }
    await assert.rejects(createDesktopPackage(value.source, value.output, "0.0.0-test"), /replace/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});
