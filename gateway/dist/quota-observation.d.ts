import type { DatabaseSync } from "node:sqlite";
import { type StatisticsErrorCode } from "./local-statistics-client.js";
export declare const QUOTA_RESOURCE_SCHEMA = "workbuddy-executor/quota-1";
type QuotaErrorCode = StatisticsErrorCode | "source_configuration_invalid";
export interface QuotaObservation {
    scopeId: string;
    scopeKind: "gateway_pool";
    shared: true;
    modelId: string;
    realm: string;
    unit: "tokens";
    valueKind: "estimated" | "unavailable";
    availability: "available" | "exhausted" | "unknown";
    used: number | null;
    budget: number | null;
    remaining: number | null;
    resetAt: string | null;
    method: string;
    limitations: string[];
}
export interface QuotaSnapshot {
    snapshotId: string;
    connectionId: string;
    collectedAt: string;
    sourceObservedAt: string | null;
    expiresAt: string;
    observations: QuotaObservation[];
}
/** Stored resource observations are independent of task revision and lifecycle. */
export declare class QuotaStore {
    private readonly db;
    private readonly salt;
    constructor(db: DatabaseSync);
    register(id: string, fingerprint: string): string;
    anonymize(origin: string, realm: string, uid: string): string;
    beginPoll(id: string, epoch: string): number | null;
    configurationError(requestedId: string): void;
    publish(id: string, epoch: string, generation: number, snapshot: QuotaSnapshot): boolean;
    failed(id: string, epoch: string, generation: number, code: QuotaErrorCode): void;
    read(options?: {
        connectionId?: string;
        modelId?: string;
        limit?: number;
    }): {
        schemaVersion: string;
        readOnly: true;
        connections: {
            connectionId: string;
            status: string;
            errorCode: string | null;
            snapshotId: string | null;
            collectedAt: string | null;
            sourceObservedAt: string | null;
            expiresAt: string | null;
            freshness: string;
        }[];
        observations: ({
            connectionId: string;
            snapshotId: string;
            sourceObservedAt: string | null;
            collectedAt: string;
            scopeId: string;
            scopeKind: "gateway_pool";
            shared: true;
            modelId: string;
            realm: string;
            unit: "tokens";
            valueKind: "estimated" | "unavailable";
            availability: "available" | "exhausted" | "unknown";
            used: number | null;
            budget: number | null;
            remaining: number | null;
            resetAt: string | null;
            method: string;
            limitations: string[];
        } & {
            connectionIds: string[];
        })[];
        truncated: boolean;
        attribution: "connection_only";
        actualTaskCredits: null;
        actualTaskTokens: null;
    };
    private connection;
}
/** WorkBuddy2API owns its authentication. Keys are memory-only and never sent
 * to the browser. Some deployments also require an existing panel token. */
export interface WorkBuddyQuotaConnection {
    id: string;
    baseUrl: string;
    apiKey: string;
    panelToken?: string;
    intervalMs?: number;
    maxAgeMs?: number;
    timeoutMs?: number;
}
export declare class WorkBuddyQuotaCollector {
    private readonly store;
    private readonly source;
    private readonly statistics;
    private readonly epoch;
    private flight?;
    private controller?;
    private timer?;
    private stopped;
    private failures;
    private nextDue;
    constructor(store: QuotaStore, source: WorkBuddyQuotaConnection);
    collect(): Promise<void>;
    start(): void;
    stop(): Promise<void>;
    private poll;
    private normalize;
}
export {};
