#!/usr/bin/env node
// Verifies an extracted desktop preview package against the single manifest at its root.
// Run from the extracted tree:  node gateway/scripts/verify-desktop.mjs [--root <dir>]
// The gateway package keeps its own entry point (scripts/verify-release.mjs); this one covers the
// desktop tree, where the manifest sits at the package root and every entry is either a gateway
// file under gateway/, a desktop binary under gateway/desktop/app/ or the preview guide.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const usage = 'Usage: node gateway/scripts/verify-desktop.mjs [--root <extracted desktop tree>]';
const args = process.argv.slice(2);
let rootArg = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--root') {
    const value = args[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) fail('--root needs a directory value. ' + usage);
    if (rootArg !== null) fail('--root was given more than once. ' + usage);
    rootArg = value;
    index += 1;
    continue;
  }
  fail('Unknown argument: ' + JSON.stringify(arg) + '. ' + usage);
}
const root = rootArg === null ? path.resolve(here, '..', '..') : path.resolve(rootArg);
const guideName = 'PREVIEW-START-HERE.md';
const manifestFile = path.join(root, 'RELEASE_MANIFEST.json');

function fail(message) { console.error(message); process.exit(1); }
if (!fs.existsSync(manifestFile)) fail('No desktop package manifest at ' + manifestFile + '. Extract the desktop package first, or pass --root <extracted tree>.');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (manifest.project !== 'workbuddy-desktop') fail('This manifest is not a desktop package manifest: project=' + JSON.stringify(manifest.project));
if (!Array.isArray(manifest.files) || !manifest.files.length) fail('Missing release file manifest');
const allowed = (entry) => entry === guideName || entry.startsWith('gateway/');
// Windows paths are case-insensitive, so "Gateway/x" and "gateway/x" are one file there.
// Counting them separately would let a manifest claim coverage it does not have.
const seen = new Map();
const pathKey = (relative) => (process.platform === 'win32' ? relative.toLowerCase() : relative);
const counts = { gateway: 0, app: 0, guide: 0 };
for (const entry of manifest.files) {
  const relative = entry.path;
  if (typeof relative !== 'string' || !allowed(relative)) fail('Unsafe release path: ' + JSON.stringify(relative));
  if (!/^\w[\w./-]*$/.test(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) fail('Unsafe release path: ' + JSON.stringify(relative));
  const key = pathKey(relative);
  if (seen.has(key)) {
    const first = seen.get(key);
    fail('Duplicate release path: ' + relative + (first === relative ? '' : ' (same file as ' + first + ' on a case-insensitive file system)'));
  }
  seen.set(key, relative);
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) fail('Release path escapes root: ' + relative);
  let current = root;
  for (const part of relative.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail('Linked release file: ' + relative); }
  if (!fs.statSync(filename).isFile()) fail('Missing release file: ' + relative);
  const bytes = fs.readFileSync(filename);
  if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) fail('Release file mismatch: ' + relative);
  if (relative === guideName) counts.guide += 1;
  else if (relative.startsWith('gateway/desktop/app/')) counts.app += 1;
  else counts.gateway += 1;
}
if (!counts.guide) fail('The desktop manifest does not cover ' + guideName + ', so a stripped guide would go unnoticed');
const coverage = manifest.coverage ?? {};
for (const key of ['gateway', 'app', 'guide']) {
  if (!Number.isInteger(coverage[key])) fail('The desktop manifest does not declare coverage.' + key + ', so a dropped file group would go unnoticed');
  if (coverage[key] !== counts[key]) fail('Coverage mismatch for ' + key + ': manifest declares ' + coverage[key] + ', list has ' + counts[key]);
}
console.log(JSON.stringify({ project: manifest.project, version: manifest.version, verifiedFiles: seen.size, gateway: counts.gateway, app: counts.app, guide: counts.guide, hashesMatch: true }));
