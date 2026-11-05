import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { supportedNode } from "./deployment-paths.js";

/**
 * Read-only candidate installation readiness.
 *
 * Two questions this module answers without touching an installation:
 *   1. Is this archive the release it claims to be (manifest + per-file hashes)?
 *   2. If we unpacked it here, what would be created, replaced, kept or refused?
 *
 * Nothing in this file writes, starts, stops or reconfigures anything. The actual
 * install/upgrade/uninstall stays in setup.ts; this module only describes what
 * that would do and refuses to guess when the target cannot be read.
 */

export const INSPECTION_SCHEMA = "workbuddy-candidate-inspection/v1";
export const INSTALLATION_PLAN_SCHEMA = "workbuddy-candidate-installation/v1";
export const CANDIDATE_MANIFEST = "RELEASE_MANIFEST.json";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 65535;
/** Runtime trees that are never part of a release and are never inspected or touched. */
const UNMANAGED_TREES = new Set(["node_modules", "data", ".git"]);
const LISTING_LIMIT = 20000;

export interface ArchiveEntry { path: string; sha256: string; bytes: number }
export interface CandidateInspection {
  schemaVersion: string;
  readOnly: true;
  archive: { file: string; sha256: string; bytes: number };
  release: { project: string; version: string; prefix: string; manifestBytes: number };
  files: number;
  totalBytes: number;
  entries: ArchiveEntry[];
  problems: string[];
  ok: boolean;
}
export interface InstalledManifest { root: string; codexHome: string; skillFiles: Record<string, string>; snippetHash: string }
export interface InstallationPlanInput {
  inspection: CandidateInspection;
  installRoot: string;
  codexHome: string;
  env?: NodeJS.ProcessEnv;
  installed?: InstalledManifest;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
}
export interface Requirement { id: string; ok: boolean; detail: string }
export interface InstallationPlan {
  schemaVersion: string;
  readOnly: true;
  target: { installRoot: string; codexHome: string };
  release: { project: string; version: string };
  counts: { create: number; update: number; unchanged: number; unmanaged: number; blocked: number; managedDrift: number };
  create: string[];
  update: string[];
  unchanged: string[];
  unmanaged: string[];
  blocked: { path: string; reason: string }[];
  managedDrift: { path: string; reason: string }[];
  setupWrites: { env: string; mcpSnippet: string; skill: string; manifest: string };
  requirements: Requirement[];
  backups: string[];
  rollback: string[];
  next: string[];
  safeToApply: boolean;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function digest(bytes: Buffer | string) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

/** Reject names that could escape an extraction root, plus Windows-specific traps. */
export function assertArchivePath(name: string) {
  if (!name || name.length > 1024) throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  if (name.includes("\0") || /[\r\n]/.test(name)) throw new Error("Archive path contains control characters.");
  if (name.includes("\\")) throw new Error(`Archive path uses a backslash: ${name}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error(`Archive path is absolute: ${name}`);
  if (name.endsWith("/")) throw new Error(`Archive entry is a directory, not a file: ${name}`);
  const parts = name.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) throw new Error(`Archive path is not normalised: ${name}`);
  // A colon after the drive prefix would be an alternate data stream on NTFS.
  if (parts.some(part => part.includes(":"))) throw new Error(`Archive path contains an alternate data stream: ${name}`);
  if (parts.some(part => /[<>"|?*]/.test(part))) throw new Error(`Archive path contains a Windows-reserved character: ${name}`);
  return name;
}

function readCentralDirectory(zip: Buffer) {
  // readUInt32LE throws ERR_OUT_OF_RANGE on a short buffer; an empty or truncated
  // file is a refused input, not an internal error.
  if (zip.length < 22) throw new Error("Not a ZIP archive: the file is shorter than an end-of-central-directory record.");
  const minimum = Math.max(0, zip.length - 66_000);
  let end = -1;
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("Not a ZIP archive: missing the end-of-central-directory record.");
  const declared = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const start = zip.readUInt32LE(end + 16);
  if (declared > MAX_ENTRIES) throw new Error("Archive has too many entries.");
  if (start + size > zip.length) throw new Error("Archive central directory is out of bounds.");
  return { declared, start, size };
}

/** Minimal ZIP reader: stored and deflated members only, verified against their CRC. */
export function readArchiveMembers(archive: string) {
  const info = fs.statSync(archive);
  if (!info.isFile()) throw new Error("Candidate archive must be a regular file.");
  if (info.size > MAX_ARCHIVE_BYTES) throw new Error("Candidate archive is too large to inspect.");
  const zip = fs.readFileSync(archive);
  const { declared, start } = readCentralDirectory(zip);
  const members = new Map<string, Buffer>();
  let offset = start, unpacked = 0;
  for (let index = 0; index < declared; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Archive central directory record is malformed.");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16);
    const compressed = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw new Error(`Encrypted archive entry is not supported: ${name}`);
    if (!["stored", "deflated"].includes(method === 0 ? "stored" : method === 8 ? "deflated" : "other")) throw new Error(`Unsupported compression method for ${name}.`);
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Archive entry has no local header: ${name}`);
    const localName = zip.readUInt16LE(localOffset + 26), localExtra = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    if (dataStart + compressed > zip.length) throw new Error(`Archive entry is truncated: ${name}`);
    const packed = zip.subarray(dataStart, dataStart + compressed);
    const bytes = method === 0 ? Buffer.from(packed) : inflateRawSync(packed);
    if (bytes.length !== size) throw new Error(`Archive entry size mismatch: ${name}`);
    if (crc32(bytes) !== crc) throw new Error(`Archive entry CRC mismatch: ${name}`);
    unpacked += bytes.length;
    if (unpacked > MAX_UNPACKED_BYTES) throw new Error("Archive expands beyond the inspection limit.");
    members.set(assertArchivePath(name), bytes);
  }
  if (members.size !== declared) throw new Error("Archive entry count does not match its central directory.");
  return members;
}

