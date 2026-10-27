import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { TaskContractScope } from "./task-contract.js";
import { AdmissionError } from "./collaboration.js";

export const WORKSPACE_SCOPE_VERSION = "workspace-scope/1";
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (value: string) => value.replaceAll("\\", "/").toLowerCase();
const fail = (code: string, message: string): never => { throw new AdmissionError(code, message); };
export interface WorkspaceEntry { path: string; kind: "file" | "directory" | "link" | "excluded"; sha256: string | null; bytes: number; links: number }
export interface WorkspaceInventory { root: string; identity: string; entries: WorkspaceEntry[]; gitIndex: string | null }
export interface WorkspaceBaseline {
  version: typeof WORKSPACE_SCOPE_VERSION; taskId: string; bindingHash: string; mode: "contract" | "scoped_submission" | "legacy_read_only";
  scope: TaskContractScope; inventory: WorkspaceInventory; protectedPaths: string[]; git: "observed" | "not_a_repository";
  excludedPaths: string[]; createdAt: string;
}
export interface ScopeChange { path: string; previousPath?: string; kind: "added" | "modified" | "deleted" | "renamed"; category: "deliverable" | "metadata" | "unauthorized"; problem?: string }
export interface WorkspaceScopeCheck {
  actor: "program";
  version: typeof WORKSPACE_SCOPE_VERSION; taskId: string; attemptId: string; baselineDigest: string;
  status: "passed" | "failed" | "checker_error"; checkedAt: string; inventoryDigest: string | null;
  coverage: "workspace_inventory"; excludedPaths: string[]; changes: ScopeChange[];
  limitations: string[]; error?: string;
}
export interface WorkspaceDispatchGuard { taskId: string; baselineDigest: string; inventory: WorkspaceInventory }
export interface WorkspaceScopeView {
  scope: TaskContractScope | null;
  version: typeof WORKSPACE_SCOPE_VERSION; baseline: "present" | "missing" | "integrity_failure";
  mode: WorkspaceBaseline["mode"] | null; baselineDigest: string | null; protectedCount: number | null;
  coverage: "workspace_inventory"; excludedPaths: string[]; check: WorkspaceScopeCheck | null;
  changeCount: number | null; changesTruncated: boolean;
}
const LIMITATIONS = ["Inventory covers the registered workspace and explicit exclusions, not the whole process filesystem.", "File deltas do not prove which actor wrote them; unobserved concurrent edits and arbitrary shell arguments have no complete attribution.", "Authenticated native write calls are conservative path-intent evidence, not proof that outside IO succeeded."];

