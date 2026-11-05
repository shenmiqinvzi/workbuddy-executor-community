export type StatisticsErrorCode = "source_unavailable" | "source_unauthorized" | "source_unsupported" | "source_invalid" | "source_timeout";
export class StatisticsSourceError extends Error {
  constructor(readonly code: StatisticsErrorCode) { super(code); this.name = "StatisticsSourceError"; }
}
export interface StatisticsCredentials { baseUrl: string; apiKey: string; panelToken?: string }

/**
 * The one place that decides what a statistics origin may be: an explicit
 * loopback literal over plain HTTP, with no credentials in the URL, no path,
 * no query and no fragment. A declared connection and the transport share this
 * rule, so a declaration can never name an origin the client would refuse (or
 * a public host the client would happily proxy).
 */
export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Statistics source must be an explicit loopback HTTP origin");
  return url.origin;
}

/** Fixed read-only statistics paths. No login, upstream refresh or model calls. */
export class LocalStatisticsClient {
  readonly origin: string;
  private readonly credentials: Readonly<StatisticsCredentials>;
  constructor(input: StatisticsCredentials) {
    const origin = loopbackOrigin(input.baseUrl);
    if (typeof input.apiKey !== "string" || !input.apiKey || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey) ||
      (input.panelToken !== undefined && (typeof input.panelToken !== "string" || input.panelToken.length > 8192 || /[\r\n]/.test(input.panelToken)))) throw new Error("Invalid local statistics credentials");
    this.origin = origin;
    this.credentials = Object.freeze({ ...input, baseUrl: origin });
  }
  async read(endpoint: "/usage/remaining" | "/v1/balance-summary" | "/v1/models", signal: AbortSignal): Promise<unknown> {
    if (!["/usage/remaining", "/v1/balance-summary", "/v1/models"].includes(endpoint)) throw new StatisticsSourceError("source_unsupported");
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
