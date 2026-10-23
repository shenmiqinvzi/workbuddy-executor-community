import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { matchesNativeRendererFileUrl } from "../src/native-desktop-trigger.js";

const archive = path.join(os.tmpdir(), "中文用户", "WorkBuddy AI", "resources", "app.asar");
const rendererUrl = pathToFileURL(path.join(archive, "renderer", "index.html")).href;

test("native renderer recognizes encoded Chinese and space-containing installation paths", () => {
  assert.equal(matchesNativeRendererFileUrl(rendererUrl, archive), true);
  assert.equal(matchesNativeRendererFileUrl(decodeURI(rendererUrl), archive), true);
});

test("native renderer normalizes encoded and literal Windows short-path tildes", () => {
  const shortArchive = path.resolve("fixture", "USER~1", "中文 WorkBuddy", "resources", "app.asar");
  const encoded = pathToFileURL(path.join(shortArchive, "renderer", "index.html")).href;
  assert.equal(matchesNativeRendererFileUrl(encoded, shortArchive), true);
  assert.equal(matchesNativeRendererFileUrl(decodeURI(encoded), shortArchive), true);
});

test("native renderer rejects encoded path separators", () => {
  for (const separator of ["%2F", "%5C"]) {
    assert.equal(matchesNativeRendererFileUrl(pathToFileURL(archive).href + "/renderer" + separator + "index.html", archive), false);
  }
});

test("native renderer URL must belong to the exact application archive", () => {
  assert.equal(matchesNativeRendererFileUrl(pathToFileURL(path.join(archive + "-other", "renderer", "index.html")).href, archive), false);
  assert.equal(matchesNativeRendererFileUrl(pathToFileURL(path.join(archive, "..", "other.asar", "index.html")).href, archive), false);
});

test("native renderer rejects web pages containing a matching local path", () => {
  const plainArchive = path.join(os.tmpdir(), "WorkBuddy", "app.asar");
  assert.equal(matchesNativeRendererFileUrl("https://example.invalid/" + plainArchive.replaceAll("\\", "/") + "/renderer/index.html", plainArchive), false);
});

test("native renderer rejects missing or malformed URL metadata", () => {
  assert.equal(matchesNativeRendererFileUrl(undefined, archive), false);
  assert.equal(matchesNativeRendererFileUrl("not a URL", archive), false);
});
