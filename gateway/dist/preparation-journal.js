import crypto from "node:crypto";
import { classifyPreparationProbe, } from "./preparation-protocol.js";
function decode(row) {
    return {
        probeId: row.probeId,
        sessionId: row.sessionId,
        workspace: row.workspace,
        source: row.source,
        kind: row.kind,
        conclusion: row.conclusion,
        reason: row.reason,
        gatewayPid: Number(row.gatewayPid),
        observedAt: row.observedAt,
        error: row.error,
    };
}
/**
 * 追加型探针日志：只 INSERT，不 UPDATE、不 DELETE。
 * 迟到的“查到了”是新增一行，不改写先前那行“没查到”，历史因此保持可复核。
 */
export class PreparationJournal {
    db;
    constructor(db) {
        this.db = db;
        this.db.exec(`CREATE TABLE IF NOT EXISTS preparation_probes(
        probeId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        workspace TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        conclusion TEXT NOT NULL,
        reason TEXT NOT NULL,
        gatewayPid INTEGER NOT NULL,
        observedAt TEXT NOT NULL,
        error TEXT);
      CREATE INDEX IF NOT EXISTS preparation_probes_session ON preparation_probes(sessionId, observedAt);`);
    }
    record(input) {
        const classification = classifyPreparationProbe(input);
        const record = {
            probeId: input.probeId ?? crypto.randomUUID(),
            sessionId: input.sessionId,
            workspace: input.workspace,
            source: input.source,
            gatewayPid: process.pid,
            observedAt: input.observedAt ?? new Date().toISOString(),
            error: input.error ? String(input.error) : null,
            ...classification,
        };
        this.db
            .prepare("INSERT INTO preparation_probes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(record.probeId, record.sessionId, record.workspace, record.source, record.kind, record.conclusion, record.reason, record.gatewayPid, record.observedAt, record.error);
        return record;
    }
    forSession(sessionId) {
        return this.db.prepare("SELECT * FROM preparation_probes WHERE sessionId=? ORDER BY observedAt, probeId").all(sessionId).map(decode);
    }
    latest(sessionId) {
        const row = this.db.prepare("SELECT * FROM preparation_probes WHERE sessionId=? ORDER BY observedAt DESC, probeId DESC LIMIT 1").get(sessionId);
        return row ? decode(row) : undefined;
    }
}
//# sourceMappingURL=preparation-journal.js.map