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
const args = process.argv.slice(2);
const flag = args.indexOf('--root');
const root = flag >= 0 ? path.resolve(args[flag + 1] ?? '') : path.resolve(here, '..', '..');
const guideName = 'PREVIEW-START-HERE.md';
const manifestFile = path.join(root, 'RELEASE_MANIFEST.json');

function fail(message) { console.error(message); process.exit(1); }
if (!fs.existsSync(manifestFile)) fail('No desktop package manifest at ' + manifestFile + '. Extract the desktop package first, or pass --root <extracted tree>.');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (manifest.project !== 'workbuddy-desktop') fail('This manifest is not a desktop package manifest: project=' + JSON.stringify(manifest.project));
if (!Array.isArray(manifest.files) || !manifest.files.length) fail('Missing release file manifest');
const allowed = (entry) => entry === guideName || entry.startsWith('gateway/');
const seen = new Set();
const counts = { gateway: 0, app: 0, guide: 0 };
for (const entry of manifest.files) {
  const relative = entry.path;
  if (typeof relative !== 'string' || !allowed(relative)) fail('Unsafe release path: ' + JSON.stringify(relative));
  if (!/^\w[\w./-]*$/.test(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) fail('Unsafe release path: ' + JSON.stringify(relative));
  if (seen.has(relative)) fail('Duplicate release path: ' + relative);
  seen.add(relative);
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
