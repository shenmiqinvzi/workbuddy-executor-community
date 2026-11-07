import test from 'node:test';
import assert from 'node:assert/strict';
import {installMiniDom,MiniElement} from './support/mini-dom.mjs';
const {body}=installMiniDom();
Object.defineProperty(MiniElement.prototype,'id',{get(){return this.getAttribute('id')??''},set(v){this.setAttribute('id',v)}});
Object.defineProperty(MiniElement.prototype,'options',{get(){return this.tagName==='SELECT'?this.children:undefined}});
Object.defineProperty(MiniElement.prototype,'value',{get(){return this._value??''},set(v){this._value=this.tagName==='SELECT'&&!this.children.some(x=>x.value===String(v))?'':String(v)}});
const append=MiniElement.prototype.append;MiniElement.prototype.append=function(...nodes){append.call(this,...nodes);for(const child of this.children)child.parent=this;if(this.tagName==='SELECT'&&!this._value)this._value=this.children[0]?.value??''};
MiniElement.prototype.replaceChildren=function(...nodes){this.children=[];this._ownText='';this._value='';this.append(...nodes)};
MiniElement.prototype.remove=function(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this)};
MiniElement.prototype.focus=function(){document.activeElement=this};
// The control card skips work for detached nodes; mini-dom has no tree walk of
// its own, so answer the one question the card asks: is this still mounted?
Object.defineProperty(MiniElement.prototype,'isConnected',{get(){let node=this;while(node.parent)node=node.parent;return node===document.body||node===body}});
globalThis.window={addEventListener(){}};
const {renderDesktopControls,renderControlUnavailable}=await import('../controls.mjs');
const tick=()=>new Promise(r=>setImmediate(r));
const record=()=>({taskId:'desktop-task-1',businessState:'needs_review',
  presentation:{objective:'把结算模块的超时策略改成显式配置',report:{authentication:'authenticated'}},
  view:{schemaVersion:'workbuddy-executor/stage-2',displayState:'needs_review',businessState:'needs_review',revision:'rev-7',remoteStopped:true,attempt:{id:'attempt-1',number:1,limit:2},timing:{nativeStoppedAt:'2026-11-05T10:00:00.000Z'}},
  reviews:[{reviewId:'review-1',attemptId:'attempt-1',committedRevision:'rev-7',basisRevision:'rev-7',checks:[{checkId:'check-1',status:'passed',actor:'program'}]}]});

function serve(value){
  globalThis.fetch=async(url,init)=>{
    const action=JSON.parse(init.body).action;
    return new Response(JSON.stringify({ok:true,value:typeof value==='function'?value(action):value}),{status:200,headers:{'Content-Type':'application/json'}});
  };
}
const names=()=>body.descendants().filter(node=>node.tagName==='BUTTON').map(node=>node.textContent.trim());

test('an empty control journal is "no receipt yet", not a broken card',async()=>{
  serve(null);
  body.replaceChildren();
  const card=renderDesktopControls(record(),{refresh:async()=>{}});
  body.append(card);
  for(let i=0;i<6;i++)await tick();
  const text=body.textContent;
  assert.ok(!/Cannot read|not a function|undefined is not/.test(text),'the card must not surface a runtime error: '+text);
  assert.ok(names().includes('提交返工'),'the rework button stays rendered');
  assert.ok(names().includes('确认验收'),'the accept button stays rendered');
});

test('a control journal that answers with a list still drives the buttons',async()=>{
  serve(action=>action==='control_list'?[{kind:'accept',state:'rejected',revision:'rev-7',message:'上一份验收请求被拒绝。'}]:null);
  body.replaceChildren();
  body.append(renderDesktopControls(record(),{refresh:async()=>{}}));
  for(let i=0;i<6;i++)await tick();
  assert.ok(body.textContent.includes('上一份验收请求被拒绝。'),'the last receipt reason is shown: '+body.textContent);
});

test('a stopped task with nothing to explain renders no unavailable card at all',async()=>{
  // Everything the panel could complain about is satisfied: stopped, reviewed,
  // checks passed. The card must then be absent rather than an empty shell.
  assert.equal(renderControlUnavailable(record(),{desktopAvailable:true,live:true,capacity:null}),null);
  const pending={...record(),view:{...record().view,remoteStopped:false,timing:{nativeStoppedAt:null}}};
  const card=renderControlUnavailable(pending,{desktopAvailable:true,live:true,capacity:null});
  assert.equal(card.tagName==='SECTION'||card.type!=='',true);
  assert.ok(card.textContent.includes('尚未确认原生停止'),'the real reason is named: '+card.textContent);
});
