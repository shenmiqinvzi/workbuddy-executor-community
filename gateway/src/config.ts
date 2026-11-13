import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./env.js";
import { discoverDesktopPaths, type DetectedPath } from "./deployment-paths.js";

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface Config {
  backend: "cli" | "api" | "gateway" | "desktop-acp" | "desktop-queue";
  apiBaseUrl: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  tokenFile: string;
  dbFile: string;
  oauthRedirectUri: string;
  oauthPort: number;
  oauthScopes: string;
  requestTimeoutMs: number;
  cliElectronPath: string;
  cliScriptPath: string;
  cliPermissionMode: string;
  acpPermissionMode: "deny" | "allow_once";
  gatewayUrl: string;
  gatewayPassword?: string;
  workbuddyConfigDir: string;
  runsDir?: string;
  taskTimeoutSeconds?: number;
  claimTimeoutSeconds?: number;
  maxTaskAttempts?: number;
  serviceConfigFile?: string;
}

/**
 * Two installations or two data directories are a real ambiguity, not a
 * preference: the process refuses rather than guessing. The refusal is useless
 * if it does not say what it found, so the message names every candidate and
 * the exact variable that resolves it, and states that nothing is guessed or
 * rolled back.
 */
export function ambiguityMessage(desktop: { executable: DetectedPath; config: DetectedPath }): string {
  const parts: string[] = [];
  if (desktop.executable.source === "ambiguous") parts.push(`可执行文件候选：${desktop.executable.candidates.join("、")}`);
  if (desktop.config.source === "ambiguous") parts.push(`配置目录候选：${desktop.config.candidates.join("、")}`);
  return `Multiple WorkBuddy installations or data directories found; set WORKBUDDY_CLI_ELECTRON and WORKBUDDY_CONFIG_DIR explicitly. 检测到${parts.join("；")}。` +
    `请设置 WORKBUDDY_CLI_ELECTRON=<WorkBuddy 可执行文件> 与/或 WORKBUDDY_CONFIG_DIR=<配置目录> 后重试。` +
    `本服务不会替你挑选其中一个，也不会回退到其他目录或磁盘上的旧状态。`;
}

export function loadConfig(): Config {
  const configuredBackend = optional("WORKBUDDY_BACKEND");
  const backend = configuredBackend === "api"
    ? "api"
    : configuredBackend === "cli"
      ? "cli"
      : configuredBackend === "desktop-queue" ? "desktop-queue" : configuredBackend === "desktop-acp" || configuredBackend === "live"
        ? "desktop-acp"
        : configuredBackend === "gateway"
          ? "gateway"
          : "desktop-queue";
  const desktop = discoverDesktopPaths({ runningExecutables: () => [] });
  if (["desktop-queue", "desktop-acp"].includes(backend) && (desktop.executable.source === "ambiguous" || desktop.config.source === "ambiguous")) {
    throw new Error(ambiguityMessage(desktop));
  }
  return {
    backend,
    apiBaseUrl: (optional("WORKBUDDY_API_BASE_URL") ?? "https://www.workbuddy.cn/openapi/v2").replace(/\/$/, ""),
    clientId: optional("WORKBUDDY_CLIENT_ID"),
    clientSecret: optional("WORKBUDDY_CLIENT_SECRET"),
    accessToken: optional("WORKBUDDY_ACCESS_TOKEN"),
    // Relative paths belong to this installation, not to the caller's working
    // directory; the sh launchers enforced that with `cd $ROOT`, and the queue
    // helper now runs from whatever directory the desktop conversation uses.
    tokenFile: path.resolve(PROJECT_ROOT, optional("WORKBUDDY_TOKEN_FILE") ?? "./data/credentials.json"),
    dbFile: path.resolve(PROJECT_ROOT, optional("WORKBUDDY_DB_FILE") ?? "./data/tasks.sqlite"),
    oauthRedirectUri: optional("WORKBUDDY_OAUTH_REDIRECT_URI") ?? "http://127.0.0.1:8787/oauth/callback",
    oauthPort: integer("WORKBUDDY_OAUTH_PORT", 8787),
    oauthScopes: optional("WORKBUDDY_OAUTH_SCOPES") ?? "user.localassistant.invokable user.localassistant.readable",
    // Downstream request budget of the gateway itself. This is NOT the wait of a
    // local MCP client: scripts/workbuddy-call.mjs keeps its stdio call attached
    // for WORKBUDDY_MCP_CLIENT_TIMEOUT_MS (default 15 minutes). Raising this value
    // never extended that client, and lowering it does not shorten native
    // preparation.
    requestTimeoutMs: integer("WORKBUDDY_REQUEST_TIMEOUT_MS", 30_000),
    cliElectronPath: desktop.executable.value ?? (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "WorkBuddy", "WorkBuddy.exe")
      : "/Applications/WorkBuddy.app/Contents/MacOS/Electron"),
    cliScriptPath: optional("WORKBUDDY_CLI_SCRIPT") ?? "/Applications/WorkBuddy.app/Contents/Resources/app.asar/cli/bin/codebuddy",
    cliPermissionMode: optional("WORKBUDDY_CLI_PERMISSION_MODE") ?? "acceptEdits",
    // Allow one explicit WorkBuddy action by default so delegated coding
    // tasks can actually edit files; set WORKBUDDY_ACP_PERMISSION_MODE=deny
    // for read-only review runs.
    acpPermissionMode: optional("WORKBUDDY_ACP_PERMISSION_MODE") === "deny" ? "deny" : "allow_once",
    gatewayUrl: (optional("WORKBUDDY_GATEWAY_URL") ?? "http://127.0.0.1:64523").replace(/\/$/, ""),
    gatewayPassword: optional("WORKBUDDY_GATEWAY_PASSWORD"),
    // The native app keeps its history database under the user's home on every
    // platform; process.env.HOME is empty on Windows, so resolve the real home.
    workbuddyConfigDir: desktop.config.value ?? path.join(os.homedir(), ".workbuddy"),
    runsDir: optional("WORKBUDDY_RUNS_DIR") ? path.resolve(PROJECT_ROOT, optional("WORKBUDDY_RUNS_DIR")!) : undefined,
    taskTimeoutSeconds: Math.min(integer("WORKBUDDY_TASK_TIMEOUT_SECONDS", 1800), 86_400),
    claimTimeoutSeconds: Math.min(integer("WORKBUDDY_CLAIM_TIMEOUT_SECONDS", 180), 600),
    maxTaskAttempts: Math.min(integer("WORKBUDDY_MAX_TASK_ATTEMPTS", 3), 20),
    serviceConfigFile: path.resolve(PROJECT_ROOT, optional("WORKBUDDY_SERVICE_CONFIG") ?? "./data/persistent-service.json"),
  };
}

export function requireOAuthConfig(config: Config): { clientId: string; clientSecret: string } {
  if (!config.clientId || !config.clientSecret) {
    throw new Error("OAuth requires WORKBUDDY_CLIENT_ID and WORKBUDDY_CLIENT_SECRET. Run the auth setup after creating an enabled WorkBuddy app.");
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}
