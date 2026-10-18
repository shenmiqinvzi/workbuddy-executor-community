import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/** Absolute path of this installation, independent of the caller's cwd. */
export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
/**
 * Load this installation's .env the way the POSIX launchers do.
 *
 * The sh launchers in bin/ source .env before starting Node; environments that
 * cannot run a sh launcher (Windows, editors, MCP hosts) call this instead.
 * Values already present in the environment always win, so the .env file can
 * never override an explicit host configuration.
 */
export function loadDotEnv(file = path.join(PROJECT_ROOT, ".env")) {
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    }
    catch {
        return;
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const separator = line.indexOf("=");
        if (separator <= 0)
            continue;
        const name = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            continue;
        let value = line.slice(separator + 1).trim();
        if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
            value = value.slice(1, -1);
        }
        if (process.env[name] === undefined)
            process.env[name] = value;
    }
}
//# sourceMappingURL=env.js.map