import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {desktopCommandHandler,installDesktopCommands} from '../../scripts/workbench-desktop-commands.mjs';
test('private command bus has no arbitrary process, permission, cancellation or acceptance surface',async()=>{
 const calls=[];const handle=desktopCommandHandler({catalog:async()=>{calls.push('catalog');return {models:[]}},preview:()=>{},review:()=>{},commit:()=>{},receipt:()=>null});
 assert.deepEqual(await handle('catalog',{}),{models:[]});
 for(const method of ['exec','cancel','accept','rework','set_model'])await assert.rejects(handle(method,{}));
 await assert.rejects(handle('catalog',{prepare:true}));assert.deepEqual(calls,['catalog']);
});
test('oversized and malformed input cannot take down later original receipt queries',async()=>{
 const input=new PassThrough(),output=new PassThrough();let result='';output.on('data',chunk=>result+=chunk);
 installDesktopCommands({receipt:id=>({requestId:id,state:'outcome_unknown'})},input,output);
 input.write('x'.repeat(80000)+'\n');input.write('{bad-json}\n');
 const id='11111111-1111-1111-1111-111111111111';input.write(JSON.stringify({id,method:'status',parameters:{requestId:id}})+'\n');
 await new Promise(resolve=>setTimeout(resolve,20));
 const replies=result.trim().split('\n').map(line=>JSON.parse(line));assert.ok(replies.some(reply=>reply.id===id&&reply.ok&&reply.value.state==='outcome_unknown'));input.end();output.end();
});
