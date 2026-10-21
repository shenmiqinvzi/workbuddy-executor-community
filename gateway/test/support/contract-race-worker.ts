/**
 * A worker process for the contract concurrency test.
 *
 * It opens its own SQLite connection to a shared database file, announces that
 * it is ready, waits for the parent's starting signal, and then attempts the
 * creation. Two of these actually contend for the same task id, which a
 * single-process test that calls one method after the other cannot show.
 *
 * Not a test file: it is spawned by task-contract.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { TaskStore } from "../../src/task-store.js";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

/** A short sleep that does not spin the CPU while waiting for the barrier. */
function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const dbFile = argument("db");
const barrier = argument("barrier");
const slot = argument("slot");
const taskId = argument("task");
const contract = JSON.parse(fs.readFileSync(argument("contract"), "utf8")) as unknown;
const policy = JSON.parse(fs.readFileSync(argument("policy"), "utf8")) as { maxAttempts: number };
const out = argument("out");

// Open the connection before announcing readiness. Both workers therefore hold
// a live connection when the starting signal arrives, and the contention under
// test is the creation itself rather than opening the file.
const store = new TaskStore(dbFile);
fs.writeFileSync(path.join(barrier, `${slot}.ready`), "");

const deadline = Date.now() + 60_000;
while (!fs.existsSync(path.join(barrier, "go"))) {
  if (Date.now() > deadline) {
    store.close();
    fs.writeFileSync(out, JSON.stringify({ error: "barrier timeout" }));
    process.exit(1);
  }
  pause(2);
}

let result: unknown;
try {
  result = store.createTaskWithContract({ taskId, messageId: "msg-1", workspace: process.cwd(), state: "queued" }, contract, policy);
} catch (error) {
  result = { error: String(error) };
} finally {
  store.close();
}
fs.writeFileSync(out, JSON.stringify(result));
