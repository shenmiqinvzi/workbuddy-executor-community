import fs from "node:fs";
import path from "node:path";
/** Read only the requested session's last user message. Missing/truncated proof fails closed. */
export function latestNativeWake(configDir, sessionId) {
    if (!/^[a-f0-9-]{36}$/.test(sessionId))
        return undefined;
    const projects = path.join(configDir, "projects");
    if (!fs.existsSync(projects))
        return undefined;
    for (const directory of fs.readdirSync(projects, { withFileTypes: true }).slice(0, 1000)) {
        if (!directory.isDirectory())
            continue;
        const file = path.join(projects, directory.name, `${sessionId}.jsonl`);
        let fd;
        try {
            fd = fs.openSync(file, "r");
            const size = fs.fstatSync(fd).size, start = Math.max(0, size - 1024 * 1024);
            const bytes = Buffer.alloc(size - start);
            fs.readSync(fd, bytes, 0, bytes.length, start);
            const lines = bytes.toString("utf8").split("\n");
            if (start)
                lines.shift();
            let last;
            for (const line of lines) {
                let entry;
                try {
                    entry = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (entry.type !== "message" || entry.sessionId !== sessionId || entry.role !== "user")
                    continue;
                const text = Array.isArray(entry.content) ? entry.content.map((p) => p?.text ?? "").join("") : String(entry.content ?? "");
                last = text.match(/\[CODEX_QUEUE_WAKE (wake-run-[a-f0-9-]{36})\]/)?.[1];
            }
            return last;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                return undefined;
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
    }
    return undefined;
}
//# sourceMappingURL=native-ownership.js.map