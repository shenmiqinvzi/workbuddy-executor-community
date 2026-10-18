import fs from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// Independent local-record reader for the ZIPs used by packaging tests.
export async function readZip(filename) {
  const zip=await fs.readFile(filename),entries=new Map();let pos=0;
  while(zip.readUInt32LE(pos)===0x04034b50){
    const method=zip.readUInt16LE(pos+8),compressed=zip.readUInt32LE(pos+18),size=zip.readUInt32LE(pos+22);
    const nameLength=zip.readUInt16LE(pos+26),extraLength=zip.readUInt16LE(pos+28);
    const name=zip.subarray(pos+30,pos+30+nameLength).toString('utf8');
    const start=pos+30+nameLength+extraLength,data=zip.subarray(start,start+compressed);
    const bytes=method===8?inflateRawSync(data):method===0?data:null;
    if(!bytes||bytes.length!==size)throw new Error('Invalid archive member');
    entries.set(name,bytes);pos=start+compressed;
  }
  if(zip.readUInt32LE(pos)!==0x02014b50)throw new Error('Missing central directory');
  return entries;
}
