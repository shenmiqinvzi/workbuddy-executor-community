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
async function until(check){for(let i=0;i<80;i++){if(check())return;await tick()}throw Error('UI did not settle: '+body.textContent.slice(0,600)+' | recommend='+String(q('recommendation')?.hidden))}
const projectPath='C:/synthetic/project',projectId='project-'+'a'.repeat(32);
const wb={key:'wbkey',execution:{executorId:'workbuddy',connectionId:'local-workbuddy',providerId:'workbuddy-native',modelId:'synthetic-model',reasoningEffort:null},credits:'x0.00',pricingVerified:true,blockedReason:null};
const wb2={key:'wb2key',execution:{executorId:'workbuddy',connectionId:'local-workbuddy',providerId:'workbuddy-native',modelId:'synthetic-model-2',reasoningEffort:'high'},credits:'x1.20',pricingVerified:true,blockedReason:null};
const dsh={key:'dshkey',execution:{executorId:'dsh',connectionId:'synthetic-host',providerId:'synthetic-provider',modelId:'synthetic-dsh',reasoningEffort:'low'},credits:null,pricingVerified:false,blockedReason:null};
const catalog=()=>({catalogId:'catalog-1',models:[wb,wb2,dsh],sessions:[{hostId:'synthetic-host',sessionId:'session-1',workspace:projectPath,attached:true,busy:false}],policy:{version:'policy-1',maxAttempts:3,maxTimeoutSeconds:1000,requireFree:false,selectionMode:'user_choice',allowed:[]},errors:[],dispatchEnabled:true,
  sources:[
    {sourceId:sourceKey(wb.execution),executorId:'workbuddy',connectionId:'local-workbuddy',providerId:'workbuddy-native',label:'WorkBuddy · 本机原生来源',state:'online',stateReason:null,dispatchable:true,stoppable:'unknown',models:[wb,wb2]},
    {sourceId:sourceKey(dsh.execution),executorId:'dsh',connectionId:'synthetic-host',providerId:'synthetic-provider',label:'DSH · synthetic-provider · synthetic-host',state:'disabled',stateReason:'DSH 来源未启用；如需使用，请检查现有连接配置。',dispatchable:false,stoppable:'unknown',models:[dsh]}],
  projects:[{projectId,realPath:projectPath,displayName:'project',state:'unverified',observedAt:'2026-11-05T00:00:00.000Z'}],projectIssues:[]});
const draft=revision=>({draftId:'draft-1',taskId:'desktop-task-1',operationId:'desktop-send-1',revision,projectId,workspace:{realPath:projectPath,device:'1',inode:'2'},sessionId:null,digest:'digest-'+revision,quote:{credits:'x0.00',pricingVerified:true,observedAt:'2026-11-05T00:00:00.000Z'},policyVersion:'policy-1',expiresAt:'2026-11-05T23:59:59.000Z',
  contract:{schemaVersion:'workbuddy-executor/vnext-2',taskId:'desktop-task-1',workspaceId:'desktop-1',title:'Synthetic scoped task',objective:'Update only the allowed files',execution:wb.execution,collaboration:{planId:'pending',expectedPlanRevision:'pending'},timeoutSeconds:600,maxAttempts:1,scope:{allowedChanges:['src/**'],permittedMetadata:[]},requiredChecks:[{id:'check-1',kind:'semantic',definition:'Independent check'}]}});
const candidate=(model,over={})=>({selection:model.execution,sourceId:sourceKey(model.execution),sourceLabel:'WorkBuddy · 本机原生来源',sourceState:'online',dispatchable:true,
  cost:{credits:model.credits,pricingVerified:model.pricingVerified,known:model.pricingVerified&&model.credits!==null,zero:model.pricingVerified&&model.credits==='x0.00',label:model.credits===null?'费用未知，可能计费':(model.credits==='x0.00'?'已核实零费率':'观察费率 '+model.credits)},
  resources:{status:'unavailable',reference:null,quotaFreshness:null,quotaRemaining:null,creditBalance:null,routingVerified:false,limitations:['resource_reference_missing','routing_unverified']},
  reasons:[{code:'cost_verified_zero',message:'费率为已核实的零。'},{code:'resource_reference_missing',message:'没有可用的资源引用；余量未知，不当作充足。'}],
  rank:{tier:2,rule:'tier_then_lexicographic'},...over});