/** Windows-safe relative names, independent of the host used for a regression. */
export function workspaceRelative(value: string): string {
  if (typeof value !== "string" || !value || /^[\\/]|^[A-Za-z]:/.test(value)) return fail("SCOPE_PATH_INVALID", "Use a workspace-relative path.");
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return fail("SCOPE_PATH_INVALID", "The path has traversal, a device name, ADS or an ambiguous Windows segment.");
  return parts.join("/");
}
function inside(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute); return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
/** Service-owned locations may use Windows short names, including not-yet-created sidecars. */
function canonicalLocation(value: string): string {
  let parent = path.resolve(value); const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(parent), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = path.dirname(parent); if (next === parent) throw error;
      suffix.unshift(path.basename(parent)); parent = next;
    }
  }
}
function matches(name: string, patterns: string[], directory = false): boolean {
  const target = key(name);
  return patterns.some(pattern => { const tree = pattern.endsWith("/**"), base = key(tree ? pattern.slice(0, -3) : pattern); return (target === base && (!directory || tree)) || (tree && target.startsWith(`${base}/`)) || (directory && base.startsWith(`${target}/`)); });
}
function category(name: string, kind: WorkspaceEntry["kind"], scope: TaskContractScope): ScopeChange["category"] {
  if (matches(name, scope.permittedMetadata, kind === "directory")) return "metadata";
  return matches(name, scope.allowedChanges, kind === "directory") ? "deliverable" : "unauthorized";
}
function entryEqual(a?: WorkspaceEntry, b?: WorkspaceEntry) { return a?.path === b?.path && a?.kind === b?.kind && a?.sha256 === b?.sha256 && a?.bytes === b?.bytes && a?.links === b?.links; }
function identity(root: string) { const stat = fs.statSync(root, { bigint: true }); return `${stat.dev}:${stat.ino}`; }
function scopePatterns(scope: TaskContractScope) { return [...scope.allowedChanges, ...scope.permittedMetadata]; }
function gitIndex(root: string): string | null {
  let cursor = root;
  while (!fs.existsSync(path.join(cursor, ".git"))) { const parent = path.dirname(cursor); if (parent === cursor) return null; cursor = parent; }
  const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root];
  return digest(execFileSync("git", [...args, "ls-files", "--stage", "-z"], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
}

/** No traversal through reparse points, even when a link currently resolves inside. */
function resolvedPath(root: string, target: string): { absolute: string; relative: string } {
  if (/[\x00-\x1f]/.test(target)) return fail("SCOPE_PATH_INVALID", "Invalid path characters.");
  if (target.replaceAll("\\", "/").split("/").includes("..")) return fail("SCOPE_PATH_INVALID", "Traversal is not accepted.");
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, workspaceRelative(target));
  if (!inside(root, absolute)) return fail("SCOPE_PATH_OUTSIDE", "The path is outside the original workspace.");
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (relative) workspaceRelative(relative);
  let current = root;
  for (const part of relative.split("/").filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || !inside(root, fs.realpathSync.native(current))) return fail("SCOPE_PATH_LINK", "Linked/reparsed paths are not authorized.");
    if (stat.isFile() && stat.nlink > 1) return fail("SCOPE_PATH_LINK", "Shared hard-linked paths cannot be authorized as inputs or outputs.");
  }
  return { absolute, relative };
}

export function resolveWorkspaceRead(root: string, target: string): string { return resolvedPath(fs.realpathSync.native(root), target).absolute; }

function inventory(root: string, scope: TaskContractScope, excluded: string[]): WorkspaceInventory {
  const canonical = fs.realpathSync.native(root), rootIdentity = identity(root);
  const explicit = scopePatterns(scope), start = Date.now(); let bytes = 0, count = 0;
  const scan = (): WorkspaceEntry[] => {
    const entries: WorkspaceEntry[] = [], seen = new Set<string>();
    const walk = (dir: string) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++count > 40000 || Date.now() - start > 15000) return fail("SCOPE_SCAN_LIMIT", "The bounded workspace inventory exceeded its entry/time limit.");
        const file = path.join(dir, item.name), name = path.relative(canonical, file).split(path.sep).join("/");
        workspaceRelative(name); if (seen.has(key(name))) return fail("SCOPE_PATH_COLLISION", "Case-insensitive workspace paths collide."); seen.add(key(name));
        const stat = fs.lstatSync(file);
        const serviceExcluded = excluded.some(value => key(name) === key(value) || key(name).startsWith(`${key(value)}/`));
        const vcs = name.split("/").some(part => key(part) === ".git");
        const dependency = key(item.name) === "node_modules" && !explicit.some(pattern => matches(name, [pattern], true));
        if (serviceExcluded) continue;
        if (vcs || dependency) { entries.push({ path: name, kind: "excluded", sha256: null, bytes: 0, links: 0 }); continue; }
        if (stat.isSymbolicLink()) { entries.push({ path: name, kind: "link", sha256: digest(fs.readlinkSync(file)), bytes: 0, links: 1 }); continue; }
        if (!inside(canonical, fs.realpathSync.native(file))) return fail("SCOPE_PATH_OUTSIDE", "An inventory path changed ownership.");
        if (stat.isDirectory()) { if (!excluded.some(value => key(value).startsWith(`${key(name)}/`))) entries.push({ path: name, kind: "directory", sha256: null, bytes: 0, links: 1 }); walk(file); }
        else if (stat.isFile()) {
          if (stat.size > 64 * 1024 * 1024 || (bytes += stat.size) > 512 * 1024 * 1024) return fail("SCOPE_SCAN_LIMIT", "The bounded workspace inventory exceeded its byte limit.");
          const fd = fs.openSync(file, "r"); let hash: string;
          try {
            const before = fs.fstatSync(fd, { bigint: true });
            hash = crypto.createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
            const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
            if (named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return fail("SCOPE_WORKSPACE_CHANGED", "A file changed during inventory.");
          } finally { fs.closeSync(fd); }
          entries.push({ path: name, kind: "file", sha256: hash!, bytes: stat.size, links: stat.nlink });
        } else return fail("SCOPE_PATH_INVALID", "Unsupported filesystem object in workspace.");
      }
    };
    walk(canonical); return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  };
  const originalIndex = gitIndex(canonical), first = scan(), second = scan();
  if (digest(first) !== digest(second) || identity(root) !== rootIdentity || fs.realpathSync.native(root) !== canonical || gitIndex(canonical) !== originalIndex) return fail("SCOPE_WORKSPACE_CHANGED", "The workspace changed during inventory.");
  return { root: canonical, identity: rootIdentity, entries: first, gitIndex: originalIndex };
}

