import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkNativeSchema } from "./doctor.js";
import { supportedNode } from "./deployment-paths.js";
import type { CandidateInspection } from "./installation-readiness.js";

/**
 * Read-only dependency-gap diagnosis for a deployment.
 *
 * A gateway release archive is not an installer and not a complete desktop
 * installation. This module states, one prerequisite at a time, what is present,
 * what is missing and what could not be observed on this machine — so a missing
 * .NET runtime is never reported as "it worked on my machine".
 *
 * It never installs, downloads, elevates, starts WorkBuddy, changes a policy or
 * probes the network: every row is a local, offline observation.
 */

export const DEPENDENCY_REPORT_SCHEMA = "workbuddy-installation-dependencies/v1";

export type ProbeStatus = "ok" | "missing" | "mismatch" | "unknown" | "not_applicable";
export interface DependencyProbe {
  id: string;
  requirement: string;
  required: boolean;
  status: ProbeStatus;
  observed: string | null;
  expected: string | null;
  detail: string;
  remediation: string | null;
}
export interface DependencyReport {
  schemaVersion: string;
  readOnly: true;
  offline: true;
  networkProbes: 0;
  target: { installRoot: string; platform: string; arch: string; node: string; label: string };
  artifact: { kind: "gateway_release" | "source_tree" | "unknown"; version: string | null; archiveSha256: string | null };
  probes: DependencyProbe[];
  productionDependencies: { required: number; present: number; missing: string[]; truncated: boolean };
  gaps: { id: string; detail: string; remediation: string | null }[];
  unknown: string[];
  blocksInstall: boolean;
  next: string[];
}

export interface DependencyProbeSources {
  /** Returns the installed .NET runtimes; injectable so tests never touch the host. */
  dotnet?: () => { ok: boolean; runtimes?: string[]; error?: string };
  /** Returns the WebView2 Runtime version; injectable for the same reason. */
  webview2?: () => { ok: boolean; version?: string; error?: string };
  /** Overrides the native-schema check used for the WorkBuddy data directory. */
  nativeSchema?: (configDir: string) => boolean;
}

export interface DependencyInput {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  /** Only used to describe the artifact ("gateway release " + version), never to read from it. */
  inspection?: CandidateInspection;
  workbuddyApp?: string;
  workbuddyConfig?: string;
  probes?: DependencyProbeSources;
}

const MAX_LISTED_MISSING = 12;
const REGISTRY_WEBVIEW2 = ["SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"];