const explanation=(over={})=>({schemaVersion:'workbuddy-executor/recommendation-1',explanationVersion:1,readOnly:true,generatedAt:'2026-11-05T12:00:00.000Z',
  decision:'delegate',mode:'recommend',authorization:{state:'none',requires:['preview','confirmation']},attempt:null,nativeAttempt:'none',
  catalog:{catalogId:'catalog-1',observedAt:'2026-11-05T11:59:00.000Z',expiresAt:'2026-11-05T12:05:00.000Z',fresh:true},
  policy:{version:'policy-1',requireFree:false,selectionMode:'user_choice',allowedCount:0,maxAttempts:3,maxTimeoutSeconds:1000,dispatchEnabled:true},
  decisionReason:{code:'delegate_ranked_candidates',message:'按当前政策与能力快照排出首个候选；这不是质量排名。',codes:['cost_verified_zero']},
  userSelection:null,recommended:candidate(wb),candidates:[candidate(wb),candidate(wb2)],
  excluded:[{selection:dsh.execution,sourceLabel:'DSH · synthetic-provider · synthetic-host',code:'source_not_online',message:'来源状态为 disabled；在线不等于可执行。'}],
  missing:[{code:'no_statistics_sample',message:'没有可用的历史统计样本；不据此推断质量、节省或优劣。',severity:'limits'}],
  history:{status:'unavailable',code:'statistics_not_read',window:null,sampleSize:null,coverage:null,limitations:[],claims:{savings:null,superiority:null}},
  constraints:{freeOnly:false,hardCostCap:{status:'none',requested:null,message:null}},
  limitations:['recommendation_only','no_model_call','no_attempt_created','routing_unverified'],notes:[],digest:'a'.repeat(64),drift:null,...over});
function setup(){body.replaceChildren();const sheet=document.createElement('div');sheet.className='sheet';const heading=document.createElement('div');heading.className='page-heading';const tools=document.createElement('div');tools.className='heading-tools';const title=document.createElement('h1');title.id='page-title';const intro=document.createElement('p');intro.className='page-intro';heading.append(title,intro,tools);sheet.append(heading);body.append(sheet);const source=document.createElement('input');source.id='data-source';source.value='live';body.append(source);}
const byText=(tag,text)=>body.descendants().filter(node=>node.tagName===tag&&node.textContent.trim()===text);
function submit(){
    const form=body.descendants().find(node=>node.tagName==='FORM');
    const handlers=[...form.listeners.get('submit')??[]];
    return Promise.all(handlers.map(handler=>handler({type:'submit',preventDefault(){}})));
}
/** A host that answers the recommendation command; `answer` decides each reply. */
async function openEditor({answer=()=>explanation(),statistics=null,reference=null}={}){
    setup();const calls=[];let dispatched=0;
    globalThis.fetch=async(url,init)=>{
        const address=String(url);
        if(address.endsWith('capabilities'))return new Response(JSON.stringify({ok:true,value:{available:true}}));
        if(address.includes('/workbench/v1/statistics'))return statistics?new Response(JSON.stringify(statistics)):new Response(JSON.stringify({ok:false}),{status:503});
        if(address.includes('/workbench/v1/resources/plan-reference'))return reference?new Response(JSON.stringify(reference)):new Response('{}',{status:404});
        const {action,parameters}=JSON.parse(init.body);calls.push({action,parameters});
        if(action==='latest')return new Response(JSON.stringify({ok:true,value:null}));
        if(action==='catalog')return new Response(JSON.stringify({ok:true,value:catalog()}));
        if(action==='preview')return new Response(JSON.stringify({ok:true,value:draft(calls.filter(call=>call.action==='preview').length)}));
        if(action==='dispatch'){dispatched++;return new Response(JSON.stringify({ok:true,value:{requestId:'draft-1',taskId:'desktop-task-1',operationId:'desktop-send-1',state:'launch_requested'}}));}
        if(action==='recommend'){
            const reply=answer(parameters,calls.filter(call=>call.action==='recommend').length);
            if(reply==='unsupported')return new Response(JSON.stringify({ok:false,error:{code:'DESKTOP_COMMAND_FAILED',message:'Unsupported desktop command.'}}));
            return new Response(JSON.stringify({ok:true,value:reply}));
        }
        return new Response(JSON.stringify({ok:true,value:null}));
    };
    await mountDesktopDispatch({onTask:async()=>{}});q('new-task').click();await until(()=>q('compose-source')&&!q('compose-source').disabled);
    return {calls,dispatched:()=>dispatched};
}
function fillIntent(){
    q('compose-workspace').value=projectPath;q('compose-workspace').dispatch('input');
    q('compose-title').value='Synthetic scoped task';q('compose-objective').value='Update only the allowed files';q('compose-checks').value='Independent check';
}

