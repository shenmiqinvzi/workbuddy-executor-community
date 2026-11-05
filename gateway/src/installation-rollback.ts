import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, readArchiveMembers, type CandidateInspection } from "./installation-readiness.js";

/**
 * Read-only version rollback plan.
 *
 * Rolling back is not "copy the old zip back": the file set changes (a newer
 * release adds files that must go away), the managed skill and MCP snippet are
 * rewritten, a running gateway process keeps its old code until restarted, and a
 * newer task database may no longer be understood by the older build. This module
 * states each of those differences with file hashes, then refuses to call the
 * plan safe when it cannot prove the target release can read the current data.
 *
 * Nothing here writes, removes, stops or restarts anything.
 */

export const ROLLBACK_PLAN_SCHEMA = "workbuddy-installation-rollback/v1";

export type ChangeAction = "replace" | "create" | "remove" | "keep" | "blocked";
export interface FileChange {
  path: string;
  action: ChangeAction;
  installedSha256: string | null;
  targetSha256: string | null;
  reason?: string;
}
export interface ReleaseIdentity {
  file: string;
  version: string;
  sha256: string;
  matched: number;
  differing: string[];
  missing: string[];
  exact: boolean;
}
export interface SchemaExpectations {
  source: string | null;
  tables: Record<string, string[]>;
  complete: boolean;
  note: string;
}
export interface DatabaseObservation {
  exists: boolean;
  readable: boolean;
  tables: Record<string, string[]>;
  states: string[];
  tasks: number | null;
  error: string | null;
}
export interface SchemaAssessment {
  decision: "not_applicable" | "compatible" | "incompatible" | "unknown";
  missingColumns: string[];
  observedStates: string[];
  notes: string[];
  recovery: string[];
}
export interface RollbackPlan {
  schemaVersion: string;
  readOnly: true;
  target: { installRoot: string; codexHome: string };
  from: { version: string; archiveSha256: string; file: string };
  to: { version: string; archiveSha256: string; file: string };
  counts: { replace: number; create: number; remove: number; keep: number; blocked: number };
  files: FileChange[];
  blocked: { path: string; reason: string }[];
  runtimeTarget: { entrypoint: string; node: string; packageVersionAfter: string; restartRequired: true; runningProcessUnaffected: true; verification: string[] };
  configImpact: { env: string; mcpSnippet: string; skill: string; taskDatabase: string; runs: string; service: string; notes: string[] };
  schema: { database: DatabaseObservation; expectations: SchemaExpectations; assessment: SchemaAssessment };
  steps: string[];
  failureRemediation: string[];
  safeToApply: boolean;
  scope: string;
}

export interface RollbackInput {
  installRoot: string;
  codexHome: string;
  current: CandidateInspection;
  target: CandidateInspection;
  env?: NodeJS.ProcessEnv;
  taskDatabase?: string;
  /** Skill tree hashes recorded by the installer; drift blocks the plan exactly as setup would. */
  installedSkillFiles?: Record<string, string>;
}

function lstatSafe(filename: string) {
  try { return fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function hashFile(filename: string) { return digest(fs.readFileSync(filename)); }
function inside(root: string, relative: string) {
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(path.resolve(root) + path.sep)) throw new Error(`Release path escapes the installation root: ${relative}`);
  return filename;
}

/** Which release archive the installation root currently matches, by file hash. */
export function identifyInstalledRelease(installRoot: string, inspections: CandidateInspection[]): ReleaseIdentity[] {
  return inspections.map(inspection => {
    let matched = 0;
    const differing: string[] = [], missing: string[] = [];
    for (const entry of inspection.entries) {
      const filename = inside(installRoot, entry.path);
      const stat = lstatSafe(filename);
      if (!stat?.isFile()) { missing.push(entry.path); continue; }
      let actual: string;
      try { actual = hashFile(filename); } catch { missing.push(entry.path); continue; }
      if (actual === entry.sha256) matched += 1; else differing.push(entry.path);
    }
    return {
      file: inspection.archive.file, version: inspection.release.version, sha256: inspection.archive.sha256,
      matched, differing, missing, exact: missing.length === 0 && differing.length === 0 && inspection.ok,
    };
  });
}

const CONSTRAINT_WORDS = /^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX|KEY)\b/i;

