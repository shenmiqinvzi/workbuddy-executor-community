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
} | undefined;
