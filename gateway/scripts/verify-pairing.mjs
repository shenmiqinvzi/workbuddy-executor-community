#!/usr/bin/env node
/**
 * Pairing check for the two release archives (WB37, R4).
 *
 * The gateway archive and the desktop preview archive ship the same gateway
 * sources; the desktop one adds the compiled shell. A user who gets both must
 * not receive two different copies of the same file, so:
 *
 *   1. every path present in both archives must be byte-identical, except the
 *      files that describe the archive itself;
 *   2. a fixed set of files the product needs must be present in both — an
 *      empty intersection is a failure, not a vacuous pass;
 *   3. one-sided files must be expected ones (the compiled shell, its readme);
 *   4. each archive's RELEASE_MANIFEST.json must describe every entry it ships,
 *      with the same size and digest, and the two manifests must agree on the
 *      version and on every path they share;
 *   5. each archive must match its `.sha256` sidecar.
 *
 * Every failure is reported in `problems`; nothing is smoothed over.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Files the paired product needs from both archives. The list is deliberately
 * short and stable: it names the entry points a user is told to run, so a
 * desktop archive that lost the gateway sources cannot pass as "paired".
 */
export const REQUIRED_SHARED = [
  "package.json",
  "dist/server.js",
  "dist/health-entry.js",
  "dist/readiness.js",
  "dist/readiness-probes.js",
  "scripts/readiness.mjs",
  "scripts/init-state.mjs",
  "scripts/verify-pairing.mjs",
  "scripts/check-acceptance-matrix.mjs",
  "scripts/sync-skill.mjs",
  "skills/workbuddy-executor/SKILL.md",
];