/**
 * Read the tables and columns an older build expects, straight out of its own
 * task-store source in the archive. Nothing is inferred from the current code.
 */
export function extractSchemaExpectations(archiveFile: string): SchemaExpectations {
  const empty: SchemaExpectations = { source: null, tables: {}, complete: false, note: "The archive carries no readable task-store source." };
  let members: Map<string, Buffer>;
  try { members = readArchiveMembers(archiveFile); } catch (error) { return { ...empty, note: `Archive could not be read: ${(error as Error).message}` }; }
  const candidates = [...members.keys()].filter(name => /(?:^|\/)(?:src\/task-store\.ts|dist\/task-store\.js)$/.test(name));
  const chosen = candidates.find(name => name.endsWith("src/task-store.ts")) ?? candidates[0];
  if (!chosen) return empty;
  const text = members.get(chosen)!.toString("utf8");
  const tables: Record<string, string[]> = {};
  for (const match of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\);/g)) {
    const table = match[1]!, body = match[2]!;
    const columns: string[] = [];
    for (const line of body.split(",")) {
      // A nested ")" from a column constraint can leave the closing paren inside the
      // final fragment; strip trailing punctuation so the name is only the identifier.
      const column = line.trim().split(/\s+/)[0]?.replace(/[)\s]+$/, "") ?? "";
      if (!column || CONSTRAINT_WORDS.test(column)) continue;
      columns.push(column);
    }
    if (columns.length) tables[table] = [...new Set([...(tables[table] ?? []), ...columns])];
  }
  // Columns added by migration are built from an object literal; read the keys.
  const migration = /PRAGMA table_info\(tasks\)[\s\S]{0,400}?Object\.entries\(\{([\s\S]*?)\n\s*\}\)/.exec(text);
  if (migration?.[1]) {
    const added = [...migration[1].matchAll(/(\w+)\s*:\s*"[A-Z]/g)].map(item => item[1]!);
    if (added.length) tables.tasks = [...new Set([...(tables.tasks ?? []), ...added])];
  }
  const complete = Boolean(tables.tasks?.length && tables.messages?.length);
  return {
    source: chosen.split("/").slice(1).join("/"),
    tables,
    complete,
    note: complete ? "Columns come from the target release's own task-store source." : "The target release's schema could not be read completely; compatibility stays unknown.",
  };
}

/** Read-only observation of the live task database. Never migrates or repairs. */
export function inspectTaskDatabase(dbFile: string): DatabaseObservation {
  const observation: DatabaseObservation = { exists: fs.existsSync(dbFile), readable: false, tables: {}, states: [], tasks: null, error: null };
  if (!observation.exists) return observation;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(item => String(item.name));
    for (const table of tables) {
      observation.tables[table] = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(item => String(item.name));
    }
    if (observation.tables.tasks) {
      observation.tasks = Number((db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count?: number } | undefined)?.count ?? 0);
      observation.states = (db.prepare("SELECT DISTINCT state FROM tasks ORDER BY state").all() as Array<{ state: string }>).map(item => String(item.state));
    }
    observation.readable = true;
  } catch (error) {
    observation.error = String((error as Error).message ?? error);
  } finally { db?.close(); }
  return observation;
}