/** Read-only: verifies the archive against the manifest it carries. Writes nothing. */
export function inspectCandidatePackage(file: string, options: { expectedSha256?: string } = {}): CandidateInspection {
  const resolved = path.resolve(file);
  const bytes = fs.readFileSync(resolved);
  const problems: string[] = [];
  const archiveSha256 = digest(bytes);
  if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== archiveSha256) {
    problems.push(`Archive SHA-256 does not match the expected value: ${archiveSha256}`);
  }
  const members = readArchiveMembers(resolved);
  const names = [...members.keys()];
  const prefix = names[0]?.split("/")[0] ?? "";
  if (!prefix || names.some(name => name.split("/")[0] !== prefix)) problems.push("Archive does not contain exactly one top-level directory.");
  const manifestName = `${prefix}/${CANDIDATE_MANIFEST}`;
  const manifestBytes = members.get(manifestName);
  if (!manifestBytes) throw new Error(`Candidate archive has no ${CANDIDATE_MANIFEST} at its root.`);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { project?: string; version?: string; files?: ArchiveEntry[] };
  if (manifest.project !== "codex-workbuddy-gateway") problems.push("Release manifest declares an unexpected project.");
  if (!manifest.version || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) problems.push("Release manifest has no safe semantic version.");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Release manifest lists no files.");
  const entries: ArchiveEntry[] = [];
  const listed = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string") { problems.push("Release manifest contains a non-string path."); continue; }
    if (listed.has(entry.path)) { problems.push(`Release manifest lists ${entry.path} twice.`); continue; }
    listed.add(entry.path);
    let safe: string;
    try { safe = assertArchivePath(entry.path); } catch (error) { problems.push((error as Error).message); continue; }
    const content = members.get(`${prefix}/${safe}`);
    if (!content) { problems.push(`Release file is missing from the archive: ${safe}`); continue; }
    const actual = digest(content);
    if (actual !== entry.sha256 || content.length !== entry.bytes) problems.push(`Release file does not match its manifest entry: ${safe}`);
    entries.push({ path: safe, sha256: entry.sha256, bytes: entry.bytes });
  }
  for (const name of names) {
    const relative = name.slice(prefix.length + 1);
    if (relative === CANDIDATE_MANIFEST) continue;
    if (!listed.has(relative)) problems.push(`Archive contains a file the manifest does not list: ${relative}`);
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    schemaVersion: INSPECTION_SCHEMA,
    readOnly: true,
    archive: { file: resolved, sha256: archiveSha256, bytes: bytes.length },
    release: { project: manifest.project ?? "unknown", version: manifest.version ?? "unknown", prefix, manifestBytes: manifestBytes.length },
    files: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    problems,
    ok: problems.length === 0,
  };
}

function lstatSafe(filename: string) {
  try { return fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function hashFile(filename: string) { return digest(fs.readFileSync(filename)); }

/** Refuse targets that are links, non-regular or otherwise not what an unpack expects. */
function targetOf(installRoot: string, relative: string) {
  const filename = path.resolve(installRoot, relative);
  if (!filename.startsWith(path.resolve(installRoot) + path.sep)) throw new Error(`Candidate path escapes the installation root: ${relative}`);
  const stat = lstatSafe(filename);
  return { filename, stat };
}
function readExistingManifest(file: string): InstalledManifest | undefined {
  if (!fs.existsSync(file)) return undefined;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as InstalledManifest;
  if (data?.skillFiles && typeof data.skillFiles === "object") return data;
  return undefined;
}
function skillTreeHashes(directory: string): Record<string, string> | undefined {
  if (!lstatSafe(directory)) return undefined;
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error("Installed skill contains a link.");
      if (item.isDirectory()) walk(filename);
      else if (item.isFile()) result[path.relative(directory, filename).replaceAll("\\", "/")] = hashFile(filename);
    }
  };
  walk(directory);
  return result;
}

