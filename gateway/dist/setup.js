import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { loadDotEnv, PROJECT_ROOT } from "./env.js";
import { discoverDesktopPaths, supportedNode } from "./deployment-paths.js";
import { checkNativeSchema } from "./doctor.js";
import { assertTaskRecordsStopped } from "./deployment-safety.js";
const SKILL_FILES = ["SKILL.md", "agents/openai.yaml", "references/setup.md", "references/execution.md", "references/dispatch.md", "references/agent-hub.md"];
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function atomicWrite(filename, bytes) {
    const temp = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        fs.renameSync(temp, filename);
    }
    finally {
        if (fs.existsSync(temp))
            fs.unlinkSync(temp);
    }
}
function regularAncestors(filename) {
    for (let current = path.resolve(filename);; current = path.dirname(current)) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
            throw new Error("Refusing a linked installation path.");
        if (current === path.dirname(current))
            break;
    }
}
function treeHashes(directory) {
    const result = {};
    function visit(dir) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const filename = path.join(dir, item.name);
            if (item.isSymbolicLink())
                throw new Error("Refusing a linked skill entry.");
            if (item.isDirectory())
                visit(filename);
            else if (item.isFile())
                result[path.relative(directory, filename).replaceAll("\\", "/")] = digest(fs.readFileSync(filename));
            else
                throw new Error("Skill contains a non-regular entry.");
        }
    }
    regularAncestors(directory);
    visit(directory);
    return result;
}
function sameHashes(a, b) {
    return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, hash]) => b[name] === hash);
}
function quote(value) { return JSON.stringify(value.replaceAll("\\", "/")); }
function envLine(key, value) {
    if (/[\r\n\0"]/u.test(value))
        throw new Error("Configuration values cannot contain control characters or double quotes.");
    return `${key}="${value.replaceAll("\\", "/")}"`;
}
export function assertInstallationIdle(root, dbFile, runsDir = path.join(path.dirname(dbFile), "runs"), serviceFile = path.join(root, "data", "persistent-service.json")) {
    if (fs.existsSync(serviceFile) || fs.existsSync(path.join(root, "data", "persistent-service.json")))
        throw new Error("A persistent service is registered. Verify its tasks are stopped and uninstall that service before changing this installation.");
    assertTaskRecordsStopped(dbFile, runsDir);
}
function installedManifest(file, root) {
    if (!fs.existsSync(file))
        return;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || data.root !== root || !path.isAbsolute(data.codexHome) || data.skillRoot !== path.join(data.codexHome, "skills", "workbuddy-executor"))
        throw new Error("Installation manifest does not match this installation.");
    if (data.skillBackup && (!path.resolve(data.skillBackup).startsWith(path.join(data.codexHome, "skill-backups") + path.sep) || !path.isAbsolute(data.skillBackup)))
        throw new Error("Invalid skill backup path.");
    return data;
}
export function setup(action, options = {}) {
    const root = path.resolve(options.root ?? PROJECT_ROOT), env = { ...(options.env ?? process.env) };
    const codexHome = path.resolve(options.codexHome ?? env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
    const localData = path.join(root, "data"), manifestFile = path.join(localData, "deployment-installation.json"), snippetFile = path.join(localData, "workbuddy-mcp.toml");
    regularAncestors(root);
    regularAncestors(codexHome);
    regularAncestors(localData);
    regularAncestors(manifestFile);
    regularAncestors(snippetFile);
    const installed = installedManifest(manifestFile, root);
    const envFile = path.join(root, ".env");
    const dbFile = path.resolve(root, env.WORKBUDDY_DB_FILE ?? "data/tasks.sqlite");
    const runsDir = env.WORKBUDDY_RUNS_DIR ? path.resolve(root, env.WORKBUDDY_RUNS_DIR) : path.join(path.dirname(dbFile), "runs");
    const serviceFile = path.resolve(root, env.WORKBUDDY_SERVICE_CONFIG ?? "data/persistent-service.json");
    if (action === "uninstall") {
        if (!installed)
            return { ok: true, action, installed: false, changed: false };
        const skillRoot = installed.skillRoot;
        regularAncestors(skillRoot);
        const skillExists = fs.existsSync(skillRoot), snippetExists = fs.existsSync(snippetFile);
        if (skillExists && !sameHashes(treeHashes(skillRoot), installed.skillFiles))
            throw new Error("Installed skill has local changes; uninstall preserved it. Resolve those changes first.");
        if (snippetExists && digest(fs.readFileSync(snippetFile)) !== installed.snippetHash)
            throw new Error("Generated MCP snippet has local changes; uninstall preserved it.");
        if (installed.skillBackup) {
            regularAncestors(installed.skillBackup);
            treeHashes(path.join(installed.skillBackup, "workbuddy-executor"));
        }
        const result = { ok: true, action, changed: Boolean(options.apply), taskDataPreserved: true, envPreserved: true, mcpConfigModified: false, previousSkillRestored: Boolean(options.apply && installed.skillBackup), previousSkillWillBeRestored: Boolean(installed.skillBackup), next: "Remove only the MCP entry pointing at this installation after confirming its tasks and processes are stopped." };
        if (!options.apply)
            return result;
        assertInstallationIdle(root, dbFile, runsDir, serviceFile);
        const lock = path.join(localData, "setup-in-progress.json");
        fs.writeFileSync(lock, JSON.stringify({ action, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
        try {
            if (skillExists)
                fs.rmSync(skillRoot, { recursive: true });
            if (installed.skillBackup)
                fs.renameSync(path.join(installed.skillBackup, "workbuddy-executor"), skillRoot);
            if (snippetExists)
                fs.unlinkSync(snippetFile);
            fs.unlinkSync(manifestFile);
        }
        finally {
            fs.unlinkSync(lock);
        }
        return result;
    }
    if (!supportedNode())
        throw new Error("Node.js >=22.13.0 is required.");
    if ((options.platform ?? process.platform) !== "win32")
        throw new Error("This setup release supports Windows only; other platforms are not verified.");
    if (options.workbuddyApp)
        env.WORKBUDDY_CLI_ELECTRON = options.workbuddyApp;
    if (options.workbuddyConfig)
        env.WORKBUDDY_CONFIG_DIR = options.workbuddyConfig;
    const detected = discoverDesktopPaths({ env, platform: options.platform });
    if (!detected.executable.value || !path.isAbsolute(detected.executable.value) || !fs.statSync(detected.executable.value).isFile())
        throw new Error("Select an existing WorkBuddy executable with --workbuddy-app; missing or ambiguous installations are not guessed.");
    if (!detected.config.value || !path.isAbsolute(detected.config.value) || !checkNativeSchema(detected.config.value))
        throw new Error("Select a compatible WorkBuddy data directory with --workbuddy-config; open WorkBuddy once first.");
    const app = detected.executable.value, configDir = detected.config.value;
    if (env.WORKBUDDY_BACKEND && env.WORKBUDDY_BACKEND !== "desktop-queue")
        throw new Error("Existing backend conflicts; resolve it explicitly. Setup never weakens it.");
    let freeModel = env.WORKBUDDY_REQUIRED_FREE_MODEL || undefined;
    if (freeModel && (freeModel.length > 200 || /[\r\n]/.test(freeModel)))
        throw new Error("Invalid explicit free-model restriction.");
    if (!fs.existsSync(path.join(root, "dist", "server.js")))
        throw new Error("Build the gateway before installation.");
    const envText = [envLine("WORKBUDDY_BACKEND", "desktop-queue"), envLine("WORKBUDDY_NODE_BIN", process.execPath), envLine("WORKBUDDY_CLI_ELECTRON", app), envLine("WORKBUDDY_CONFIG_DIR", configDir), ...(freeModel ? [envLine("WORKBUDDY_REQUIRED_FREE_MODEL", freeModel)] : []), "WORKBUDDY_MAX_TASK_ATTEMPTS=3", ""].join("\n");
    if (fs.existsSync(envFile)) {
        // Existing .env is never rewritten, including when only a policy is missing.
        const existing = {};
        for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
            const m = line.trim().match(/^([A-Z_]+)=(.*)$/);
            if (m)
                existing[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
        if (existing.WORKBUDDY_BACKEND !== "desktop-queue")
            throw new Error("Existing .env was preserved. Explicitly resolve the backend before retrying.");
        if (freeModel && existing.WORKBUDDY_REQUIRED_FREE_MODEL !== freeModel)
            throw new Error("Existing .env was preserved. Explicitly resolve the free-model policy conflict before retrying.");
        freeModel = existing.WORKBUDDY_REQUIRED_FREE_MODEL || undefined;
        for (const [key, value] of [["WORKBUDDY_CLI_ELECTRON", app], ["WORKBUDDY_CONFIG_DIR", configDir]]) {
            if (existing[key] && path.resolve(existing[key]) !== path.resolve(value))
                throw new Error("Existing .env path conflicts with selected deployment; edit it explicitly before retrying.");
        }
    }
    const snippet = `[mcp_servers.workbuddy]\ncommand = ${quote(process.execPath)}\nargs = [${quote(path.join(root, "dist", "server.js"))}]\ncwd = ${quote(root)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n\n[mcp_servers.workbuddy.env]\nWORKBUDDY_BACKEND = "desktop-queue"\nWORKBUDDY_NODE_BIN = ${quote(process.execPath)}\n${freeModel ? `WORKBUDDY_REQUIRED_FREE_MODEL = ${quote(freeModel)}\n` : ""}WORKBUDDY_CLI_ELECTRON = ${quote(app)}\nWORKBUDDY_CONFIG_DIR = ${quote(configDir)}\n`;
    const skillRoot = path.join(codexHome, "skills", "workbuddy-executor"), source = path.join(root, "skills", "workbuddy-executor");
    const hashes = Object.fromEntries(SKILL_FILES.map(name => { const filename = path.join(source, name); regularAncestors(filename); return [name, digest(fs.readFileSync(filename))]; }));
    regularAncestors(skillRoot);
    if (installed && (installed.codexHome !== codexHome || installed.skillRoot !== skillRoot))
        throw new Error("Use the original CODEX_HOME to upgrade or uninstall; migration is not an in-place install.");
    if (!installed && fs.existsSync(snippetFile))
        throw new Error("An unmanaged MCP snippet exists; it was preserved. Move or reconcile it before installation.");
    if (installed && fs.existsSync(skillRoot) && !sameHashes(treeHashes(skillRoot), installed.skillFiles))
        throw new Error("Skill has local changes; preserve and resolve them before upgrading.");
    if (installed && fs.existsSync(snippetFile) && digest(fs.readFileSync(snippetFile)) !== installed.snippetHash)
        throw new Error("MCP snippet has local changes; preserve and resolve them before upgrading.");
    const unchanged = Boolean(installed && fs.existsSync(envFile) && fs.existsSync(skillRoot) && fs.existsSync(snippetFile) && sameHashes(hashes, installed.skillFiles) && digest(snippet) === installed.snippetHash);
    const result = { ok: true, action, changed: !unchanged && Boolean(options.apply) && action !== "plan", unchanged, application: app, configDirectory: configDir, codexHome, mcpSnippet: snippetFile, envWillBeCreated: !fs.existsSync(envFile), mcpConfigModified: false, taskSent: false, next: "Review data/workbuddy-mcp.toml and add the workbuddy entry to Codex. Existing MCP configuration is never overwritten." };
    if (!options.apply || action === "plan" || unchanged)
        return result;
    if (installed && action === "install")
        throw new Error("An installation exists with changed sources; use upgrade --apply.");
    if (!installed && action === "upgrade")
        throw new Error("No managed installation found; use install --apply first.");
    if (env.WORKBUDDY_SERVICE_CONFIG && path.resolve(root, env.WORKBUDDY_SERVICE_CONFIG) !== path.join(localData, "persistent-service.json")) {
        if (fs.existsSync(path.resolve(root, env.WORKBUDDY_SERVICE_CONFIG)))
            throw new Error("An external persistent service is registered; stop and verify it before installation changes.");
    }
    assertInstallationIdle(root, dbFile, runsDir, serviceFile);
    fs.mkdirSync(localData, { recursive: true, mode: 0o700 });
    const lock = path.join(localData, "setup-in-progress.json");
    fs.writeFileSync(lock, JSON.stringify({ action, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    let createdEnv = false, skillBackup, installedSkill = false;
    const previousSnippet = fs.existsSync(snippetFile) ? fs.readFileSync(snippetFile) : undefined;
    try {
        if (!fs.existsSync(envFile)) {
            fs.writeFileSync(envFile, envText, { flag: "wx", mode: 0o600 });
            createdEnv = true;
        }
        const output = execFileSync(process.execPath, [path.join(root, "scripts", "install-skill.mjs")], { env: { ...process.env, CODEX_HOME: codexHome }, encoding: "utf8", windowsHide: true, timeout: 30000 });
        const skillResult = JSON.parse(output);
        skillBackup = skillResult.backup;
        installedSkill = skillResult.unchanged !== true;
        atomicWrite(snippetFile, snippet);
        const manifest = { version: 1, root, codexHome, skillRoot, skillBackup: installed ? installed.skillBackup : skillBackup, skillFiles: hashes, snippetHash: digest(snippet), envCreated: installed?.envCreated ?? createdEnv, installedAt: new Date().toISOString() };
        atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
        fs.unlinkSync(lock);
        return result;
    }
    catch (error) {
        if (installedSkill) {
            if (fs.existsSync(skillRoot))
                fs.rmSync(skillRoot, { recursive: true });
            if (skillBackup)
                fs.renameSync(path.join(skillBackup, "workbuddy-executor"), skillRoot);
        }
        if (previousSnippet)
            fs.writeFileSync(snippetFile, previousSnippet);
        else if (fs.existsSync(snippetFile))
            fs.unlinkSync(snippetFile);
        if (createdEnv && fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8") === envText)
            fs.unlinkSync(envFile);
        fs.unlinkSync(lock);
        throw error;
    }
}
export async function runSetup(args = process.argv.slice(2)) {
    const parsed = parseArgs({ args, allowPositionals: true, options: { apply: { type: "boolean" }, "codex-home": { type: "string" }, "workbuddy-app": { type: "string" }, "workbuddy-config": { type: "string" } } });
    const action = parsed.positionals[0] ?? "plan";
    if (!["plan", "install", "upgrade", "uninstall"].includes(action) || parsed.positionals.length > 1)
        throw new Error("Usage: node scripts/setup.mjs plan|install|upgrade|uninstall [--apply] [--workbuddy-app PATH] [--workbuddy-config PATH] [--codex-home PATH]");
    loadDotEnv();
    console.log(JSON.stringify(setup(action, { apply: parsed.values.apply, codexHome: parsed.values["codex-home"], workbuddyApp: parsed.values["workbuddy-app"], workbuddyConfig: parsed.values["workbuddy-config"] }), null, 2));
}
//# sourceMappingURL=setup.js.map