/** Decide whether an older build can still read the current data, and name the route if it cannot. */
export function assessSchemaDowngrade(database: DatabaseObservation, expectations: SchemaExpectations): SchemaAssessment {
  const recovery = [
    "Keep the current installation and its data/ directory exactly as they are until the rollback is decided; do not start the older build against the live database to \"see what happens\".",
    "Copy data/tasks.sqlite, data/runs/ and .env to a timestamped backup before touching any file; a copy, not a move.",
    "If the older build cannot read the current schema, run it in a side-by-side root with a copy of the data and verify reading there before the live root changes.",
    "If the current data must stay authoritative, restore the pre-upgrade copy of data/ taken before this upgrade; that copy is the only state the older build is known to read.",
    "Deleting or recreating the task database is not a recovery step: it erases task history, stop evidence and reports. Never present it as the fix.",
  ];
  if (!database.exists) return { decision: "not_applicable", missingColumns: [], observedStates: [], notes: ["No task database exists in this installation, so there is no schema to downgrade."], recovery: [] };
  if (!database.readable) return { decision: "unknown", missingColumns: [], observedStates: [], notes: [`The task database could not be read (${database.error ?? "unknown error"}); an unreadable database is refused by the installer, not assumed empty.`], recovery };
  if (!expectations.complete) return { decision: "unknown", missingColumns: [], observedStates: database.states, notes: [expectations.note], recovery };
  const expectedTables = Object.keys(expectations.tables);
  if (expectedTables.length && expectedTables.every(table => !(database.tables[table] ?? []).length)) {
    return {
      decision: "unknown",
      missingColumns: [],
      observedStates: [],
      notes: [
        expectations.note,
        `This database has none of the tables the target release declares (${expectedTables.join(", ")}); it does not look like a gateway task store. Point --task-db at the gateway's own data directory instead of a native WorkBuddy database.`,
      ],
      recovery,
    };
  }
  const missingColumns: string[] = [];
  for (const [table, columns] of Object.entries(expectations.tables)) {
    const present = new Set(database.tables[table] ?? []);
    if (!present.size) { missingColumns.push(`${table} (table absent)`); continue; }
    for (const column of columns) if (!present.has(column)) missingColumns.push(`${table}.${column}`);
  }
  const notes = [expectations.note];
  if (!missingColumns.length) notes.push("Every column the target release declares is present; extra newer columns are ignored by named-column reads.");
  if (database.states.length) notes.push(`Task states currently stored: ${database.states.join(", ")}. An older build may not understand a state string introduced after it was released; review those tasks before switching.`);
  return { decision: missingColumns.length ? "incompatible" : "compatible", missingColumns, observedStates: database.states, notes, recovery };
}

