import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipDirectory } from "../scripts/zip.mjs";
import { REQUIRED_SHARED, readArchive, relativeName, unsafePath, verifyPairing, versionCore } from "../scripts/verify-pairing.mjs";

/**
 * R4: a pairing check that only compares the intersection passes when the
 * desktop archive lost the gateway sources, when a manifest is missing, or when
 * the manifests describe files the archives do not ship. These fixtures build
 * two archives from one policy (REQUIRED_SHARED) and then break one thing at a
 * time; every break must be reported, never smoothed over.
 */

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

function write(root: string, relative: string, text: string) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return { path: relative, bytes: Buffer.byteLength(text), sha256: sha256(text) };
}

function sidecar(archive: string, digest?: string) {
  const bytes = fs.readFileSync(archive);
  const recorded = digest ?? crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(`${archive}.sha256`, `${recorded}  ${path.basename(archive)}\n`, "utf8");
}

interface PairOptions {
  desktopText?: (relative: string) => string;
  omitDesktop?: string[];
  omitGateway?: string[];
  skipDesktopManifest?: boolean;
  manifestDigest?: string;
  manifestExtra?: { path: string; bytes: number; sha256: string };
  manifestMissing?: string;
  versions?: { gateway: string; desktop: string };
  unexpectedGatewayOnly?: string;
  wrongSidecar?: boolean;
}

async function pair(options: PairOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));
  const gatewayRoot = path.join(directory, "gateway-source");
  const desktopRoot = path.join(directory, "desktop-source", "gateway");
  const shared = REQUIRED_SHARED.filter(relative => !(options.omitGateway ?? []).includes(relative) && !(options.omitDesktop ?? []).includes(relative));
  for (const relative of shared) {
    const text = `// ${relative}\n`;
    write(gatewayRoot, relative, text);
    write(desktopRoot, relative, options.desktopText?.(relative) ?? text);
  }
  for (const relative of options.omitGateway ?? []) write(desktopRoot, relative, `// ${relative}\n`);
  for (const relative of options.omitDesktop ?? []) write(gatewayRoot, relative, `// ${relative}\n`);
  if (options.unexpectedGatewayOnly) write(gatewayRoot, options.unexpectedGatewayOnly, "// only here\n");
  // One-sided desktop files, by design: the compiled shell and its guide.
  write(path.join(directory, "desktop-source"), "desktop/app/WorkBuddy.Workbench.exe", "MZ fake\n");
  write(path.join(directory, "desktop-source"), "PREVIEW-START-HERE.md", "# preview\n");

  const gatewayFiles = [...shared.filter(relative => !(options.omitDesktop ?? []).includes(relative)), ...(options.omitDesktop ?? [])]
    .map(relative => ({ path: relative, bytes: Buffer.byteLength(`// ${relative}\n`), sha256: sha256(`// ${relative}\n`) }));
  const gatewayManifest = { project: "codex-workbuddy-gateway", version: options.versions?.gateway ?? "0.7.1", files: gatewayFiles };
  if (options.manifestMissing) gatewayManifest.files = gatewayManifest.files.filter(entry => entry.path !== options.manifestMissing);
  if (options.manifestExtra) gatewayManifest.files = [...gatewayManifest.files, options.manifestExtra];
  write(gatewayRoot, "RELEASE_MANIFEST.json", JSON.stringify(gatewayManifest));

  const desktopFiles = [
    ...shared.map(relative => ({ path: `gateway/${relative}`, bytes: Buffer.byteLength(options.desktopText?.(relative) ?? `// ${relative}\n`), sha256: sha256(options.desktopText?.(relative) ?? `// ${relative}\n`) })),
    { path: "desktop/app/WorkBuddy.Workbench.exe", bytes: Buffer.byteLength("MZ fake\n"), sha256: sha256("MZ fake\n") },
    { path: "PREVIEW-START-HERE.md", bytes: Buffer.byteLength("# preview\n"), sha256: sha256("# preview\n") },
  ];
  if (options.manifestDigest) desktopFiles[0] = { ...desktopFiles[0], sha256: options.manifestDigest };
  if (!options.skipDesktopManifest) {
    write(path.join(directory, "desktop-source"), "RELEASE_MANIFEST.json", JSON.stringify({ project: "codex-workbuddy-gateway", version: options.versions?.desktop ?? "0.7.1", files: desktopFiles }));
  }

  const gatewayArchive = path.join(directory, "codex-workbuddy-gateway-v0.7.1.zip");
  const desktopArchive = path.join(directory, "workbuddy-desktop-v0.7.1-t7d.zip");
  await zipDirectory(gatewayRoot, gatewayArchive, "codex-workbuddy-gateway-v0.7.1");
  await zipDirectory(path.join(directory, "desktop-source"), desktopArchive, "workbuddy-desktop-v0.7.1-t7d");
  sidecar(desktopArchive);
  sidecar(gatewayArchive, options.wrongSidecar ? "0".repeat(64) : undefined);
  return { directory, gatewayArchive, desktopArchive };
}