/**
 * Read-only: compares the candidate contents with what is already on disk.
 * It never decides that a differing file is "local modification" unless the
 * installed manifest actually records that file; everything uncertain is
 * reported as such instead of being assumed safe or assumed changed.
 */
export function planCandidateInstallation(input: InstallationPlanInput): InstallationPlan {
  const installRoot = path.resolve(input.installRoot);
  const codexHome = path.resolve(input.codexHome);
  const env = input.env ?? {};
  const platform = input.platform ?? process.platform;
  const create: string[] = [], update: string[] = [], unchanged: string[] = [], unmanaged: string[] = [];
  const blocked: { path: string; reason: string }[] = [], managedDrift: { path: string; reason: string }[] = [];
  for (const entry of input.inspection.entries) {
    const { filename, stat } = targetOf(installRoot, entry.path);
    if (!stat) { create.push(entry.path); continue; }
    if (stat.isSymbolicLink()) { blocked.push({ path: entry.path, reason: "target_is_link" }); continue; }
    if (!stat.isFile()) { blocked.push({ path: entry.path, reason: "target_is_not_a_file" }); continue; }
    let actual: string;
    try { actual = hashFile(filename); } catch { blocked.push({ path: entry.path, reason: "target_unreadable" }); continue; }
    if (actual === entry.sha256) unchanged.push(entry.path); else update.push(entry.path);
  }
  const candidatePaths = new Set(input.inspection.entries.map(entry => entry.path));
  const homeLike = [os.homedir(), path.parse(installRoot).root].includes(installRoot);
  let listed = 0, listingTruncated = false;
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (listed++ >= LISTING_LIMIT) { listingTruncated = true; return; }
      const filename = path.join(dir, item.name);
      const relative = path.relative(installRoot, filename).replaceAll("\\", "/");
      if (item.isDirectory()) {
        if (UNMANAGED_TREES.has(item.name)) { unmanaged.push(`${relative}/`); continue; }
        if (item.isSymbolicLink()) { blocked.push({ path: relative, reason: "existing_directory_is_link" }); continue; }
        walk(filename);
        if (listingTruncated) return;
      } else if (!candidatePaths.has(relative)) unmanaged.push(relative);
    }
  };
  // Never enumerate the user profile or a drive root: those are refused targets,
  // and walking them would be slow and could surface unrelated personal files.
  if (lstatSafe(installRoot)?.isDirectory() && !homeLike) walk(installRoot);
  // A truncated listing is an incomplete comparison, so it stops the plan instead
  // of presenting a short unmanaged list as if it were the whole installation.
  if (listingTruncated) blocked.push({ path: ".", reason: "unmanaged_listing_truncated" });
  let installed = input.installed;
  if (installed === undefined) {
    try { installed = readExistingManifest(path.join(installRoot, "data", "deployment-installation.json")); }
    catch { blocked.push({ path: "data/deployment-installation.json", reason: "installed_manifest_unreadable" }); }
  }
  if (installed) {
    const skillDir = path.join(codexHome, "skills", "workbuddy-executor");
    let current: Record<string, string> | undefined;
    try { current = skillTreeHashes(skillDir); } catch (error) { managedDrift.push({ path: "skills/workbuddy-executor", reason: (error as Error).message }); }
    if (current) {
      const expected = installed.skillFiles;
      const same = Object.keys(expected).length === Object.keys(current).length && Object.entries(expected).every(([name, hash]) => current![name] === hash);
      if (!same) managedDrift.push({ path: "skills/workbuddy-executor", reason: "installed_skill_has_local_changes" });
    }
    const snippet = path.join(installRoot, "data", "workbuddy-mcp.toml");
    const snippetStat = lstatSafe(snippet);
    if (snippetStat?.isFile() && hashFile(snippet) !== installed.snippetHash) managedDrift.push({ path: "data/workbuddy-mcp.toml", reason: "managed_snippet_has_local_changes" });
  }
  const distServer = candidatePaths.has("dist/server.js");
  const distSetup = candidatePaths.has("dist/setup.js");
  const desktopBinary = input.inspection.entries.some(entry => /^desktop\/(app|bin)\/.+\.exe$/i.test(entry.path));
  const nodeModules = lstatSafe(path.join(installRoot, "node_modules", "zod"));
  const envFile = path.join(installRoot, ".env");
  const envStat = lstatSafe(envFile);
  const requirements: Requirement[] = [
    { id: "node_version", ok: supportedNode(input.nodeVersion ?? process.versions.node), detail: "Node.js >= 22.13.0" },
    { id: "platform", ok: platform === "win32", detail: "Windows only; other platforms are not verified" },
    { id: "gateway_entrypoint", ok: distServer && distSetup, detail: "Candidate must contain dist/server.js and dist/setup.js" },
    { id: "runtime_dependencies", ok: Boolean(nodeModules), detail: "node_modules must be installed from the lockfile (npm ci --omit=dev); the archive does not carry them" },
    { id: "desktop_application", ok: desktopBinary, detail: "The candidate is a gateway release; the WorkBuddy desktop shell, .NET 10 and WebView2 are separate prerequisites" },
    { id: "target_is_directory", ok: lstatSafe(installRoot)?.isDirectory() !== false, detail: "Installation root must be a directory, not a file or link" },
    { id: "target_not_home", ok: !homeLike, detail: "Installation root cannot be the user home or a drive root" },
    { id: "codex_home_not_home", ok: codexHome !== os.homedir(), detail: "CODEX_HOME must be an explicit directory, not the user home" },
  ];
  if (envStat && envStat.isFile()) {
    const text = fs.readFileSync(envFile, "utf8");
    const backend = /\bWORKBUDDY_BACKEND\s*=\s*"?([^"\r\n]+)"?/.exec(text)?.[1]?.trim();
    requirements.push({ id: "existing_env_backend", ok: backend === "desktop-queue", detail: "An existing .env is preserved; its backend must already be desktop-queue" });
  }
  const backups = [
    `Skill backup (created by the installer): ${path.join(codexHome, "skill-backups", "<stamp>-workbuddy-executor")}`,
    `Installed-file record: ${path.join(installRoot, "data", "deployment-installation.json")}`,
    "Unmanaged files, .env, data/ and node_modules are never overwritten or removed by this plan",
  ];
  const rollback = [
    "node scripts/setup.mjs uninstall --apply  (restores the pre-existing skill and removes only the managed snippet)",
    "The installer refuses to change anything when an installed skill or managed snippet has local changes; resolve those first",
    "A failed install or upgrade removes a newly created .env, restores the previous snippet and puts the previous skill back",
    "Re-unpack the previous candidate archive over the installation root to return the gateway files to their prior bytes",
  ];
  const next = [
    "Review the create/update/unmanaged lists and the requirement rows above",
    "Back up data/ and .env yourself; this plan does not copy or modify either",
    "Only then run the installer with --apply; production switching and model verification stay separate actions",
  ];
  const safeToApply = blocked.length === 0 && managedDrift.length === 0 && requirements.every(requirement => requirement.ok);
  return {
    schemaVersion: INSTALLATION_PLAN_SCHEMA,
    readOnly: true,
    target: { installRoot, codexHome },
    release: { project: input.inspection.release.project, version: input.inspection.release.version },
    counts: { create: create.length, update: update.length, unchanged: unchanged.length, unmanaged: unmanaged.length, blocked: blocked.length, managedDrift: managedDrift.length },
    create: create.sort(), update: update.sort(), unchanged: unchanged.sort(), unmanaged: unmanaged.sort(),
    blocked, managedDrift,
    setupWrites: {
      env: envStat ? "preserved" : "created",
      mcpSnippet: "written only when absent or byte-identical to the managed one",
      skill: managedDrift.some(item => item.path.startsWith("skills/")) ? "refused_local_changes" : "installed",
      manifest: "written last, after the skill and snippet succeed",
    },
    requirements, backups, rollback, next, safeToApply,
  };
}

