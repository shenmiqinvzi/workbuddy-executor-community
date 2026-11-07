import test from 'node:test';
import assert from 'node:assert/strict';
import {installMiniDom,MiniElement} from './support/mini-dom.mjs';
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
globalThis.window={addEventListener(){}};
const stored=new Map();globalThis.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
const {mountDesktopDispatch,sourceKey}=await import('../dispatch.mjs');
const q=id=>document.getElementById(id);const tick=()=>new Promise(r=>setImmediate(r));
async function until(check){for(let i=0;i<80;i++){if(check())return;await tick()}throw Error('UI did not settle: '+body.textContent.slice(0,400)+' | source='+String(q('compose-source')?.disabled)+' open='+String(q('new-task')?.disabled))}
const projectPath='C:/synthetic/project',projectId='project-'+'a'.repeat(32);
const wb={key:'wbkey',execution:{executorId:'workbuddy',connectionId:'local-workbuddy',providerId:'workbuddy-native',modelId:'synthetic-model',reasoningEffort:null},credits:'x0.00',pricingVerified:true,blockedReason:null};
const dsh={key:'dshkey',execution:{executorId:'dsh',connectionId:'synthetic-host',providerId:'synthetic-provider',modelId:'synthetic-dsh',reasoningEffort:'low'},credits:null,pricingVerified:false,blockedReason:null};
const catalog=()=>({catalogId:'catalog-1',models:[wb,dsh],sessions:[{hostId:'synthetic-host',sessionId:'session-1',workspace:projectPath,attached:true,busy:false}],policy:{maxAttempts:3,maxTimeoutSeconds:1000},errors:[],dispatchEnabled:true,
  sources:[
    {sourceId:sourceKey(wb.execution),executorId:'workbuddy',connectionId:'local-workbuddy',providerId:'workbuddy-native',label:'WorkBuddy · 本机原生来源',state:'online',stateReason:null,dispatchable:true,stoppable:'unknown',models:[wb]},
    {sourceId:sourceKey(dsh.execution),executorId:'dsh',connectionId:'synthetic-host',providerId:'synthetic-provider',label:'DSH · synthetic-provider · synthetic-host',state:'disabled',stateReason:'DSH 来源未启用；如需使用，请检查现有连接配置。',dispatchable:false,stoppable:'unknown',models:[dsh]}],
  projects:[{projectId,realPath:projectPath,displayName:'project',state:'unverified',observedAt:'2026-11-05T00:00:00.000Z'}],projectIssues:[]});
const draft=(revision,warnings=[])=>({draftId:'draft-1',taskId:'desktop-task-1',operationId:'desktop-send-1',revision,projectId,workspace:{realPath:projectPath,device:'1',inode:'2'},sessionId:null,digest:'digest-'+revision,quote:{credits:'x0.00',pricingVerified:true,observedAt:'2026-11-05T00:00:00.000Z'},policyVersion:'policy-1',expiresAt:'2026-11-05T23:59:59.000Z',warnings,
  contract:{schemaVersion:'workbuddy-executor/vnext-2',taskId:'desktop-task-1',workspaceId:'desktop-1',title:'Synthetic scoped task',objective:'Update only the allowed files',execution:wb.execution,collaboration:{planId:'pending',expectedPlanRevision:'pending'},timeoutSeconds:600,maxAttempts:1,scope:{allowedChanges:['src/**'],permittedMetadata:[]},requiredChecks:[{id:'check-1',kind:'semantic',definition:'Independent check'}]}});
