/** Read only the requested session's last user message. Missing/truncated proof fails closed. */
export declare function latestNativeWake(configDir: string, sessionId: string): string | undefined;
