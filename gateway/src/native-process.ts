import path from "node:path";
import { execFileSync } from "node:child_process";

export interface NativeProcess {
  pid: number;
  ppid: number;
  exe?: string;
  commandLine?: string;
}

/**
 * Read the Windows process table once through the OS. This only inspects
 * process metadata: it never starts, stops or reconfigures another program.
 */
export function windowsPowerShellPath(): string {
  // PATH may contain a tool/sandbox shim named "powershell". Invoke the OS
  // executable directly; ancestry inspection must never depend on that shim.
  return path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The process table could not be read at all. Never equal to "no processes". */
export class ProcessTableUnavailableError extends Error {
  constructor(readonly attempts: number, readonly cause: unknown) {
    super(`the Windows process table could not be read after ${attempts} attempts (${cause instanceof Error ? cause.message : String(cause)}); nothing was assumed about any process, so no process was treated as started or stopped — retry when the machine is idle`);
    this.name = "ProcessTableUnavailableError";
  }
}

function sleepSync(ms: number): void { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function windowsProcessTable(run: typeof execFileSync = execFileSync, options: { attempts?: number; backoffMs?: number } = {}): NativeProcess[] {
  // Hidden Windows PowerShell may use the system legacy code page. Match the
  // UTF-8 decoder below so non-ASCII executable paths retain their identity.
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 3";
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 200;
  let output = "";
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      output = String(run(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      })).trim();
      lastError = undefined;
      break;
    } catch (error) {
      // WMI answers 0x80004005 (an unspecified error) under contention. A short
      // bounded retry absorbs that; anything persistent still fails loudly.
      lastError = error;
      if (attempt + 1 < attempts) sleepSync(backoffMs * (attempt + 1));
    }
  }
  if (lastError) throw new ProcessTableUnavailableError(attempts, lastError);
  if (!output) return [];
  const parsed = JSON.parse(output) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    const value = row as Record<string, unknown>;
    const pid = Number(value.ProcessId);
    const ppid = Number(value.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0) return [];
    return [{
      pid,
      ppid: Number.isSafeInteger(ppid) ? ppid : 0,
      exe: typeof value.ExecutablePath === "string" ? value.ExecutablePath : undefined,
      commandLine: typeof value.CommandLine === "string" ? value.CommandLine : undefined,
    }];
  });
}

export function hasProcess(pid: number, table?: NativeProcess[]): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const rows = table ?? windowsProcessTable();
  return rows.some((row) => row.pid === pid);
}

/**
 * Compare the workspace the native app reports with the one a request dispatched.
 *
 * Windows hands the session cwd back with backslashes while a dispatch may carry
 * forward slashes, so a raw `!==` reads every healthy run as a mismatch and the
 * supervisor can never confirm the stop (F-PATH-1). Compare normalized paths.
 */
export function sameWorkspacePath(candidate: string | undefined, configured: string | undefined): boolean {
  if (!candidate || !configured) return false;
  const normalize = (value: string) => String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  const left = normalize(candidate);
  const right = normalize(configured);
  if (left === right) return true;
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : false;
}

/** Compare an executable path from the process table with a configured path. */
export function sameExecutable(candidate: string | undefined, configured: string): boolean {
  if (!candidate) return false;
  try {
    return path.resolve(candidate).toLowerCase() === path.resolve(configured).toLowerCase();
  } catch {
    return false;
  }
}