function setup(){body.replaceChildren();const sheet=document.createElement('div');sheet.className='sheet';const heading=document.createElement('div');heading.className='page-heading';const tools=document.createElement('div');tools.className='heading-tools';const title=document.createElement('h1');title.id='page-title';const intro=document.createElement('p');intro.className='page-intro';heading.append(title,intro,tools);sheet.append(heading);body.append(sheet);const source=document.createElement('input');source.id='data-source';source.value='live';body.append(source);}
const byText=(tag,text)=>body.descendants().filter(node=>node.tagName===tag&&node.textContent.trim()===text);
function submit(){
    const form=body.descendants().find(node=>node.tagName==='FORM');
    const handlers=[...form.listeners.get('submit')??[]];
    return Promise.all(handlers.map(handler=>handler({type:'submit',preventDefault(){}})));
}
async function openEditor(warnings=[]){
    setup();const calls=[];globalThis.fetch=async(url,init)=>{if(url.endsWith('capabilities'))return new Response(JSON.stringify({ok:true,value:{available:true}}));const action=JSON.parse(init.body).action;calls.push({action,parameters:JSON.parse(init.body).parameters});
        if(action==='latest')return new Response(JSON.stringify({ok:true,value:null}));
        if(action==='preview'){const revision=(calls.filter(call=>call.action==='preview').length);return new Response(JSON.stringify({ok:true,value:draft(revision,warnings)}));}
        return new Response(JSON.stringify({ok:true,value:action==='catalog'?catalog():null}));};
    await mountDesktopDispatch({onTask:async()=>{}});q('new-task').click();await until(()=>q('compose-source')&&!q('compose-source').disabled);
    return calls;
}

test('a source that failed or is disabled stays visible with its own reason',async()=>{
    await openEditor();
    const options=[...q('compose-source').options].map(node=>({value:node.value,text:node.textContent,disabled:node.disabled}));
    assert.equal(options.length,3);
    assert.equal(options[0].value,'');
    assert.match(options[1].text,/可用/);
    assert.equal(options[1].disabled,false);
    assert.match(options[2].text,/未启用/);
    assert.equal(options[2].disabled,true);
    assert.match(q('catalog-notices').textContent,/DSH 来源未启用/);
});

test('a remembered project is chosen by identity and sent without re-typing its path',async()=>{
    const calls=await openEditor();
    assert.match(q('compose-project').options[1].textContent,/project/);
    q('compose-project').value=projectId;q('compose-project').dispatch('change');
    assert.equal(q('compose-workspace').value,projectPath);
    assert.match(q('project-notice').textContent,/已核验项目身份/);
    q('compose-source').value=sourceKey(wb.execution);q('compose-source').dispatch('change');
    q('compose-model').value='synthetic-model';q('compose-model').dispatch('change');
    q('compose-effort').value='__none__';q('compose-effort').dispatch('change');
    q('compose-title').value='Synthetic scoped task';q('compose-objective').value='Update only the allowed files';q('compose-checks').value='Independent check';
    assert.equal(q('preview-task').disabled,false);
    await submit();await tick();
    const preview=calls.filter(call=>call.action==='preview').at(-1);
    assert.equal(preview.parameters.projectId,projectId);
    assert.equal(preview.parameters.workspace,null);
    assert.equal(preview.parameters.draftId,undefined);
});

test('going back keeps the task identity and the next review is a new revision',async()=>{
    const calls=await openEditor();
    q('compose-workspace').value=projectPath;q('compose-workspace').dispatch('input');
    q('compose-source').value=sourceKey(wb.execution);q('compose-source').dispatch('change');
    q('compose-model').value='synthetic-model';q('compose-model').dispatch('change');
    q('compose-effort').value='__none__';q('compose-effort').dispatch('change');
    q('compose-title').value='Synthetic scoped task';q('compose-objective').value='Update only the allowed files';q('compose-checks').value='Independent check';
    await submit();await until(()=>q('confirm-task'));
    assert.match(q('revision-note').textContent,/第 1 版/);
    byText('BUTTON','返回修改')[0].click();
    await until(()=>q('preview-task'));
    assert.match(q('preview-task').textContent,/第 2 版/);
    assert.match(body.textContent,/已保留原任务身份/);
    await submit();await until(()=>q('confirm-task'));
    const previews=calls.filter(call=>call.action==='preview');
    assert.equal(previews.length,2);
    assert.equal(previews[1].parameters.draftId,'draft-1');
    assert.equal(previews[1].parameters.digest,'digest-1');
    assert.match(q('revision-note').textContent,/第 2 版/);
    assert.match(body.textContent,/desktop-task-1/);
});

