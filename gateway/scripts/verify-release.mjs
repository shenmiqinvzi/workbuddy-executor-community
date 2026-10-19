import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'RELEASE_MANIFEST.json'),'utf8'));
if(!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Missing release file manifest');
const seen=new Set();
for(const entry of manifest.files){
  if(typeof entry.path!=='string'||!/^\w[\w./-]*$|^\.env\.example$|^\.gitignore$/.test(entry.path)||entry.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(entry.path))throw new Error('Unsafe release path');
  seen.add(entry.path);
  const filename=path.resolve(root,entry.path);
  if(!filename.startsWith(root+path.sep))throw new Error('Release path escapes root');
  let current=root;
  for(const part of entry.path.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new Error('Linked release file');}
  const bytes=fs.readFileSync(filename);
  if(bytes.length!==entry.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`Release file mismatch: ${entry.path}`);
}
console.log(JSON.stringify({version:manifest.version,verifiedFiles:seen.size,hashesMatch:true}));
