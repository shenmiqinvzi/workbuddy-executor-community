const route = '/workbench/desktop/command';
const receiptKey = 'workbuddy.desktop.lastRequest';
function el(tag, properties = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(properties)) {
        if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
        else if (name === 'class') node.className = value;
        else if (name in node) node[name] = value;
        else node.setAttribute(name, value);
    }
    for (const child of children.flat(Infinity)) if (child !== undefined && child !== null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
}
export async function desktopRequest(action, parameters = {}) {
    const body=JSON.stringify({action,parameters});
    if(new TextEncoder().encode(body).byteLength>65536)throw Object.assign(new Error('任务约定过长，请缩短目标、范围或验收文字。'),{code:'REQUEST_TOO_LARGE'});
    const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(95000) });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw Object.assign(new Error(result.error?.message || '本地请求未完成，请查询原任务后再处理。'), { code: result.error?.code || 'DESKTOP_UNAVAILABLE' });
    return result.value;
}
export function sourceKey(execution) { return JSON.stringify([execution.executorId, execution.connectionId, execution.providerId]); }
export function rateText(quote) { return quote.pricingVerified && quote.credits !== null ? '观察费率 ' + quote.credits : '费用未知，可能计费'; }
const option = (value, text, disabled = false) => el('option', { value, disabled }, text);
const lineValues = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export async function mountDesktopDispatch({ onTask }) {
    const sheet = document.querySelector('.sheet'), heading = document.querySelector('.heading-tools');
    const open = el('button', { type: 'button', class: 'button dispatch-primary', id: 'new-task', disabled: true, title: '在独立桌面应用中准备任务' }, '新建任务');
    heading.prepend(open);
    let available = false, catalog, draft, busy = false, timer, stage = 'edit', polls = 0, receiptSignature = '';
    const panel = el('section', { class: 'dispatch-workflow', id: 'task-compose', hidden: true, 'aria-label': '准备新任务' });
    sheet.querySelector('.page-heading').after(panel);
    const notice = el('div', { class: 'dispatch-notice', role: 'status', 'aria-live': 'polite', hidden: true });
    const steps = el('nav', { class: 'dispatch-steps', 'aria-label': '任务准备进度' });
    const content = el('div');
    panel.append(el('button', { class: 'text-button dispatch-back', type: 'button', onclick: close }, '返回任务记录'), steps, notice, content);
    const controls = {};
    const field = (name, label, node, hint) => {
        node.id = 'compose-' + name; node.name = name; controls[name] = node;
        const description = hint ? el('p', { id: node.id + '-hint', class: 'dispatch-hint' }, hint) : null;
        if (hint) node.setAttribute('aria-describedby', description.id);
        return el('div', { class: 'dispatch-field' }, el('label', { htmlFor: node.id }, label), node, description);
    };
    const showNotice = (message, error = false) => { notice.hidden = !message; notice.classList.toggle('is-error', error); notice.textContent = message || ''; };
    function setStage(next) {
        stage = next; steps.replaceChildren(...[['edit','填写约定'],['review','核对并确认'],['receipt','请求回执']].map(([value,label]) => el('span', { ...(value === next ? { 'aria-current': 'step' } : {}) }, label)));
    }
    function close() {
        if(busy){showNotice('请等待原请求返回。若关闭窗口，重新打开后先查询原派工回执。');return;}
        clearTimeout(timer); panel.hidden = true; sheet.classList.remove('composing');
        document.getElementById('page-title').textContent = '任务工作台';
        document.querySelector('.page-intro').textContent = '执行有记录，交付有依据。';
        open.focus();
    }
    const isDemo=()=>document.getElementById('data-source')?.value==='demo';
    function sourceChanged() {
        open.disabled=busy||!available||isDemo();open.title=!available||isDemo()?'演示和浏览器模式不能派工；请使用桌面应用的已保存任务':'准备任务约定，核对后在本机确认';
        panel.querySelector('.dispatch-back').disabled=busy;
        const preview=document.getElementById('preview-task'),confirm=document.getElementById('confirm-task');
        if(isDemo()&&!panel.hidden&&stage!=='receipt')showNotice('演示模式不支持派工，请切换回已保存任务。');
        else if(notice.textContent==='演示模式不支持派工，请切换回已保存任务。')showNotice('');
        if(preview)updateChoice();
        if(confirm)confirm.disabled=busy||isDemo()||!catalog?.dispatchEnabled;
    }
    window.addEventListener('workbench-sourcechange', sourceChanged);
    open.addEventListener('click', async () => {
        clearTimeout(timer); panel.hidden = false; sheet.classList.add('composing');
        document.getElementById('page-title').textContent = '新建任务'; document.querySelector('.page-intro').textContent = '先明确约定，再启动执行。';
        draft = null; catalog = null; polls = 0; receiptSignature = ''; showNotice(''); renderEditor();
        busy=true;sourceChanged();
        const saved = (() => { try { return localStorage.getItem(receiptKey); } catch { return null; } })();
        try {const latest=await desktopRequest('latest');const receipt=latest??(saved&&/^[a-f0-9-]{36}$/.test(saved)?await desktopRequest('status',{requestId:saved}):null);if(receipt){renderReceipt(receipt);return;}}
        catch(error){showNotice('无法核对原派工回执。请恢复连接后查询，不会创建新任务。',true);content.replaceChildren(el('button',{class:'button',type:'button',onclick:()=>open.click()},'重新查询原回执'));return;}
        finally{busy=false;sourceChanged();}
        await loadCatalog(); controls.workspace.focus();
    });
    function renderEditor() {
        setStage('edit');
        const workspace = field('workspace', '项目文件夹', el('input', { required: true, autocomplete: 'off', placeholder: '已有项目的绝对路径' }), '任务只作用于此目录；原有改动继续受保护。');
        workspace.append(el('button', { type: 'button', class: 'text-button', onclick: async () => { try { const selected = await desktopRequest('choose_workspace'); if (selected.directory) controls.workspace.value = selected.directory; } catch (error) { showNotice(error.message, true); } } }, '选择文件夹'));
        const source = field('source', '执行来源', el('select', { required: true, onchange: updateModels }), '读取可用目录不会准备或切换模型。');
        const model = field('model', '精确模型', el('select', { required: true, onchange: updateEfforts }));
        const effort = field('effort', '推理档位', el('select', { required: true, onchange: updateChoice }));
        const session = field('session', 'DSH 原会话', el('select', { onchange: updateChoice }), '选择属于本项目、已连接且空闲的会话；不会自动创建或续接其他会话。'); session.id = 'compose-session-field'; session.hidden = true;
        const main = el('div', { class: 'dispatch-fields' }, el('fieldset', {}, el('legend', {}, '项目与目标'), workspace,
            field('title', '任务名称', el('input', { required: true, maxLength: 200, placeholder: '为这次交付起一个明确的名字' })),
            field('objective', '任务目标', el('textarea', { required: true, rows: 4, maxLength: 8000, placeholder: '说明要完成什么，以及完成后应有的行为。' }))),
            el('fieldset', {}, el('legend', {}, '执行选择'), el('div', { class: 'dispatch-inline' }, source, model), effort, session,
                el('p', {id:'choice-rate',class:'dispatch-rate',role:'status'},'请选择完整模型'), el('button', { class: 'text-button', id: 'refresh-models', type: 'button', onclick: loadCatalog }, '刷新来源与费率'), el('div', { id: 'catalog-notices', class: 'dispatch-hint' })),
            el('fieldset', {}, el('legend', {}, '修改范围与验收'),
                field('allowedChanges', '允许修改的文件或目录（每行一项）', el('textarea', { rows: 3, placeholder: 'src/example.ts\nsrc/components/**' }), '留空表示只读。填写精确文件或 directory/**，不自动扩大范围。'),
                field('checks', '独立验收要求（每行一项）', el('textarea', { required: true, rows: 4, placeholder: '用户输入无效值时显示明确提示\n现有功能继续可用' }), '保存为语义检查约定；报告收到后仍需独立验收。'),
                el('details', { class: 'dispatch-advanced' }, el('summary', {}, '项目元数据范围（可选）'), field('permittedMetadata', '允许修改的元数据（每行一项）', el('textarea', { rows: 2 }), '仅在任务确需修改时声明，不默认授予 .git 写权限。'))));
        const aside = el('aside', { class: 'dispatch-summary', 'aria-label': '费用与执行预算' }, el('h2', {}, '执行预算'),
            el('p', { id: 'compose-rate', class: 'dispatch-rate', 'aria-live': 'polite' }, '请选择完整模型'),
            el('p', { class: 'dispatch-hint' }, '费率是读取时的信息，不代表总费用。未知费率可能计费，执行时限不是费用上限。'),
            field('maxAttempts', '最多执行轮次（含首次）', el('input', { type: 'number', min: 1, value: '1', required: true })),
            field('timeoutSeconds', '执行时限（秒）', el('input', { type: 'number', min: 1, value: '600', required: true })),
            el('p', { class: 'dispatch-hint', id: 'compose-policy' }), el('p', { class: 'dispatch-hint' }, '本页只准备约定。核对后还需在本机确认窗口明确同意，才会派工。'));
        const submit = el('button', { type: 'submit', class: 'button dispatch-primary', id: 'preview-task', disabled: true }, '核对任务约定');
        const form = el('form', { class: 'dispatch-grid', onsubmit: async event => {
            event.preventDefault(); if (busy || !catalog || !selectedChoice() || isDemo()) return;
            busy = true; sourceChanged(); submit.disabled = true; showNotice('正在核对任务约定…');
            try {
                draft = await desktopRequest('preview', { catalogId: catalog.catalogId, modelKey: selectedChoice().key, workspace: controls.workspace.value, title: controls.title.value, objective: controls.objective.value,
                    allowedChanges: lineValues(controls.allowedChanges.value), permittedMetadata: lineValues(controls.permittedMetadata.value), checks: lineValues(controls.checks.value),
                    maxAttempts: Number(controls.maxAttempts.value), timeoutSeconds: Number(controls.timeoutSeconds.value), sessionId: selectedChoice().execution.executorId === 'dsh' ? controls.session.value || null : null });
                renderReview(); showNotice('');
            } catch (error) { showNotice(error.message, true); } finally { busy = false; sourceChanged(); if (stage === 'edit') updateChoice(); }
        } }, main, aside, el('div', { class: 'dispatch-actions' }, el('span', { class: 'dispatch-hint' }, '任务完成后不会自动标记为已验收。'), submit));
        content.replaceChildren(form); resetSelects(); if (catalog) populateCatalog();
    }
    function resetSelects() { for (const [name, label] of [['source','请选择执行来源'],['model','请先选择来源'],['effort','请先选择模型'],['session','请选择已有会话']]) { controls[name].replaceChildren(option('',label)); controls[name].disabled = true; } }
    async function loadCatalog() {
        if (busy) return; busy = true; sourceChanged(); catalog = null; resetSelects(); document.getElementById('preview-task').disabled = true;
        const refresh = document.getElementById('refresh-models'); refresh.disabled = true; showNotice('正在读取可用来源与费率…');
        try { catalog = await desktopRequest('catalog'); populateCatalog(); showNotice(''); }
        catch (error) { showNotice(error.message + ' 可以刷新后重试；尚未派工。',true); }
        finally {busy = false; sourceChanged(); refresh.disabled = false; updateChoice();}
    }
    function populateCatalog() {
        const sources = new Map(catalog.models.map(model => [sourceKey(model.execution), model.execution]));
        controls.source.replaceChildren(option('','请选择执行来源'), ...[...sources].map(([key,e]) => option(key, e.executorId === 'workbuddy' ? 'WorkBuddy · 本机原生来源' : `DSH · ${e.providerId} · ${e.connectionId}`)));
        controls.source.disabled = !sources.size;
        controls.maxAttempts.max = catalog.policy.maxAttempts; controls.timeoutSeconds.max = catalog.policy.maxTimeoutSeconds;
        document.getElementById('compose-policy').textContent = `当前上限：${catalog.policy.maxAttempts} 轮、${catalog.policy.maxTimeoutSeconds} 秒。原任务的期限不会因重连延长。`;
        document.getElementById('catalog-notices').replaceChildren(...catalog.errors.map(message=>el('p',{},message)), ...(!catalog.models.length?[el('p',{},'当前没有可选模型，请检查执行器连接后刷新。')]:[]));
        if (!catalog.dispatchEnabled) document.getElementById('catalog-notices').append(el('p',{},'当前安装仅支持查看和准备任务，派工需先完成网关部署核验。'));
    }
    function updateModels() {
        showNotice('');
        controls.model.replaceChildren(option('','请选择精确模型'));
        const models = [...new Set(catalog.models.filter(m=>sourceKey(m.execution)===controls.source.value).map(m=>m.execution.modelId))];
        controls.model.append(...models.map(model=>option(model,model))); controls.model.disabled = !models.length;
        updateEfforts();
    }
    function updateEfforts() {
        showNotice('');
        controls.effort.replaceChildren(option('','请选择推理档位'));
        const models = catalog.models.filter(m=>sourceKey(m.execution)===controls.source.value&&m.execution.modelId===controls.model.value);
        controls.effort.append(...models.map(model=>option(model.execution.reasoningEffort??'__none__',model.execution.reasoningEffort??'未提供'))); controls.effort.disabled = !models.length;
        const executor = models[0]?.execution.executorId;
        const sessions = catalog.sessions.filter(s=>s.hostId===models[0]?.execution.connectionId);
        controls.session.replaceChildren(option('','请选择已有会话'),...sessions.map(s=>option(s.sessionId,`${s.sessionId} · ${s.workspace}${s.attached&&!s.busy?' · 空闲':' · 不可用'}`,!s.attached||s.busy)));
        controls.session.disabled = executor !== 'dsh'; document.getElementById('compose-session-field').hidden = executor !== 'dsh'; updateChoice();
    }
    function selectedChoice() { return catalog?.models.find(m=>sourceKey(m.execution)===controls.source.value&&m.execution.modelId===controls.model.value&&(m.execution.reasoningEffort??'__none__')===controls.effort.value); }
    function updateChoice() {
        if(stage !== 'edit')return;
        const choice = selectedChoice(); document.getElementById('compose-rate').textContent = choice ? rateText(choice) : '请选择完整模型'; document.getElementById('choice-rate').textContent = choice ? rateText(choice) : '请选择完整模型';
        const canPreview = choice && !choice.blockedReason && (choice.execution.executorId !== 'dsh' || controls.session.value);
        document.getElementById('preview-task').disabled = busy || isDemo() || !canPreview;
        if (choice?.blockedReason) showNotice(choice.blockedReason,true);
    }
    function renderReview() {
        setStage('review');
        const c = draft.contract, e = c.execution;
        const list = (title, values, empty) => el('section', { class: 'dispatch-review-section' }, el('h3',{},title), values.length?el('ul',{},values.map(value=>el('li',{},value))):el('p',{class:'dispatch-hint'},empty));
        const grid = el('div',{class:'dispatch-grid'},el('div',{class:'dispatch-review'},el('h2',{},c.title),el('p',{class:'dispatch-objective'},c.objective),
            el('dl',{class:'dispatch-facts'},el('dt',{},'项目'),el('dd',{},draft.workspace.realPath),el('dt',{},'执行来源'),el('dd',{},`${e.executorId} / ${e.connectionId} / ${e.providerId}`),el('dt',{},'精确模型'),el('dd',{},e.modelId),el('dt',{},'推理档位'),el('dd',{},e.reasoningEffort??'未提供'),...(draft.sessionId?[el('dt',{},'原会话'),el('dd',{},draft.sessionId)]:[])),
            list('允许修改范围',c.scope.allowedChanges,'只读，不授予文件写权限。'),list('允许的元数据',c.scope.permittedMetadata,'无额外元数据写权限。'),list('独立验收要求',c.requiredChecks.map(check=>check.definition),''),
            el('details', {class:'dispatch-advanced'},el('summary',{},'任务标识'),el('p',{class:'technical'},draft.taskId),el('p',{class:'technical'},draft.operationId),el('p',{class:'technical'},draft.digest))),
            el('aside',{class:'dispatch-summary'},el('h2',{},'确认前核对'),el('p',{class:'dispatch-rate'},rateText(draft.quote)),el('p',{},`最多 ${c.maxAttempts} 轮 · 时限 ${c.timeoutSeconds} 秒`),el('p',{class:'dispatch-hint'},'时限不是费用上限。费率为读取时的信息，未知费率可能产生费用。'),el('p',{class:'dispatch-hint'},'将在本机确认窗口显示完整约定。勾选同意并确认后才开始派工。'),el('p',{class:'dispatch-hint'},`本约定有效至 ${new Date(draft.expiresAt).toLocaleTimeString()}`)),
            el('div',{class:'dispatch-actions'},el('button',{class:'button',type:'button',onclick:()=>{
                const previous=draft;draft=null;renderEditor();
                for(const name of ['title','objective','maxAttempts','timeoutSeconds'])controls[name].value=String(previous.contract[name]);
                controls.workspace.value=previous.workspace.realPath;controls.allowedChanges.value=previous.contract.scope.allowedChanges.join('\n');controls.permittedMetadata.value=previous.contract.scope.permittedMetadata.join('\n');controls.checks.value=previous.contract.requiredChecks.map(c=>c.definition).join('\n');
                controls.source.value=sourceKey(previous.contract.execution);updateModels();controls.model.value=previous.contract.execution.modelId;updateEfforts();controls.effort.value=previous.contract.execution.reasoningEffort??'__none__';controls.session.value=previous.sessionId??'';updateChoice();showNotice('修改后需重新核对约定。');
            }},'返回修改'),el('button',{class:'button dispatch-primary',id:'confirm-task',type:'button',disabled:!catalog.dispatchEnabled,onclick:confirm},'打开派工确认')));
        content.replaceChildren(grid); content.querySelector('h2').setAttribute('tabindex','-1');content.querySelector('h2').focus();
        if(!catalog.dispatchEnabled)showNotice('当前安装仅支持查看和准备任务，尚未启用派工。');
    }
    async function confirm() {
        if(busy||!draft||isDemo())return;busy=true;sourceChanged();const button=document.getElementById('confirm-task');button.disabled=true;showNotice('请在本机确认窗口核对，尚未派工。');
        try {
            try {localStorage.setItem(receiptKey,draft.draftId);}catch{}
            const receipt=await desktopRequest('dispatch',{draftId:draft.draftId,digest:draft.digest});renderReceipt(receipt);showNotice('');
        } catch(error){if(error.code==='CONFIRMATION_CANCELLED'){try{localStorage.removeItem(receiptKey);}catch{}}showNotice(error.message,true);}
        finally{busy=false;sourceChanged();if(stage==='review')button.disabled=!catalog.dispatchEnabled||isDemo();}
    }
    function renderReceipt(receipt) {
        setStage('receipt');clearTimeout(timer);
        document.getElementById('page-title').textContent='派工回执';document.querySelector('.page-intro').textContent='按原任务编号查询，连接恢复后继续核对。';
        open.textContent='派工回执';
        const signature=JSON.stringify(receipt),unchanged=receiptSignature===signature;receiptSignature=signature;
        const labels={launch_requested:'派工请求已登记',dispatching:'正在处理原派工请求',submitted:'派工已受理',failed:'派工未完成',outcome_unknown:'派工结果尚未明确'};
        if(!unchanged)content.replaceChildren(el('div',{class:'dispatch-receipt'},el('h2',{tabIndex:-1,role:'status'},labels[receipt.state]||'请查询原派工请求'),el('p',{},receipt.message||(receipt.state==='submitted'?'任务尚未验收。执行进度、原生停止与独立验收将分别展示。':'请求登记不代表原生接单，请保留以下编号。')),
            el('dl',{class:'dispatch-facts'},el('dt',{},'任务编号'),el('dd',{class:'technical'},receipt.taskId),el('dt',{},'操作编号'),el('dd',{class:'technical'},receipt.operationId)),
            el('div',{class:'dispatch-actions'},el('button',{type:'button',class:'button',onclick:()=>queryReceipt(receipt.requestId)},'查询原请求'),
                ...(receipt.state==='submitted'?[el('button',{type:'button',class:'button',onclick:async event=>{event.currentTarget.disabled=true;showNotice('正在观察原执行状态，不会派工或改变模型…');try{await desktopRequest('observe',{requestId:receipt.requestId});close();await onTask(receipt.taskId);}catch(error){showNotice(error.message,true);}finally{event.target.disabled=false;}}},'更新执行状态')]:[]),
                el('button',{type:'button',class:'button dispatch-primary',onclick:async()=>{close();await onTask(receipt.taskId);}},'查看已保存任务')),
            el('p',{class:'dispatch-hint'},'连接中断不会自动重派。报告收到不代表原生停止或独立验收通过。'),
            ...(['submitted','failed'].includes(receipt.state)?[el('button',{class:'text-button',type:'button',onclick:async()=>{try{localStorage.removeItem(receiptKey);}catch{}document.getElementById('page-title').textContent='新建任务';document.querySelector('.page-intro').textContent='先明确约定，再启动执行。';open.textContent='新建任务';receiptSignature='';polls=0;renderEditor();showNotice('新派工仍须满足原任务的共享容量与停止规则。');await loadCatalog();}},'准备另一项任务')]:[])));
        if((receipt.state==='launch_requested'||receipt.state==='dispatching')&&polls++<45)timer=setTimeout(()=>queryReceipt(receipt.requestId),2000);
    }
    async function queryReceipt(requestId) {
        if(panel.hidden)return;
        try {const receipt=await desktopRequest('status',{requestId});if(receipt)renderReceipt(receipt);else showNotice('尚无已受理的原请求记录。请核对原任务与操作编号，不会自动派工。',true);}
        catch(error){showNotice(error.message,true);}
    }
    try {
        const response=await fetch('/workbench/desktop/capabilities',{method:'GET',signal:AbortSignal.timeout(5000)});
        const result=await response.json();available=response.ok&&result.ok===true&&result.value?.available===true;
        if(available){const badge=document.querySelector('.readonly-top');if(badge)badge.lastChild.textContent='任务记录只读';}
    }catch{available=false;}
    sourceChanged();
}
