import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'SNAPSHOT_MANIFEST.json'), 'utf8'));
if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid snapshot manifest');
const seen = new Set();
for (const item of manifest.files) {
  if (typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid snapshot entry');
  const relative = item.path.replaceAll('\\', '/');
  if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || seen.has(relative)) throw Error('Unsafe or repeated snapshot path');
  seen.add(relative);
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) throw Error('Snapshot path escapes directory');
  let parent = root;
  for (const segment of relative.split('/')) {
    parent = path.join(parent, segment);
    if (fs.lstatSync(parent).isSymbolicLink()) throw Error(`Linked snapshot input: ${relative}`);
  }
  if (!fs.statSync(filename).isFile()) throw Error(`Missing snapshot file: ${relative}`);
  const bytes = fs.readFileSync(filename);
  if (bytes.length !== item.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw Error(`Snapshot mismatch: ${relative}`);
}
console.log(JSON.stringify({ snapshotFilesVerified: seen.size, hashesMatch: true }));