test('the explanation shows reasons, exclusions, the missing sample and no authorization',async()=>{
    const host=await openEditor();
    fillIntent();
    q('recommendation-refresh').click();
    await until(()=>q('recommendation-decision'));
    assert.equal(q('recommendation').hidden,false);
    assert.match(q('recommendation-decision').textContent,/建议交给执行器/);
    assert.match(q('recommendation-decision').textContent,/已核实零费率/);
    assert.match(q('recommendation-why').textContent,/费率为已核实的零/);
    assert.match(q('recommendation-why').textContent,/delegate_ranked_candidates/);
    assert.match(q('recommendation-candidates').textContent,/采用此候选/);
    assert.match(q('recommendation-excluded').textContent,/在线不等于可执行/);
    assert.match(q('recommendation-missing').textContent,/没有可用的历史统计样本/);
    assert.match(q('recommendation-history').textContent,/历史统计：不可用/);
    assert.match(q('recommendation-history').textContent,/样本量与时间窗未知/);
    assert.match(q('recommendation-limitations').textContent,/routing_unverified/);
    assert.match(q('recommendation-digest').textContent,/评估 aaaaaaaaaaaaaaaa/);
    assert.match(body.textContent,/推荐不等于授权/);
    assert.equal(host.calls.filter(call=>call.action==='dispatch').length,0,'a recommendation never dispatches');
    assert.equal(host.calls.filter(call=>call.action==='preview').length,0,'a recommendation never prepares a plan');
});

test('a host without the command hides the panel and keeps the composer usable',async()=>{
    const host=await openEditor({answer:()=>'unsupported'});
    fillIntent();
    q('recommendation-refresh').click();
    await until(()=>q('recommendation').hidden===true);
    assert.equal(q('recommendation').hidden,true);
    assert.match(q('catalog-notices').textContent,/DSH 来源未启用/,'the rest of the composer still reports its own state');
    q('compose-source').value=sourceKey(wb.execution);q('compose-source').dispatch('change');
    q('compose-model').value='synthetic-model';q('compose-model').dispatch('change');
    q('compose-effort').value='__none__';q('compose-effort').dispatch('change');
    assert.equal(q('preview-task').disabled,false);
    await submit();await until(()=>q('confirm-task'));
    assert.match(q('revision-note').textContent,/第 1 版/);
    assert.ok(host.calls.some(call=>call.action==='preview'),'preparing a plan does not depend on the recommendation');
});

test('applying a candidate switches the fields and keeps the choice explicit',async()=>{
    const host=await openEditor();
    fillIntent();
    q('recommendation-refresh').click();
    await until(()=>q('recommendation-candidates'));
    const target=body.descendants().filter(node=>node.tagName==='LI'&&/synthetic-model-2/.test(node.textContent))[0];
    const apply=target.descendants().find(node=>node.tagName==='BUTTON');
    apply.click();
    await until(()=>q('compose-model').value==='synthetic-model-2');
    assert.equal(q('compose-source').value,sourceKey(wb2.execution));
    assert.equal(q('compose-effort').value,'high');
    assert.match(body.textContent,/已改用 synthetic-model-2 · high/);
    q('recommendation-refresh').click();
    await until(()=>host.calls.filter(call=>call.action==='recommend').length>=2);
    const last=host.calls.filter(call=>call.action==='recommend').at(-1);
    assert.equal(last.parameters.constraints?.selection?.modelId,'synthetic-model-2','the chosen candidate is sent as an explicit choice');
});

