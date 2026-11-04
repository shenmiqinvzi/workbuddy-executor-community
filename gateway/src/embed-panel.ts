/**
 * One optional embedded page inside the workbench window.
 *
 * Which page that is belongs to whoever installed the gateway, not to this
 * repository: with nothing configured the workbench shows no extra view and
 * the desktop shell keeps cancelling every sub-frame. An installer opts in by
 * naming a loopback HTTP origin, and only that origin is allowed through both
 * the shell frame policy and the page's CSP.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_TITLE = "嵌入面板";
const MAX_TITLE_LENGTH = 40;

export interface EmbedPanel {
  /** Absolute URL the panel loads. Paths are allowed, queries are not. */
  url: string;
  /** Sidebar and page heading text, from the installer's environment. */
  title: string;
  /** Scheme, host and port only; this is what the policies compare. */
  origin: string;
}

export interface EmbedConfig {
  panel: EmbedPanel | null;
  /** Origins the shell and the page CSP may frame; empty means none. */
  origins: string[];
}

/**
 * Only plain HTTP on a loopback host qualifies: a remote dashboard would make
 * the workbench a window onto the network, which this stage does not offer.
 */
function parseLoopback(raw: string | undefined, options: { allowPath: boolean }): URL | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  let url: URL;
  try { url = new URL(value); }
  catch { return null; }
  if (url.protocol !== "http:") return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (!options.allowPath && url.pathname !== "/" && url.pathname !== "") return null;
  return url;
}

export function parseEmbedUrl(raw: string | undefined): { url: string; origin: string } | null {
  const url = parseLoopback(raw, { allowPath: true });
  return url === null ? null : { url: url.toString(), origin: url.origin };
}

/** Invalid entries are skipped rather than thrown: a typo must not stop the workbench. */
export function parseEmbedOrigins(raw: string | undefined): string[] {
  const origins = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const url = parseLoopback(part, { allowPath: false });
    if (url !== null) origins.add(url.origin);
  }
  return [...origins];
}

function embedTitle(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_TITLE;
  return value.length > MAX_TITLE_LENGTH ? value.slice(0, MAX_TITLE_LENGTH) : value;
}

export function readEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig {
  const resolved = parseEmbedUrl(env.WORKBUDDY_WORKBENCH_EMBED_URL);
  const origins = parseEmbedOrigins(env.WORKBUDDY_WORKBENCH_EMBED_ORIGINS);
  if (resolved !== null && !origins.includes(resolved.origin)) origins.unshift(resolved.origin);
  return {
    panel: resolved === null ? null : { ...resolved, title: embedTitle(env.WORKBUDDY_WORKBENCH_EMBED_TITLE) },
    origins,
  };
}
