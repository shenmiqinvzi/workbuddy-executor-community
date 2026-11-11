#!/usr/bin/env node
/**
 * Pairing check for the two release archives (WB37).
 *
 * The gateway archive and the desktop preview archive ship the same gateway
 * sources; the desktop one adds the compiled shell. A user who gets both must
 * not receive two different copies of the same file, so every path present in
 * both archives must be byte-identical, and each archive must match its
 * published `.sha256` sidecar. Anything else is reported, never smoothed over.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

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
    if (method === 0) entries.set(name, Buffer.from(packed));
    else if (method === 8) entries.set(name, inflateRawSync(packed));
    else throw new Error(`${file}: unsupported compression method ${method} for ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { archive: file, bytes: bytes.length, sha256: digest(bytes), entries };
}

function sidecar(archive) {
  const file = `${archive}.sha256`;
  if (!fs.existsSync(file)) return { file, present: false, matches: null, recorded: null };
  const recorded = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0];
  const actual = digest(fs.readFileSync(archive));
  return { file, present: true, recorded, matches: recorded === actual, actual };
}

/**
 * Compare two archives. Both wrap their contents in one top-level directory
 * (`codex-workbuddy-gateway-v0.7.1/`, `workbuddy-desktop-…/`), and the desktop
 * archive nests the same gateway sources under `gateway/`. Paths are compared
 * after those wrappers are removed, so `shared` really means "same file".
 * `shared` lists paths in both; every one of them must hash the same. One-sided
 * paths are reported with counts so a reader can see that the desktop archive
 * is a superset by design rather than by accident.
 */
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

/**
 * Files whose content is *about* the archive rather than shared code. Each
 * archive records its own file list, so these may differ by design; they are
 * still compared field by field for the paths both manifests describe.
 */
function manifestOf(archive) {
  for (const [name, bytes] of archive.entries) if (relativeName(name) === "RELEASE_MANIFEST.json") return JSON.parse(bytes.toString("utf8"));
  return null;
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
  if (!a || !b) return { present: { gateway: Boolean(a), desktop: Boolean(b) }, compared: 0, disagreements: [] };
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

export function verifyPairing(gatewayArchive, desktopArchive) {
  const gateway = readArchive(gatewayArchive);
  const desktop = readArchive(desktopArchive);
  const desktopByRelative = new Map();
  for (const [name, bytes] of desktop.entries) desktopByRelative.set(relativeName(name), { name, bytes });
  const shared = [];
  const mismatched = [];
  const identity = [];
  const gatewayOnly = [];
  const desktopOnly = [];
  const matchedDesktop = new Set();
  for (const [name, bytes] of gateway.entries) {
    const relative = relativeName(name);
    const other = desktopByRelative.get(relative);
    if (!other) { gatewayOnly.push(relative); continue; }
    matchedDesktop.add(relative);
    if (IDENTITY_FILES.has(relative)) identity.push({ path: relative, gateway: digest(bytes), desktop: digest(other.bytes) });
    else if (other.bytes.equals(bytes)) shared.push(relative);
    else mismatched.push({ path: relative, gateway: digest(bytes), desktop: digest(other.bytes), gatewayBytes: bytes.length, desktopBytes: other.bytes.length });
  }
  for (const relative of desktopByRelative.keys()) if (!matchedDesktop.has(relative)) desktopOnly.push(relative);
  const manifestAgreement = compareManifests(gateway, desktop);
  const gatewaySum = sidecar(gatewayArchive);
  const desktopSum = sidecar(desktopArchive);
  return {
    gateway: { archive: gateway.archive, bytes: gateway.bytes, sha256: gateway.sha256, entries: gateway.entries.size, checksum: gatewaySum },
    desktop: { archive: desktop.archive, bytes: desktop.bytes, sha256: desktop.sha256, entries: desktop.entries.size, checksum: desktopSum },
    shared: { count: shared.length, identical: shared.length },
    mismatched,
    identity,
    manifestAgreement,
    gatewayOnly: { count: gatewayOnly.length, sample: gatewayOnly.slice(0, 10) },
    desktopOnly: { count: desktopOnly.length, sample: desktopOnly.slice(0, 10) },
    ok: mismatched.length === 0
      && manifestAgreement.disagreements.length === 0
      && gatewaySum.matches !== false
      && desktopSum.matches !== false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [gatewayArchive, desktopArchive] = process.argv.slice(2);
  if (!gatewayArchive || !desktopArchive) throw new Error("usage: verify-pairing.mjs <gateway.zip> <desktop.zip>");
  const report = verifyPairing(path.resolve(gatewayArchive), path.resolve(desktopArchive));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
