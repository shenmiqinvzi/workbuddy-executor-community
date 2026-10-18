import fs from "node:fs";
import path from "node:path";
import { windowsProcessTable } from "./native-process.js";
import { writePrivateJson } from "./run-journal.js";
/** A killed supervisor cannot write its final record. Its non-inheritable Job
 * handle is closed by Windows, killing all owned descendants. Prove the exact
 * supervisor is absent; never infer ownership or terminate by process name. */
export function reconcileOwnedCommands(directory, inspect = windowsProcessTable) {
    if (process.platform !== "win32" || !fs.existsSync(directory))
        return { recovered: [] };
    const pending = fs.readdirSync(directory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).flatMap(name => {
        const file = path.join(directory, name), value = JSON.parse(fs.readFileSync(file, "utf8"));
        return !value.endedAt ? [{ name, file, value }] : [];
    });
    if (!pending.length)
        return { recovered: [] };
    const processes = inspect(), normalize = (s) => s.replaceAll("\\", "/").toLowerCase();
    const recovered = [];
    for (const { name, file, value } of pending) {
        const specFile = file.slice(0, -5) + ".spec.json";
        if (!fs.existsSync(specFile))
            continue;
        const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
        if (spec.executable !== value.executable || JSON.stringify(spec.args) !== JSON.stringify(value.args) || spec.cwd !== value.cwd ||
            path.resolve(spec.stdout) !== file.slice(0, -5) + ".stdout.log" || path.resolve(spec.stderr) !== file.slice(0, -5) + ".stderr.log")
            continue;
        // New runs record the directly spawned supervisor PID. Legacy v1 records
        // use the unique absolute spec path present in the supervisor command line.
        if (value.supervisorPid) {
            const owner = processes.find(p => p.pid === value.supervisorPid);
            if (owner && (!owner.commandLine || normalize(owner.commandLine).includes(normalize(specFile))))
                continue;
        }
        if (processes.some(p => p.commandLine && normalize(p.commandLine).includes(normalize(specFile))))
            continue;
        const latest = JSON.parse(fs.readFileSync(file, "utf8"));
        if (latest.endedAt)
            continue;
        const now = new Date().toISOString();
        writePrivateJson(file, { ...latest, state: "interrupted", endedAt: now, exitCode: 125, reason: "supervisor_exited_job_closed", cleanupConfirmed: true,
            cleanupEvidence: { source: "windows_job_owner_absent", specFile, observedAt: now, exitCodeKnown: false } });
        recovered.push(name);
    }
    return { recovered };
}
//# sourceMappingURL=command-cleanup.js.map