function probeDotnet(): { ok: boolean; runtimes?: string[]; error?: string } {
  try {
    const text = execFileSync("dotnet", ["--list-runtimes"], { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, runtimes: text.split(/\r?\n/).map(line => line.trim()).filter(Boolean) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? "dotnet is not on PATH" : String((error as Error).message ?? error) };
  }
}

function probeWebView2(): { ok: boolean; version?: string; error?: string } {
  if (process.platform !== "win32") return { ok: false, error: "registry probing is Windows only" };
  for (const key of REGISTRY_WEBVIEW2) {
    try {
      const text = String(execFileSync("reg", ["query", `HKLM\\${key}`, "/v", "pv"], { encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
      const match = /pv\s+REG_SZ\s+(\S+)/i.exec(text);
      if (match?.[1]) return { ok: true, version: match[1] };
    } catch { /* try the next key; absence is reported below, not guessed */ }
  }
  return { ok: false, error: "WebView2 Runtime registry value not found" };
}

/** Production packages named by the lockfile that are actually resolvable on disk. */
export function inspectProductionDependencies(installRoot: string) {
  const result = { required: 0, present: 0, missing: [] as string[], truncated: false };
  const lockFile = path.join(installRoot, "package-lock.json");
  if (!fs.existsSync(lockFile)) { result.missing.push("package-lock.json"); return result; }
  let packages: Record<string, { version?: string; dev?: boolean }>;
  try { packages = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { packages?: Record<string, { version?: string; dev?: boolean }> }).packages ?? {}; }
  catch { result.missing.push("package-lock.json (unreadable)"); return result; }
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/") || entry.dev === true || !entry.version) continue;
    result.required += 1;
    const name = key.slice("node_modules/".length);
    let installed: string | undefined;
    try { installed = String((JSON.parse(fs.readFileSync(path.join(installRoot, key, "package.json"), "utf8")) as { version?: string }).version ?? ""); }
    catch { installed = undefined; }
    if (installed === entry.version) { result.present += 1; continue; }
    if (result.missing.length < MAX_LISTED_MISSING) result.missing.push(installed === undefined ? `${name}@${entry.version} (absent)` : `${name}@${entry.version} (found ${installed || "unknown"})`);
    else result.truncated = true;
  }
  return result;
}

function row(id: string, requirement: string, required: boolean, status: ProbeStatus, detail: string, extra: Partial<DependencyProbe> = {}): DependencyProbe {
  return { id, requirement, required, status, observed: extra.observed ?? null, expected: extra.expected ?? null, detail, remediation: extra.remediation ?? null };
}

/**
 * Diagnose what a gateway release still needs before it becomes a runnable
 * desktop installation. Missing observations stay "unknown" — never "ok".
 */
export function diagnoseInstallationDependencies(input: DependencyInput): DependencyReport {
  const installRoot = path.resolve(input.installRoot);
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const node = input.nodeVersion ?? process.versions.node;
  const probes = input.probes ?? {};
  const rows: DependencyProbe[] = [];

  rows.push(row("node_version", "Node.js >= 22.13.0", true, supportedNode(node) ? "ok" : "mismatch", `This process runs Node ${node}.`, {
    observed: node, expected: ">=22.13.0", remediation: supportedNode(node) ? null : "Install Node.js 22.13.0 or newer and re-run the deployment step.",
  }));
  rows.push(row("platform", "Windows", true, platform === "win32" ? "ok" : "mismatch", "This deployment release is verified on Windows only.", {
    observed: platform, expected: "win32", remediation: platform === "win32" ? null : "Use the Windows machine that will host the installation; other platforms are unverified.",
  }));
  rows.push(row("architecture", "x64", true, arch === "x64" ? "ok" : arch === "arm64" ? "mismatch" : "unknown",
    arch === "x64" ? "The desktop build publishes win-x64 only." : "The desktop build publishes win-x64 assets; this architecture is not verified.",
    { observed: arch, expected: "x64", remediation: arch === "x64" ? null : "Install the x64 gateway and desktop build; arm64 execution is not verified by this release." }));

  const build = ["dist/server.js", "dist/setup.js"].filter(name => fs.existsSync(path.join(installRoot, name)));
  rows.push(row("gateway_build", "Built gateway (dist/server.js, dist/setup.js)", true,
    build.length === 2 ? "ok" : build.length === 0 ? "missing" : "mismatch",
    build.length === 2 ? "Both entrypoints are present." : `Present: ${build.join(", ") || "none"}.`,
    { observed: String(build.length), expected: "2", remediation: build.length === 2 ? null : "Run npm ci && npm run build in the gateway directory (a source archive carries no dist/)." }));

  const dependencies = inspectProductionDependencies(installRoot);
  rows.push(row("production_dependencies", "Production dependencies from package-lock.json", true,
    dependencies.required === 0 ? "unknown" : dependencies.missing.length === 0 && dependencies.present === dependencies.required ? "ok" : "missing",
    dependencies.required === 0 ? "The lockfile names no production packages; nothing can be verified." : `${dependencies.present}/${dependencies.required} production packages resolve from disk.`,
    { observed: `${dependencies.present}/${dependencies.required}`, expected: "all", remediation: dependencies.missing.length ? "Run npm ci --omit=dev next to the gateway; the release archive does not carry node_modules." : null }));

  const desktopExe = path.join(installRoot, "desktop", "app", "WorkBuddy.Workbench.exe");
  const hasDesktopApp = Boolean(input.inspection?.entries.some(entry => entry.path === "gateway/desktop/app/WorkBuddy.Workbench.exe"));
  rows.push(row("desktop_shell", "Desktop workbench executable", false,
    fs.existsSync(desktopExe) ? "ok" : hasDesktopApp ? "missing" : "not_applicable",
    fs.existsSync(desktopExe) ? "desktop/app/WorkBuddy.Workbench.exe is present." : hasDesktopApp ? "The desktop package carries the shell, but it is not unpacked here." : "This artifact is the gateway release; the desktop window is optional and built separately.",
    { observed: fs.existsSync(desktopExe) ? "present" : hasDesktopApp ? "packaged, not unpacked" : "not included", expected: "desktop/app/WorkBuddy.Workbench.exe",
      remediation: fs.existsSync(desktopExe) ? null : "Run npm run desktop:build on Windows with the .NET SDK, or use the desktop package; the skill and MCP paths work without the window." }));

  const dotnet = (probes.dotnet ?? probeDotnet)();
  const windowsDesktop = dotnet.runtimes?.filter(line => /^Microsoft\.WindowsDesktop\.App\s+10\./.test(line)) ?? [];
  rows.push(row("dotnet_desktop_runtime", ".NET Desktop Runtime 10", false,
    !dotnet.ok ? "unknown" : windowsDesktop.length ? "ok" : "missing",
    !dotnet.ok ? `Could not enumerate .NET runtimes: ${dotnet.error ?? "unknown error"}.` : windowsDesktop.length ? windowsDesktop.join("; ") : "dotnet is installed, but no Microsoft.WindowsDesktop.App 10.x is registered.",
    { observed: dotnet.ok ? (windowsDesktop[0]?.split(/\s+/)[1] ?? "none") : "not observable", expected: "Microsoft.WindowsDesktop.App 10.x",
      remediation: !dotnet.ok ? "Run the check on the target machine or add these values to docs/DEPLOYMENT_ACCEPTANCE.md; absence is not assumed either way." : windowsDesktop.length ? null : "Install the .NET Desktop Runtime 10 x64 from Microsoft; the gateway and skill paths do not need it." }));

  const webview2 = (probes.webview2 ?? probeWebView2)();
  rows.push(row("webview2_runtime", "WebView2 Runtime", false,
    webview2.ok ? "ok" : platform === "win32" ? "missing" : "unknown",
    webview2.ok ? `WebView2 Runtime ${webview2.version ?? "(version not shown)"} is registered.` : `WebView2 Runtime was not observed: ${webview2.error ?? "unknown error"}.`,
    { observed: webview2.version ?? "not observable", expected: "Evergreen WebView2 Runtime",
      remediation: webview2.ok ? null : "Install the Evergreen WebView2 Runtime on the target machine; the browser workbench does not need it." }));

  const app = input.workbuddyApp ?? env.WORKBUDDY_CLI_ELECTRON;
  const appOk = Boolean(app && path.isAbsolute(app) && fs.existsSync(app) && fs.statSync(app).isFile());
  rows.push(row("workbuddy_application", "WorkBuddy executable", true, appOk ? "ok" : app ? "mismatch" : "missing",
    appOk ? "An explicit WorkBuddy executable was selected." : app ? "WORKBUDDY_CLI_ELECTRON is set but does not name a readable absolute file." : "No WorkBuddy executable was selected and detection is not guessed here.",
    { observed: app ?? "not selected", expected: "absolute path to WorkBuddy.exe / WorkBuddyAI.exe",
      remediation: appOk ? null : "Open WorkBuddy once, then pass --workbuddy-app with the absolute executable path or set WORKBUDDY_CLI_ELECTRON." }));

  const config = input.workbuddyConfig ?? env.WORKBUDDY_CONFIG_DIR;
  const schemaCheck = probes.nativeSchema ?? checkNativeSchema;
  let configOk = false;
  if (config && path.isAbsolute(config) && fs.existsSync(config)) { try { configOk = schemaCheck(config); } catch { configOk = false; } }
  rows.push(row("workbuddy_data", "Compatible WorkBuddy data directory", true, configOk ? "ok" : config ? "mismatch" : "missing",
    configOk ? "The native sessions schema is readable." : config ? "The directory does not expose a compatible sessions table." : "No WorkBuddy data directory was selected.",
    { observed: config ?? "not selected", expected: "directory containing workbuddy.db with sessions(id,cwd,is_playground,deleted_at)",
      remediation: configOk ? null : "Open WorkBuddy once so it creates its data directory, then pass --workbuddy-config with that directory." }));

  rows.push(row("code_signing", "Authenticode signature of the release artifacts", false, "not_applicable",
    "This line does not sign releases: the gateway archive and the desktop executable are unsigned unless the release owner signs them. Signature status is reported as-is and never inferred from a successful run.",
    { observed: "unsigned by this line", expected: "signed by the release owner (pending decision)",
      remediation: "Sign with the publisher's certificate at packaging time; do not disable system protection, SmartScreen or a security policy as a workaround." }));

  const gaps = rows.filter(item => item.required && item.status !== "ok").map(item => ({ id: item.id, detail: item.detail, remediation: item.remediation }));
  const unknown = rows.filter(item => item.status === "unknown").map(item => item.id);
  const artifact = input.inspection
    ? { kind: "gateway_release" as const, version: input.inspection.release.version, archiveSha256: input.inspection.archive.sha256 }
    : { kind: fs.existsSync(path.join(installRoot, "package.json")) ? "source_tree" as const : "unknown" as const, version: null, archiveSha256: null };

  return {
    schemaVersion: DEPENDENCY_REPORT_SCHEMA,
    readOnly: true,
    offline: true,
    networkProbes: 0,
    target: { installRoot, platform, arch, node, label: `${platform}-${arch}` },
    artifact,
    probes: rows,
    productionDependencies: dependencies,
    gaps,
    unknown,
    blocksInstall: gaps.length > 0,
    next: [
      "A gateway release archive is source and build output, not an installer: unpack it, install dependencies from its lockfile and build before installing.",
      "Rows marked unknown were not observable on this machine; confirm them on the target machine instead of assuming they pass.",
      "Desktop window rows (.NET Desktop Runtime 10, WebView2) are optional for the skill/MCP path and required only for the desktop shell.",
      "This report reads local state only; it does not install, download, elevate, start WorkBuddy or touch the network.",
    ],
  };
}
