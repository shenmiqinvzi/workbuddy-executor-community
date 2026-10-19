export interface NativeRateLimit {
    kind: "rate_limited";
    statusCode: 429;
    phase?: "session:sendMessage" | "native_history";
    retryAfterSeconds?: number;
    observedAt: string;
}
/** Describe the observed native error without inferring account quota or retrying. */
export declare function diagnoseNativeFailure(error: string, observedAt: string, phase?: NativeRateLimit["phase"]): {
    message: string;
    rateLimit?: NativeRateLimit;
};
/** Some desktop versions resolve sendMessage while recording provider errors
 * as incomplete assistant messages rather than RPC errors. Read only this
 * session's bounded native history, correlated with the exact wake marker. */
export declare function readNativeTurnFailure(configDir: string, sessionId: string, wake: {
    wakeId: string;
    createdAt: string;
}): {
    wakeId: string;
    error: string;
    observedAt: string;
    phase: "native_history";
} | undefined;
