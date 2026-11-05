import test from 'node:test';
import assert from 'node:assert/strict';
import {installMiniDom,MiniElement,MiniNode} from './support/mini-dom.mjs';
const {body}=installMiniDom();
Object.defineProperty(MiniElement.prototype,'id',{get(){return this.getAttribute('id')??''},set(v){this.setAttribute('id',v)}});
Object.defineProperty(MiniElement.prototype,'options',{get(){return this.tagName==='SELECT'?this.children:undefined}});
Object.defineProperty(MiniElement.prototype,'value',{get(){return this._value??''},set(v){this._value=this.tagName==='SELECT'&&!this.children.some(x=>x.value===String(v))?'':String(v)}});
const append=MiniElement.prototype.append;MiniElement.prototype.append=function(...nodes){append.call(this,...nodes);for(const child of this.children)child.parent=this;if(this.tagName==='SELECT'&&!this._value)this._value=this.children[0]?.value??''};
MiniElement.prototype.replaceChildren=function(...nodes){this.children=[];this._ownText='';this._value='';this.append(...nodes)};
MiniElement.prototype.prepend=function(node){this.children.unshift(node);node.parent=this};
MiniElement.prototype.after=function(node){const i=this.parent.children.indexOf(this);this.parent.children.splice(i+1,0,node);node.parent=this};
MiniElement.prototype.remove=function(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this)};
MiniElement.prototype.focus=function(){document.activeElement=this};
globalThis.window={addEventListener(){}};globalThis.localStorage={getItem(){return null},setItem(){},removeItem(){}};
const {mountDesktopDispatch,sourceKey}=await import('../dispatch.mjs');
const q=id=>document.getElementById(id);const tick=()=>new Promise(r=>setImmediate(r));
const wb={key:'wb',execution:{executorId:'workbuddy',connectionId:'local',providerId:'native',modelId:'a',reasoningEffort:null},credits:null,pricingVerified:false,blockedReason:null};
const dsh={key:'dsh',execution:{executorId:'dsh',connectionId:'host',providerId:'p',modelId:'b',reasoningEffort:'low'},credits:null,pricingVerified:false,blockedReason:null};
const make=()=>({catalogId:'test',models:[wb,dsh],sessions:[{hostId:'host',sessionId:'one',workspace:'C:/project',attached:true,busy:false}],policy:{maxAttempts:3,maxTimeoutSeconds:1000},errors:[],dispatchEnabled:true});
function setup(){body.replaceChildren();const sheet=document.createElement('div');sheet.className='sheet';const heading=document.createElement('div');heading.className='page-heading';const tools=document.createElement('div');tools.className='heading-tools';const title=document.createElement('h1');title.id='page-title';const intro=document.createElement('p');intro.className='page-intro';heading.append(title,intro,tools);sheet.append(heading);body.append(sheet);const source=document.createElement('input');source.id='data-source';source.value='live';body.append(source);}
function change(id,value){const node=q('compose-'+id);node.value=value;node.dispatch('change')}
async function until(fn){for(let i=0;i<50;i++){if(fn())return;await tick()}throw Error('UI did not settle')}

test('refresh preserves the exact choice, clears invalid choices, and project changes clear only the session',async()=>{
 setup();let current=make(),calls=[];globalThis.fetch=async(url,init)=>{if(url.endsWith('capabilities'))return new Response(JSON.stringify({ok:true,value:{available:true}}));const action=JSON.parse(init.body).action;calls.push(action);return new Response(JSON.stringify({ok:true,value:action==='catalog'?structuredClone(current):null}))};
 await mountDesktopDispatch({onTask:async()=>{}});q('new-task').click();await until(()=>q('compose-source')&&!q('compose-source').disabled);
 q('compose-workspace').value='C:/project';change('source',sourceKey(dsh.execution));change('model','b');change('effort','low');change('session','one');assert.equal(q('compose-session').value,'one');
 current.models[1]={...dsh,credits:'x2.00',pricingVerified:true};q('refresh-models').click();await until(()=>!q('refresh-models').disabled);assert.equal(q('compose-source').value,sourceKey(dsh.execution));assert.equal(q('compose-model').value,'b');assert.equal(q('compose-effort').value,'low');assert.equal(q('compose-session').value,'one');assert.match(q('choice-rate').textContent,/x2\.00/);
 current.models[1]={...current.models[1],blockedReason:'当前政策禁止此模型'};q('refresh-models').click();await until(()=>!q('refresh-models').disabled);assert.equal(q('compose-model').value,'b');assert.equal(q('preview-task').disabled,true);assert.match(body.textContent,/当前政策禁止此模型/);
 q('compose-workspace').value='C:/other';q('compose-workspace').dispatch('input');assert.equal(q('compose-session').value,'');assert.equal(q('compose-effort').value,'low');
 current=make();current.models=[wb];q('refresh-models').click();await until(()=>!q('refresh-models').disabled);assert.equal(q('compose-source').value,'');assert.match(body.textContent,/先前选择已失效/);assert.ok(calls.every(x=>['latest','catalog'].includes(x)));
});

test('a refresh from the closed editor cannot overwrite the reopened editor',async()=>{
 setup();let release,held=false,calls=0;globalThis.fetch=async(url,init)=>{if(url.endsWith('capabilities'))return new Response(JSON.stringify({ok:true,value:{available:true}}));const action=JSON.parse(init.body).action;if(action==='latest')return new Response(JSON.stringify({ok:true,value:null}));calls++;if(held){held=false;return new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({ok:true,value:make()})))})}return new Response(JSON.stringify({ok:true,value:make()}))};
 await mountDesktopDispatch({onTask:async()=>{}});q('new-task').click();await until(()=>q('compose-source')&&!q('compose-source').disabled);held=true;q('refresh-models').click();await until(()=>!!release);document.querySelector('.dispatch-back').click();q('new-task').click();await until(()=>q('compose-source')&&!q('compose-source').disabled);change('source',sourceKey(wb.execution));release();await tick();await tick();assert.equal(q('compose-source').value,sourceKey(wb.execution));assert.equal(calls,3);
});

test('a delayed folder picker cannot replace a newer project or a reopened editor',async()=>{
 setup();let release;globalThis.fetch=async(url,init)=>{if(url.endsWith('capabilities'))return new Response(JSON.stringify({ok:true,value:{available:true}}));const action=JSON.parse(init.body).action;if(action==='choose_workspace')return new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({ok:true,value:{directory:'C:/old'}})))});return new Response(JSON.stringify({ok:true,value:action==='catalog'?make():null}))};
 await mountDesktopDispatch({onTask:async()=>{}});q('new-task').click();await until(()=>q('compose-source')&&!q('compose-source').disabled);
 const picker=body.descendants().find(e=>e.tagName==='BUTTON'&&e.textContent==='选择文件夹');picker.click();await until(()=>!!release);q('compose-workspace').value='C:/new';release();await tick();await tick();assert.equal(q('compose-workspace').value,'C:/new');
 release=null;picker.click();await until(()=>!!release);document.querySelector('.dispatch-back').click();q('new-task').click();await until(()=>q('compose-source')&&!q('compose-source').disabled);q('compose-workspace').value='C:/reopened';release();await tick();await tick();assert.equal(q('compose-workspace').value,'C:/reopened');
});
