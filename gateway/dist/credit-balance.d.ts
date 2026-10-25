import type { DatabaseSync } from "node:sqlite";
import { type StatisticsErrorCode } from "./local-statistics-client.js";
import type { QuotaStore } from "./quota-observation.js";
export declare const CREDIT_BALANCE_SCHEMA = "workbuddy-executor/credit-balance-1";
export interface CreditBalanceSnapshot {
    snapshotId: string;
    connectionId: string;
    scopeId: string;
    realm: "cn" | "intl";
    unit: "credit";
    valueKind: "reported_cache";
    balance: number | null;
    accountsEnabled: number;
    accountsWithData: number;
    coverage: "complete" | "partial" | "unavailable";
    latestMemberObservedAt: string | null;
    collectedAt: string;
    cacheExpiresAt: string;
}
type CollectionError = StatisticsErrorCode | "source_configuration_invalid";
/** Region summaries have their own table, schema and unit; they never replace
 * token-estimate rows or task usage. Account identities are not accepted. */
export declare class CreditBalanceStore {
    private readonly db;
    private readonly scopes;
    constructor(db: DatabaseSync, scopes: QuotaStore);
    register(id: string, fingerprint: string): string;
    configurationError(id: string): void;
    begin(id: string, epoch: string): number | null;
    scope(origin: string, realm: string): string;
    publish(id: string, epoch: string, generation: number, snapshot: CreditBalanceSnapshot): boolean;
    failed(id: string, epoch: string, generation: number, code: CollectionError): void;
    read(connectionId?: string): {
        schemaVersion: string;
        readOnly: true;
        connections: {
            connectionId: string;
            status: string;
            errorCode: string | null;
            snapshotId: string | null;
            collectedAt: string | null;
            cacheFreshness: string;
        }[];
        balances: {
            shared: true;
            scopeKind: "gateway_region_pool";
            balanceFreshness: string;
            limitations: string[];
            errorCode: string | null;
            snapshotId: string;
            connectionId: string;
            scopeId: string;
            realm: "cn" | "intl";
            unit: "credit";
            valueKind: "reported_cache";
            balance: number | null;
            accountsEnabled: number;
            accountsWithData: number;
            coverage: "complete" | "partial" | "unavailable";
            latestMemberObservedAt: string | null;
            collectedAt: string;
            cacheExpiresAt: string;
            connectionIds: string[];
        }[];
        actualTaskCredits: null;
        attribution: "connection_only";
    };
    private connection;
}
export interface CreditBalanceConnection {
    id: string;
    baseUrl: string;
    apiKey: string;
    intervalMs?: number;
    maxAgeMs?: number;
    timeoutMs?: number;
}
export declare class WorkBuddyCreditBalanceCollector {
    private readonly store;
    private readonly source;
    private readonly client;
    private readonly epoch;
    private flight?;
    private controller?;
    private timer?;
    private stopped;
    private failures;
    private nextDue;
    constructor(store: CreditBalanceStore, input: CreditBalanceConnection);
    collect(): Promise<void>;
    start(): void;
    stop(): Promise<void>;
    private poll;
    private normalize;
}
export {};
