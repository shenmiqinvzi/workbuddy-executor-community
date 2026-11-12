// A runner may report a temp path with another drive-letter case or an 8.3 short
// name, so containment checks canonicalise both sides and compare Windows paths
// case-insensitively. A path that does not exist yet is resolved against its
// nearest existing parent, so a runs directory can be checked before it is made.
import fs from 'node:fs';
import path from 'node:path';

export function canonicalPath(target){
  const resolved=path.resolve(target);let existing=resolved;const tail=[];
  while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)break;tail.unshift(path.basename(existing));existing=parent}
  const base=fs.existsSync(existing)?fs.realpathSync.native(existing):existing;
  return tail.length?path.join(base,...tail):base;
}

export function inside(base,target){
  const left=canonicalPath(target),right=canonicalPath(base);
  const fold=value=>process.platform==='win32'?value.toLowerCase():value;
  const outer=fold(right),inner=fold(left);
  return inner===outer||inner.startsWith(outer+path.sep);
}
