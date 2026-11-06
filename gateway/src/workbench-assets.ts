import fs from "node:fs";
import type { ServerResponse } from "node:http";

// Exact public-file allowlist: URLs can never become arbitrary filesystem paths.
const assets: Record<string, [string, string]> = {
  "/workbench/": ["index.html", "text/html; charset=utf-8"],
  "/workbench/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"],
  "/workbench/resources.mjs": ["resources.mjs", "text/javascript; charset=utf-8"],
  "/workbench/resources-source.mjs": ["resources-source.mjs", "text/javascript; charset=utf-8"],
  "/workbench/resources-model.mjs": ["resources-model.mjs", "text/javascript; charset=utf-8"],
  "/workbench/resources.css": ["resources.css", "text/css; charset=utf-8"],
  "/workbench/model.mjs": ["model.mjs", "text/javascript; charset=utf-8"],
  "/workbench/task-link.mjs": ["task-link.mjs", "text/javascript; charset=utf-8"],
  "/workbench/dispatch.mjs": ["dispatch.mjs", "text/javascript; charset=utf-8"],
  "/workbench/plan-reference.mjs": ["plan-reference.mjs", "text/javascript; charset=utf-8"],
  "/workbench/dispatch.css": ["dispatch.css", "text/css; charset=utf-8"],
  "/workbench/attention.mjs": ["attention.mjs", "text/javascript; charset=utf-8"],
  "/workbench/controls.mjs": ["controls.mjs", "text/javascript; charset=utf-8"],
  "/workbench/controls.css": ["controls.css", "text/css; charset=utf-8"],
  "/workbench/http-source.mjs": ["http-source.mjs", "text/javascript; charset=utf-8"],
  "/workbench/demo-source.mjs": ["demo-source.mjs", "text/javascript; charset=utf-8"],
  "/workbench/style.css": ["style.css", "text/css; charset=utf-8"],
  "/workbench/statistics.mjs": ["statistics.mjs", "text/javascript; charset=utf-8"],
  "/workbench/statistics.css": ["statistics.css", "text/css; charset=utf-8"],
  "/workbench/productivity.mjs": ["productivity.mjs", "text/javascript; charset=utf-8"],
  "/workbench/productivity.css": ["productivity.css", "text/css; charset=utf-8"],
  "/workbench/automation.mjs": ["automation.mjs", "text/javascript; charset=utf-8"],
  "/workbench/automation.css": ["automation.css", "text/css; charset=utf-8"],
  "/workbench/fonts/plex-sans.woff2": ["fonts/plex-sans.woff2", "font/woff2"],
  "/workbench/fonts/plex-mono.woff2": ["fonts/plex-mono.woff2", "font/woff2"],
  "/workbench/fonts/ibmplexsans-OFL.txt": ["fonts/ibmplexsans-OFL.txt", "text/plain; charset=utf-8"],
  "/workbench/fonts/ibmplexmono-OFL.txt": ["fonts/ibmplexmono-OFL.txt", "text/plain; charset=utf-8"],
};

export function serveWorkbenchAsset(pathname: string, response: ServerResponse, embedOrigins: readonly string[] = []): boolean {
  if (pathname === "/workbench") { response.writeHead(308, { location: "/workbench/", "cache-control": "no-store" }); response.end(); return true; }
  const entry = assets[pathname];
  if (!entry) return false;
  // Nothing may be framed unless the installer named the origin; the default
  // stays 'none' so an unconfigured workbench cannot load a third-party page.
  const frameSrc = embedOrigins.length === 0 ? "'none'" : embedOrigins.join(" ");
  try {
    const body = fs.readFileSync(new URL(`../workbench/${entry[0]}`, import.meta.url));
    response.writeHead(200, {
      "content-type": entry[1], "cache-control": "no-store", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${frameSrc}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    });
    response.end(body);
  } catch { response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); response.end("Workbench assets are unavailable. Check this gateway package."); }
  return true;
}