test("a matching pair reports identical shared files, agreeing manifests and no problems", async () => {
  const p = await pair();
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.equal(report.shared.count, REQUIRED_SHARED.length);
  assert.deepEqual(report.required.missing, []);
  assert.equal(report.mismatched.length, 0);
  assert.equal(report.manifestAgreement.disagreements.length, 0);
  assert.equal(report.identity.length, 1, "the manifest describes each archive and is compared separately");
});

test("a desktop archive that lost the gateway sources cannot pass as a pair", async () => {
  const p = await pair({ omitDesktop: ["dist/server.js"] });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.deepEqual(report.required.missing, ["dist/server.js"]);
  assert.ok(report.problems.some(problem => /dist\/server\.js is missing from the desktop archive/.test(problem)), report.problems.join("\n"));
});

test("an archive without a manifest is a failure, not an empty comparison", async () => {
  const p = await pair({ skipDesktopManifest: true });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some(problem => /no RELEASE_MANIFEST\.json/.test(problem)), report.problems.join("\n"));
});

test("a manifest that disagrees with the bytes it ships is a failure", async () => {
  const p = await pair({ manifestDigest: "f".repeat(64) });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some(problem => /hashes .* but the manifest says/.test(problem)), report.problems.join("\n"));
});

test("a manifest that names a file the archive does not ship is a failure", async () => {
  const p = await pair({ manifestExtra: { path: "dist/invented.js", bytes: 12, sha256: "a".repeat(64) } });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some(problem => /dist\/invented\.js, which the archive does not contain/.test(problem)), report.problems.join("\n"));
});

test("a file that ships without a manifest entry is a failure", async () => {
  const p = await pair({ manifestMissing: "dist/readiness.js" });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some(problem => /dist\/readiness\.js ships in the archive but is not in the manifest/.test(problem)), report.problems.join("\n"));
});

test("two archives describing different versions are not a pair", async () => {
  const p = await pair({ versions: { gateway: "0.7.1", desktop: "0.7.2" } });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some(problem => /different versions/.test(problem)), report.problems.join("\n"));
});

test("a desktop preview label after the numeric version is still the same release", async () => {
  const p = await pair({ versions: { gateway: "0.7.1", desktop: "0.7.1-t7d-desktop-preview" } });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.equal(versionCore(report.manifestAgreement.versions.desktop), "0.7.1");
});

test("archives sharing nothing fail instead of reporting a vacuous success", async () => {
  const p = await pair({ omitDesktop: [...REQUIRED_SHARED] });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.equal(report.shared.count, 0);
  assert.ok(report.problems.some(problem => /share no byte-identical file/.test(problem)), report.problems.join("\n"));
});

test("an unexpected one-sided file is reported while the expected desktop shell is not", async () => {
  const p = await pair({ unexpectedGatewayOnly: "src/private-notes.md" });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some(problem => /src\/private-notes\.md is only in the gateway archive/.test(problem)), report.problems.join("\n"));
  assert.ok(!report.problems.some(problem => /desktop\/app\/WorkBuddy\.Workbench\.exe is only/.test(problem)));
});

test("the same path with different bytes fails the pair even when both archives are intact", async () => {
  const p = await pair({ desktopText: relative => relative === "dist/server.js" ? "// other\n" : `// ${relative}\n` });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatched.map((entry: { path: string }) => entry.path), ["dist/server.js"]);
});

test("a published checksum that does not match its archive fails the pair", async () => {
  const p = await pair({ wrongSidecar: true });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.equal(report.gateway.checksum.present, true);
  assert.equal(report.gateway.checksum.matches, false);
});

test("relative names drop the version wrapper but never a real directory", async () => {
  assert.equal(relativeName("codex-workbuddy-gateway-v0.7.1/dist/server.js"), "dist/server.js");
  assert.equal(relativeName("workbuddy-desktop-v0.7.1-t7d-desktop-preview/gateway/dist/server.js"), "dist/server.js");
  assert.equal(relativeName("deepseek-plugin/README.md"), "deepseek-plugin/README.md");
  assert.equal(relativeName("dist/server.js"), "dist/server.js");
  const p = await pair();
  assert.ok(readArchive(p.gatewayArchive).entries.size >= REQUIRED_SHARED.length);
});

test("paths a reader could escape the extraction root with are refused", () => {
  assert.equal(unsafePath("dist/server.js"), null);
  assert.match(unsafePath("../evil.js") ?? "", /unresolved path segment/);
  assert.match(unsafePath("dist/../../evil.js") ?? "", /unresolved path segment/);
  assert.match(unsafePath("C:/Windows/system32/x.dll") ?? "", /absolute path/);
  assert.match(unsafePath("/etc/passwd") ?? "", /absolute path/);
  assert.match(unsafePath("dist\\server.js") ?? "", /backslash separator/);
  assert.match(unsafePath("") ?? "", /empty path/);
  assert.match(unsafePath("dist/") ?? "", /directory entry/);
});
