import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoverDesktopPaths, supportedNode, type DiscoveryOptions } from "./deployment-paths.js";
import { loadDotEnv, PROJECT_ROOT } from "./env.js";
import { loadConfig, type Config } from "./config.js";
import { runtimeVersion } from "./runtime-version.js";

export const APPROVED_FREE_MODEL = "deepseek-v4.1-flash";
export function checkNativeSchema(directory: string | undefined): boolean {
  if (!directory) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(directory, "workbuddy.db"), { readOnly: true });
    const columns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map(row => row.name));
    return ["id", "cwd", "is_playground", "deleted_at"].every(name => columns.has(name));
  } catch { return false; } finally { db?.close(); }
}
function existsFile(filename?: string) { try { return Boolean(filename && fs.statSync(filename).isFile()); } catch { return false; } }
export async function diagnose(options: DiscoveryOptions & { root?: string; live?: boolean; port?: number; probe?: () => Promise<{ bridgeReady: boolean; models?: Array<{id:string;credits?:unknown}> }> } = {}) {
  const root = options.root ?? PROJECT_ROOT, env = options.env ?? process.env;
  const discovery = discoverDesktopPaths(options);
  const checks = {
    nodeSupported: supportedNode(), platformSupported: (options.platform ?? process.platform) === "win32",
    buildPresent: existsFile(path.join(root, "dist", "server.js")),
    applicationPresent: existsFile(discovery.executable.value),
    configSchemaCompatible: checkNativeSchema(discovery.config.value),
    desktopRoute: (env.WORKBUDDY_BACKEND ?? "desktop-queue") === "desktop-queue",
    freePolicyEnabled: env.WORKBUDDY_REQUIRED_FREE_MODEL === APPROVED_FREE_MODEL,
  };
  const localSetupReady = Object.values(checks).every(Boolean);
  const nextSteps: string[] = [];
  if (!checks.nodeSupported) nextSteps.push("Install Node.js >=22.13.0.");
  if (!checks.platformSupported) nextSteps.push("This community deployment release targets Windows; other platforms are not verified.");
  if (!checks.buildPresent) nextSteps.push("Run npm ci and npm run build in the gateway directory.");
  if (!checks.applicationPresent) nextSteps.push("Install/open WorkBuddy, or set WORKBUDDY_CLI_ELECTRON to its absolute executable path.");
  if (!checks.configSchemaCompatible) nextSteps.push("Open WorkBuddy once; set WORKBUDDY_CONFIG_DIR to its data directory. The sessions schema must be compatible.");
  if (!checks.desktopRoute || !checks.freePolicyEnabled) nextSteps.push("Use setup plan/install; preserve existing .env and explicitly resolve backend/free-model conflicts.");
  let connection: "not_checked" | "unavailable" | "bridge_missing" | "verified" = "not_checked";
  let modelPolicy: "not_checked" | "unknown" | "verified" | "blocked" = "not_checked";
  if (options.live && localSetupReady) {
    connection = "unavailable"; modelPolicy = "unknown";
    try {
      const probe = options.probe ?? (async () => {
        const { NativeDesktopRpcTrigger } = await import("./native-desktop-trigger.js");
        const config: Config = { ...loadConfig(), cliElectronPath: discovery.executable.value!, workbuddyConfigDir: discovery.config.value! };
        let port = options.port ?? 18491;
        if (!options.port && config.serviceConfigFile && fs.existsSync(config.serviceConfigFile)) {
          const registration = JSON.parse(fs.readFileSync(config.serviceConfigFile, "utf8"));
          if (Number.isInteger(registration.cdpPort)) port = registration.cdpPort;
        }
        const observer = new NativeDesktopRpcTrigger(config, port, false);
        try { return await observer.diagnoseReadOnly(); } finally { observer.close(); }
      });
      const result = await probe();
      connection = result.bridgeReady ? "verified" : "bridge_missing";
      const selected = result.models?.find(model => model.id === APPROVED_FREE_MODEL);
      if (result.bridgeReady) modelPolicy = selected && /^x0(?:\.0+)?(?: credits)?$/i.test(String(selected.credits ?? "").trim()) ? "verified" : selected?.credits === undefined && selected ? "unknown" : "blocked";
    } catch { /* Never print private native errors, accounts, paths or history. */ }
    if (connection !== "verified") nextSteps.push("Open WorkBuddy and complete the documented first connection. Diagnosis never starts/restarts the app or installs its native bridge.");
    if (modelPolicy !== "verified") nextSteps.push("Confirm the approved model is currently available at x0.00 in WorkBuddy; no paid fallback.");
  }
  return {
    ok: localSetupReady && (!options.live || (connection === "verified" && modelPolicy === "verified")),
    readOnly: true, mode: options.live ? "live_observation" : "local", runtime: {packageVersion:runtimeVersion.packageVersion,release:runtimeVersion.release,codeHash:runtimeVersion.codeHash}, checks, localSetupReady,
    discovery: { application: discovery.executable.source, config: discovery.config.source },
    connection, modelPolicy, login: "unknown", quota: "unknown", taskExecutionVerified: false, taskSent: false, nextSteps,
  };
}
export async function runDoctor(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== "--live")) throw new Error("Usage: node scripts/doctor.mjs [--live]");
  loadDotEnv();
  const result = await diagnose({ live: args.includes("--live") });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(PROJECT_ROOT, "dist", "doctor.js")) {
  runDoctor().catch(() => { console.error("Diagnosis failed; inspect local configuration without sharing private data."); process.exitCode = 1; });
}