function skillTreeHashes(directory: string): Record<string, string> | undefined {
  if (!lstatSafe(directory)?.isDirectory()) return undefined;
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

/** Build the difference plan between the installed release and an older one. */
export function planVersionRollback(input: RollbackInput): RollbackPlan {
  const installRoot = path.resolve(input.installRoot);
  const codexHome = path.resolve(input.codexHome);
  const env = input.env ?? {};
  const files: FileChange[] = [];
  const blocked: { path: string; reason: string }[] = [];
  if (!input.current.ok) blocked.push({ path: input.current.archive.file, reason: "current_archive_not_verified" });
  if (!input.target.ok) blocked.push({ path: input.target.archive.file, reason: "target_archive_not_verified" });

  const targetPaths = new Map(input.target.entries.map(entry => [entry.path, entry.sha256]));
  for (const entry of input.target.entries) {
    let filename: string;
    try { filename = inside(installRoot, entry.path); } catch (error) { blocked.push({ path: entry.path, reason: (error as Error).message }); continue; }
    const stat = lstatSafe(filename);
    if (!stat) { files.push({ path: entry.path, action: "create", installedSha256: null, targetSha256: entry.sha256 }); continue; }
    if (stat.isSymbolicLink()) { files.push({ path: entry.path, action: "blocked", installedSha256: null, targetSha256: entry.sha256, reason: "target_is_link" }); blocked.push({ path: entry.path, reason: "target_is_link" }); continue; }
    if (!stat.isFile()) { files.push({ path: entry.path, action: "blocked", installedSha256: null, targetSha256: entry.sha256, reason: "target_is_not_a_file" }); blocked.push({ path: entry.path, reason: "target_is_not_a_file" }); continue; }
    let installed: string;
    try { installed = hashFile(filename); } catch { files.push({ path: entry.path, action: "blocked", installedSha256: null, targetSha256: entry.sha256, reason: "target_unreadable" }); blocked.push({ path: entry.path, reason: "target_unreadable" }); continue; }
    if (installed === entry.sha256) files.push({ path: entry.path, action: "keep", installedSha256: installed, targetSha256: entry.sha256 });
    else files.push({ path: entry.path, action: "replace", installedSha256: installed, targetSha256: entry.sha256 });
  }
  // Files the newer release added must go away on a downgrade, but only when they
  // are still exactly the bytes that release published.
  for (const entry of input.current.entries) {
    if (targetPaths.has(entry.path)) continue;
    let filename: string;
    try { filename = inside(installRoot, entry.path); } catch { continue; }
    const stat = lstatSafe(filename);
    if (!stat) continue;
    if (stat.isSymbolicLink()) { files.push({ path: entry.path, action: "blocked", installedSha256: null, targetSha256: null, reason: "installed_file_is_link" }); blocked.push({ path: entry.path, reason: "installed_file_is_link" }); continue; }
    if (!stat.isFile()) continue;
    let installed: string;
    try { installed = hashFile(filename); } catch { continue; }
    if (installed === entry.sha256) files.push({ path: entry.path, action: "remove", installedSha256: installed, targetSha256: null });
    else {
      files.push({ path: entry.path, action: "blocked", installedSha256: installed, targetSha256: null, reason: "local_changes_would_be_lost" });
      blocked.push({ path: entry.path, reason: "local_changes_would_be_lost" });
    }
  }
  const skillDir = path.join(codexHome, "skills", "workbuddy-executor");
  try {
    const current = skillTreeHashes(skillDir);
    const expected = input.installedSkillFiles;
    if (current && expected) {
      const same = Object.keys(expected).length === Object.keys(current).length && Object.entries(expected).every(([name, hash]) => current[name] === hash);
      if (!same) blocked.push({ path: "skills/workbuddy-executor", reason: "installed_skill_has_local_changes" });
    }
  } catch (error) {
    blocked.push({ path: "skills/workbuddy-executor", reason: (error as Error).message });
  }

  const taskDatabase = path.resolve(input.taskDatabase ?? path.join(installRoot, "data", "tasks.sqlite"));
  const database = inspectTaskDatabase(taskDatabase);
  const expectations = extractSchemaExpectations(input.target.archive.file);
  const assessment = assessSchemaDowngrade(database, expectations);

  const counts = { replace: 0, create: 0, remove: 0, keep: 0, blocked: files.filter(item => item.action === "blocked").length };
  for (const item of files) if (item.action === "replace") counts.replace += 1; else if (item.action === "create") counts.create += 1; else if (item.action === "remove") counts.remove += 1; else if (item.action === "keep") counts.keep += 1;

  const schemaBlocks = assessment.decision === "incompatible" || assessment.decision === "unknown";
  const safeToApply = blocked.length === 0 && input.current.ok && input.target.ok && !schemaBlocks && counts.blocked === 0;

  const configImpact = {
    env: "Preserved byte for byte: the installer never rewrites an existing .env, and this plan writes none.",
    mcpSnippet: `data/workbuddy-mcp.toml is regenerated by setup upgrade only when the managed content differs; a locally edited snippet stops the upgrade instead of being overwritten.`,
    skill: `The managed skill tree at ${skillDir} is replaced from the target release by setup upgrade; the previous tree is backed up by the installer before replacement.`,
    taskDatabase: database.exists ? `Untouched by every step in this plan: ${taskDatabase}. Back it up before applying.` : "No task database exists in this installation.",
    runs: "data/runs/ is never rewritten, moved or pruned by a rollback; run journals stay readable evidence.",
    service: "A registered persistent service must be uninstalled first: it embeds the absolute paths of this installation, and setup refuses to change a live service.",
    notes: [
      "Replacing files does not change a process that is already running: the old gateway keeps executing its old code until it is restarted.",
      "No model, task, account or login state is read, changed or re-sent by this plan.",
    ],
  };

  const runtimeTarget = {
    entrypoint: path.join(installRoot, "dist", "server.js"),
    node: env.WORKBUDDY_NODE_BIN ?? process.execPath,
    packageVersionAfter: input.target.release.version,
    restartRequired: true as const,
    runningProcessUnaffected: true as const,
    verification: [
      "node scripts/doctor.mjs  (prints runtime.packageVersion and runtime.codeHash)",
      "Confirm packageVersion equals the target release version and codeHash differs from the newer build",
      "Then restart the MCP client/gateway process; a running process is not upgraded by replacing files",
    ],
  };

  const steps = [
    `Record the current release: ${input.current.release.version} (${input.current.archive.sha256})`,
    `Target release for the rollback: ${input.target.release.version} (${input.target.archive.sha256})`,
    "Finish or explicitly end every task, confirm native stop evidence and uninstall any registered persistent service; the installer refuses anything else.",
    "Copy .env, data/tasks.sqlite, data/runs/, data/persistent-service.json and the managed skill directory to a timestamped backup.",
    `Write exactly the ${counts.replace} replace and ${counts.create} create paths listed here from the target archive; keep the ${counts.keep} matching files untouched.`,
    counts.remove ? `Remove exactly the ${counts.remove} path(s) the newer release added and nothing else.` : "No file was added by the newer release, so nothing has to be removed.",
    "Run node scripts/setup.mjs upgrade --apply from the installation root so the skill, snippet and installation record match the target release.",
    "Run node scripts/doctor.mjs and compare runtime.packageVersion / codeHash with the target release.",
    "Restart the gateway/MCP process yourself; deleting the database is never part of a rollback.",
  ];

  const failureRemediation = [
    `Re-unpack ${input.current.archive.file} over the installation root to return every managed file to the newer release's bytes.`,
    "setup upgrade restores a previously backed-up skill when it fails; verify the skill directory and data/workbuddy-mcp.toml afterwards.",
    "If the schema assessment was incompatible or unknown and data was already touched, restore the pre-upgrade copy of data/ instead of recreating the database.",
    "A remaining data/setup-in-progress.json lock means an earlier run was interrupted: inspect the backup and that run before retrying.",
  ];

  return {
    schemaVersion: ROLLBACK_PLAN_SCHEMA,
    readOnly: true,
    target: { installRoot, codexHome },
    from: { version: input.current.release.version, archiveSha256: input.current.archive.sha256, file: input.current.archive.file },
    to: { version: input.target.release.version, archiveSha256: input.target.archive.sha256, file: input.target.archive.file },
    counts,
    files: files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    blocked,
    runtimeTarget,
    configImpact,
    schema: { database, expectations, assessment },
    steps,
    failureRemediation,
    safeToApply,
    scope: "Isolated, file-and-schema difference plan for one installation. It contains no production switch, no service change and no data migration.",
  };
}

/** The exact writes and removals a caller may perform for this plan, or nothing. */
export function rollbackOperations(plan: RollbackPlan) {
  if (!plan.safeToApply) return { apply: false as const, reason: plan.blocked.length ? "blocked_paths" : "schema_or_archive_not_verified", write: [] as string[], remove: [] as string[] };
  return {
    apply: true as const,
    write: plan.files.filter(item => item.action === "replace" || item.action === "create").map(item => item.path),
    remove: plan.files.filter(item => item.action === "remove").map(item => item.path),
  };
}
