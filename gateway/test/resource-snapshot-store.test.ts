import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESOURCE_SNAPSHOT_SCHEMA,
  canonicalJson,
  findCredentialLeaks,
  listResourceSnapshots,
  readResourceSnapshot,
  saveResourceSnapshot,
  snapshotDigest,
} from "../src/resource-snapshot-store.js";

// A saved snapshot is the only thing a later reader can re-check: the digest
// must match the document it claims to describe, and a document carrying a
// credential must never reach the disk. These tests cover both directions.

function directory(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resource-snapshot-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  return dir;
}

const routing = () => ({
  schemaVersion: "workbuddy-executor/routing-evidence-1",
  readOnly: true,
  routingVerified: false,
  mappings: [{ scopeId: `pool-${"1".repeat(32)}`, unit: "tokens", level: "observed" }],
});

test("a saved snapshot round-trips and its digest describes its document", (t) => {
  const dir = directory(t);
  const document = routing();
  const saved = saveResourceSnapshot({ directory: dir, kind: "routing", document, savedAt: new Date("2026-11-04T10:00:00.000Z") });

  assert.equal(saved.status, "saved");
  assert.equal(saved.digest, snapshotDigest(document));
  assert.deepEqual(saved.violations, []);
  assert.equal(path.basename(saved.file!).startsWith("routing-20261104T100000Z-"), true);
  assert.equal(path.basename(saved.file!).endsWith(".json"), true);

  const read = readResourceSnapshot(saved.file!);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  assert.equal(read.digest, saved.digest);
  assert.equal(read.kind, "routing");
  assert.equal(read.savedAt, "2026-11-04T10:00:00.000Z");
  assert.deepEqual(read.document, document);

  const envelope = JSON.parse(fs.readFileSync(saved.file!, "utf8")) as Record<string, unknown>;
  assert.equal(envelope.schemaVersion, RESOURCE_SNAPSHOT_SCHEMA);
  assert.equal(envelope.documentSchema, "workbuddy-executor/routing-evidence-1");
  // No temporary file is left behind by the atomic write.
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith(".tmp")), []);
});

test("a document edited after writing fails the digest check instead of being trusted", (t) => {
  const dir = directory(t);
  const saved = saveResourceSnapshot({ directory: dir, kind: "routing", document: routing() });
  const envelope = JSON.parse(fs.readFileSync(saved.file!, "utf8")) as { document: { mappings: { level: string }[] } };
  envelope.document.mappings[0]!.level = "verified";
  fs.writeFileSync(saved.file!, JSON.stringify(envelope), "utf8");

  const read = readResourceSnapshot(saved.file!);
  assert.equal(read.status, "digest_mismatch");
  if (read.status === "ok") return;
  assert.equal(read.detail, "digest_mismatch");
});

test("truncated, non-JSON and foreign-schema files are reported by name", (t) => {
  const dir = directory(t);
  const truncated = path.join(dir, "routing-broken.json");
  fs.writeFileSync(truncated, "{\"schemaVersion\":\"workbuddy", "utf8");
  assert.deepEqual(readResourceSnapshot(truncated), { status: "corrupt", detail: "file_not_json" });

  const foreign = path.join(dir, "routing-foreign.json");
  fs.writeFileSync(foreign, JSON.stringify({ schemaVersion: "workbuddy-executor/resource-snapshot-archive-2", kind: "routing", savedAt: "2026-11-04T10:00:00.000Z", digest: "0".repeat(64), bytes: 1, documentSchema: null, document: {} }), "utf8");
  assert.deepEqual(readResourceSnapshot(foreign), { status: "schema_unsupported", detail: "schema_mismatch" });

  const missing = readResourceSnapshot(path.join(dir, "absent.json"));
  assert.deepEqual(missing, { status: "not_found", detail: "file_not_found" });
});

test("a credential-shaped key refuses the write and leaves no file", (t) => {
  const dir = directory(t);
  const saved = saveResourceSnapshot({ directory: dir, kind: "routing", document: { ...routing(), apiKey: "synthetic-credential-value" } });

  assert.equal(saved.status, "refused");
  assert.equal(saved.file, null);
  assert.deepEqual(saved.violations.map(item => item.code), ["credential_key"]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a credential-shaped value refuses the write even under an innocent key", (t) => {
  const dir = directory(t);
  const saved = saveResourceSnapshot({ directory: dir, kind: "quota", document: { note: `Authorization: Bearer ${"a".repeat(32)}` } });

  assert.equal(saved.status, "refused");
  assert.deepEqual(saved.violations.map(item => item.code), ["credential_value"]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a credential reference is allowed, because it names a variable and not a value", () => {
  assert.deepEqual(findCredentialLeaks({
    credentialEnv: { apiKey: "WORKBUDDY_QUOTA_API_KEY" },
    credentials: [{ purpose: "api_key", envVar: "WORKBUDDY_QUOTA_API_KEY", present: true }],
  }), []);
});

test("canonical JSON ignores key order, so the same document keeps one digest", () => {
  const left = { b: 1, a: [2, { d: null, c: "x" }], skipped: undefined };
  const right = { a: [2, { c: "x", d: null }], b: 1 };

  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(snapshotDigest(left), snapshotDigest(right));
  assert.notEqual(snapshotDigest({ ...right, b: 2 }), snapshotDigest(right));
});

test("snapshots list newest first and an absent directory lists nothing", (t) => {
  const dir = directory(t);
  const older = saveResourceSnapshot({ directory: dir, kind: "routing", document: routing(), savedAt: new Date("2026-11-04T09:00:00.000Z") });
  const newer = saveResourceSnapshot({ directory: dir, kind: "routing", document: { ...routing(), routingVerified: false, note: "second read" }, savedAt: new Date("2026-11-04T11:00:00.000Z") });

  const list = listResourceSnapshots(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.file, newer.file);
  assert.equal(list[1]!.file, older.file);
  assert.deepEqual(listResourceSnapshots(path.join(dir, "absent")), []);
});

test("an invalid kind or an oversized document is rejected before any write", (t) => {
  const dir = directory(t);
  assert.throws(() => saveResourceSnapshot({ directory: dir, kind: "../escape", document: {} }), /snapshot_kind_invalid/);
  assert.throws(() => saveResourceSnapshot({ directory: dir, kind: "routing", document: { blob: "x".repeat(4 * 1024 * 1024 + 1) } }), /snapshot_too_large/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
