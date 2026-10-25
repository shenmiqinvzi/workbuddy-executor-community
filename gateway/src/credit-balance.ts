import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LocalStatisticsClient, StatisticsSourceError, type StatisticsErrorCode } from "./local-statistics-client.js";
import type { QuotaStore } from "./quota-observation.js";

export const CREDIT_BALANCE_SCHEMA = "workbuddy-executor/credit-balance-1";
export interface CreditBalanceSnapshot {
  snapshotId: string; connectionId: string; scopeId: string; realm: "cn" | "intl";
  unit: "credit"; valueKind: "reported_cache"; balance: number | null;
  accountsEnabled: number; accountsWithData: number; coverage: "complete" | "partial" | "unavailable";
  latestMemberObservedAt: string | null; collectedAt: string; cacheExpiresAt: string;
}
interface ConnectionRow { id: string; fingerprint: string; epoch: string; generation: number; snapshot_json: string | null; error_code: string | null }
type CollectionError = StatisticsErrorCode | "source_configuration_invalid";
const validId = (id: string) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id);
const fail = (): never => { throw new StatisticsSourceError("source_invalid"); };

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}
function amount(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) return fail();
  return value;
}
function decode(raw: string, id: string): CreditBalanceSnapshot {
  try {
    const value = JSON.parse(raw) as CreditBalanceSnapshot;
    const iso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    if (!value || value.connectionId !== id || !/^[A-Za-z0-9_-]{20,100}$/.test(value.snapshotId) || !/^pool-[a-f0-9]{32}$/.test(value.scopeId) || !["cn", "intl"].includes(value.realm) ||
      value.unit !== "credit" || value.valueKind !== "reported_cache" || !iso(value.collectedAt) || !iso(value.cacheExpiresAt) || (value.latestMemberObservedAt !== null && !iso(value.latestMemberObservedAt)) ||
      Object.keys(value).length !== 13 || Object.keys(value).some(key => !["snapshotId", "connectionId", "scopeId", "realm", "unit", "valueKind", "balance", "accountsEnabled", "accountsWithData", "coverage", "latestMemberObservedAt", "collectedAt", "cacheExpiresAt"].includes(key))) throw Error();
    const enabled = count(value.accountsEnabled), known = count(value.accountsWithData), balance = amount(value.balance);
    const coverage = known === 0 ? "unavailable" : known === enabled ? "complete" : "partial";
    if (known > enabled || (known === 0) !== (balance === null) || value.coverage !== coverage) throw Error();
    return value;
  } catch { throw new Error("credit_resource_corrupt"); }
}

/** Region summaries have their own table, schema and unit; they never replace
 * token-estimate rows or task usage. Account identities are not accepted. */
