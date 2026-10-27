export type StatisticsErrorCode = "source_unavailable" | "source_unauthorized" | "source_unsupported" | "source_invalid" | "source_timeout";
export class StatisticsSourceError extends Error {
  constructor(readonly code: StatisticsErrorCode) { super(code); this.name = "StatisticsSourceError"; }
}
export interface StatisticsCredentials { baseUrl: string; apiKey: string; panelToken?: string }

/** Fixed read-only statistics paths. No login, upstream refresh or model calls. */
export class LocalStatisticsClient {
  readonly origin: string;
  private readonly credentials: Readonly<StatisticsCredentials>;
  constructor(input: StatisticsCredentials) {
    const url = new URL(input.baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Statistics source must be an explicit loopback HTTP origin");
    if (typeof input.apiKey !== "string" || !input.apiKey || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey) ||
      (input.panelToken !== undefined && (typeof input.panelToken !== "string" || input.panelToken.length > 8192 || /[\r\n]/.test(input.panelToken)))) throw new Error("Invalid local statistics credentials");
    this.origin = url.origin;
    this.credentials = Object.freeze({ ...input, baseUrl: url.origin });
  }
  async read(endpoint: "/usage/remaining" | "/v1/balance-summary", signal: AbortSignal): Promise<unknown> {
    if (!["/usage/remaining", "/v1/balance-summary"].includes(endpoint)) throw new StatisticsSourceError("source_unsupported");
    try {
      const response = await fetch(new URL(endpoint, this.origin), { method: "GET", redirect: "error", signal,
        headers: { authorization: `Bearer ${this.credentials.apiKey}`, ...(this.credentials.panelToken ? { "X-Panel-Token": this.credentials.panelToken } : {}) } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new StatisticsSourceError(response.status === 401 || response.status === 403 ? "source_unauthorized" : response.status === 404 || response.status === 501 ? "source_unsupported" : "source_unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new StatisticsSourceError("source_invalid");
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1024 * 1024) { await reader.cancel(); throw new StatisticsSourceError("source_invalid"); }
        chunks.push(next.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new StatisticsSourceError("source_invalid"); }
    } catch (error) {
      if (signal.aborted) throw new StatisticsSourceError("source_timeout");
      if (error instanceof StatisticsSourceError) throw error;
      throw new StatisticsSourceError("source_unavailable");
    }
  }
}
