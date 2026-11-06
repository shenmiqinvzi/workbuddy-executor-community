/**
 * L06 acceptance tests: the redacted delivery export.
 *
 * The export is built from an injected read-only store. These tests use a fake
 * store and a temporary folder, so no task database is opened and no real
 * delivery target is written to. They cover the acceptance list: an explicit
 * field whitelist, nested secrets, HTML-looking values, path traversal, a
 * duplicate name, a cancelled (stale) save, and an oversized input.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DELIVERY_EXPORT_LIMITS,
  DELIVERY_EXPORT_SCHEMA,
  EXPORT_KEY_WHITELIST,
  buildDeliveryExport,
  findUnlistedExportKey,
  redactSecrets,
  resolveExportTarget,
  saveDeliveryExport,
  type DeliveryExportStore,
  type ExportStatistics,
} from "../src/delivery-export.js";
import type { ReviewRecord } from "../src/task-reviews.js";
import type { StoredTask, StoredTaskEvent, TaskContractRead } from "../src/task-store.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");

function taskFixture(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    taskId: "task-1",
    messageId: "msg-1",
    objective: "PRIVATE-OBJECTIVE-BODY",
    state: "accepted",
    createdAt: "2026-11-05T09:00:00.000Z",
    updatedAt: "2026-11-05T11:00:00.000Z",
    revision: "rev-1",
    ...overrides,
  };
}

function contractRecord(title = "交付一节车厢"): TaskContractRead {
  return {
    state: "found",
    record: {
      taskId: "task-1",
      agreementVersion: "agreement-1",
      contractHash: "b".repeat(64),
      schemaVersion: "workbuddy-executor/vnext-1",
      contract: {
        schemaVersion: "workbuddy-executor/vnext-1",
        taskId: "task-1",
        workspaceId: "ws-1",
        title,
        objective: "PRIVATE-OBJECTIVE-BODY",
        model: "some-model",
        timeoutSeconds: 3600,
        maxAttempts: 2,
        scope: { allowedChanges: ["gateway/src/**"], permittedMetadata: ["note"] },
        requiredChecks: [{ id: "unit", kind: "command", definition: "npm test" }],
      },
      requestedMaxAttempts: 2,
      policyMaxAttempts: 3,
      effectiveMaxAttempts: 2,
      createdAt: "2026-11-05T09:00:00.000Z",
    },
  } as TaskContractRead;
}

function reviewFixture(index: number, note = "looks right"): ReviewRecord {
  return {
    reviewId: `review-${index}`,
    taskId: "task-1",
    attemptId: "attempt-1",
    basisRevision: "rev-1",
    committedRevision: "rev-2",
    bindingDigest: "c".repeat(64),
    agreement: { hash: "b".repeat(64), version: "agreement-1" },
    runtimeSource: "synthetic",
    sessionId: "session-1",
    machineCheckIds: ["unit"],
    checks: [{ id: "unit", checkId: "unit", kind: "command", status: "passed", attemptId: "attempt-1", actor: "program", evidenceRefs: [], inputHashes: [], fileHashes: [], checkedAt: "2026-11-05T10:00:00.000Z", checkerVersion: "t6-1", note }],
    note: "独立审查完成",
    createdAt: `2026-11-05T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
    reviewer: { actor: "independent_reviewer", channel: "trusted_local_coordinator" },
    supersedesReviewId: null,
    correction: null,
  } as unknown as ReviewRecord;
}

interface FakeStoreOptions {
  task?: StoredTask;
  contract?: TaskContractRead;
  reviews?: ReviewRecord[];
  events?: StoredTaskEvent[];
  failEvents?: boolean;
}

function fakeStore(options: FakeStoreOptions = {}): DeliveryExportStore {
  const task = "task" in options ? options.task : taskFixture();
  const contract = options.contract ?? contractRecord();
  const reviews = options.reviews ?? [reviewFixture(1)];
  const events = options.events ?? [];
  return {
    get: () => task,
    getContract: () => contract,
    listAttempts: () => [{ attemptId: "attempt-1" }, { attemptId: "attempt-2" }],
    listTaskEvents: () => {
      if (options.failEvents) throw new Error("store offline");
      return { events, nextEventId: events.at(-1)?.eventId ?? 0 };
    },
    reviews: { list: () => reviews },
  };
}

function tempDir(t: { after(callback: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l06-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return dir;
}

test("export: the document only carries whitelisted fields and named limitations", () => {
  const built = buildDeliveryExport(fakeStore(), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.document.schemaVersion, DELIVERY_EXPORT_SCHEMA);
  assert.equal(built.document.generator.readOnly, true);
  assert.equal(built.document.generator.version, null);
  assert.equal(findUnlistedExportKey(built.document), null, "every emitted key is on the whitelist");
  for (const key of Object.keys(built.document)) assert.ok(EXPORT_KEY_WHITELIST.has(key), key);

  const json = built.bytes.toString("utf8");
  assert.equal(json.includes("PRIVATE-OBJECTIVE-BODY"), false, "the objective body is not an export field");
  assert.equal(json.includes("some-model"), false, "the model binding is not an export field");
  assert.equal(json.includes("messageId"), false, "chat and message plumbing stay out");
  assert.equal(built.document.statistics.present, false);
  assert.ok(built.document.limitations.some(line => line.includes("白名单")));
  assert.ok(built.document.limitations.some(line => line.includes("快照")));
  assert.ok(built.document.limitations.some(line => line.includes("不构成验收结论")));
  assert.ok(built.document.limitations.some(line => line.includes("统计 coverage")));
  assert.deepEqual(built.document.evidence.evidenceTypes, ["attempt", "check:command"]);
  assert.equal(built.digest.length, 64);
});

test("export: nested secret values are redacted, and their field names are reported", () => {
  const contract = contractRecord();
  if (contract.state === "found") contract.record.contract.scope.permittedMetadata = ["token=abc123", "sk-livesecret0001", "note"];
  const built = buildDeliveryExport(fakeStore({ contract }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const json = built.bytes.toString("utf8");
  assert.equal(json.includes("sk-livesecret0001"), false);
  assert.equal(json.includes("token=abc123"), false);
  assert.ok(built.document.redactions.count >= 2);
  assert.ok(built.document.redactions.fields.some(field => field.includes("permittedMetadata")));
  assert.equal(findUnlistedExportKey(built.document), null);
});

test("export: redaction walks nested objects and arrays and names the path", () => {
  const result = redactSecrets({ outer: [{ apiKey: "sk-1", note: "ok" }], headers: { authorization: "Bearer abc.def" } });
  assert.equal(result.fields.length >= 2, true);
  const text = JSON.stringify(result.value);
  assert.equal(text.includes("sk-1"), false);
  assert.equal(text.includes("abc.def"), false);
  assert.equal(text.includes("ok"), true);
  assert.equal(findUnlistedExportKey({ rogue: 1 }), "rogue");
  assert.equal(findUnlistedExportKey({ limitationCounts: { savings_not_measured: 2 } }), null);
});

test("export: HTML-looking titles stay literal data, never markup", () => {
  const title = '</script><img src=x onerror="alert(1)">';
  const built = buildDeliveryExport(fakeStore({ contract: contractRecord(title) }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.document.task.title, title, "the title is preserved verbatim as a value");
  const parsed = JSON.parse(built.bytes.toString("utf8")) as { task: { title: string } };
  assert.equal(parsed.task.title, title);
  assert.equal("html" in built.document, false, "the export has no HTML surface");
});

test("export: a failed event read is reported instead of being counted as zero evidence", () => {
  const built = buildDeliveryExport(fakeStore({ failEvents: true }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.document.task.events, 0);
  assert.equal(built.document.evidence.evidenceTypes.includes("task_event"), false);
  assert.ok(built.document.limitations.some(line => line.includes("不可读取")));
});

test("export: an unreadable contract is labelled, not reproduced", () => {
  const integrity: TaskContractRead = { state: "integrity_failure", integrity: { ok: false, reason: "hash mismatch" } } as TaskContractRead;
  const built = buildDeliveryExport(fakeStore({ contract: integrity }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.document.contract, { present: false, reason: "integrity_failure" });
  assert.equal(built.document.task.title, "");
  assert.ok(built.document.limitations.some(line => line.includes("不可解释")));
});

test("export: statistics coverage is copied with its limitations and both claims stay null", () => {
  const statistics: ExportStatistics = {
    window: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-05T00:00:00.000Z" },
    coverage: {
      tasksRead: 2, tasksIncluded: 1, tasksExcludedOutsideWindow: 1, tasksWithoutEvents: 0, tasksIncomplete: 0,
      eventsRead: 4, tasksTruncated: 0, eventsTruncated: 0,
    },
    limitations: ["usage_ledger_absent"],
    limitationCounts: { usage_ledger_absent: 1 },
  };
  const built = buildDeliveryExport(fakeStore(), "task-1", { now: NOW, statistics });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.document.statistics.present, true);
  if (!built.document.statistics.present) return;
  assert.deepEqual(built.document.statistics.coverage, statistics.coverage);
  assert.deepEqual(built.document.statistics.claims, { savings: null, superiority: null });
  assert.equal(built.document.limitations.some(line => line.includes("统计 coverage")), false);
});

test("export: review history is bounded, and a long note is clipped with a flag", () => {
  const many = Array.from({ length: DELIVERY_EXPORT_LIMITS.reviews + 5 }, (_, index) => reviewFixture(index + 1));
  const built = buildDeliveryExport(fakeStore({ reviews: many }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.document.evidence.reviews.length, DELIVERY_EXPORT_LIMITS.reviews);
  assert.ok(built.document.limitations.some(line => line.includes("仅导出最近的")));

  const longNote = "x".repeat(DELIVERY_EXPORT_LIMITS.noteCharacters + 20);
  const clipped = buildDeliveryExport(fakeStore({ reviews: [reviewFixture(1, longNote)] }), "task-1", { now: NOW });
  assert.equal(clipped.ok, true);
  if (!clipped.ok) return;
  const check = clipped.document.evidence.reviews[0]?.checks[0];
  assert.equal(check?.noteTruncated, true);
  assert.ok((check?.note.length ?? 0) <= DELIVERY_EXPORT_LIMITS.noteCharacters);
});

test("export: bad identities and missing tasks are refused before any bytes exist", () => {
  assert.deepEqual(buildDeliveryExport(fakeStore({ task: undefined }), "no-such-task", { now: NOW }), {
    ok: false, code: "task_not_found", message: "No saved task with that identity exists.",
  });
  const invalid = buildDeliveryExport(fakeStore(), "../etc/passwd", { now: NOW });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "invalid_task_id");
});

test("export: an oversized document is refused before a file is created", (t) => {
  const dir = tempDir(t);
  const built = saveDeliveryExport(fakeStore(), { taskId: "task-1", directory: dir }, { now: NOW, maxBytes: 200 });
  assert.equal(built.ok, false);
  if (!built.ok) assert.equal(built.code, "export_too_large");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("export: a traversal directory, a file path and a relative path are refused", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "x", "utf8");
  const traversal = resolveExportTarget(path.join(dir, "..", "escape"), "task-1", NOW);
  assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.equal(traversal.code, "invalid_directory");
  const notDir = resolveExportTarget(file, "task-1", NOW);
  assert.equal(notDir.ok, false);
  if (!notDir.ok) assert.equal(notDir.code, "invalid_directory");
  const relative = resolveExportTarget("outputs", "task-1", NOW);
  assert.equal(relative.ok, false);
  if (!relative.ok) assert.equal(relative.code, "invalid_directory");
  assert.deepEqual(fs.readdirSync(dir), ["a.txt"], "nothing was written outside or inside");
});

test("export: the same task saved twice keeps both files under distinct names", (t) => {
  const dir = tempDir(t);
  const store = fakeStore();
  const first = saveDeliveryExport(store, { taskId: "task-1", directory: dir }, { now: NOW });
  const second = saveDeliveryExport(store, { taskId: "task-1", directory: dir }, { now: NOW });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.file, second.file);
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(first.file), path.basename(second.file)].sort());
  assert.equal(fs.statSync(first.file).size, first.bytes);
});

test("export: a stale preview digest cancels the save and leaves the folder untouched", (t) => {
  const dir = tempDir(t);
  const preview = buildDeliveryExport(fakeStore(), "task-1", { now: NOW });
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  const changed = fakeStore({
    task: taskFixture({ updatedAt: "2026-11-05T11:30:00.000Z", revision: "rev-2" }),
    contract: contractRecord("名字变了"),
  });
  const saved = saveDeliveryExport(changed, { taskId: "task-1", directory: dir, expectedDigest: preview.digest }, { now: NOW });
  assert.equal(saved.ok, false);
  if (!saved.ok) assert.equal(saved.code, "export_stale");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("export: a credential inside review prose is redacted wherever it sits", () => {
  const bearerToken = ["sk", "live", "9f8e7d6c5b4a321055"].join("-");
  const note = [
    `Ran the smoke test; the header sent was Authorization: Bearer ${bearerToken}`,
    "Proxy line: proxy-authorization: Basic dXNlcjpwYXNzd29yZA==",
    "Then POST https://user:passw0rd@example.invalid/api with token=abc123def456ghi789",
    "Keep this sentence: the retry budget is three attempts.",
  ].join("\n");
  const built = buildDeliveryExport(fakeStore({ reviews: [reviewFixture(1, note)] }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const bytes = JSON.stringify(built.document);
  for (const secret of [bearerToken, "dXNlcjpwYXNzd29yZA==", "passw0rd", "abc123def456ghi789"]) {
    assert.equal(bytes.includes(secret), false, `the export must not keep ${secret}`);
  }
  assert.match(bytes, /the header sent was Authorization: \[redacted\]/);
  assert.match(bytes, /the retry budget is three attempts/, "ordinary prose stays readable");
  assert.ok(built.document.redactions.fields.length >= 1, "the export names what it redacted");
});

test("export: clipping never splits a credential in half", () => {
  const secret = ["sk", "live", "0123456789abcdef0123456789abcdef"].join("-");
  const limit = DELIVERY_EXPORT_LIMITS.definitionCharacters;
  const contract = contractRecord("clip-boundary");
  const record = (contract as unknown as { record: { contract: { requiredChecks: unknown[] } } }).record.contract;
  record.requiredChecks = [{ id: "c1", kind: "command", definition: `${"a".repeat(limit - 8)}${secret}` }];
  const built = buildDeliveryExport(fakeStore({ contract }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const bytes = JSON.stringify(built.document);
  assert.equal(bytes.includes("sk-live"), false, "no prefix of the credential survives the boundary");
  assert.equal(bytes.includes(secret.slice(0, 8)), false);
  assert.match(bytes, /\[redacted\]/);
});

test("redact: inline pairs and header values are scrubbed inside sentences, not only at the start", () => {
  const result = redactSecrets({ note: "first line\nAuthorization: Bearer abc.def.ghi\npassword=hunter2 and api_key: 0123456789abcdef" });
  const note = String((result.value as { note: string }).note);
  assert.equal(note.includes("hunter2"), false);
  assert.equal(note.includes("0123456789abcdef"), false);
  assert.equal(note.includes("first line"), true);
  assert.ok(result.fields.includes("note"));
});

test("export: a title and a reviewer correction are scrubbed like any other prose", () => {
  const titleToken = ["sk", "live", "00112233445566778899"].join("-");
  const correctionValue = ["Basic", "dXNlcjpwYXNzd29yZA=="].join(" ");
  const review = { ...reviewFixture(1), correction: `Corrected after review: Authorization: ${correctionValue}` } as ReviewRecord;
  const built = buildDeliveryExport(fakeStore({ contract: contractRecord(`Delivery for ${titleToken}`), reviews: [review] }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const bytes = built.bytes.toString("utf8");
  assert.equal(bytes.includes(titleToken), false, "the title credential never reaches the export bytes");
  assert.equal(bytes.includes("dXNlcjpwYXNzd29yZA=="), false, "the correction credential never reaches the export bytes");
  assert.match(built.document.task.title, /\[redacted\]/);
  assert.match(String(built.document.evidence.reviews[0]?.correction), /\[redacted\]/);
  assert.ok(built.document.redactions.fields.includes("task.title"));
  assert.ok(built.document.redactions.fields.includes("evidence.reviews[].correction"));
  assert.equal(built.document.redactions.count, built.document.redactions.fields.length);
});

test("export: one field holding the same secret twice is reported once", () => {
  const secret = ["sk", "live", "ffeeddccbbaa99887766"].join("-");
  const note = `first line ${secret} and again ${secret}`;
  const built = buildDeliveryExport(fakeStore({ reviews: [reviewFixture(1, note)] }), "task-1", { now: NOW });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const fields = built.document.redactions.fields;
  assert.equal(fields.filter(field => field === "evidence.reviews[].checks[].note").length, 1);
  assert.equal(built.document.redactions.count, fields.length);
  assert.equal(built.bytes.toString("utf8").includes(secret), false);
});
