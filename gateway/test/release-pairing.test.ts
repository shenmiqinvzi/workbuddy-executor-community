import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipDirectory } from "../scripts/zip.mjs";
import { readArchive, relativeName, verifyPairing } from "../scripts/verify-pairing.mjs";

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

async function pair(options: { gatewayShared?: string; desktopShared?: string; manifestForDesktop?: boolean; manifestDigest?: string; wrongSidecar?: boolean }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));
  const gatewayRoot = path.join(directory, "gateway-source");
  const desktopRoot = path.join(directory, "desktop-source", "gateway");
  const sharedGateway = write(gatewayRoot, "src/shared.ts", options.gatewayShared ?? "export const shared = 1;\n");
  write(gatewayRoot, "src/gateway-only.ts", "export const only = 'gateway';\n");
  const sharedDesktop = write(desktopRoot, "src/shared.ts", options.desktopShared ?? "export const shared = 1;\n");
  write(desktopRoot, "src/desktop-only.ts", "export const only = 'desktop';\n");
  write(path.join(directory, "desktop-source"), "PREVIEW-START-HERE.md", "# preview\n");
  const desktopManifest = { project: "codex-workbuddy-gateway", version: "0.7.1-t7d", files: [sharedDesktop, { path: "gateway/src/desktop-only.ts", bytes: 33, sha256: "0".repeat(64) }] };
  if (options.manifestForDesktop !== false) write(path.join(directory, "desktop-source"), "RELEASE_MANIFEST.json", JSON.stringify(options.manifestDigest ? { ...desktopManifest, files: [{ ...sharedDesktop, sha256: options.manifestDigest }] } : desktopManifest));
  write(gatewayRoot, "RELEASE_MANIFEST.json", JSON.stringify({ project: "codex-workbuddy-gateway", version: "0.7.1", files: [sharedGateway, { path: "src/gateway-only.ts", bytes: 34, sha256: "1".repeat(64) }] }));
  const gatewayArchive = path.join(directory, "codex-workbuddy-gateway-v0.7.1.zip");
  const desktopArchive = path.join(directory, "workbuddy-desktop-v0.7.1-t7d.zip");
  await zipDirectory(gatewayRoot, gatewayArchive, "codex-workbuddy-gateway-v0.7.1");
  await zipDirectory(path.join(directory, "desktop-source"), desktopArchive, "workbuddy-desktop-v0.7.1-t7d");
  sidecar(desktopArchive);
  sidecar(gatewayArchive, options.wrongSidecar ? "0".repeat(64) : undefined);
  return { directory, gatewayArchive, desktopArchive };
}

test("a matching pair reports identical shared files and agreeing manifests", async () => {
  const p = await pair({});
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, true);
  assert.ok(report.shared.count >= 1);
  assert.equal(report.mismatched.length, 0);
  assert.equal(report.manifestAgreement.disagreements.length, 0);
  assert.equal(report.manifestAgreement.compared, 1);
  assert.ok(report.desktopOnly.count >= 2, "the desktop shell and its guide are one-sided by design");
  assert.deepEqual(report.identity.map((entry: { path: string }) => entry.path), ["RELEASE_MANIFEST.json"]);
});

test("the same path with different bytes fails the pair even when both archives are intact", async () => {
  const p = await pair({ desktopShared: "export const shared = 2;\n" });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatched.map((entry: { path: string }) => entry.path), ["src/shared.ts"]);
  assert.notEqual(report.mismatched[0].gateway, report.mismatched[0].desktop);
});

test("a published checksum that does not match its archive fails the pair", async () => {
  const p = await pair({ wrongSidecar: true });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.ok, false);
  assert.equal(report.gateway.checksum.present, true);
  assert.equal(report.gateway.checksum.matches, false);
});

test("two manifests that disagree about the same file fail the pair", async () => {
  const p = await pair({ manifestDigest: "f".repeat(64) });
  const report = verifyPairing(p.gatewayArchive, p.desktopArchive);
  assert.equal(report.mismatched.length, 0);
  assert.equal(report.ok, false);
  assert.deepEqual(report.manifestAgreement.disagreements.map((entry: { path: string }) => entry.path), ["src/shared.ts"]);
});

test("relative names drop the version wrapper but never a real directory", async () => {
  assert.equal(relativeName("codex-workbuddy-gateway-v0.7.1/dist/server.js"), "dist/server.js");
  assert.equal(relativeName("workbuddy-desktop-v0.7.1-t7d-desktop-preview/gateway/dist/server.js"), "dist/server.js");
  assert.equal(relativeName("deepseek-plugin/README.md"), "deepseek-plugin/README.md");
  assert.equal(relativeName("dist/server.js"), "dist/server.js");
  assert.equal(readArchive(await (async () => (await pair({})).gatewayArchive)()).entries.size >= 3, true);
});
