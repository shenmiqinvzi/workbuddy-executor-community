import { createHash, createHmac, randomBytes } from "node:crypto";
import { LocalStatisticsClient, StatisticsSourceError } from "./local-statistics-client.js";
export const QUOTA_RESOURCE_SCHEMA = "workbuddy-executor/quota-1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const idOk = (value) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value);
const numberOrNull = (value) => {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error("source_invalid");
    return value;
};
const timestamp = (value) => {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 253402300799)
        throw new Error("source_invalid");
    return new Date(value * 1000).toISOString();
};
function savedSnapshot(raw, id) {
    try {
        const value = JSON.parse(raw);
        const iso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
        if (!value || value.connectionId !== id || typeof value.snapshotId !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(value.snapshotId) ||
            !iso(value.collectedAt) || !iso(value.expiresAt) || (value.sourceObservedAt !== null && !iso(value.sourceObservedAt)) || !Array.isArray(value.observations) || value.observations.length > 2000 ||
            Object.keys(value).length !== 6 || Object.keys(value).some(key => !["snapshotId", "connectionId", "collectedAt", "sourceObservedAt", "expiresAt", "observations"].includes(key)))
            throw Error();
        for (const row of value.observations) {
            if (!row || typeof row !== "object" || !/^pool-[a-f0-9]{32}$/.test(row.scopeId) || row.scopeKind !== "gateway_pool" || row.shared !== true || row.unit !== "tokens" ||
                typeof row.modelId !== "string" || !row.modelId || row.modelId.length > 200 || !["cn", "intl"].includes(row.realm) || !["estimated", "unavailable"].includes(row.valueKind) ||
                !["available", "exhausted", "unknown"].includes(row.availability) || !Array.isArray(row.limitations) || row.limitations.some(x => !["routing_unverified", "shared_pool", "budget_estimated", "gateway_observed_usage_only", "task_attribution_unavailable"].includes(x)) ||
                !["source_cooling_and_historical_budget", "historical_budget_minus_observed_usage"].includes(row.method) || (row.resetAt !== null && !iso(row.resetAt)) ||
                Object.keys(row).length !== 14 || Object.keys(row).some(key => !["scopeId", "scopeKind", "shared", "modelId", "realm", "unit", "valueKind", "availability", "used", "budget", "remaining", "resetAt", "method", "limitations"].includes(key)))
                throw Error();
            for (const n of [row.used, row.budget, row.remaining])
                numberOrNull(n);
        }
        return value;
    }
    catch {
        throw new Error("resource_corrupt");
    }
}
/** Stored resource observations are independent of task revision and lifecycle. */
export class QuotaStore {
    db;
    salt;
    constructor(db) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS quota_connections (
      id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,epoch TEXT NOT NULL,snapshot_json TEXT,error_code TEXT,generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS quota_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
        db.prepare("INSERT INTO quota_metadata VALUES ('scope_salt',?) ON CONFLICT(key) DO NOTHING").run(randomBytes(32).toString("hex"));
        this.salt = String(db.prepare("SELECT value FROM quota_metadata WHERE key='scope_salt'").get().value);
    }
    register(id, fingerprint) {
        if (!idOk(id))
            throw new Error("Invalid quota connection identifier");
        const existing = this.connection(id);
        if (existing?.fingerprint === fingerprint)
            return existing.epoch;
        if (!existing && Number(this.db.prepare("SELECT COUNT(*) AS n FROM quota_connections").get().n) >= 16)
            throw new Error("Quota connection limit reached");
        const epoch = randomBytes(18).toString("base64url");
        this.db.prepare("INSERT INTO quota_connections (id,fingerprint,epoch) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,epoch=excluded.epoch,snapshot_json=NULL,error_code=NULL,generation=0").run(id, fingerprint, epoch);
        return epoch;
    }
    anonymize(origin, realm, uid) {
        return `pool-${createHmac("sha256", this.salt).update(JSON.stringify([origin, realm, uid])).digest("hex").slice(0, 32)}`;
    }
    beginPoll(id, epoch) {
        const row = this.db.prepare("UPDATE quota_connections SET generation=generation+1 WHERE id=? AND epoch=? RETURNING generation").get(id, epoch);
        return row ? Number(row.generation) : null;
    }
    configurationError(requestedId) {
        const id = idOk(requestedId) ? requestedId : "quota-source-invalid";
        const epoch = this.register(id, "invalid-source-configuration"), generation = this.beginPoll(id, epoch);
        if (generation !== null)
            this.failed(id, epoch, generation, "source_configuration_invalid");
    }
    publish(id, epoch, generation, snapshot) {
        const row = this.connection(id);
        if (!row || row.epoch !== epoch || row.generation !== generation)
            return false;
        if (row.snapshot_json) {
            let previous;
            try {
                previous = savedSnapshot(row.snapshot_json, id);
            }
            catch { /* only a verified background refresh may replace corrupt cache; GET still refuses it */ }
            if (previous?.sourceObservedAt && (!snapshot.sourceObservedAt || previous.sourceObservedAt > snapshot.sourceObservedAt))
                return false;
        }
        return Number(this.db.prepare("UPDATE quota_connections SET snapshot_json=?,error_code=NULL WHERE id=? AND epoch=? AND generation=?").run(JSON.stringify(snapshot), id, epoch, generation).changes) === 1;
    }
    failed(id, epoch, generation, code) {
        this.db.prepare("UPDATE quota_connections SET error_code=? WHERE id=? AND epoch=? AND generation=?").run(code, id, epoch, generation);
    }
    read(options = {}) {
        const limit = options.limit ?? 200;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new Error("Invalid resource limit");
        const rows = (options.connectionId ? this.db.prepare("SELECT * FROM quota_connections WHERE id=?").all(options.connectionId) : this.db.prepare("SELECT * FROM quota_connections ORDER BY id").all());
        const connections = rows.map(row => {
            const snapshot = row.snapshot_json ? savedSnapshot(row.snapshot_json, row.id) : null;
            const freshness = !snapshot || !snapshot.sourceObservedAt ? "unavailable" : row.error_code || Date.parse(snapshot.expiresAt) <= Date.now() ? "stale" : "fresh";
            return { connectionId: row.id, status: row.error_code ? "unavailable" : snapshot ? "observed" : "not_observed", errorCode: row.error_code,
                snapshotId: snapshot?.snapshotId ?? null, collectedAt: snapshot?.collectedAt ?? null, sourceObservedAt: snapshot?.sourceObservedAt ?? null, expiresAt: snapshot?.expiresAt ?? null, freshness };
        });
        const candidates = rows.flatMap(row => {
            const snapshot = row.snapshot_json ? savedSnapshot(row.snapshot_json, row.id) : null;
            return (snapshot?.observations ?? []).filter(item => options.modelId === undefined || item.modelId === options.modelId).map(item => ({ ...item, connectionId: row.id, snapshotId: snapshot.snapshotId, sourceObservedAt: snapshot.sourceObservedAt, collectedAt: snapshot.collectedAt }));
        }).sort((a, b) => (b.sourceObservedAt ?? b.collectedAt).localeCompare(a.sourceObservedAt ?? a.collectedAt));
        const unique = new Map();
        for (const item of candidates) {
            const key = `${item.scopeId}:${item.modelId}`;
            const prior = unique.get(key);
            if (prior)
                prior.connectionIds.push(item.connectionId);
            else
                unique.set(key, { ...item, connectionIds: [item.connectionId] });
        }
        const observations = [...unique.values()].sort((a, b) => `${a.scopeId}:${a.modelId}`.localeCompare(`${b.scopeId}:${b.modelId}`));
        // Explicitly partial; no pool total or spendable balance is inferred.
        return { schemaVersion: QUOTA_RESOURCE_SCHEMA, readOnly: true, connections, observations: observations.slice(0, limit), truncated: observations.length > limit,
            attribution: "connection_only", actualTaskCredits: null, actualTaskTokens: null };
    }
    connection(id) {
        return this.db.prepare("SELECT * FROM quota_connections WHERE id=?").get(id);
    }
}
export class WorkBuddyQuotaCollector {
    store;
    source;
    statistics;
    epoch;
    flight;
    controller;
    timer;
    stopped = false;
    failures = 0;
    nextDue = 0;
    constructor(store, source) {
        this.store = store;
        this.statistics = new LocalStatisticsClient(source);
        for (const [value, min, max] of [[source.intervalMs ?? 30000, 1000, 3600000], [source.maxAgeMs ?? 90000, 1000, 86400000], [source.timeoutMs ?? 5000, 50, 30000]]) {
            if (!Number.isInteger(value) || value < min || value > max)
                throw new Error("Invalid quota collection interval");
        }
        this.source = Object.freeze({ ...source, baseUrl: this.statistics.origin });
        this.epoch = store.register(source.id, hash(JSON.stringify([this.statistics.origin, source.apiKey, source.panelToken ?? null, source.maxAgeMs ?? 90000, source.intervalMs ?? 30000])));
    }
    collect() {
        if (this.stopped || Date.now() < this.nextDue)
            return Promise.resolve();
        if (this.flight)
            return this.flight;
        const promise = this.poll().finally(() => { if (this.flight === promise)
            this.flight = undefined; });
        this.flight = promise;
        return promise;
    }
    start() {
        if (this.stopped || this.timer)
            return;
        const tick = async () => { this.timer = undefined; try {
            await this.collect();
        }
        catch {
            this.nextDue = Date.now() + 30000;
        } if (!this.stopped) {
            this.timer = setTimeout(tick, Math.max(1000, this.nextDue - Date.now()));
            this.timer.unref();
        } };
        this.timer = setTimeout(tick, 0);
        this.timer.unref();
    }
    async stop() { this.stopped = true; if (this.timer)
        clearTimeout(this.timer); this.controller?.abort(); await this.flight; }
    async poll() {
        const generation = this.store.beginPoll(this.source.id, this.epoch);
        if (generation === null) {
            this.stopped = true;
            return;
        }
        const controller = new AbortController();
        this.controller = controller;
        const timeout = setTimeout(() => controller.abort(), this.source.timeoutMs ?? 5000);
        timeout.unref();
        let code = "source_unavailable";
        try {
            const payload = await this.statistics.read("/usage/remaining", controller.signal);
            code = "source_invalid";
            const snapshot = this.normalize(payload);
            if (!this.stopped)
                this.store.publish(this.source.id, this.epoch, generation, snapshot);
            this.failures = 0;
            this.nextDue = Date.now() + (this.source.intervalMs ?? 30000);
        }
        catch (error) {
            if (error instanceof StatisticsSourceError)
                code = error.code;
            if (controller.signal.aborted)
                code = "source_timeout";
            if (!this.stopped) {
                this.failures++;
                this.nextDue = Date.now() + Math.min(300000, (this.source.intervalMs ?? 30000) * 2 ** Math.min(this.failures - 1, 8));
                this.store.failed(this.source.id, this.epoch, generation, code);
            }
        }
        finally {
            clearTimeout(timeout);
            if (this.controller === controller)
                this.controller = undefined;
        }
    }
    normalize(payload) {
        if (!Array.isArray(payload.rows) || payload.rows.length > 2000)
            throw Error("source_invalid");
        const sourceObservedAt = timestamp(payload.generated_at);
        if (sourceObservedAt && Date.parse(sourceObservedAt) > Date.now() + 30000)
            throw Error("source_invalid");
        const collectedAt = new Date().toISOString(), seen = new Set();
        const observations = payload.rows.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                throw Error("source_invalid");
            const row = item;
            if (typeof row.uid !== "string" || !row.uid || row.uid.length > 200 || typeof row.model !== "string" || !row.model || row.model.length > 200 || !['cn', 'intl'].includes(String(row.realm)))
                throw Error("source_invalid");
            const scopeId = this.store.anonymize(this.source.baseUrl, String(row.realm), row.uid), key = `${scopeId}:${row.model}`;
            if (seen.has(key))
                throw Error("source_invalid");
            seen.add(key);
            const used = numberOrNull(row.used), budget = numberOrNull(row.budget), remaining = numberOrNull(row.remaining), resetAt = timestamp(row.reset_at);
            if (row.cooling !== true && row.cooling !== false)
                throw Error("source_invalid");
            if (row.cooling === true && remaining !== 0)
                throw Error("source_invalid");
            const exhausted = row.cooling === true && remaining === 0 && resetAt !== null && Date.parse(resetAt) > Date.now();
            return { scopeId, scopeKind: "gateway_pool", shared: true, modelId: row.model, realm: String(row.realm), unit: "tokens",
                valueKind: budget !== null || remaining !== null ? "estimated" : "unavailable", availability: exhausted ? "exhausted" : remaining !== null && remaining > 0 ? "available" : "unknown",
                used, budget, remaining, resetAt, method: exhausted ? "source_cooling_and_historical_budget" : "historical_budget_minus_observed_usage",
                limitations: ["routing_unverified", "shared_pool", "budget_estimated", "gateway_observed_usage_only", "task_attribution_unavailable"] };
        });
        return { snapshotId: randomBytes(18).toString("base64url"), connectionId: this.source.id, collectedAt, sourceObservedAt,
            expiresAt: new Date(Math.min(Date.now(), sourceObservedAt ? Date.parse(sourceObservedAt) : Date.now()) + (this.source.maxAgeMs ?? 90000)).toISOString(), observations };
    }
}
//# sourceMappingURL=quota-observation.js.map