export class CreditBalanceStore {
  constructor(private readonly db: DatabaseSync, private readonly scopes: QuotaStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS credit_balance_connections (
      id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,epoch TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,snapshot_json TEXT,error_code TEXT);`);
  }
  register(id: string, fingerprint: string): string {
    if (!validId(id)) throw new Error("Invalid credit source identifier");
    const previous = this.connection(id);
    if (previous?.fingerprint === fingerprint) return previous.epoch;
    if (!previous && Number(this.db.prepare("SELECT COUNT(*) AS n FROM credit_balance_connections").get()!.n) >= 16) throw new Error("Credit source limit reached");
    const epoch = randomBytes(18).toString("base64url");
    this.db.prepare("INSERT INTO credit_balance_connections (id,fingerprint,epoch) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,epoch=excluded.epoch,generation=0,snapshot_json=NULL,error_code=NULL").run(id, fingerprint, epoch);
    return epoch;
  }
  configurationError(id: string): void {
    const safeId = validId(id) ? id : "credit-source-invalid", epoch = this.register(safeId, "invalid-source-configuration");
    const generation = this.begin(safeId, epoch);
    if (generation !== null) this.failed(safeId, epoch, generation, "source_configuration_invalid");
  }
  begin(id: string, epoch: string): number | null {
    const row = this.db.prepare("UPDATE credit_balance_connections SET generation=generation+1 WHERE id=? AND epoch=? RETURNING generation").get(id, epoch);
    return row ? Number(row.generation) : null;
  }
  scope(origin: string, realm: string): string { return this.scopes.anonymize(origin, realm, "region-credit-summary"); }
  publish(id: string, epoch: string, generation: number, snapshot: CreditBalanceSnapshot): boolean {
    decode(JSON.stringify(snapshot), id);
    const previous = this.connection(id);
    if (!previous || previous.epoch !== epoch || previous.generation !== generation) return false;
    if (previous.snapshot_json) {
      let prior:CreditBalanceSnapshot|undefined;
      try {prior=decode(previous.snapshot_json,id);}catch{/* a validated refresh can repair a resource cache; never a GET */}
      if (prior?.latestMemberObservedAt && (!snapshot.latestMemberObservedAt || prior.latestMemberObservedAt > snapshot.latestMemberObservedAt)) return false;
    }
    return Number(this.db.prepare("UPDATE credit_balance_connections SET snapshot_json=?,error_code=NULL WHERE id=? AND epoch=? AND generation=?").run(JSON.stringify(snapshot), id, epoch, generation).changes) === 1;
  }
  failed(id: string, epoch: string, generation: number, code: CollectionError): void {
    this.db.prepare("UPDATE credit_balance_connections SET error_code=? WHERE id=? AND epoch=? AND generation=?").run(code, id, epoch, generation);
  }
  read(connectionId?: string) {
    const rows = (connectionId ? this.db.prepare("SELECT * FROM credit_balance_connections WHERE id=?").all(connectionId) : this.db.prepare("SELECT * FROM credit_balance_connections ORDER BY id").all()) as unknown as ConnectionRow[];
    const connections = rows.map(row => {
      const snapshot = row.snapshot_json ? decode(row.snapshot_json, row.id) : null;
      const cacheFreshness = !snapshot ? "unavailable" : row.error_code || Date.parse(snapshot.cacheExpiresAt) <= Date.now() ? "stale" : "fresh";
      return { connectionId: row.id, status: row.error_code ? "unavailable" : snapshot ? "observed" : "not_observed", errorCode: row.error_code,
        snapshotId: snapshot?.snapshotId ?? null, collectedAt: snapshot?.collectedAt ?? null, cacheFreshness };
    });
    const candidates = rows.flatMap(row => row.snapshot_json ? [{ ...decode(row.snapshot_json, row.id), errorCode: row.error_code }] : [])
      .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
    const balances = new Map<string, (typeof candidates)[number] & { connectionIds: string[] }>();
    for (const item of candidates) { const prior = balances.get(item.scopeId); if (prior) prior.connectionIds.push(item.connectionId); else balances.set(item.scopeId, { ...item, connectionIds: [item.connectionId] }); }
    return { schemaVersion: CREDIT_BALANCE_SCHEMA, readOnly: true as const,
      connections, balances: [...balances.values()].map(item => ({ ...item, shared: true as const, scopeKind: "gateway_region_pool" as const,
        balanceFreshness: item.latestMemberObservedAt && Date.parse(item.latestMemberObservedAt) < Date.now() - (Date.parse(item.cacheExpiresAt)-Date.parse(item.collectedAt)) ? "stale" : "unavailable",
        limitations: ["shared_region_pool", "routing_unverified", "latest_member_timestamp_only", "member_freshness_unavailable", "task_attribution_unavailable"] })),
      actualTaskCredits: null, attribution: "connection_only" as const };
  }
  private connection(id: string): ConnectionRow | undefined { return this.db.prepare("SELECT * FROM credit_balance_connections WHERE id=?").get(id) as unknown as ConnectionRow | undefined; }
}

export interface CreditBalanceConnection { id: string; baseUrl: string; apiKey: string; intervalMs?: number; maxAgeMs?: number; timeoutMs?: number }

export class WorkBuddyCreditBalanceCollector {
  private readonly source: Readonly<CreditBalanceConnection>;
  private readonly client: LocalStatisticsClient;
  private readonly epoch: string;
  private flight?: Promise<void>; private controller?: AbortController; private timer?: ReturnType<typeof setTimeout>;
  private stopped = false; private failures = 0; private nextDue = 0;
  constructor(private readonly store: CreditBalanceStore, input: CreditBalanceConnection) {
    this.client = new LocalStatisticsClient({ baseUrl: input.baseUrl, apiKey: input.apiKey });
    for (const [value, min, max] of [[input.intervalMs ?? 30000, 1000, 3600000], [input.maxAgeMs ?? 90000, 1000, 86400000], [input.timeoutMs ?? 5000, 50, 30000]] as const) if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid credit collection interval");
    this.source = Object.freeze({ ...input, baseUrl: this.client.origin });
    const fingerprint = createHash("sha256").update(JSON.stringify([this.client.origin, input.apiKey, input.intervalMs ?? 30000, input.maxAgeMs ?? 90000])).digest("hex");
    this.epoch = store.register(input.id, fingerprint);
  }
  collect(): Promise<void> {
    if (this.stopped || Date.now() < this.nextDue) return Promise.resolve();
    if (this.flight) return this.flight;
    const promise = this.poll().finally(() => { if (this.flight === promise) this.flight = undefined; }); this.flight = promise; return promise;
  }
  start(): void {
    if (this.stopped || this.timer) return;
    const tick = async () => { this.timer = undefined; try { await this.collect(); } catch { this.nextDue = Date.now() + 30000; }
      if (!this.stopped) { this.timer = setTimeout(tick, Math.max(1000, this.nextDue - Date.now())); this.timer.unref(); } };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); await this.flight; }
  private async poll(): Promise<void> {
    const generation = this.store.begin(this.source.id, this.epoch); if (generation === null) { this.stopped = true; return; }
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), this.source.timeoutMs ?? 5000); timeout.unref();
    try {
      const payload = await this.client.read("/v1/balance-summary", controller.signal);
      const snapshot = this.normalize(payload);
      if (!this.stopped) this.store.publish(this.source.id, this.epoch, generation, snapshot);
      this.failures = 0; this.nextDue = Date.now() + (this.source.intervalMs ?? 30000);
    } catch (error) {
      if (!this.stopped) { this.failures++; this.nextDue = Date.now() + Math.min(300000, (this.source.intervalMs ?? 30000) * 2 ** Math.min(this.failures - 1, 8));
        this.store.failed(this.source.id, this.epoch, generation, error instanceof StatisticsSourceError ? error.code : "source_invalid"); }
    } finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; }
  }
  private normalize(input: unknown): CreditBalanceSnapshot {
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
    const payload = input as Record<string, unknown>;
    if (payload.unit !== "credit" || (payload.realm !== "cn" && payload.realm !== "intl")) return fail();
    const balance = amount(payload.balance), enabled = count(payload.accounts_enabled), known = count(payload.accounts_with_credit_data);
    if (known > enabled || (known === 0) !== (balance === null)) return fail();
    let latestMemberObservedAt: string | null = null;
    if (payload.updated_at !== null) {
      if (typeof payload.updated_at !== "number" || !Number.isFinite(payload.updated_at) || payload.updated_at < 0 || payload.updated_at > Date.now() / 1000 + 30) return fail();
      latestMemberObservedAt = new Date(payload.updated_at * 1000).toISOString();
    }
    return { snapshotId: randomBytes(18).toString("base64url"), connectionId: this.source.id, scopeId: this.store.scope(this.client.origin, payload.realm), realm: payload.realm,
      unit: "credit", valueKind: "reported_cache", balance, accountsEnabled: enabled, accountsWithData: known, coverage: known === 0 ? "unavailable" : known === enabled ? "complete" : "partial",
      latestMemberObservedAt, collectedAt: new Date().toISOString(), cacheExpiresAt: new Date(Date.now() + (this.source.maxAgeMs ?? 90000)).toISOString() };
  }
}
