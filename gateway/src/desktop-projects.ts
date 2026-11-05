import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Project identity for the desktop dispatch surface.
 *
 * The identity is the filesystem identity (device + inode) of the real
 * directory, not the spelling of the path. A junction, a short name, a
 * differently cased path or a renamed folder resolve to the same project;
 * a directory that was deleted and recreated behind the same path is a
 * different project and must be re-selected instead of being re-used.
 *
 * Nothing here writes to the task database, prepares a model or opens a
 * session. The registry is a local, bounded list of verified identities used
 * only to show candidates and to re-verify the user's earlier choice.
 */
export type DesktopProjectFailure =
  | "PROJECT_PATH_REQUIRED"
  | "PROJECT_PATH_NOT_ABSOLUTE"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ACCESS_DENIED"
  | "PROJECT_NOT_DIRECTORY"
  | "PROJECT_UNREADABLE"
  | "PROJECT_LINK_UNRESOLVED"
  | "PROJECT_NOT_REGISTERED"
  | "PROJECT_IDENTITY_CHANGED";

export interface DesktopProjectIdentity { realPath: string; device: string; inode: string }
export interface DesktopProject extends DesktopProjectIdentity {
  projectId: string;
  displayName: string;
  aliases: string[];
  observedAt: string;
}
export interface DesktopProjectCandidate {
  projectId: string;
  realPath: string;
  displayName: string;
  /** A remembered identity is never treated as verified until it is re-read. */
  state: "unverified";
  observedAt: string;
}
export type DesktopProjectResolution =
  | { ok: true; identity: DesktopProjectIdentity; requestedPath: string; linked: boolean }
  | { ok: false; code: DesktopProjectFailure; message: string };
export type DesktopProjectVerification = { ok: true; identity: DesktopProjectIdentity } | { ok: false; code: DesktopProjectFailure; message: string };

const fail = (code: DesktopProjectFailure, message: string): { ok: false; code: DesktopProjectFailure; message: string } => ({ ok: false, code, message });
const text = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;
const normalize = (value: string) => value.replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase();

/** The identity is derived from the filesystem pair, so a rename keeps it. */
export function desktopProjectId(identity: DesktopProjectIdentity): string {
  return "project-" + crypto.createHash("sha256").update(`${identity.device}:${identity.inode}`).digest("hex").slice(0, 32);
}

function denyReason(error: unknown): { code: DesktopProjectFailure; message: string } {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return { code: "PROJECT_NOT_FOUND", message: "项目文件夹不存在，请重新选择。" };
  if (code === "EACCES" || code === "EPERM") return { code: "PROJECT_ACCESS_DENIED", message: "无法读取项目文件夹（权限不足），请选择可访问的目录。" };
  if (code === "ENOTDIR" || code === "ELOOP") return { code: "PROJECT_NOT_DIRECTORY", message: "项目路径必须是目录。" };
  return { code: "PROJECT_UNREADABLE", message: "无法读取项目文件夹，请检查路径后重试。" };
}

/**
 * Resolve a user supplied directory into a real identity. A link is accepted
 * only after its target resolved; the link name is kept as a hint, never as
 * the identity.
 */
export function resolveDesktopProject(directory: unknown): DesktopProjectResolution {
  if (typeof directory !== "string" || !directory.trim()) return fail("PROJECT_PATH_REQUIRED", "请选择已有项目的文件夹。");
  const requestedPath = directory.trim();
  if (!path.isAbsolute(requestedPath)) return fail("PROJECT_PATH_NOT_ABSOLUTE", "请选择项目的绝对路径。");
  let entry: fs.Stats;
  try { entry = fs.lstatSync(requestedPath); }
  catch (error) { return { ok: false, ...denyReason(error) }; }
  const linked = entry.isSymbolicLink();
  let realPath: string;
  try { realPath = fs.realpathSync.native(requestedPath); }
  catch (error) { return linked ? fail("PROJECT_LINK_UNRESOLVED", "该链接指向的目录无法核验，请直接选择目标文件夹。") : { ok: false, ...denyReason(error) }; }
  let stat: fs.BigIntStats;
  try { stat = fs.statSync(realPath, { bigint: true }); }
  catch (error) { return { ok: false, ...denyReason(error) }; }
  if (!stat.isDirectory()) return fail("PROJECT_NOT_DIRECTORY", "项目路径必须是目录。");
  return { ok: true, identity: { realPath, device: String(stat.dev), inode: String(stat.ino) }, requestedPath, linked };
}

/** Re-read a remembered identity; a changed directory is never silently reused. */
export function verifyDesktopProject(project: Pick<DesktopProject, "realPath" | "device" | "inode">): DesktopProjectVerification {
  const current = resolveDesktopProject(project.realPath);
  if (!current.ok) return { ok: false, code: "PROJECT_IDENTITY_CHANGED", message: `项目的目录已不可用（${current.message}）请重新选择文件夹。` };
  if (current.identity.device !== project.device || current.identity.inode !== project.inode) return fail("PROJECT_IDENTITY_CHANGED", "该路径下的目录已被替换，项目身份已变化，请重新选择文件夹。");
  return { ok: true, identity: current.identity };
}

