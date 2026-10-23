#!/usr/bin/env node
/**
 * Regenerate SNAPSHOT_MANIFEST.json from the version-controlled files.
 *
 * The manifest lists every file Git tracks under this directory, except the two
 * that describe the snapshot rather than belong to it:
 *   - SNAPSHOT_MANIFEST.json itself
 *   - RUNTIME_BASELINE.json, the historical baseline record
 *
 * Everything else comes from `git ls-files`, so untracked local state, ignored
 * data directories, logs, credentials and node_modules can never slip in.
 * Byte counts and SHA-256 digests are computed from the files on disk.
 *
 * Upstream provenance (upstream, upstreamCommit, snapshot, packageVersion) is
 * preserved from the existing manifest: this branch is not the upstream
 * commit and the script must not rewrite that claim. `capturedAt` is also
 * preserved by default so that regenerating is idempotent; pass
 * `--captured-at=<ISO-8601>` to stamp a new capture.
 *
 * Usage:
 *   node scripts/generate-snapshot-manifest.mjs
 *   node scripts/generate-snapshot-manifest.mjs --captured-at=2026-10-21T00:00:00.000Z
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const gatewayRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(gatewayRoot, "..");
const manifestFile = path.join(gatewayRoot, "SNAPSHOT_MANIFEST.json");

/** Files that describe the snapshot instead of belonging to it. */
const EXCLUDED = new Set(["SNAPSHOT_MANIFEST.json", "RUNTIME_BASELINE.json"]);

const previous = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const capturedArgument = process.argv.find(argument => argument.startsWith("--captured-at="));
const capturedAt = capturedArgument ? capturedArgument.slice("--captured-at=".length) : previous.capturedAt;
if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("--captured-at must be an ISO-8601 timestamp");

const tracked = execFileSync(
  "git",
  [
    // Trust exactly the repository this script belongs to. Some Windows
    // checkouts are owned by a different local account than the one running
    // the build, which git otherwise refuses; this widens nothing else.
    "-c",
    `safe.directory=${repoRoot}`,
    "-C",
    repoRoot,
    "ls-files",
    "--",
    "gateway",
  ],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .map(entry => entry.replace(/^gateway[\\/]/, ""));

const files = [];
for (const relative of tracked) {
  if (EXCLUDED.has(relative)) continue;
  const bytes = fs.readFileSync(path.join(gatewayRoot, relative));
  files.push({
    path: relative,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

const manifest = {
  format: previous.format,
  capturedAt,
  upstream: previous.upstream,
  upstreamCommit: previous.upstreamCommit,
  snapshot: previous.snapshot,
  packageVersion: previous.packageVersion,
  exclusions: previous.exclusions,
  notes: previous.notes,
  files,
};

fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ files: files.length, capturedAt, excluded: [...EXCLUDED] }));
