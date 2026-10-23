import path from "node:path";
import { execFileSync } from "node:child_process";
/**
 * Read the Windows process table once through the OS. This only inspects
 * process metadata: it never starts, stops or reconfigures another program.
 */
export function windowsPowerShellPath() {
    // PATH may contain a tool/sandbox shim named "powershell". Invoke the OS
    // executable directly; ancestry inspection must never depend on that shim.
    return path.win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
export function windowsProcessTable(run = execFileSync) {
    // Hidden Windows PowerShell may use the system legacy code page. Match the
    // UTF-8 decoder below so non-ASCII executable paths retain their identity.
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 3";
    const output = String(run(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
    })).trim();
    if (!output)
        return [];
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
        const value = row;
        const pid = Number(value.ProcessId);
        const ppid = Number(value.ParentProcessId);
        if (!Number.isSafeInteger(pid) || pid <= 0)
            return [];
        return [{
                pid,
                ppid: Number.isSafeInteger(ppid) ? ppid : 0,
                exe: typeof value.ExecutablePath === "string" ? value.ExecutablePath : undefined,
                commandLine: typeof value.CommandLine === "string" ? value.CommandLine : undefined,
            }];
    });
}
export function hasProcess(pid, table) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    const rows = table ?? windowsProcessTable();
    return rows.some((row) => row.pid === pid);
}
/** Compare an executable path from the process table with a configured path. */
export function sameExecutable(candidate, configured) {
    if (!candidate)
        return false;
    try {
        return path.resolve(candidate).toLowerCase() === path.resolve(configured).toLowerCase();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=native-process.js.map