function gitProtected(root: string, entries: WorkspaceEntry[]): { paths: string[]; git: WorkspaceBaseline["git"] } {
  let cursor = root;
  while (!fs.existsSync(path.join(cursor, ".git"))) { const parent = path.dirname(cursor); if (parent === cursor) return { paths: [], git: "not_a_repository" }; cursor = parent; }
  const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "submodule.recurse=false"];
  const run = (extra: string[], cwd = root) => execFileSync("git", [...args, "-C", cwd, ...extra], { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  // Status must not invoke repository-configured clean/process helpers.
  let filters = "";
  try { filters = run(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"]); } catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  for (const name of filters.split(/\r?\n/).filter(Boolean)) args.push("-c", `${name}=${name.endsWith(".required") ? "false" : ""}`);
  const top = run(["rev-parse", "--show-toplevel"]).trim(), tracked = new Set(run(["ls-files", "-z", "--cached"], top).split("\0").filter(Boolean).map(value => key(path.resolve(top, value))));
  const status = run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]), records = status.split("\0"), paths = new Set<string>();
  const add = (value: string) => { const absolute = path.resolve(top, value); if (inside(root, absolute)) { const relative = path.relative(root, absolute).split(path.sep).join("/"); if (relative && !relative.split("/").includes(".git")) paths.add(relative); } };
  for (let i = 0; i < records.length; i++) { const item = records[i]; if (!item) continue; add(item.slice(3)); if (/[RC]/.test(item.slice(0, 2))) add(records[++i] ?? ""); }
  for (const entry of entries) if (entry.kind !== "excluded" && entry.kind !== "directory" && !tracked.has(key(path.resolve(root, entry.path)))) paths.add(entry.path);
  return { paths: [...paths].sort(), git: "observed" };
}

function changes(baseline: WorkspaceBaseline, current: WorkspaceInventory): ScopeChange[] {
  const previous = new Map(baseline.inventory.entries.map(entry => [key(entry.path), entry])), now = new Map(current.entries.map(entry => [key(entry.path), entry]));
  const protectedPaths = new Set(baseline.protectedPaths.map(key)), result: ScopeChange[] = [];
  if (baseline.inventory.gitIndex !== current.gitIndex) result.push({ path: ".git", kind: "modified", category: "unauthorized", problem: "repository_index_conflict" });
  for (const name of new Set([...previous.keys(), ...now.keys(), ...protectedPaths])) {
    const before = previous.get(name), after = now.get(name); if (entryEqual(before, after)) continue;
    const entry = after ?? before!; if (!entry) continue;
    const unsafe = entry.kind === "link" || entry.kind === "excluded" || (entry.kind === "file" && entry.links > 1);
    const problem = protectedPaths.has(name) ? "pre_existing_change_conflict" : unsafe ? "linked_or_unscanned_path" : undefined;
    result.push({ path: after?.path ?? before!.path, ...(before && after && before.path !== after.path ? { previousPath: before.path } : {}), kind: !before ? "added" : !after ? "deleted" : before.path !== after.path ? "renamed" : "modified", category: problem ? "unauthorized" : category(entry.path, entry.kind, baseline.scope), ...(problem ? { problem } : {}) });
  }
  // Content-identical one-to-one file moves are observable renames, not proof of an actor.
  for (const removed of [...result].filter(change => change.kind === "deleted")) {
    const old = previous.get(key(removed.path)); if (old?.kind !== "file") continue;
    const candidates = result.filter(change => change.kind === "added" && now.get(key(change.path))?.kind === "file" && now.get(key(change.path))?.sha256 === old.sha256);
    if (candidates.length !== 1 || result.filter(change => change.kind === "deleted" && previous.get(key(change.path))?.sha256 === old.sha256).length !== 1) continue;
    const added = candidates[0]!; added.kind = "renamed"; added.previousPath = removed.path;
    if (removed.category === "unauthorized" || added.category === "unauthorized") { added.category = "unauthorized"; added.problem ??= removed.problem ?? "rename_endpoint_outside_scope"; }
    result.splice(result.indexOf(removed), 1);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Durable scope facts share the authority database; reads never touch workspace files. */
export class WorkspaceProtection {
  constructor(private readonly db: DatabaseSync, private readonly dbFile: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_scope_baselines (task_id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_scope_attempts (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_scope_checks (check_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_scope_checks_task ON workspace_scope_checks(task_id, check_id);
      CREATE TABLE IF NOT EXISTS workspace_scope_mutations (task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, source_ref TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,attempt_id,source_ref));`);
  }
  private write<T>(action: () => T): T { const savepoint = `scope_${crypto.randomBytes(6).toString("hex")}`; this.db.exec(`SAVEPOINT ${savepoint}`); try { const result = action(); this.db.exec(`RELEASE ${savepoint}`); return result; } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; } }
  private changed(taskId: string, attemptId?: string, type?: string, payload: Record<string, unknown> = {}) {
    const at = new Date().toISOString(), updated = this.db.prepare("UPDATE tasks SET revision=?,updated_at=? WHERE task_id=?").run(crypto.randomBytes(12).toString("base64url"), at, taskId);
    if (Number(updated.changes) && type) this.db.prepare("INSERT INTO task_events(task_id,event_id,attempt_id,type,occurred_at,observed_at,actor,payload_json,source_ref) VALUES (?,(SELECT COALESCE(MAX(event_id),0)+1 FROM task_events WHERE task_id=?),?,?,?,?,?,?,NULL)").run(taskId, taskId, attemptId ?? null, type, at, at, "program", JSON.stringify(payload));
  }
  private baseline(taskId: string): { value: WorkspaceBaseline; digest: string } {
    const row = this.db.prepare("SELECT digest,body FROM workspace_scope_baselines WHERE task_id=?").get(taskId) as { digest: string; body: string } | undefined;
    if (!row) return fail("SCOPE_BASELINE_MISSING", "No dispatch-time workspace baseline exists; history will not be backfilled.");
    const value = JSON.parse(row.body) as WorkspaceBaseline;
    const task = this.db.prepare("SELECT submission_hash FROM tasks WHERE task_id=?").get(taskId) as { submission_hash: string | null } | undefined;
    if (digest(value) !== row.digest || value.taskId !== taskId || value.version !== WORKSPACE_SCOPE_VERSION || (task?.submission_hash && task.submission_hash !== value.bindingHash)) return fail("SCOPE_BASELINE_INTEGRITY", "The original workspace baseline no longer matches its task terms.");
    return { value, digest: row.digest };
  }
  create(taskId: string, workspace: string, bindingHash: string, scope: TaskContractScope, runsDir: string, mode: WorkspaceBaseline["mode"] = "contract") {
    if (this.db.prepare("SELECT 1 FROM workspace_scope_baselines WHERE task_id=?").get(taskId)) { const saved = this.baseline(taskId); if (saved.value.bindingHash !== bindingHash || fs.realpathSync.native(workspace) !== saved.value.inventory.root || digest(scope) !== digest(saved.value.scope) || mode !== saved.value.mode) return fail("SCOPE_BASELINE_INTEGRITY", "Baseline terms or original workspace conflict."); return saved; }
    if (!workspace || !path.isAbsolute(workspace)) return fail("SCOPE_WORKSPACE_REQUIRED", "A real absolute workspace is required before preparation.");
    if (mode === "legacy_read_only" && scopePatterns(scope).length) return fail("SCOPE_PATH_UNAUTHORIZED", "Legacy submissions have no implicit write grant.");
    const root = fs.realpathSync.native(workspace), excludedPaths: string[] = [];
    for (const location of [this.dbFile, `${this.dbFile}-wal`, `${this.dbFile}-shm`, runsDir]) {
      const absolute = canonicalLocation(location);
      if (inside(root, absolute)) { const relative = path.relative(root, absolute).split(path.sep).join("/"); if (!relative) return fail("SCOPE_RUNTIME_CONFLICT", "The workspace cannot equal the service runs directory."); excludedPaths.push(relative); }
    }
    for (const pattern of scopePatterns(scope)) {
      const relative = workspaceRelative(pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern);
      if (relative.split("/").some(part => key(part) === ".git") || excludedPaths.some(item => matches(item, [pattern], true) || key(relative).startsWith(`${key(item)}/`))) return fail("SCOPE_RUNTIME_CONFLICT", "Scope cannot grant writes to service or version-control state.");
      resolvedPath(root, relative);
    }
    const captured = inventory(root, scope, excludedPaths), protectedState = gitProtected(root, captured.entries);
    if (protectedState.paths.filter(name => matches(name, scopePatterns(scope))).length > 100) return fail("SCOPE_SCAN_LIMIT", "Too many protected original paths overlap the declared grant.");
    const value: WorkspaceBaseline = { version: WORKSPACE_SCOPE_VERSION, taskId, bindingHash, mode, scope: structuredClone(scope), inventory: captured, protectedPaths: protectedState.paths, git: protectedState.git, excludedPaths, createdAt: new Date().toISOString() };
    for (const entry of captured.entries) if (category(entry.path, entry.kind, scope) !== "unauthorized" && (entry.kind === "link" || entry.kind === "excluded" || (entry.kind === "file" && entry.links > 1))) return fail("SCOPE_PATH_LINK", "An authorized path is linked or could not be inventoried.");
    // Git observation may take time; no raced bytes are promoted to the original input.
    if (digest(inventory(root, scope, excludedPaths)) !== digest(captured)) return fail("SCOPE_WORKSPACE_CHANGED", "The workspace changed during baseline preparation.");
    this.write(() => { const inserted = this.db.prepare("INSERT INTO workspace_scope_baselines VALUES (?,?,?) ON CONFLICT(task_id) DO NOTHING").run(taskId, digest(value), JSON.stringify(value)); if (Number(inserted.changes)) this.changed(taskId); });
    return this.baseline(taskId);
  }
  guard(taskId: string): WorkspaceDispatchGuard {
    const saved = this.baseline(taskId), current = this.current(saved.value);
    if (changes(saved.value, current).some(change => ["pre_existing_change_conflict", "repository_index_conflict"].includes(change.problem ?? ""))) return fail("SCOPE_USER_CHANGE_CONFLICT", "Protected original user changes or index state were altered.");
    return { taskId, baselineDigest: saved.digest, inventory: current };
  }
  assertGuard(guard: WorkspaceDispatchGuard) {
    const saved = this.baseline(guard.taskId); if (saved.digest !== guard.baselineDigest) return fail("SCOPE_BASELINE_INTEGRITY", "Dispatch baseline changed.");
    const current = this.current(saved.value), prior = { ...saved.value, inventory: guard.inventory };
    if (changes(prior, current).some(change => change.category !== "metadata" || change.problem)) return fail("SCOPE_WORKSPACE_CHANGED", "Workspace input changed while native preparation was awaiting; no new prompt is authorized.");
  }
  bindAttempt(taskId: string, attemptId: string, guard: WorkspaceDispatchGuard) {
    if (guard.taskId !== taskId) return fail("SCOPE_BASELINE_INTEGRITY", "A dispatch guard belongs to another task.");
    this.assertCurrentAttempt(taskId, attemptId);
    this.assertGuard(guard); const body = { taskId, attemptId, baselineDigest: guard.baselineDigest, inventory: guard.inventory };
    this.write(() => { const inserted = this.db.prepare("INSERT INTO workspace_scope_attempts VALUES (?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING").run(attemptId, taskId, digest(body), JSON.stringify(body)); if (Number(inserted.changes)) this.changed(taskId, attemptId, "workspace_baseline_bound", { baselineDigest: guard.baselineDigest }); });
    this.attempt(taskId, attemptId);
  }
  private attempt(taskId: string, attemptId: string) {
    const row = this.db.prepare("SELECT digest,body FROM workspace_scope_attempts WHERE attempt_id=? AND task_id=?").get(attemptId, taskId) as { digest: string; body: string } | undefined;
    if (!row) return fail("SCOPE_BASELINE_MISSING", "This attempt has no original input manifest.");
    const body = JSON.parse(row.body) as WorkspaceDispatchGuard & { attemptId: string };
    if (digest(body) !== row.digest || body.taskId !== taskId || body.attemptId !== attemptId || body.baselineDigest !== this.baseline(taskId).digest) return fail("SCOPE_BASELINE_INTEGRITY", "Attempt scope identity does not verify.");
    return body;
  }
  private assertCurrentAttempt(taskId: string, attemptId: string) {
    const task = this.db.prepare("SELECT attempt_id FROM tasks WHERE task_id=?").get(taskId) as { attempt_id: string | null } | undefined;
    if (!task || task.attempt_id !== attemptId) return fail("STALE_ATTEMPT", "Workspace protection requires the current task attempt.");
  }
  private rootMatches(baseline: WorkspaceBaseline) {
    const task = this.db.prepare("SELECT workspace FROM tasks WHERE task_id=?").get(baseline.taskId) as { workspace: string | null } | undefined;
    if (task && (!task.workspace || fs.realpathSync.native(task.workspace) !== baseline.inventory.root)) return fail("SCOPE_WORKSPACE_CHANGED", "The task no longer names its original workspace.");
    if (fs.realpathSync.native(baseline.inventory.root) !== baseline.inventory.root || identity(baseline.inventory.root) !== baseline.inventory.identity) return fail("SCOPE_WORKSPACE_CHANGED", "The original workspace root was replaced.");
  }
  private current(baseline: WorkspaceBaseline) { this.rootMatches(baseline); const value = inventory(baseline.inventory.root, baseline.scope, baseline.excludedPaths); if (value.root !== baseline.inventory.root || value.identity !== baseline.inventory.identity) return fail("SCOPE_WORKSPACE_CHANGED", "The original workspace root was replaced."); return value; }
  authorizePath(taskId: string, attemptId: string, target: string, mode: "read" | "write") {
    this.assertCurrentAttempt(taskId, attemptId);
    this.attempt(taskId, attemptId); const baseline = this.baseline(taskId).value, currentRoot = fs.realpathSync.native(baseline.inventory.root);
    this.rootMatches(baseline);
    if (currentRoot !== baseline.inventory.root || identity(currentRoot) !== baseline.inventory.identity) return fail("SCOPE_WORKSPACE_CHANGED", "The original workspace root was replaced.");
    const result = resolvedPath(currentRoot, target);
    if (mode === "write" && (!result.relative || category(result.relative, "file", baseline.scope) === "unauthorized" || baseline.protectedPaths.some(item => key(item) === key(result.relative)) || result.relative.split("/").some(part => key(part) === ".git") || baseline.excludedPaths.some(item => key(result.relative) === key(item) || key(result.relative).startsWith(`${key(item)}/`)))) return fail("SCOPE_PATH_UNAUTHORIZED", "The path is outside the original write grant or protects existing user/service state.");
    return result.absolute;
  }
  verifyDispatch(taskId: string, attemptId: string) { this.assertGuard(this.attempt(taskId, attemptId)); }
  verifyPreparation(taskId: string, workspace: string) {
    const saved = this.baseline(taskId);
    if (fs.realpathSync.native(workspace) !== saved.value.inventory.root) return fail("SCOPE_WORKSPACE_CHANGED", "Preparation workspace differs from the original baseline.");
    this.assertGuard({ taskId, baselineDigest: saved.digest, inventory: saved.value.inventory });
  }
  instructions(taskId: string): string {
    const saved = this.baseline(taskId).value, protectedPaths = saved.protectedPaths.filter(name => matches(name, scopePatterns(saved.scope)));
    if (protectedPaths.length > 100) return fail("SCOPE_SCAN_LIMIT", "Too many protected original paths overlap this grant for a bounded handoff.");
    return `Workspace protection: original user changes remain read-only even under declared patterns. Protected relative paths: ${JSON.stringify(protectedPaths)}. Do not stage, commit, reset or modify Git control state. Do not follow symlinks/junctions or edit shared hard links. Only the original allowedChanges and permittedMetadata may change; the gateway will compare cumulative actual files before acceptance.`;
  }
  observeToolCall(taskId: string, attemptId: string, rawType: string | undefined, data: unknown, sourceRef: string) {
    if (rawType !== "tool/call" || !data || typeof data !== "object") return;
    if (this.readView(taskId).baseline === "missing") return;
    const call = data as { name?: string; arguments?: unknown };
    if (!["write", "write_file", "edit", "edit_file", "move_file", "rename_file", "delete_file"].includes(call.name ?? "")) return;
    let args: Record<string, unknown>;
    try { args = (typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments) as Record<string, unknown>; if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("shape"); }
    catch { this.noteMutation(taskId, attemptId, ["<unresolved native write path>"], sourceRef); return; }
    const root = this.baseline(taskId).value.inventory.root, cwd = typeof args.workdir === "string" ? path.resolve(root, args.workdir) : root;
    const targets = ["path", "filePath", "file_path", "source", "destination", "oldPath", "newPath"].flatMap(name => typeof args[name] === "string" ? [path.resolve(cwd, args[name] as string)] : []);
    this.noteMutation(taskId, attemptId, targets.length ? targets : ["<unresolved native write path>"], sourceRef);
  }
  noteMutation(taskId: string, attemptId: string, paths: string[], sourceRef: string) {
    const issues: string[] = [];
    for (const target of paths) { try { this.authorizePath(taskId, attemptId, target, "write"); } catch (error) { issues.push(error instanceof AdmissionError ? error.code : "SCOPE_CHECKER_ERROR"); } }
    if (!issues.length) return;
    this.write(() => { const inserted = this.db.prepare("INSERT INTO workspace_scope_mutations VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(taskId, attemptId, sourceRef, JSON.stringify({ paths, issues })); if (Number(inserted.changes)) this.changed(taskId, attemptId, "workspace_path_violation", { issues, sourceRef }); });
  }
  review(taskId: string, attemptId: string): WorkspaceScopeCheck {
    const observed = this.db.prepare("SELECT attempt_id,revision FROM tasks WHERE task_id=?").get(taskId) as { attempt_id: string | null; revision: string | null } | undefined;
    if (!observed || observed.attempt_id !== attemptId) return fail("STALE_ATTEMPT", "Scope checks only inspect the current attempt.");
    this.attempt(taskId, attemptId); const saved = this.baseline(taskId);
    let check: WorkspaceScopeCheck = { actor: "program", version: WORKSPACE_SCOPE_VERSION, taskId, attemptId, baselineDigest: saved.digest, status: "checker_error", checkedAt: new Date().toISOString(), inventoryDigest: null, coverage: "workspace_inventory", excludedPaths: [".git", "node_modules (unless explicitly inventoried)", ...saved.value.excludedPaths], changes: [], limitations: LIMITATIONS };
    try {
      const current = this.current(saved.value), delta = changes(saved.value, current), violations = this.db.prepare("SELECT 1 FROM workspace_scope_mutations WHERE task_id=? LIMIT 1").get(taskId);
      check = { ...check, status: violations || delta.some(change => change.category === "unauthorized") ? "failed" : "passed", inventoryDigest: digest(current), changes: delta, ...(violations ? { error: "known_native_path_violation" } : {}) };
    } catch (error) { check.error = error instanceof AdmissionError ? error.code : "SCOPE_CHECKER_ERROR"; }
    const stable = (value: WorkspaceScopeCheck) => digest({ ...value, checkedAt: null });
    const prior = this.latest(taskId, attemptId);
    return this.write(() => {
      const current = this.db.prepare("SELECT attempt_id,revision FROM tasks WHERE task_id=?").get(taskId) as typeof observed;
      if (!current || current.attempt_id !== attemptId || current.revision !== observed.revision) return fail("READ_CONFLICT", "The task changed during scope observation.");
      if (prior && stable(prior) === stable(check)) return prior;
      this.db.prepare("INSERT INTO workspace_scope_checks(task_id,attempt_id,digest,body) VALUES(?,?,?,?)").run(taskId, attemptId, digest(check), JSON.stringify(check)); this.changed(taskId, attemptId, "workspace_scope_checked", { status: check.status, changeCount: check.changes.length, coverage: check.coverage }); return check;
    });
  }
  latest(taskId: string, attemptId?: string): WorkspaceScopeCheck | null {
    const row = this.db.prepare(`SELECT digest,body FROM workspace_scope_checks WHERE task_id=? ${attemptId ? "AND attempt_id=?" : ""} ORDER BY check_id DESC LIMIT 1`).get(taskId, ...(attemptId ? [attemptId] : [])) as { digest: string; body: string } | undefined;
    if (!row) return null; const result = JSON.parse(row.body) as WorkspaceScopeCheck;
    if (digest(result) !== row.digest || result.taskId !== taskId || (attemptId && result.attemptId !== attemptId)) return fail("SCOPE_BASELINE_INTEGRITY", "The saved scope check is corrupt."); return result;
  }
  assertAcceptance(taskId: string, attemptId: string) {
    this.assertCurrentAttempt(taskId, attemptId);
    this.attempt(taskId, attemptId); const saved = this.baseline(taskId), check = this.latest(taskId, attemptId);
    if (!check || check.status !== "passed" || check.baselineDigest !== saved.digest) return fail("SCOPE_REVIEW_REQUIRED", "A current passing workspace scope check is required.");
    if (digest(this.current(saved.value)) !== check.inventoryDigest || this.db.prepare("SELECT 1 FROM workspace_scope_mutations WHERE task_id=? LIMIT 1").get(taskId)) return fail("SCOPE_EVIDENCE_STALE", "Workspace scope evidence changed before acceptance.");
  }
  readView(taskId: string, attemptId?: string): WorkspaceScopeView {
    try { const saved = this.baseline(taskId), check = attemptId ? this.latest(taskId, attemptId) : null; if (check && check.baselineDigest !== saved.digest) return fail("SCOPE_BASELINE_INTEGRITY", "Scope check belongs to another baseline."); return { scope: saved.value.scope, version: WORKSPACE_SCOPE_VERSION, baseline: "present", mode: saved.value.mode, baselineDigest: saved.digest, protectedCount: saved.value.protectedPaths.length, coverage: "workspace_inventory", excludedPaths: [".git", "node_modules (unless explicitly inventoried)", ...saved.value.excludedPaths], check: check ? { ...check, changes: check.changes.slice(0, 100) } : null, changeCount: check?.changes.length ?? null, changesTruncated: (check?.changes.length ?? 0) > 100 }; }
    catch (error) { return { scope: null, version: WORKSPACE_SCOPE_VERSION, baseline: error instanceof AdmissionError && error.code === "SCOPE_BASELINE_MISSING" ? "missing" : "integrity_failure", mode: null, baselineDigest: null, protectedCount: null, coverage: "workspace_inventory", excludedPaths: [], check: null, changeCount: null, changesTruncated: false }; }
  }
}
