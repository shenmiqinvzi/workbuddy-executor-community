import type { DatabaseSync } from "node:sqlite";
import { type PreparationProbeInput, type PreparationProbeRecord } from "./preparation-protocol.js";
/**
 * 追加型探针日志：只 INSERT，不 UPDATE、不 DELETE。
 * 迟到的“查到了”是新增一行，不改写先前那行“没查到”，历史因此保持可复核。
 */
export declare class PreparationJournal {
    private readonly db;
    constructor(db: DatabaseSync);
    record(input: PreparationProbeInput & {
        sessionId: string;
        workspace: string;
        observedAt?: string;
        probeId?: string;
    }): PreparationProbeRecord;
    forSession(sessionId: string): PreparationProbeRecord[];
    latest(sessionId: string): PreparationProbeRecord | undefined;
}