test('one agreement is confirmed once, and a refusal keeps the exact identity',async()=>{
    const calls=await openEditor();
    let dispatchCount=0,outcome='cancel';
    globalThis.fetch=async(url,init)=>{if(url.endsWith('capabilities'))return new Response(JSON.stringify({ok:true,value:{available:true}}));const {action,parameters}=JSON.parse(init.body);calls.push({action,parameters});
        if(action==='latest')return new Response(JSON.stringify({ok:true,value:null}));
        if(action==='catalog')return new Response(JSON.stringify({ok:true,value:catalog()}));
        if(action==='preview')return new Response(JSON.stringify({ok:true,value:draft(1)}));
        if(action==='dispatch'){dispatchCount++;if(outcome==='cancel')return new Response(JSON.stringify({ok:false,error:{code:'CONFIRMATION_CANCELLED',message:'已在本机确认窗口取消。'}}));
            if(outcome==='consumed')return new Response(JSON.stringify({ok:false,error:{code:'PLAN_ALREADY_CONSUMED',message:'同一份任务约定已在其他任务上派工。'}}));
            return new Response(JSON.stringify({ok:true,value:{requestId:'draft-1',taskId:'desktop-task-1',operationId:'desktop-send-1',state:'launch_requested'}}));}
        return new Response(JSON.stringify({ok:true,value:null}));};
    q('compose-workspace').value=projectPath;q('compose-workspace').dispatch('input');
    q('compose-source').value=sourceKey(wb.execution);q('compose-source').dispatch('change');
    q('compose-model').value='synthetic-model';q('compose-model').dispatch('change');
    q('compose-effort').value='__none__';q('compose-effort').dispatch('change');
    q('compose-title').value='Synthetic scoped task';q('compose-objective').value='Update only the allowed files';q('compose-checks').value='Independent check';
    await submit();await until(()=>q('confirm-task'));
    q('confirm-task').click();await until(()=>dispatchCount===1);await until(()=>/已在本机确认窗口取消/.test(body.textContent));
    assert.equal(q('confirm-task').disabled,false);
    outcome='consumed';q('confirm-task').click();await until(()=>dispatchCount===2);await until(()=>/同一份任务约定/.test(body.textContent));
    assert.equal(q('confirm-task').disabled,true);
    assert.equal(calls.filter(call=>call.action==='dispatch').length,2);
});

test('a scope warning is shown on the terms it belongs to and never blocks the review',async()=>{
    const warnings=[{code:'scope_not_declared',message:'目标看起来要改动文件，但允许修改范围为空。'},
        {code:'scope_path_not_covered',message:'目标提到 docs/README.md，但它不在允许修改范围里。'}];
    await openEditor(warnings);
    q('compose-workspace').value=projectPath;q('compose-workspace').dispatch('input');
    q('compose-source').value=sourceKey(wb.execution);q('compose-source').dispatch('change');
    q('compose-model').value='synthetic-model';q('compose-model').dispatch('change');
    q('compose-effort').value='__none__';q('compose-effort').dispatch('change');
    q('compose-title').value='Synthetic scoped task';q('compose-objective').value='Update docs/README.md';q('compose-checks').value='Independent check';
    await submit();await until(()=>q('confirm-task'));
    assert.match(q('review-warnings').textContent,/正文与允许范围不一致/);
    assert.match(q('review-warnings').textContent,/docs\/README\.md/);
    assert.match(q('review-warnings').textContent,/不会扩大范围/);
    // The warning asks the user to fix the scope; it is not a refusal and it
    // does not grant anything.
    assert.equal(q('confirm-task').disabled,false);
    assert.match(q('review-warnings').textContent,/正文与允许范围不一致/);
});
