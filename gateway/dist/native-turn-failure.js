import fs from 'node:fs';
import path from 'node:path';
/** Describe the observed native error without inferring account quota or retrying. */
export function diagnoseNativeFailure(error, observedAt, phase) {
    const original = error.slice(0, 2000);
    const rateLimited = /^(?:HTTP(?:\/[\d.]+)?\s+|status(?:\s+code)?\s*[:=]?\s*)?429\b/i.test(original.trim());
    if (!rateLimited)
        return { message: `WorkBuddy native turn failed: ${original}. No automatic resend occurred.` };
    const retryAfter = original.match(/(?:^|[\s,;])Retry-After\s*[:=]\s*(\d+)(?=\s*(?:[;,\r\n]|$))/i);
    const seconds = retryAfter ? Number(retryAfter[1]) : undefined;
    const retryAfterSeconds = seconds !== undefined && Number.isSafeInteger(seconds) ? seconds : undefined;
    const rateLimit = {
        kind: "rate_limited", statusCode: 429, observedAt,
        ...(phase === undefined ? {} : { phase }),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
    const origin = phase === "session:sendMessage" ? " during native message submission"
        : phase === "native_history" ? " in native turn history" : "";
    const timing = retryAfterSeconds === undefined
        ? "No retry time was supplied."
        : `The native error supplied Retry-After: ${retryAfterSeconds} seconds.`;
    return {
        message: `WorkBuddy native turn was rate limited (HTTP 429)${origin}. ${timing} Native error: ${original}. No automatic resend occurred.`,
        rateLimit,
    };
}
/** Some desktop versions resolve sendMessage while recording provider errors
 * as incomplete assistant messages rather than RPC errors. Read only this
 * session's bounded native history, correlated with the exact wake marker. */
export function readNativeTurnFailure(configDir, sessionId, wake) {
    if (!/^[a-f0-9-]{36}$/.test(sessionId) || !/^wake-run-[a-f0-9-]{36}$/.test(wake.wakeId))
        return undefined;
    const projects = path.join(configDir, 'projects');
    if (!fs.existsSync(projects))
        return undefined;
    for (const directory of fs.readdirSync(projects, { withFileTypes: true }).slice(0, 1000)) {
        if (!directory.isDirectory())
            continue;
        const file = path.join(projects, directory.name, `${sessionId}.jsonl`);
        let fd;
        try {
            if (!fs.lstatSync(file).isFile())
                continue;
            fd = fs.openSync(file, 'r');
            const size = fs.fstatSync(fd).size;
            const start = Math.max(0, size - 256 * 1024);
            const buffer = Buffer.alloc(size - start);
            fs.readSync(fd, buffer, 0, buffer.length, start);
            const lines = buffer.toString('utf8').split('\n');
            if (start)
                lines.shift();
            let matchingTurn = false;
            let failure;
            for (const line of lines) {
                let entry;
                try {
                    entry = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (entry.type !== 'message' || entry.sessionId !== sessionId)
                    continue;
                const text = Array.isArray(entry.content) ? entry.content.map((part) => part?.text ?? '').join('') : String(entry.content ?? '');
                if (entry.role === 'user' && text.includes('[CODEX_QUEUE_WAKE ')) {
                    matchingTurn = text.includes(`[CODEX_QUEUE_WAKE ${wake.wakeId}]`);
                    failure = undefined;
                    continue;
                }
                const observedAt = typeof entry.timestamp === 'number' ? new Date(entry.timestamp).toISOString() : String(entry.timestamp ?? '');
                if (matchingTurn && entry.role === 'assistant' && entry.status === 'incomplete' &&
                    /^[45]\d{2}\b/.test(text.trim()) && Number.isFinite(Date.parse(observedAt)) && Date.parse(observedAt) >= Date.parse(wake.createdAt)) {
                    failure = { wakeId: wake.wakeId, error: text.slice(0, 2000), observedAt, phase: "native_history" };
                }
            }
            return failure;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                return undefined;
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
    }
    return undefined;
}
//# sourceMappingURL=native-turn-failure.js.map