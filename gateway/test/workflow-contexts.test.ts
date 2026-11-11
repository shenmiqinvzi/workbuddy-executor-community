import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * GitHub validates a workflow before starting any job. Two of the contexts that
 * look universally available are not: `runner` only exists once a runner is
 * assigned, so it is rejected inside `jobs.<id>.env`. When that happens the run
 * is created and immediately fails with **zero jobs**, which reads like an
 * infrastructure outage on the run page. These checks keep that class of mistake
 * out of the tree.
 */
const gateway = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(gateway, "..");
const workflows = path.join(repository, ".github", "workflows");

const files = readdirSync(workflows)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

function read(name) {
  return readFileSync(path.join(workflows, name), "utf8");
}

/** Returns the lines that sit inside a job's `env:` block, with their line numbers. */
function jobEnvLines(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  let jobIndent = null;
  let envIndent = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (envIndent !== null) {
      if (indent > envIndent) {
        found.push({ line: index + 1, text: line.trim() });
        continue;
      }
      envIndent = null;
    }
    if (/^\s+jobs:\s*$/.test(line)) {
      jobIndent = indent;
      continue;
    }
    if (jobIndent === null) continue;
    if (indent <= jobIndent) {
      jobIndent = null;
      continue;
    }
    if (/^\s+env:\s*$/.test(line)) envIndent = indent;
  }
  return found;
}

test("every workflow is a file GitHub can start", () => {
  assert.ok(files.length >= 3, `expected at least three workflows, found ${files.length}`);
  for (const name of files) {
    const text = read(name);
    assert.match(text, /^name:\s*\S/m, `${name} needs a top-level name`);
    assert.match(text, /^on:/m, `${name} needs a trigger`);
    assert.match(text, /^permissions:/m, `${name} should state its token permissions`);
    assert.match(text, /^jobs:/m, `${name} needs jobs`);
    assert.doesNotMatch(text, /\t/, `${name} must not contain tab indentation`);
  }
});

test("no workflow reads the runner context where GitHub does not define it", () => {
  const offenders = [];
  for (const name of files) {
    for (const entry of jobEnvLines(read(name))) {
      if (/\$\{\{\s*runner\./.test(entry.text)) {
        offenders.push(`${name}:${entry.line} ${entry.text}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "runner is assigned after jobs.<id>.env is evaluated; write the value in a step and export it through GITHUB_ENV",
  );
});

test("the gates export the empty configuration directory instead of templating it", () => {
  for (const name of ["forward-gate.yml", "release-pairing.yml"]) {
    const text = read(name);
    assert.match(
      text,
      /"WORKBUDDY_CONFIG_DIR=\$config"\s*\|\s*Out-File -FilePath \$env:GITHUB_ENV/,
      `${name} should publish WORKBUDDY_CONFIG_DIR through GITHUB_ENV`,
    );
  }
});
