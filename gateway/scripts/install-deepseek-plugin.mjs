#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { privateDirectory } from "../deepseek-plugin/transport.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
function option(name, fallback) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return fallback;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
const profile = option("--profile", "desktop");
const appOption = option("--app", process.platform === "darwin" ? "/Applications/DeepSeek Harness.app" : undefined);
if (!appOption) throw new Error("Pass --app with the existing Harness installation directory");
const application = path.resolve(appOption);
if (!new Set(["desktop", "web"]).has(profile)) throw new Error("Supported profiles: desktop, web");
if (!["darwin", "win32"].includes(process.platform)) throw new Error("Use the existing Harness desktop installation on Windows or macOS");
const binary = process.platform === "win32" ? path.join(application, "DeepSeek Harness.exe") : path.join(application, "Contents/MacOS/DeepSeek Harness");
const cli = process.platform === "win32" ? path.join(application, "resources/app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js") : path.join(application, "Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js");
if (!fs.existsSync(binary) || (process.platform === "win32" && !fs.existsSync(cli))) throw new Error("The selected installation lacks its supported bundled CLI; no profile was changed");
const plugin = path.resolve(option("--package", path.join(root, "deepseek-plugin")));
if (!fs.existsSync(plugin)) throw new Error("The bridge package does not exist");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "deepseek-plugin/package.json"), "utf8"));
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
const version = spawnSync(binary, ["--expose-internals", cli, "--version"], { env, encoding: "utf8", windowsHide: true });
if (version.status !== 0) throw new Error(`Cannot run the selected App's CLI: ${version.stderr || version.error?.message}`);
const supported = ["0.2.0-rc.2", "0.2.1-rc.2"];
if (!supported.includes(version.stdout.trim())) throw new Error("The existing Harness CLI version is not supported; no profile was changed");

const harnessHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
const profileDirectory = path.join(harnessHome, "profiles", profile);
const profileManifest = path.join(profileDirectory, "package.json");
if (!fs.existsSync(profileManifest)) throw new Error("Open the selected Harness profile once before installing its bridge");
const backup = path.join(harnessHome, "codex-bridge", "backups", `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
await privateDirectory(path.join(harnessHome, "codex-bridge"));
await privateDirectory(backup);
for (const filename of ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"]) {
  const source = path.join(profileDirectory, filename);
  if (fs.existsSync(source)) fs.writeFileSync(path.join(backup, filename), fs.readFileSync(source), { flag: "wx", mode: 0o600 });
}
const installation = spawnSync(binary, ["--expose-internals", cli, "plugin", "--profile", profile, "add", "--ignore-scripts", "--config.auto-install-peers=false", plugin], {
  env, cwd: root, stdio: "inherit", windowsHide: true,
});
if (installation.status !== 0) throw new Error(`Harness plugin install failed; previous profile files are backed up at ${backup}`);

// The native CLI owns the profile write lock and reconciles bundle activation.
// Read its committed result; never race its lock with a separate manifest edit.
const configured = JSON.parse(fs.readFileSync(profileManifest, "utf8"));
if (!Array.isArray(configured.dsh?.profile?.bundles)) throw new Error(`Profile has no bundle list; inspect the profile and backup at ${backup}`);
if (!configured.dsh.profile.bundles.includes(manifest.name)) {
  throw new Error(`The native installer did not activate ${manifest.name}. Enable the installed bundle in Harness Plugin Manager; existing profile configuration was not overwritten. Backup: ${backup}`);
}
console.log(JSON.stringify({ installed: true, profile, version: version.stdout.trim(), plugin: manifest.name, backup, next: "Reload this Harness profile while idle, then check deepseek_health." }));