/** One-sided files that are expected, by role rather than by name count. */
export const ALLOWED_DESKTOP_ONLY = [/^desktop\/app\//, /^PREVIEW-START-HERE\.md$/];
export const ALLOWED_GATEWAY_ONLY = [];

/** Read a ZIP32 central directory and inflate every entry. */
export function readArchive(file) {
  const bytes = fs.readFileSync(file);
  let end = -1;
  for (let index = bytes.length - 22; index >= 0 && index > bytes.length - 65558; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error(`${file}: no ZIP end-of-central-directory record`);
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  const duplicates = [];
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error(`${file}: bad central directory entry`);
    const method = bytes.readUInt16LE(offset + 10);
    const packedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const packed = bytes.subarray(dataStart, dataStart + packedSize);
    if (entries.has(name)) duplicates.push(name);
    if (method === 0) entries.set(name, Buffer.from(packed));
    else if (method === 8) entries.set(name, inflateRawSync(packed));
    else throw new Error(`${file}: unsupported compression method ${method} for ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { archive: file, bytes: bytes.length, sha256: digest(bytes), entries, duplicates };
}

/**
 * A published checksum is only evidence when it exists, names a SHA-256 digest
 * and agrees with the archive. A missing sidecar makes the verdict `unknown`,
 * which the caller must treat as a failure: "we did not publish a checksum"
 * is not the same as "the checksum matched".
 */
function sidecar(archive) {
  const file = `${archive}.sha256`;
  if (!fs.existsSync(file)) return { file, present: false, formatValid: null, matches: null, recorded: null, actual: null };
  const text = fs.readFileSync(file, "utf8").trim();
  const recorded = text.split(/\s+/)[0] ?? null;
  const actual = digest(fs.readFileSync(archive));
  const formatValid = /^[a-f0-9]{64}$/i.test(recorded ?? "");
  return { file, present: true, formatValid, recorded, actual, matches: formatValid && recorded.toLowerCase() === actual };
}

/**
 * Remove the release wrapper from an archive entry or a manifest path.
 * Archive entries always start with a wrapper that carries the version
 * (`codex-workbuddy-gateway-v0.7.1/`, `workbuddy-desktop-v0.7.1-t7d-…/`), while
 * a manifest may already list bare relative paths (`dist/server.js`). The
 * wrapper is therefore dropped only when the first segment carries a
 * `vMAJOR.MINOR.PATCH` token, which a real directory such as `deepseek-plugin/`
 * never does; a following `gateway/` segment is dropped too because the desktop
 * archive nests the same sources under it.
 */
export function relativeName(name) {
  const parts = String(name).split("/");
  if (parts.length > 1 && /-v\d+\.\d+\.\d+/.test(parts[0])) parts.shift();
  if (parts.length > 1 && parts[0] === "gateway") parts.shift();
  return parts.join("/");
}

/** A path that a reader could resolve to something outside the extraction root, or that two files could share. */
export function unsafePath(name) {
  const raw = String(name);
  if (!raw) return "empty path";
  if (raw.includes("\\")) return "backslash separator";
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return "absolute path";
  if (raw.endsWith("/")) return "directory entry";
  const segments = raw.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return "unresolved path segment";
  return null;
}

function manifestOf(archive) {
  for (const [name, bytes] of archive.entries) if (relativeName(name) === "RELEASE_MANIFEST.json") return JSON.parse(bytes.toString("utf8"));
  return null;
}

/** Check that one archive's manifest describes exactly the entries it ships. */
export function verifyManifest(archive) {
  const problems = [];
  const manifest = manifestOf(archive);
  const label = path.basename(archive.archive);
  if (!manifest) return { manifest: null, problems: [`${label}: no RELEASE_MANIFEST.json in the archive`], described: 0 };
  if (!Array.isArray(manifest.files)) return { manifest, problems: [`${label}: RELEASE_MANIFEST.json has no files array`], described: 0 };
  // A manifest may name a file with the archive's own wrapper (`gateway/dist/x`)
  // or without it; both describe the same shipped file, so compare the relative name.
  const shipped = new Map();
  for (const [name, bytes] of archive.entries) shipped.set(relativeName(name), bytes);
  const byPath = new Map();
  for (const entry of manifest.files) {
    const issue = unsafePath(entry?.path);
    if (issue) { problems.push(`${label}: manifest entry ${JSON.stringify(entry?.path)} is ${issue}`); continue; }
    const relative = relativeName(String(entry.path));
    if (byPath.has(relative)) { problems.push(`${label}: manifest lists ${relative} more than once`); continue; }
    byPath.set(relative, entry);
    const bytes = shipped.get(relative);
    if (!bytes) { problems.push(`${label}: manifest lists ${relative}, which the archive does not contain`); continue; }
    const actual = digest(bytes);
    if (entry.sha256 !== actual) problems.push(`${label}: ${relative} hashes ${actual} but the manifest says ${entry.sha256}`);
    if (entry.bytes !== bytes.length) problems.push(`${label}: ${relative} is ${bytes.length} bytes but the manifest says ${entry.bytes}`);
  }
  for (const relative of shipped.keys()) {
    if (relative === "RELEASE_MANIFEST.json") continue;
    if (!byPath.has(relative)) problems.push(`${label}: ${relative} ships in the archive but is not in the manifest`);
  }
  if (archive.duplicates.length) problems.push(`${label}: duplicate archive entries ${archive.duplicates.slice(0, 5).join(", ")}`);
  return { manifest, problems, described: byPath.size };
}

/**
 * Both archives describe themselves in RELEASE_MANIFEST.json. Those two files
 * legitimately differ (one lists the desktop binaries), but every path they
 * both list must carry the same digest, otherwise the pair disagrees about the
 * same file.
 */
export function compareManifests(gateway, desktop) {
  const a = manifestOf(gateway);
  const b = manifestOf(desktop);
  if (!a || !b) return { present: { gateway: Boolean(a), desktop: Boolean(b) }, compared: 0, disagreements: [], versions: { gateway: a?.version ?? null, desktop: b?.version ?? null } };
  const other = new Map((b.files ?? []).map(entry => [relativeName(String(entry.path)), entry]));
  const disagreements = [];
  let compared = 0;
  for (const entry of a.files ?? []) {
    const twin = other.get(relativeName(String(entry.path)));
    if (!twin) continue;
    compared += 1;
    if (twin.sha256 !== entry.sha256 || twin.bytes !== entry.bytes) disagreements.push({ path: entry.path, gateway: entry.sha256, desktop: twin.sha256 });
  }
  return { present: { gateway: true, desktop: true }, compared, disagreements, versions: { gateway: a.version ?? null, desktop: b.version ?? null } };
}

export const IDENTITY_FILES = new Set(["RELEASE_MANIFEST.json"]);

/** `0.7.1-t7d-desktop-preview` and `0.7.1` are the same release; `0.7.2` is not. */
export function versionCore(version) {
  if (typeof version !== "string") return null;
  const match = /^(\d+\.\d+\.\d+)(?:[-+]|$)/.exec(version);
  return match ? match[1] : null;
}

export function verifyPairing(gatewayArchive, desktopArchive) {
  const problems = [];
  const gateway = readArchive(gatewayArchive);
  const desktop = readArchive(desktopArchive);
  const gatewayRelative = new Map();
  for (const [name, bytes] of gateway.entries) {
    const relative = relativeName(name);
    const issue = unsafePath(relative);
    if (issue) { problems.push(`${path.basename(gatewayArchive)}: ${JSON.stringify(name)} is ${issue}`); continue; }
    gatewayRelative.set(relative, { name, bytes });
  }
  const desktopRelative = new Map();
  for (const [name, bytes] of desktop.entries) {
    const relative = relativeName(name);
    const issue = unsafePath(relative);
    if (issue) { problems.push(`${path.basename(desktopArchive)}: ${JSON.stringify(name)} is ${issue}`); continue; }
    desktopRelative.set(relative, { name, bytes });
  }

  const shared = [];
  const mismatched = [];
  const identity = [];
  const gatewayOnly = [];
  const desktopOnly = [];
  for (const [relative, entry] of gatewayRelative) {
    const other = desktopRelative.get(relative);
    if (!other) { gatewayOnly.push(relative); continue; }
    if (IDENTITY_FILES.has(relative)) identity.push({ path: relative, gateway: digest(entry.bytes), desktop: digest(other.bytes) });
    else if (other.bytes.equals(entry.bytes)) shared.push(relative);
    else mismatched.push({ path: relative, gateway: digest(entry.bytes), desktop: digest(other.bytes), gatewayBytes: entry.bytes.length, desktopBytes: other.bytes.length });
  }
  for (const relative of desktopRelative.keys()) if (!gatewayRelative.has(relative)) desktopOnly.push(relative);

  for (const problem of mismatched) problems.push(`${problem.path} differs between the archives (${problem.gatewayBytes} vs ${problem.desktopBytes} bytes)`);
  const missing = REQUIRED_SHARED.filter(relative => !gatewayRelative.has(relative) || !desktopRelative.has(relative));
  for (const relative of missing) {
    const where = !gatewayRelative.has(relative) && !desktopRelative.has(relative) ? "both archives" : !gatewayRelative.has(relative) ? "the gateway archive" : "the desktop archive";
    problems.push(`${relative} is missing from ${where}`);
  }
  for (const relative of desktopOnly) if (!ALLOWED_DESKTOP_ONLY.some(pattern => pattern.test(relative))) problems.push(`${relative} is only in the desktop archive and is not an expected desktop file`);
  for (const relative of gatewayOnly) if (!ALLOWED_GATEWAY_ONLY.some(pattern => pattern.test(relative))) problems.push(`${relative} is only in the gateway archive and is not an expected gateway file`);
  if (!shared.length) problems.push("the two archives share no byte-identical file; they are not a pair");

  const gatewayIntegrity = verifyManifest(gateway);
  const desktopIntegrity = verifyManifest(desktop);
  problems.push(...gatewayIntegrity.problems, ...desktopIntegrity.problems);
  const manifestAgreement = compareManifests(gateway, desktop);
  if (manifestAgreement.disagreements.length) problems.push(...manifestAgreement.disagreements.map(item => `${item.path}: the two manifests disagree (${item.gateway} vs ${item.desktop})`));
  const gatewayVersion = versionCore(manifestAgreement.versions.gateway);
  const desktopVersion = versionCore(manifestAgreement.versions.desktop);
  if (gatewayIntegrity.manifest && !gatewayVersion) {
    problems.push(`${path.basename(gatewayArchive)}: RELEASE_MANIFEST.json version ${JSON.stringify(manifestAgreement.versions.gateway ?? null)} is not a MAJOR.MINOR.PATCH version`);
  }
  if (desktopIntegrity.manifest && !desktopVersion) {
    problems.push(`${path.basename(desktopArchive)}: RELEASE_MANIFEST.json version ${JSON.stringify(manifestAgreement.versions.desktop ?? null)} is not a MAJOR.MINOR.PATCH version`);
  }
  // The desktop preview carries its own label after the numeric version
  // (`0.7.1-t7d-desktop-preview`); the numeric core is what must agree.
  if (gatewayVersion && desktopVersion && gatewayVersion !== desktopVersion) {
    problems.push(`the archives describe different versions (${manifestAgreement.versions.gateway} vs ${manifestAgreement.versions.desktop})`);
  }
  if (manifestAgreement.present.gateway && manifestAgreement.present.desktop && manifestAgreement.compared === 0) {
    problems.push("the manifests describe no common path; the pair cannot be verified");
  }

  const gatewaySum = sidecar(gatewayArchive);
  const desktopSum = sidecar(desktopArchive);
  for (const [label, sum] of [[path.basename(gatewayArchive), gatewaySum], [path.basename(desktopArchive), desktopSum]]) {
    if (!sum.present) problems.push(`${label} ships without a .sha256 sidecar`);
    else if (!sum.formatValid) problems.push(`${label}: .sha256 sidecar ${JSON.stringify(sum.recorded)} is not a SHA-256 digest`);
    else if (!sum.matches) problems.push(`${label} does not match its .sha256 sidecar`);
  }

  return {
    gateway: { archive: gateway.archive, bytes: gateway.bytes, sha256: gateway.sha256, entries: gateway.entries.size, checksum: gatewaySum, manifest: gatewayIntegrity.described },
    desktop: { archive: desktop.archive, bytes: desktop.bytes, sha256: desktop.sha256, entries: desktop.entries.size, checksum: desktopSum, manifest: desktopIntegrity.described },
    required: { count: REQUIRED_SHARED.length, missing },
    shared: { count: shared.length, identical: shared.length },
    mismatched,
    identity,
    manifestAgreement,
    gatewayOnly: { count: gatewayOnly.length, sample: gatewayOnly.slice(0, 10) },
    desktopOnly: { count: desktopOnly.length, sample: desktopOnly.slice(0, 10) },
    problems,
    ok: problems.length === 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [gatewayArchive, desktopArchive] = process.argv.slice(2);
  if (!gatewayArchive || !desktopArchive) throw new Error("usage: verify-pairing.mjs <gateway.zip> <desktop.zip>");
  const report = verifyPairing(path.resolve(gatewayArchive), path.resolve(desktopArchive));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
