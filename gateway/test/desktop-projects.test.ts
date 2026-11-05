import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopProjectStore, desktopProjectId, matchDesktopProject, resolveDesktopProject, verifyDesktopProject } from "../src/desktop-projects.js";

function sandbox(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-projects-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return dir;
}

test("project selection refuses an unusable folder with a specific reason instead of guessing", (t) => {
  const dir = sandbox(t), file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "x");
  const cases: Array<[unknown, string]> = [
    [undefined, "PROJECT_PATH_REQUIRED"],
    ["   ", "PROJECT_PATH_REQUIRED"],
    ["relative/project", "PROJECT_PATH_NOT_ABSOLUTE"],
    [path.join(dir, "missing"), "PROJECT_NOT_FOUND"],
    [file, "PROJECT_NOT_DIRECTORY"],
  ];
  for (const [value, code] of cases) {
    const result = resolveDesktopProject(value);
    assert.equal(result.ok, false, String(value));
    if (!result.ok) assert.equal(result.code, code);
  }
});

test("a junction resolves to the target identity, so the link name never becomes the project", (t) => {
  const dir = sandbox(t), target = path.join(dir, "real-project"), link = path.join(dir, "linked-project");
  fs.mkdirSync(target);
  try { fs.symlinkSync(target, link, "junction"); }
  catch { t.skip?.("this filesystem cannot create a junction"); return; }
  const direct = resolveDesktopProject(target), throughLink = resolveDesktopProject(link);
  assert.equal(direct.ok, true); assert.equal(throughLink.ok, true);
  if (!direct.ok || !throughLink.ok) return;
  assert.equal(throughLink.linked, true);
  assert.equal(throughLink.requestedPath, link);
  assert.equal(throughLink.identity.realPath, direct.identity.realPath);
  assert.equal(desktopProjectId(throughLink.identity), desktopProjectId(direct.identity));
});

test("a renamed folder keeps its identity while a replaced directory is refused", (t) => {
  const dir = sandbox(t), before = path.join(dir, "before"), after = path.join(dir, "after");
  fs.mkdirSync(before);
  const original = resolveDesktopProject(before);
  assert.equal(original.ok, true);
  if (!original.ok) return;
  fs.renameSync(before, after);
  const renamed = resolveDesktopProject(after);
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;
  assert.equal(desktopProjectId(renamed.identity), desktopProjectId(original.identity));
  const replaced = verifyDesktopProject({ ...original.identity, inode: String(BigInt(original.identity.inode) + 1n) });
  assert.equal(replaced.ok, false);
  if (!replaced.ok) assert.equal(replaced.code, "PROJECT_IDENTITY_CHANGED");
  const gone = verifyDesktopProject({ realPath: path.join(dir, "deleted"), device: "1", inode: "2" });
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.code, "PROJECT_IDENTITY_CHANGED");
});

test("the registry is bounded, ordered and reports an unreadable file instead of inventing identities", (t) => {
  const dir = sandbox(t), file = path.join(dir, "state", "projects.json");
  const store = new DesktopProjectStore({ file, now: () => Date.parse("2026-11-05T00:00:00Z") });
  for (let index = 0; index < 25; index++) {
    const project = path.join(dir, `project-${String(index).padStart(2, "0")}`);
    fs.mkdirSync(project);
    const resolved = resolveDesktopProject(project);
    assert.equal(resolved.ok, true);
    if (resolved.ok) store.remember(resolved.identity, project);
  }
  const listed = store.list();
  assert.equal(listed.length, 20);
  assert.equal(listed[0]!.displayName, "project-24");
  assert.equal(new DesktopProjectStore({ file }).list().length, 20);

  const renamed = path.join(dir, "renamed-24");
  fs.renameSync(path.join(dir, "project-24"), renamed);
  const renamedIdentity = resolveDesktopProject(renamed);
  assert.equal(renamedIdentity.ok, true);
  if (renamedIdentity.ok) {
    const remembered = store.remember(renamedIdentity.identity, renamed);
    assert.equal(remembered.projectId, listed[0]!.projectId);
    assert.ok(remembered.aliases.includes("project-24"));
    assert.equal(store.list().length, 20);
  }

  fs.writeFileSync(file, "not a registry");
  const broken = new DesktopProjectStore({ file });
  assert.deepEqual(broken.list(), []);
  assert.equal(broken.issues().length, 1);
  assert.deepEqual(broken.candidates(), []);
});

test("a folder name shared by two identities is ambiguous instead of newest-wins", (t) => {
  const dir = sandbox(t), store = new DesktopProjectStore({ file: null });
  const projects = ["one", "two"].map(parent => {
    const project = path.join(dir, parent, "app");
    fs.mkdirSync(project, { recursive: true });
    const resolved = resolveDesktopProject(project);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) throw Error("unexpected");
    return store.remember(resolved.identity, project);
  });
  const ambiguous = matchDesktopProject(projects, "app");
  assert.equal(ambiguous.state, "ambiguous");
  if (ambiguous.state === "ambiguous") assert.equal(ambiguous.candidates.length, 2);
  const exact = matchDesktopProject(projects, projects[1]!.realPath);
  assert.equal(exact.state, "matched");
  if (exact.state === "matched") assert.equal(exact.project.projectId, projects[1]!.projectId);
  assert.equal(matchDesktopProject(projects, "unknown").state, "missing");
  assert.equal(matchDesktopProject(projects, "").state, "missing");
});

test("candidate rows stay unverified until a selection re-reads the directory", (t) => {
  const dir = sandbox(t), project = path.join(dir, "project"), file = path.join(dir, "projects.json");
  fs.mkdirSync(project);
  const resolved = resolveDesktopProject(project);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const store = new DesktopProjectStore({ file });
  const saved = store.remember(resolved.identity, project);
  const candidates = store.candidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.state, "unverified");
  assert.equal(candidates[0]!.projectId, saved.projectId);
  assert.equal(store.find(saved.projectId)!.device, resolved.identity.device);
  assert.equal(store.find("project-" + "0".repeat(32)), null);
  assert.ok(!JSON.stringify(candidates).includes("device"), "candidate rows never expose the raw identity pair");
});

test("an unwritable registry path never blocks the selection it only remembers", (t) => {
  const dir = sandbox(t), project = path.join(dir, "project");
  fs.mkdirSync(project);
  const resolved = resolveDesktopProject(project);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const blocker = path.join(dir, "blocked-file");
  fs.writeFileSync(blocker, "x");
  const store = new DesktopProjectStore({ file: path.join(blocker, "projects.json") });
  const saved = store.remember(resolved.identity);
  assert.equal(saved.realPath, resolved.identity.realPath);
  assert.equal(store.issues().length, 1);
  assert.equal(store.list().length, 1);
  for (const issue of store.issues()) assert.ok(!issue.includes(dir), "registry problems never echo an absolute path");
});
