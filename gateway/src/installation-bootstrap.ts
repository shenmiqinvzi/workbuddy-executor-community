import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { supportedNode } from "./deployment-paths.js";
import { diagnoseInstallationDependencies } from "./installation-dependencies.js";

/**
 * The release archive carries source and build output, never node_modules. The
 * documented install therefore starts with a command the user has to run by
 * hand, which is exactly what makes "install from the lockfile" unverifiable.
 * This module turns that hand step into planned, bounded, observable steps so a
 * failure names the command, the exit code and the next action instead of a
 * stack trace. It never runs outside the install root it is given, never
 * contacts the network by itself (npm does), and never configures WorkBuddy.
 */
export const BOOTSTRAP_SCHEMA = "workbuddy-installation-bootstrap/v1";

export interface BootstrapStep {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  reason: string;
}

export interface BootstrapStepResult extends BootstrapStep {
  status: "planned" | "ok" | "failed" | "skipped";
  exitCode: number | null;
  durationMs: number;
  output?: string;
  error?: string;
}

export interface BootstrapRunner {
  (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }):
    { code: number | null; stdout?: string; stderr?: string; error?: string };
}

export interface BootstrapInput {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  npmExecutable?: string;
  apply?: boolean;
  run?: BootstrapRunner;
  timeoutMs?: number;
}

export interface BootstrapBlocker { id: string; detail: string; remediation: string }

export interface BootstrapReport {
  schemaVersion: typeof BOOTSTRAP_SCHEMA;
  apply: boolean;
  installRoot: string;
  ok: boolean;
  blockers: BootstrapBlocker[];
  steps: BootstrapStepResult[];
  diagnosis: ReturnType<typeof diagnoseInstallationDependencies> | null;
  next: string[];
}

function exists(file: string): boolean { return fs.existsSync(file); }

function defaultRunner(): BootstrapRunner {
  return (command, args, options) => {
    // Windows ships npm as a batch file; spawning it directly fails with an
    // empty status, so go through ComSpec when the target is a .cmd/.bat.
    const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const file = batch ? options.env.ComSpec ?? "cmd.exe" : command;
    const argv = batch ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args;
    try {
      const stdout = execFileSync(file, argv, {
        cwd: options.cwd, env: options.env, encoding: "utf8", timeout: options.timeoutMs,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
      });
      return { code: 0, stdout: String(stdout) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        code: typeof failure.status === "number" ? failure.status : null,
        stdout: failure.stdout ? String(failure.stdout) : undefined,
        stderr: failure.stderr ? String(failure.stderr) : undefined,
        error: failure.code === "ENOENT" ? `${command} was not found on PATH` : undefined,
      };
    }
  };
}

/** Everything that must be true before a step list is worth running. */
export function planInstallationBootstrap(input: BootstrapInput): { installRoot: string; blockers: BootstrapBlocker[]; steps: BootstrapStep[]; next: string[] } {
  const installRoot = path.resolve(input.installRoot);
  const node = input.nodeVersion ?? process.versions.node;
  const platform = input.platform ?? process.platform;
  const npm = input.npmExecutable ?? (platform === "win32" ? "npm.cmd" : "npm");
  const blockers: BootstrapBlocker[] = [];
  if (!exists(installRoot)) blockers.push({ id: "install_root", detail: `${installRoot} does not exist.`, remediation: "Unpack the release archive first; this step installs into an existing root." });
  if (!supportedNode(node)) blockers.push({ id: "node_version", detail: `Node ${node} is older than the required 22.13.0.`, remediation: "Install Node.js 22.13.0 or newer, then re-run; npm from an older Node cannot build this release." });
  const manifest = path.join(installRoot, "package.json");
  const lockfile = path.join(installRoot, "package-lock.json");
  if (!exists(manifest)) blockers.push({ id: "package_json", detail: "package.json is missing.", remediation: "Point --install-root at the unpacked gateway directory that contains package.json." });
  if (!exists(lockfile)) blockers.push({ id: "package_lock", detail: "package-lock.json is missing, so no dependency set can be reproduced.", remediation: "Use a release archive that carries package-lock.json; this step never guesses versions with npm install." });

  const buildPresent = exists(path.join(installRoot, "dist", "server.js"));
  const hasBuildScript = (() => {
    try { return typeof (JSON.parse(fs.readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts?.build === "string"; }
    catch { return false; }
  })();
  const steps: BootstrapStep[] = [
    { id: "npm_ci", command: npm, args: buildPresent ? ["ci", "--omit=dev"] : ["ci"], cwd: installRoot,
      reason: buildPresent ? "Install the production dependency set from package-lock.json; dist/ is already built." : "Install the full dependency set from package-lock.json before building." },
  ];
  if (!buildPresent) steps.push({ id: "npm_build", command: npm, args: ["run", "build", "--if-present"], cwd: installRoot, reason: "Build dist/ because the archive carries no usable build output." });
  if (!hasBuildScript && !buildPresent) blockers.push({ id: "build_script", detail: "package.json declares no build script and dist/ is absent.", remediation: "Use a complete release archive; this step does not synthesise a build." });

  const next = blockers.length ? [] : [
    "node scripts/setup.mjs plan --root <install-root> to review the first-run configuration without writing it",
    "node scripts/readiness.mjs to see the five readiness layers for this installation",
  ];
  return { installRoot, blockers, steps, next };
}

export function runInstallationBootstrap(input: BootstrapInput): BootstrapReport {
  const plan = planInstallationBootstrap(input);
  const run = input.run ?? defaultRunner();
  const env = input.env ?? process.env;
  const apply = Boolean(input.apply);
  const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
  const results: BootstrapStepResult[] = [];
  let failed = false;
  for (const step of plan.steps) {
    if (!apply) { results.push({ ...step, status: "planned", exitCode: null, durationMs: 0 }); continue; }
    if (failed || plan.blockers.length) { results.push({ ...step, status: "skipped", exitCode: null, durationMs: 0 }); continue; }
    const started = Date.now();
    const outcome = run(step.command, step.args, { cwd: step.cwd, env, timeoutMs });
    const durationMs = Date.now() - started;
    const output = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`.trim().slice(-4000);
    if (outcome.code === 0) { results.push({ ...step, status: "ok", exitCode: 0, durationMs, ...(output ? { output } : {}) }); continue; }
    failed = true;
    results.push({ ...step, status: "failed", exitCode: outcome.code, durationMs, ...(output ? { output } : {}),
      error: outcome.error ?? `${step.command} ${step.args.join(" ")} exited with ${outcome.code ?? "an unknown status"}` });
  }
  const diagnosis = apply && !plan.blockers.length ? diagnoseInstallationDependencies({ installRoot: plan.installRoot, env, platform: input.platform, ...(input.nodeVersion ? { nodeVersion: input.nodeVersion } : {}) }) : null;
  const next = [...plan.next];
  for (const step of results.filter(item => item.status === "failed")) {
    next.push(`Fix ${step.id} and re-run: ${step.command} ${step.args.join(" ")} (exit ${step.exitCode ?? "unknown"}). Nothing was installed beyond the dependency directory in this root.`);
  }
  if (diagnosis?.gaps.length) next.push(...diagnosis.gaps.map(gap => `${gap.id}: ${gap.remediation ?? gap.detail}`));
  return {
    schemaVersion: BOOTSTRAP_SCHEMA, apply, installRoot: plan.installRoot,
    ok: plan.blockers.length === 0 && results.every(step => step.status !== "failed" && step.status !== "skipped"),
    blockers: plan.blockers, steps: results, diagnosis, next: [...new Set(next)],
  };
}
