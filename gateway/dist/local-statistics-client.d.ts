export type StatisticsErrorCode = "source_unavailable" | "source_unauthorized" | "source_unsupported" | "source_invalid" | "source_timeout";
export declare class StatisticsSourceError extends Error {
    readonly code: StatisticsErrorCode;
    constructor(code: StatisticsErrorCode);
}
export interface StatisticsCredentials {
    baseUrl: string;
    apiKey: string;
    panelToken?: string;
}
/** Fixed read-only statistics paths. No login, upstream refresh or model calls. */
export declare class LocalStatisticsClient {
    readonly origin: string;
    private readonly credentials;
    constructor(input: StatisticsCredentials);
    read(endpoint: "/usage/remaining" | "/v1/balance-summary" | "/v1/models", signal: AbortSignal): Promise<unknown>;
}
