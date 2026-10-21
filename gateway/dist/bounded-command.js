import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writePrivateJson } from "./run-journal.js";
import { windowsPowerShellPath } from "./native-process.js";
function fingerprints(spec) {
    return Object.fromEntries((spec.inputs ?? []).map(file => {
        const absolute = path.resolve(spec.cwd, file);
        return [absolute, fs.existsSync(absolute) ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : "missing"];
    }));
}
export async function runBounded(spec, directory, options = {}) {
    if (!path.isAbsolute(spec.executable) || !fs.statSync(spec.executable).isFile() || !Array.isArray(spec.args) || !spec.args.every(v => typeof v === "string") || !path.isAbsolute(spec.cwd) || !fs.statSync(spec.cwd).isDirectory())
        throw Error("Use an absolute executable/cwd and an array of arguments; no implicit shell");
    if (!Number.isFinite(spec.timeoutSeconds) || spec.timeoutSeconds <= 0 || spec.timeoutSeconds > 86400)
        throw Error("Command timeoutSeconds must be in (0,86400]");
    const remaining = options.reportBy ? Date.parse(options.reportBy) - Date.now() : Infinity;
    if (options.cancelFile && fs.existsSync(options.cancelFile))
        throw Error("Cancellation requested; command was not started");
    if (remaining <= 0 || Number.isNaN(remaining))
        throw Error("Report reserve reached; submit real partial/blocked result now");
    fs.mkdirSync(directory, { recursive: true });
    const id = crypto.randomUUID(), base = path.join(directory, id), stdout = base + ".stdout.log", stderr = base + ".stderr.log", record = base + ".json";
    const timeoutMs = Math.max(1, Math.min(spec.timeoutSeconds * 1000, remaining)), startedAt = new Date().toISOString(), before = fingerprints(spec);
    writePrivateJson(record, { ...spec, startedAt, before, state: "running", stdout, stderr });
    let outcome;
    if (process.platform === "win32") {
        const specFile = base + ".spec.json";
        writePrivateJson(specFile, { ...spec, stdout, stderr, timeoutMs: Math.ceil(timeoutMs), cancelFile: options.cancelFile });
        outcome = await new Promise((resolve) => {
            const helper = fileURLToPath(new URL("../scripts/bounded-job.ps1", import.meta.url));
            const child = spawn(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-File", helper, "-SpecFile", specFile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            writePrivateJson(record, { ...spec, startedAt, before, state: "running", stdout, stderr, supervisorPid: child.pid, supervisorSpec: specFile, ownership: "windows_job_object" });
            let out = "", err = "", watchdogFired = false, helperExitCode = null;
            const spawnedAt = Date.now();
            const evidence = () => ({ watchdogFired, helperExitCode, elapsedMs: Date.now() - spawnedAt, stdoutBytes: Buffer.byteLength(out, "utf8"), stderrTail: err.slice(-600) });
            const fail = (reason) => resolve({ exitCode: 125, reason, cleanupConfirmed: false, failure: evidence() });
            child.stdout.on("data", b => out += String(b));
            child.stderr.on("data", b => err += String(b));
            // The supervisor enforces the command's own timeout; this watchdog only
            // catches a supervisor that never returns. Its margin has to cover the
            // supervisor's startup, which is why a firing watchdog is recorded.
            const watchdog = setTimeout(() => { watchdogFired = true; child.kill(); }, timeoutMs + 20000);
            child.once("error", e => { clearTimeout(watchdog); fail(`Job supervisor could not be started: ${String(e)}`); });
            child.once("exit", code => {
                clearTimeout(watchdog);
                helperExitCode = code;
                if (code !== 0)
                    return fail(`Job supervisor exited ${code}: ${err.slice(-2000) || "no stderr"}`);
                try {
                    resolve(JSON.parse(out.trim()));
                }
                catch {
                    fail(`Job supervisor did not return a JSON result: ${err.slice(-2000) || "no stderr"}`);
                }
            });
        });
    }
    else {
        const out = fs.openSync(stdout, "w"), err = fs.openSync(stderr, "w");
        outcome = await new Promise((resolve) => {
            const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, detached: true, stdio: ["ignore", out, err] });
            let reason = "exit";
            const start = Date.now();
            const kill = () => { try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch { } };
            const timer = setInterval(() => { if (options.cancelFile && fs.existsSync(options.cancelFile)) {
                reason = "cancelled";
                kill();
            }
            else if (Date.now() - start >= timeoutMs) {
                reason = "timeout";
                kill();
            } }, 100);
            child.once("error", e => { clearInterval(timer); resolve({ exitCode: 125, reason: String(e), cleanupConfirmed: false }); });
            child.once("exit", code => { clearInterval(timer); kill(); resolve({ pid: child.pid, exitCode: reason === "timeout" ? 124 : reason === "cancelled" ? 130 : code ?? 1, reason, cleanupConfirmed: true, ownership: "process_group" }); });
        });
        fs.closeSync(out);
        fs.closeSync(err);
    }
    const result = { ...spec, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), before, after: fingerprints(spec), ...outcome, stdout, stderr, record };
    writePrivateJson(record, result);
    return result;
}
//# sourceMappingURL=bounded-command.js.map