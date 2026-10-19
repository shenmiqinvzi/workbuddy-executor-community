import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const table=Uint32Array.from({length:256},(_,i)=>{
  let crc=i;for(let bit=0;bit<8;bit++)crc=(crc&1)?(0xedb88320^(crc>>>1)):(crc>>>1);return crc>>>0;
});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}

/** ZIP32/deflate, UTF-8 names, fixed timestamps; no external executable. */
export async function zipDirectory(source,output,prefix=''){
  const entries=[];
  async function visit(dir,relative=''){
    for(const item of(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const filename=path.join(dir,item.name),name=relative?`${relative}/${item.name}`:item.name;
      if(item.isSymbolicLink())throw new Error('Refusing linked archive input');
      if(item.isDirectory())await visit(filename,name);
      else if(item.isFile())entries.push({filename,name});
      else throw new Error('Archive input must be a regular file');
    }
  }
  if(prefix&&!/^[A-Za-z0-9._-]+$/.test(prefix))throw new Error('Unsafe archive prefix');
  await visit(source);
  if(entries.length>65535)throw new Error('ZIP32 entry limit exceeded');
  const locals=[],central=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(prefix?`${prefix}/${entry.name}`:entry.name,'utf8'),bytes=await fs.readFile(entry.filename);
    if(name.length>65535||bytes.length>256*1024*1024)throw new Error('Archive input too large');
    const packed=deflateRawSync(bytes),crc=crc32(bytes),header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
    locals.push(header,name,packed);
    const record=Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x0314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(8,10);record.writeUInt16LE(33,14);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(packed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);
    record.writeUInt32LE(((entry.name.startsWith('bin/')?0o100755:0o100644)*65536)>>>0,38);record.writeUInt32LE(offset,42);
    central.push(record,name);offset+=header.length+name.length+packed.length;
    if(offset>256*1024*1024)throw new Error('Archive size limit exceeded');
  }
  const centralBytes=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
  await fs.writeFile(output,Buffer.concat([...locals,centralBytes,end]),{flag:'wx',mode:0o644});
}