function assertInside(drillRoot: string, candidate: string, label: string) {
  const root = path.resolve(drillRoot);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(root + path.sep)) throw new Error(`${label} must be inside the drill directory: ${resolved}`);
  return resolved;
}

/**
 * Drill workspaces must be explicit and self-owned. A missing argument is an
 * error, never a fallback to the real CODEX_HOME or the user profile.
 */
export function assertDrillWorkspace(input: { drillRoot: string; installRoot: string; codexHome: string; env?: NodeJS.ProcessEnv }) {
  const drillRoot = path.resolve(input.drillRoot);
  if (!lstatSafe(drillRoot)?.isDirectory()) throw new Error("Drill directory must exist and be a directory.");
  if ([path.parse(drillRoot).root, os.homedir()].includes(drillRoot)) throw new Error("Drill directory cannot be a drive root or the user home.");
  const installRoot = assertInside(drillRoot, input.installRoot, "Installation root");
  const codexHome = assertInside(drillRoot, input.codexHome, "CODEX_HOME");
  if (installRoot === codexHome) throw new Error("Installation root and CODEX_HOME must be separate directories.");
  if (input.env?.CODEX_HOME) {
    const envHome = path.resolve(input.env.CODEX_HOME);
    if (!envHome.startsWith(drillRoot + path.sep)) throw new Error("CODEX_HOME from the environment points outside the drill directory.");
  }
  return { drillRoot, installRoot, codexHome };
}
