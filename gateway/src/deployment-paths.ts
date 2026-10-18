import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { windowsPowerShellPath } from "./native-process.js";

export interface DetectedPath {
  value?: string;
  source: "environment" | "detected" | "missing" | "ambiguous";
  candidates: string[];
}
export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  runningExecutables?: () => string[];
}
function file(filename: string): boolean { try { return fs.statSync(filename).isFile(); } catch { return false; } }
function choose(explicit: string | undefined, candidates: string[]): DetectedPath {
  if (explicit?.trim()) return { value: explicit.trim(), source: "environment", candidates: [] };
  const unique = new Map<string, string>();
  for (const candidate of candidates.filter(file)) {
    const real = fs.realpathSync(candidate);
    unique.set(process.platform === "win32" ? real.toLowerCase() : real, candidate);
  }
  const found = [...unique.values()];
  return found.length === 1 ? { value: found[0], source: "detected", candidates: found }
    : { source: found.length ? "ambiguous" : "missing", candidates: found };
}

/** Query executable paths only, never command lines, chat history or settings. */
function runningWorkBuddyExecutables(): string[] {
  if (process.platform !== "win32") return [];
  try {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe' OR Name='WorkBuddyAI.exe'\" | Select-Object -ExpandProperty ExecutablePath -Unique | ConvertTo-Json -Compress";
    const text = String(execFileSync(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 4000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    })).trim();
    const result: unknown = text ? JSON.parse(text) : [];
    return (Array.isArray(result) ? result : [result]).filter((x): x is string => typeof x === "string" && path.isAbsolute(x));
  } catch { return []; }
}

export function discoverDesktopPaths(options: DiscoveryOptions = {}) {
  const env = options.env ?? process.env, home = options.home ?? os.homedir(), platform = options.platform ?? process.platform;
  const applications: string[] = [];
  if (platform === "win32") {
    for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]].filter((x): x is string => Boolean(x))) {
      for (const folder of ["WorkBuddy", "WorkBuddyAI"]) for (const exe of ["WorkBuddy.exe", "WorkBuddyAI.exe"]) applications.push(path.join(base, folder, exe));
    }
    if (!env.WORKBUDDY_CLI_ELECTRON) applications.push(...(options.runningExecutables ?? runningWorkBuddyExecutables)());
  } else if (platform === "darwin") applications.push("/Applications/WorkBuddy.app/Contents/MacOS/Electron");
  const executable = choose(env.WORKBUDDY_CLI_ELECTRON, applications);
  const config = choose(env.WORKBUDDY_CONFIG_DIR, [path.join(home, ".workbuddy-ai", "workbuddy.db"), path.join(home, ".workbuddy", "workbuddy.db")]);
  if (config.source !== "environment") {
    config.candidates = config.candidates.map(x => path.dirname(x));
    if (config.value) config.value = path.dirname(config.value);
  }
  return { executable, config };
}

export function supportedNode(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}