test('a changed snapshot blocks the confirmation instead of dispatching',async()=>{
    const host=await openEditor({answer:(parameters)=>parameters.previous?explanation({digest:'b'.repeat(64),drift:{codes:['catalog_changed','policy_changed'],message:'能力快照与政策已更新。',blockedForDispatch:true}}):explanation()});
    fillIntent();
    q('compose-source').value=sourceKey(wb.execution);q('compose-source').dispatch('change');
    q('compose-model').value='synthetic-model';q('compose-model').dispatch('change');
    q('compose-effort').value='__none__';q('compose-effort').dispatch('change');
    q('recommendation-refresh').click();
    await until(()=>q('recommendation-decision'));
    await submit();await until(()=>q('confirm-task'));
    q('confirm-task').click();
    await until(()=>/能力快照或政策已变化/.test(body.textContent));
    assert.match(body.textContent,/catalog_changed、policy_changed/);
    assert.match(body.textContent,/不会按旧解释派工/);
    assert.equal(host.dispatched(),0,'no dispatch on an outdated explanation');
    assert.equal(q('confirm-task').disabled,false,'the user may return and review again');
});

test('an unchanged snapshot lets the confirmed dispatch proceed',async()=>{
    const host=await openEditor({answer:(parameters)=>parameters.previous?explanation({drift:{codes:[],message:'与上次评估一致。',blockedForDispatch:false}}):explanation()});
    fillIntent();
    q('compose-source').value=sourceKey(wb.execution);q('compose-source').dispatch('change');
    q('compose-model').value='synthetic-model';q('compose-model').dispatch('change');
    q('compose-effort').value='__none__';q('compose-effort').dispatch('change');
    q('recommendation-refresh').click();
    await until(()=>q('recommendation-decision'));
    await submit();await until(()=>q('confirm-task'));
    q('confirm-task').click();
    await until(()=>host.dispatched()===1);
    assert.equal(host.calls.filter(call=>call.action==='dispatch').length,1);
});

const withResources = has => candidate(wb, {resources:{status:has?'fresh':'unavailable',reference:null,quotaFreshness:has?'fresh':null,quotaRemaining:has?12000:null,creditBalance:has?'x4.00':null,routingVerified:false,limitations:has?['routing_unverified']:['resource_reference_missing']}});
test('the statistics window and the resource reference reach the panel when available',async()=>{
    await openEditor({
        statistics:{schemaVersion:'workbuddy-executor/statistics-1',window:{from:'2026-10-01T00:00:00.000Z',to:null},coverage:{tasksRead:20,tasksIncluded:12,tasksExcludedOutsideWindow:8,tasksWithoutEvents:0,tasksIncomplete:0,eventsRead:60,tasksTruncated:0,eventsTruncated:0},limitations:[],claims:{savings:null,superiority:null}},
        reference:{schemaVersion:'workbuddy-executor/plan-resource-reference-1',generatedAt:'2026-11-05T11:58:00.000Z',execution:wb.execution,routingVerified:false,attribution:'execution_link_declared',association:{status:'linked'},quota:{unit:'tokens',freshness:'fresh',remaining:12000,limitations:[]},credit:{unit:'credit',balance:'x4.00',cacheFreshness:'fresh',limitations:[]},caveats:['resource_reference_only','not_task_usage','not_a_spend_limit','routing_unverified']},
        answer:parameters=>{
            const has = Array.isArray(parameters.resources) && parameters.resources.length > 0;
            return explanation({
                candidates:[withResources(has)],
                recommended:withResources(has),
                history:{status:'partial',code:'statistics_partial_coverage',window:{from:'2026-10-01T00:00:00.000Z',to:null},sampleSize:12,coverage:{tasksIncluded:12},limitations:[],claims:{savings:null,superiority:null}},
            });
        },
    });
    fillIntent();
    q('recommendation-refresh').click();
    await until(()=>q('recommendation-decision')&&/资源引用新鲜/.test(q('recommendation-decision').textContent));
    assert.match(q('recommendation-history').textContent,/仅部分覆盖/);
    assert.match(q('recommendation-history').textContent,/样本 12 项/);
    assert.match(q('recommendation-history').textContent,/2026-10-01T00:00:00.000Z 至 现在/);
});