export type DesktopProjectMatch =
  | { state: "missing" }
  | { state: "ambiguous"; candidates: DesktopProject[] }
  | { state: "matched"; project: DesktopProject };

/**
 * Match a folder name or an earlier path against remembered projects. A name
 * shared by two identities is ambiguous: no newest/most recent guess is made.
 */
export function matchDesktopProject(projects: DesktopProject[], hint: string): DesktopProjectMatch {
  const wanted = normalize(hint);
  if (!wanted) return { state: "missing" };
  const exact = projects.filter(project => normalize(project.realPath) === wanted);
  if (exact.length === 1) return { state: "matched", project: exact[0]! };
  if (exact.length > 1) return { state: "ambiguous", candidates: exact };
  const byName = projects.filter(project => [project.displayName, ...project.aliases].some(name => normalize(path.basename(name)) === path.basename(wanted)));
  if (byName.length === 1) return { state: "matched", project: byName[0]! };
  if (byName.length > 1) return { state: "ambiguous", candidates: byName };
  return { state: "missing" };
}

interface RegistryFile { schemaVersion: 1; projects: DesktopProject[] }

/**
 * Bounded local registry. Persistence is best effort: a missing or corrupt
 * file is reported through `issues()` and treated as an empty registry, so a
 * broken cache can never invent a project identity or block dispatch.
 */
export class DesktopProjectStore {
  private cache: DesktopProject[] | null = null;
  private readonly problems: string[] = [];
  private readonly limit: number;
  private readonly now: () => number;
  constructor(private readonly options: { file?: string | null; now?: () => number; limit?: number } = {}) {
    this.limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    this.now = options.now ?? Date.now;
  }
  issues(): string[] { return [...this.problems]; }
  list(): DesktopProject[] { return this.load().map(project => ({ ...project, aliases: [...project.aliases] })); }
  find(projectId: string): DesktopProject | null { return this.list().find(project => project.projectId === projectId) ?? null; }
  candidates(): DesktopProjectCandidate[] {
    return this.list().map(project => ({ projectId: project.projectId, realPath: project.realPath, displayName: project.displayName, state: "unverified" as const, observedAt: project.observedAt }));
  }
  remember(identity: DesktopProjectIdentity, hint?: string | null): DesktopProject {
    const displayName = text(path.basename(identity.realPath) || identity.realPath, 200);
    const aliasHint = text(path.basename((hint ?? "").replace(/[\\/]+$/, "")) || "", 200);
    const projectId = desktopProjectId(identity);
    const projects = this.load();
    const previous = projects.find(project => project.projectId === projectId);
    const aliases = new Set<string>(previous?.aliases ?? []);
    if (previous && previous.displayName !== displayName) aliases.add(previous.displayName);
    if (aliasHint && aliasHint !== displayName) aliases.add(aliasHint);
    const value: DesktopProject = { projectId, ...identity, displayName, aliases: [...aliases].filter(alias => !!alias).slice(0, 8), observedAt: new Date(this.now()).toISOString() };
    this.cache = [value, ...projects.filter(project => project.projectId !== projectId)].slice(0, this.limit);
    this.save(this.cache);
    return { ...value, aliases: [...value.aliases] };
  }
  private load(): DesktopProject[] {
    if (this.cache) return this.cache;
    this.cache = [];
    const file = this.options.file;
    if (!file) return this.cache;
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.problems.push("项目登记文件无法读取，已按空登记继续；身份仍会在选择时重新核验。");
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile>;
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects)) throw Error("shape");
      const seen = new Set<string>();
      for (const entry of parsed.projects) {
        if (!entry || typeof entry !== "object") continue;
        const { projectId, realPath, device, inode, displayName, aliases, observedAt } = entry as DesktopProject;
        if (typeof projectId !== "string" || !/^project-[a-f0-9]{32}$/.test(projectId) || typeof realPath !== "string" || !realPath || !path.isAbsolute(realPath)) continue;
        if (typeof device !== "string" || typeof inode !== "string" || !device || !inode) continue;
        if (seen.has(projectId)) continue;
        seen.add(projectId);
        this.cache.push({ projectId, realPath, device, inode, displayName: text(typeof displayName === "string" && displayName ? displayName : path.basename(realPath), 200),
          aliases: Array.isArray(aliases) ? aliases.filter(alias => typeof alias === "string" && alias).slice(0, 8).map(alias => text(alias, 200)) : [], observedAt: typeof observedAt === "string" ? observedAt : new Date(0).toISOString() });
        if (this.cache.length >= this.limit) break;
      }
    } catch { this.cache = []; this.problems.push("项目登记文件的内容无法识别，已按空登记继续；请重新选择一次项目。"); }
    return this.cache;
  }
  private save(projects: DesktopProject[]) {
    const file = this.options.file;
    if (!file) return;
    const body: RegistryFile = { schemaVersion: 1, projects };
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {
      this.problems.push("无法写入项目登记文件；本次选择仍然有效，但下次需要重新选择文件夹。");
      try { fs.rmSync(temporary, { force: true }); } catch { /* the temporary file is not part of the answer */ }
    }
  }
}
