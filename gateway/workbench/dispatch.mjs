import { mountPlanReference } from './plan-reference.mjs';

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
const receiptLabels = { launch_requested: '派工请求已登记', dispatching: '派工请求已发出，等待回执', submitted: '派工已受理', failed: '派工未完成', outcome_unknown: '派工结果尚未明确' };
export function receiptStatusText(state) { return receiptLabels[state] || '请查询原派工请求'; }
export function receiptStillPending(state) { return state === 'launch_requested' || state === 'dispatching'; }
export function operationStateLabel(state) { return { reserved: '已预留', effect_started: '已开始生效', succeeded: '已成功', rejected: '已拒绝', outcome_unknown: '结果不明' }[state] || '未知状态'; }
const leaseLabels = { live: '所有者仍在运行，心跳正常', stuck: '所有者进程仍在，但心跳已停止', abandoned: '所有者进程已退出，未见回执', lease_unavailable: '无租约记录' };
export function leaseLabel(dispatch) { return !dispatch ? '无记录' : (leaseLabels[dispatch.settlement] || '无租约记录'); }
export function recoveryConclusionText(conclusion) { return { outcome_unsettled: '效果不可排除：保留原请求与执行容量，由后端按证据判断。', succeeded: '原操作已成功完成。', rejected: '原操作被拒绝，未产生效果。', active: '原操作仍在进行，等待回执。', dispatch_only: '只有派工请求记录，没有原操作记录。' }[conclusion] || '证据不足，请保留原编号。'; }
/** Refusals the gateway raises before anything was handed to an executor. They
 * are definite: the terms can be corrected under the same task identity. */
const definiteRefusals = new Set(['DISPATCH_NOT_ENABLED', 'MODEL_UNVERIFIED', 'MODEL_POLICY_BLOCKED', 'MODEL_SELECTION_REQUIRED', 'QUOTE_CHANGED', 'POLICY_CHANGED', 'WORKSPACE_CONFLICT', 'SESSION_REQUIRED', 'SESSION_AMBIGUOUS', 'DRAFT_EXPIRED', 'DRAFT_CHANGED', 'DRAFT_CONSUMED', 'PLAN_ALREADY_CONSUMED', 'CATALOG_EXPIRED', 'CATALOG_TOO_LARGE', 'BUDGET_EXCEEDED', 'INVALID_REQUEST', 'INVALID_CONTRACT', 'SCOPE_NOT_DECLARED', 'PROJECT_NOT_REGISTERED', 'PROJECT_IDENTITY_CHANGED', 'PROJECT_NOT_FOUND', 'PROJECT_ACCESS_DENIED', 'PROJECT_NOT_DIRECTORY', 'PROJECT_UNREADABLE', 'PROJECT_LINK_UNRESOLVED', 'GATEWAY_UPGRADE_REQUIRED', 'DISPATCH_PREPARATION_FAILED']);
export function isDefiniteRefusal(code) { return definiteRefusals.has(code); }
/**
 * One confirmation has three possible endings, and the page must not blur them:
 * the user cancelled (nothing sent, the agreement stands), the gateway refused
 * before the hand-off (nothing sent, same identity, correct and re-check), or
 * the hand-off may have happened (identity stays spent, query the original).
 */
export function confirmFailure(error, identity) {
    const code = error?.code, message = error?.message;
    if (code === 'CONFIRMATION_CANCELLED') return { tone: 'info', consumed: false, receipt: false, text: '已在本机确认窗口取消，尚未派工。原约定仍然有效，可以再次打开确认或返回修改。' };
    if (code === 'PLAN_ALREADY_CONSUMED') return { tone: 'error', consumed: true, receipt: false, text: `同一份任务约定已在任务 ${identity.taskId} 上派工，不能换一个任务身份重复提交。结果不明时按操作编号 ${identity.operationId} 查询原请求。` };
    if (isDefiniteRefusal(code)) return { tone: 'error', consumed: false, receipt: false, text: `尚未派工：${message || '准备阶段的核验没有通过'}。已保留原任务与操作编号；返回修改后重新核对即可，不会自动换模型、换档位或重试。` };
    return { tone: 'error', consumed: true, receipt: true, text: `无法确认本次派工是否已经开始：${message || '本地连接中断'}。请按操作编号 ${identity.operationId} 查询原回执或恢复证据，不要重复派工。` };
}
const option = (value, text, disabled = false) => el('option', { value, disabled }, text);
const lineValues = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export async function mountDesktopDispatch({ onTask, onResources = null }) {
    const sheet = document.querySelector('.sheet'), heading = document.querySelector('.heading-tools');
    const open = el('button', { type: 'button', class: 'button dispatch-primary', id: 'new-task', disabled: true, title: '在独立桌面应用中准备任务' }, '新建任务');
    heading.prepend(open);
    let available = false, catalog, draft, busy = false, timer, stage = 'edit', polls = 0, receiptSignature = '', catalogGeneration = 0, catalogLoading = false, editorGeneration = 0;
    /** The chosen remembered identity, the agreement being revised and the one
     * agreement already dispatched. All three survive a catalog refresh so a
     * late response never rewrites a newer decision. */
    let selectedProjectId = null, revising = null, consumedDraftId = null;
    let planReference = null;
    /** The last explanation, whether the desktop host answered the recommendation
     * command at all, whether the user touched the selection, and the digest the
     * explanation was computed from. A host that cannot answer keeps the composer
     * working: the panel degrades to hidden instead of blocking a dispatch. */
    let recommendation = null, recommendationSupported = null, recommendationGeneration = 0, recommendationTimer = null, selectionTouched = false;
    const recommendationBody = el('div', { id: 'recommendation-body' });
    const recommendationRefresh = el('button', { class: 'text-button', id: 'recommendation-refresh', type: 'button', onclick: () => refreshRecommendation(null) }, '评估选择');
    const recommendationPanel = el('section', { class: 'dispatch-recommendation', id: 'recommendation', 'aria-label': '推荐与排除原因' },
        el('h3', {}, '推荐与排除原因'), recommendationRefresh, recommendationBody,
        el('p', { class: 'dispatch-hint' }, '只依据本次约定、当前能力快照与已有统计给出解释；不调用模型、不创建轮次，推荐不等于授权。'));
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
        if(busy&&!catalogLoading){showNotice('请等待原请求返回。若关闭窗口，重新打开后先查询原派工回执。');return;}
        if(catalogLoading){catalogGeneration++;catalogLoading=false;busy=false;sourceChanged();}
        editorGeneration++; clearTimeout(timer); planReference?.reset(); panel.hidden = true; sheet.classList.remove('composing');
        document.getElementById('page-title').textContent = '任务工作台';
        document.querySelector('.page-intro').textContent = '执行有记录，交付有依据。';
        open.focus();
    }
    const isDemo=()=>document.getElementById('data-source')?.value==='demo';
    function sourceChanged() {
        open.disabled=busy||!available||isDemo();open.title=!available||isDemo()?'演示和浏览器模式不能派工；请使用桌面应用的已保存任务':'准备任务约定，核对后在本机确认';
        panel.querySelector('.dispatch-back').disabled=busy&&!catalogLoading;
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
        draft = null; catalog = null; polls = 0; receiptSignature = ''; selectedProjectId = null; revising = null; consumedDraftId = null; showNotice(''); renderEditor();
        busy=true;sourceChanged();
        const saved = (() => { try { return localStorage.getItem(receiptKey); } catch { return null; } })();
        try {const latest=await desktopRequest('latest');const receipt=latest??(saved&&/^[a-f0-9-]{36}$/.test(saved)?await desktopRequest('status',{requestId:saved}):null);if(receipt){renderReceipt(receipt);return;}}
        catch(error){showNotice('无法核对原派工回执。请恢复连接后查询，不会创建新任务。',true);content.replaceChildren(el('button',{class:'button',type:'button',onclick:()=>open.click()},'重新查询原回执'));return;}
        finally{busy=false;sourceChanged();}
        await loadCatalog(); controls.workspace.focus();
    });
    function renderEditor() {
        const editor=++editorGeneration;
        setStage('edit');
        recommendation=null; recommendationBody.replaceChildren(el('p',{class:'dispatch-hint',id:'recommendation-idle'},'填写目标与范围后点「评估选择」，或直接选择执行来源；两者都不会开始派工。'));
        const workspace = field('workspace', '项目文件夹', el('input', { required: true, autocomplete: 'off', placeholder: '已有项目的绝对路径' }), '任务只作用于此目录；原有改动继续受保护。');
        const typedProject = () => { selectedProjectId = null; if (controls.project) controls.project.value = ''; updateProjectNotice(); };
        controls.workspace.addEventListener('input', () => { typedProject(); controls.session.value=''; if(catalog&&controls.model.value) updateSessions(); });
        workspace.append(el('button', { type: 'button', class: 'text-button', onclick: async () => { const prior=controls.workspace.value; try { const selected = await desktopRequest('choose_workspace'); if(editor!==editorGeneration||panel.hidden||controls.workspace.value!==prior)return; if (selected.directory) { controls.workspace.value = selected.directory; typedProject(); controls.session.value=''; if(catalog&&controls.model.value) updateSessions(); } } catch (error) { if(editor===editorGeneration&&!panel.hidden)showNotice(error.message, true); } } }, '选择文件夹'));
        const project = field('project', '已登记项目（可选）', el('select', { onchange: () => selectProject(controls.project.value) }), '从已核验的项目身份中选择；直接填写路径同样有效，预览时会重新核验目录身份。');
        const projectNotice = el('p', { id: 'project-notice', class: 'dispatch-hint', role: 'status', hidden: true });
        const source = field('source', '执行来源', el('select', { required: true, onchange: () => { selectionTouched = true; updateModels(); } }), '读取可用目录不会准备或切换模型。');
        const model = field('model', '精确模型', el('select', { required: true, onchange: () => { selectionTouched = true; updateEfforts(); } }));
        const effort = field('effort', '推理档位', el('select', { required: true, onchange: () => { selectionTouched = true; updateChoice(); } }));
        const session = field('session', 'DSH 原会话', el('select', { onchange: updateChoice }), '选择属于本项目、已连接且空闲的会话；不会自动创建或续接其他会话。'); session.id = 'compose-session-field'; session.hidden = true;
        const main = el('div', { class: 'dispatch-fields' }, el('fieldset', {}, el('legend', {}, '项目与目标'), workspace, project, projectNotice,
            field('title', '任务名称', el('input', { required: true, maxLength: 200, placeholder: '为这次交付起一个明确的名字' })),
            field('objective', '任务目标', el('textarea', { required: true, rows: 4, maxLength: 8000, placeholder: '说明要完成什么，以及完成后应有的行为。' }))),
            el('fieldset', {}, el('legend', {}, '执行选择'), recommendationPanel, el('div', { class: 'dispatch-inline' }, source, model), effort, session,
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
            const generation = editorGeneration, projectId = selectedProjectId, revisingThis = revising;
            busy = true; sourceChanged(); submit.disabled = true; showNotice('正在核对任务约定…');
            try {
                const result = await desktopRequest('preview', { catalogId: catalog.catalogId, modelKey: selectedChoice().key, workspace: projectId ? null : controls.workspace.value.trim(), projectId, title: controls.title.value, objective: controls.objective.value,
                    allowedChanges: lineValues(controls.allowedChanges.value), permittedMetadata: lineValues(controls.permittedMetadata.value), checks: lineValues(controls.checks.value),
                    maxAttempts: Number(controls.maxAttempts.value), timeoutSeconds: Number(controls.timeoutSeconds.value), sessionId: selectedChoice().execution.executorId === 'dsh' ? controls.session.value || null : null,
                    ...(revisingThis ? { draftId: revisingThis.draftId, digest: revisingThis.digest } : {}) });
                // A response for a closed or replaced editor never rewrites what
                // the user is looking at now.
                if (generation !== editorGeneration || panel.hidden) return;
                draft = result; revising = null; renderReview(); showNotice('');
            } catch (error) {
                if (['DRAFT_CHANGED', 'DRAFT_EXPIRED', 'DRAFT_CONSUMED'].includes(error.code)) revising = null;
                if (generation === editorGeneration && !panel.hidden) showNotice(error.message, true);
            } finally { busy = false; sourceChanged(); if (stage === 'edit') updateChoice(); }
        } }, main, aside, el('div', { class: 'dispatch-actions' }, el('span', { class: 'dispatch-hint' }, '任务完成后不会自动标记为已验收。'), submit));
        content.replaceChildren(form); resetSelects(); if (catalog) populateCatalog();
    }
    function resetSelects() { for (const [name, label] of [['source','请选择执行来源'],['model','请先选择来源'],['effort','请先选择模型'],['session','请选择已有会话']]) { controls[name].replaceChildren(option('',label)); controls[name].disabled = true; } }
    async function loadCatalog() {
        if (busy) return;
        const generation=++catalogGeneration; busy = true; catalogLoading=true; sourceChanged(); document.getElementById('preview-task').disabled = true;
        const refresh = document.getElementById('refresh-models'); refresh.disabled = true; showNotice('正在读取可用来源与费率…');
        try {
            const result = await desktopRequest('catalog'); if(generation!==catalogGeneration||panel.hidden)return;
            const previous={source:controls.source.value,model:controls.model.value,effort:controls.effort.value,session:controls.session.value,workspace:controls.workspace.value};
            catalog=result;populateCatalog();
            const exists=(control,value)=>value&&[...control.options].some(item=>item.value===value&&!item.disabled);
            let invalid=false;
            if(exists(controls.source,previous.source)){controls.source.value=previous.source;updateModels();
                if(exists(controls.model,previous.model)){controls.model.value=previous.model;updateEfforts();
                    if(exists(controls.effort,previous.effort))controls.effort.value=previous.effort;else if(previous.effort)invalid=true;
                    if(previous.workspace===controls.workspace.value&&exists(controls.session,previous.session))controls.session.value=previous.session;else if(previous.session)invalid=true;
                }else if(previous.model)invalid=true;
            }else if(previous.source)invalid=true;
            updateChoice(); if(invalid)showNotice('先前选择已失效，请检查来源、模型、档位或会话后重新选择。',true);else if(!selectedChoice()?.blockedReason)showNotice('');
        }
        catch {if(generation===catalogGeneration&&!panel.hidden){catalog=null;resetSelects();showNotice('无法读取来源目录，请检查连接后刷新；尚未派工。',true);}}
        finally {if(generation===catalogGeneration){busy = false; catalogLoading=false;sourceChanged(); refresh.disabled = false; updateChoice();}}
    }
    const sourceStates = { online: '可用', disabled: '未启用', unverified: '未核验', unavailable: '不可用', unknown: '状态未知' };
    /** Per-source rows keep a failed or disabled source visible instead of
     * hiding it, so an empty model list is never mistaken for an empty catalog. */
    function sourceRows() {
        if (Array.isArray(catalog.sources) && catalog.sources.length) return catalog.sources.map(row => ({ key: row.sourceId, label: row.label, state: row.state, reason: row.stateReason, disabled: !row.dispatchable }));
        const groups = new Map(catalog.models.map(model => [sourceKey(model.execution), model.execution]));
        return [...groups].map(([key, e]) => ({ key, label: e.executorId === 'workbuddy' ? 'WorkBuddy · 本机原生来源' : `DSH · ${e.providerId} · ${e.connectionId}`, state: 'online', reason: null, disabled: false }));
    }
    function updateProjectNotice(extra = '') {
        const node = document.getElementById('project-notice'); if (!node) return;
        const projects = catalog?.projects ?? [], chosen = projects.find(item => item.projectId === selectedProjectId) ?? null;
        const messages = [...(catalog?.projectIssues ?? [])];
        if (extra) messages.push(extra);
        if (selectedProjectId && !chosen) messages.push('所选项目登记已不可用，请重新选择文件夹后再核对。');
        if (chosen) messages.push(`已核验项目身份：${chosen.displayName}${chosen.state === 'unverified' ? '（旧登记，预览时会重新核验）' : ''}。`);
        node.replaceChildren(...messages.map(message => el('span', {}, message)));
        node.hidden = !messages.length;
    }
    function populateProjects() {
        if (!controls.project) return updateProjectNotice();
        const projects = catalog?.projects ?? [];
        controls.project.replaceChildren(option('', projects.length ? '选择已登记项目' : '尚无可选项目'), ...projects.map(project => option(project.projectId, `${project.displayName} · ${project.state === 'unverified' ? '待核验' : '已核验'}`)));
        controls.project.disabled = !projects.length;
        const lost = !!selectedProjectId && !projects.some(project => project.projectId === selectedProjectId);
        if (lost) selectedProjectId = null;
        controls.project.value = selectedProjectId ?? '';
        updateProjectNotice(lost ? '先前选择的项目登记已不可用，请重新选择。' : '');
    }
    function selectProject(projectId) {
        const project = (catalog?.projects ?? []).find(item => item.projectId === projectId) ?? null;
        selectedProjectId = project ? project.projectId : null;
        if (project && controls.workspace.value !== project.realPath) {
            controls.workspace.value = project.realPath; controls.session.value = '';
            if (catalog && controls.model.value) updateSessions();
        }
        updateProjectNotice(); updateChoice();
    }
    function populateCatalog() {
        const rows = sourceRows();
        controls.source.replaceChildren(option('', '请选择执行来源'), ...rows.map(row => option(row.key, `${row.label} · ${sourceStates[row.state] ?? '状态未知'}`, row.disabled)));
        controls.source.disabled = !rows.some(row => !row.disabled);
        controls.maxAttempts.max = catalog.policy.maxAttempts; controls.timeoutSeconds.max = catalog.policy.maxTimeoutSeconds;
        document.getElementById('compose-policy').textContent = `当前上限：${catalog.policy.maxAttempts} 轮、${catalog.policy.maxTimeoutSeconds} 秒。原任务的期限不会因重连延长。`;
        document.getElementById('catalog-notices').replaceChildren(...catalog.errors.map(message => el('p', {}, message)),
            ...rows.filter(row => row.state !== 'online' || row.disabled).map(row => el('p', {}, `${row.label}：${row.reason || sourceStates[row.state] || '状态未知'}${row.disabled ? '；当前不可选择' : ''}`)),
            ...(!catalog.models.length ? [el('p', {}, '当前没有可选模型，请检查执行器连接后刷新。')] : []));
        if (!catalog.dispatchEnabled) document.getElementById('catalog-notices').append(el('p', {}, '当前安装仅支持查看和准备任务，派工需先完成网关部署核验。'));
        populateProjects();
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
        updateSessions();
    }
    function updateSessions() {
        const models = catalog.models.filter(m=>sourceKey(m.execution)===controls.source.value&&m.execution.modelId===controls.model.value);
        const executor = models[0]?.execution.executorId;
        const sessions = catalog.sessions.filter(s=>s.hostId===models[0]?.execution.connectionId);
        const project=controls.workspace.value.trim().replace(/[\\/]+$/,'').replaceAll('\\','/').toLowerCase();
        controls.session.replaceChildren(option('','请选择已有会话'),...sessions.map(s=>{const same=project&&s.workspace.replace(/[\\/]+$/,'').replaceAll('\\','/').toLowerCase()===project;const duplicate=sessions.filter(item=>item.sessionId===s.sessionId).length!==1;const state=s.availability??(!s.attached?'disconnected':s.busy?'busy':'idle');const label=duplicate?'身份不唯一':state==='disconnected'?'未连接':state==='busy'?'忙碌':state==='unknown'?'状态未知':same?'当前项目，空闲':project?'目录不同，预览时核验':'请先填写项目';return option(s.sessionId,`${s.sessionId} · ${label}`,duplicate||state!=='idle');}));
        document.getElementById('session-notice')?.remove();
        if(executor==='dsh'&&!sessions.length) document.getElementById('catalog-notices').append(el('p',{id:'session-notice'},'当前宿主没有可选择的会话，请在原应用检查当前项目后刷新。'));
        else if(executor==='dsh'&&project&&!sessions.some(s=>s.workspace.replace(/[\\/]+$/,'').replaceAll('\\','/').toLowerCase()===project)) document.getElementById('catalog-notices').append(el('p',{id:'session-notice'},'没有与输入路径直接一致的会话；请核对项目。目录别名会在预览时核验。'));
        controls.session.disabled = executor !== 'dsh'; document.getElementById('compose-session-field').hidden = executor !== 'dsh'; updateChoice();
    }
    function selectedChoice() { return catalog?.models.find(m=>sourceKey(m.execution)===controls.source.value&&m.execution.modelId===controls.model.value&&(m.execution.reasoningEffort??'__none__')===controls.effort.value); }
    function updateChoice() {
        if(stage !== 'edit')return;
        const choice = selectedChoice(), rate = choice ? rateText(choice) : '请选择完整模型';
        // A different source, model or effort is a different agreement: the
        // original was quoted for another selection, so it is not revised.
        if (revising) {
            const original = revising.execution;
            if (!choice || choice.execution.modelId !== original.modelId || (choice.execution.reasoningEffort ?? null) !== (original.reasoningEffort ?? null) || sourceKey(choice.execution) !== sourceKey(original)) revising = null;
        }
        document.getElementById('compose-rate').textContent = rate; document.getElementById('choice-rate').textContent = rate;
        const hasProject = !!(selectedProjectId || controls.workspace.value.trim());
        const canPreview = choice && !choice.blockedReason && hasProject && (choice.execution.executorId !== 'dsh' || controls.session.value);
        const submit = document.getElementById('preview-task');
        if (submit) { submit.disabled = busy || isDemo() || !canPreview; submit.textContent = revising ? `核对第 ${revising.revision + 1} 版` : '核对任务约定'; }
        if (choice?.blockedReason) showNotice(choice.blockedReason,true);
        scheduleRecommendation();
    }
    const isUnsupportedRecommendation = error => /unsupported desktop (command|action)/i.test(String(error?.message || ''));
    const effortSuffix = execution => execution.reasoningEffort ? ` · ${execution.reasoningEffort}` : '';
    const resourceLabel = status => ({ fresh: '资源引用新鲜', stale: '资源引用已过期', unavailable: '无可用资源引用', unverified_claim: '声明关联未被核实' }[status] || '无可用资源引用');
    const candidateText = item => `${item.sourceLabel} / ${item.selection.modelId}${effortSuffix(item.selection)} · ${item.cost.label} · ${resourceLabel(item.resources.status)}`;
    /** The intent and the explicit selection are read from the fields exactly as
     * the user typed them; the panel never invents a scope or a preference. */
    function intentFromForm() {
        const choice = selectedChoice();
        return { title: controls.title.value.trim(), objective: controls.objective.value.trim(),
            allowedChanges: lineValues(controls.allowedChanges.value), permittedMetadata: lineValues(controls.permittedMetadata.value), checks: lineValues(controls.checks.value),
            maxAttempts: Number(controls.maxAttempts.value) || 1, timeoutSeconds: Number(controls.timeoutSeconds.value) || 600,
            sessionId: choice && choice.execution.executorId === 'dsh' && controls.session.value ? controls.session.value : null };
    }
    function constraintsFromForm() { const choice = selectedChoice(); return selectionTouched && choice ? { selection: choice.execution } : {}; }
    async function readStatisticsSample() {
        try { const response = await fetch('/workbench/v1/statistics?limit=20', { signal: AbortSignal.timeout(15000) }); if (!response.ok) return null; const doc = await response.json(); return doc && doc.schemaVersion ? doc : null; } catch { return null; }
    }
    async function readResourceReference(execution) {
        const query = new URLSearchParams({ executorId: execution.executorId, connectionId: execution.connectionId, providerId: execution.providerId, modelId: execution.modelId });
        if (execution.reasoningEffort) query.set('reasoningEffort', execution.reasoningEffort);
        try { const response = await fetch('/workbench/v1/resources/plan-reference?' + query, { signal: AbortSignal.timeout(15000) }); if (!response.ok) return null; const doc = await response.json(); return doc && doc.schemaVersion ? doc : null; } catch { return null; }
    }
    function renderRecommendation(result) {
        recommendationPanel.hidden = false;
        const recommended = result.recommended;
        const head = result.decision === 'direct' ? '建议直接处理' : result.decision === 'wait' ? '暂不派工' : '建议交给执行器';
        const reasons = recommended ? recommended.reasons.map(item => el('li', {}, item.message)) : [el('li', {}, result.decisionReason.message)];
        const candidates = result.candidates.slice(0, 8).map(item => el('li', {},
            el('span', {}, `${candidateText(item)} · ${item.reasons.slice(0, 2).map(reason => reason.message).join('；')}`),
            el('button', { class: 'text-button', type: 'button', onclick: () => applySelection(item.selection) }, '采用此候选')));
        recommendationBody.replaceChildren(
            el('p', { class: 'dispatch-rate', id: 'recommendation-decision' }, recommended ? `${head} · ${candidateText(recommended)}` : `${head} · ${result.decisionReason.message}`),
            el('ul', { class: 'dispatch-hint', id: 'recommendation-why' }, reasons, el('li', {}, `判定编号：${[result.decisionReason.code, ...result.decisionReason.codes].join('、')}`)),
            el('ul', { class: 'dispatch-recommendation-list', id: 'recommendation-candidates' }, candidates),
            result.excluded.length ? el('p', { class: 'dispatch-hint', id: 'recommendation-excluded' }, `排除 ${result.excluded.length} 项：${result.excluded.slice(0, 3).map(item => `${item.sourceLabel}/${item.selection.modelId}：${item.message}`).join('；')}`) : null,
            el('ul', { class: 'dispatch-hint', id: 'recommendation-missing' }, result.missing.map(item => el('li', {}, `${item.severity === 'blocks' ? '阻断' : '局限'} · ${item.message}`))),
            el('p', { class: 'dispatch-hint', id: 'recommendation-history' }, result.history.status === 'unavailable'
                ? `历史统计：不可用（${result.history.code}）；样本量与时间窗未知，不据此推断质量。`
                : `历史统计：${result.history.status === 'partial' ? '仅部分覆盖' : '可用'} · 样本 ${result.history.sampleSize ?? '未知'} 项 · 时间窗 ${result.history.window ? `${result.history.window.from ?? '未限定'} 至 ${result.history.window.to ?? '现在'}` : '未知'}`),
            el('p', { class: 'dispatch-hint', id: 'recommendation-limitations' }, `局限：${result.limitations.join('、')}`),
            result.drift && result.drift.codes.length ? el('p', { class: 'dispatch-hint is-error', id: 'recommendation-drift' }, `与上次评估不同：${result.drift.message}`) : null,
            el('p', { class: 'technical', id: 'recommendation-digest' }, `评估 ${result.digest.slice(0, 16)} · 快照 ${result.catalog.catalogId || '未知'}${result.catalog.fresh ? '' : '（已过期）'}`));
    }
    function applySelection(execution) {
        selectionTouched = true;
        controls.source.value = sourceKey(execution); updateModels();
        controls.model.value = execution.modelId; updateEfforts();
        controls.effort.value = execution.reasoningEffort ?? '__none__';
        updateChoice();
        showNotice(`已改用 ${execution.modelId}${effortSuffix(execution)}；仍需核对约定并在本机确认，推荐本身不授权。`);
    }
    /**
     * One explanation per snapshot: the catalog answer, the statistics window and
     * the documented resource references are read, then the same pure evaluator
     * runs again with them attached. A host without the command hides the panel
     * and leaves the existing composer untouched.
     */
    async function refreshRecommendation(previous) {
        if (recommendationSupported === false || !available || isDemo() || stage !== 'edit') return;
        const generation = ++recommendationGeneration;
        const parameters = { intent: intentFromForm(), constraints: constraintsFromForm() };
        if (previous) parameters.previous = previous;
        const statistics = await readStatisticsSample();
        if (generation !== recommendationGeneration || panel.hidden) return;
        if (statistics) parameters.statistics = statistics;
        let result;
        try { result = await desktopRequest('recommend', parameters); }
        catch (error) {
            if (isUnsupportedRecommendation(error)) { recommendationSupported = false; recommendationPanel.hidden = true; return; }
            if (generation === recommendationGeneration && !panel.hidden) showNotice(`推荐未能生成：${error.message}`, true);
            return;
        }
        if (generation !== recommendationGeneration || panel.hidden) return;
        // A host that answers with nothing has not implemented the command; the
        // panel disappears instead of reporting an empty evaluation.
        if (!result || !Array.isArray(result.candidates)) { recommendationSupported = false; recommendationPanel.hidden = true; return; }
        const documents = [];
        for (const item of result.candidates.slice(0, 5)) { const doc = await readResourceReference(item.selection); if (doc) documents.push(doc); }
        if (documents.length && generation === recommendationGeneration) {
            try {
                const refined = await desktopRequest('recommend', { ...parameters, resources: documents });
                if (generation === recommendationGeneration) result = refined;
            } catch { /* the first answer stands; resources stay named as missing */ }
        }
        if (generation !== recommendationGeneration || panel.hidden) return;
        recommendation = result; renderRecommendation(result);
    }
    function scheduleRecommendation() {
        if (recommendationSupported === false || !available || isDemo() || stage !== 'edit') return;
        clearTimeout(recommendationTimer);
        recommendationTimer = setTimeout(() => { void refreshRecommendation(null); }, 400);
    }
    function renderReview() {
        setStage('review');
        const c = draft.contract, e = c.execution;
        const list = (title, values, empty) => el('section', { class: 'dispatch-review-section' }, el('h3',{},title), values.length?el('ul',{},values.map(value=>el('li',{},value))):el('p',{class:'dispatch-hint'},empty));
        const grid = el('div',{class:'dispatch-grid'},el('div',{class:'dispatch-review'},el('h2',{},c.title),el('p',{class:'dispatch-objective'},c.objective),
            el('p',{class:'dispatch-hint',id:'revision-note'},`第 ${draft.revision} 版任务约定 · 确认时会重新核验项目身份、费率与政策；失败会明确提示，不会静默替换。`),
            el('dl',{class:'dispatch-facts'},el('dt',{},'项目'),el('dd',{},draft.workspace.realPath),el('dt',{},'执行来源'),el('dd',{},`${e.executorId} / ${e.connectionId} / ${e.providerId}`),el('dt',{},'精确模型'),el('dd',{},e.modelId),el('dt',{},'推理档位'),el('dd',{},e.reasoningEffort??'未提供'),...(draft.sessionId?[el('dt',{},'原会话'),el('dd',{},draft.sessionId)]:[])),
            list('允许修改范围',c.scope.allowedChanges,'只读，不授予文件写权限。'),list('允许的元数据',c.scope.permittedMetadata,'无额外元数据写权限。'),list('独立验收要求',c.requiredChecks.map(check=>check.definition),''),
            el('details', {class:'dispatch-advanced'},el('summary',{},'任务标识'),el('p',{class:'technical'},draft.taskId),el('p',{class:'technical'},draft.operationId),el('p',{class:'technical'},draft.digest))),el('div',{class:'dispatch-resource-slot',id:'plan-resource-slot'}),
            el('aside',{class:'dispatch-summary'},el('h2',{},'确认前核对'),el('p',{class:'dispatch-rate'},rateText(draft.quote)),el('p',{},`最多 ${c.maxAttempts} 轮 · 时限 ${c.timeoutSeconds} 秒`),el('p',{class:'dispatch-hint'},'时限不是费用上限。费率为读取时的信息，未知费率可能产生费用。'),el('p',{class:'dispatch-hint'},'将在本机确认窗口显示完整约定。勾选同意并确认后才开始派工。'),el('p',{class:'dispatch-hint'},`本约定有效至 ${new Date(draft.expiresAt).toLocaleTimeString()}`)),
            el('div',{class:'dispatch-actions'},el('button',{class:'button',type:'button',onclick:()=>{
                const previous=draft;draft=null;planReference?.reset();renderEditor();
                selectedProjectId=previous.projectId??null;if(catalog)populateProjects();
                for(const name of ['title','objective','maxAttempts','timeoutSeconds'])controls[name].value=String(previous.contract[name]);
                controls.workspace.value=previous.workspace.realPath;controls.allowedChanges.value=previous.contract.scope.allowedChanges.join('\n');controls.permittedMetadata.value=previous.contract.scope.permittedMetadata.join('\n');controls.checks.value=previous.contract.requiredChecks.map(c=>c.definition).join('\n');
                controls.source.value=sourceKey(previous.contract.execution);updateModels();controls.model.value=previous.contract.execution.modelId;updateEfforts();controls.effort.value=previous.contract.execution.reasoningEffort??'__none__';controls.session.value=previous.sessionId??'';updateChoice();
                // The task identity and its revision chain survive going back:
                // the next review is the same task, quoted again for its new scope.
                revising={draftId:previous.draftId,digest:previous.digest,revision:previous.revision,execution:previous.contract.execution};
                const submit=document.getElementById('preview-task');if(submit)submit.textContent=`核对第 ${previous.revision+1} 版`;
                showNotice(`已保留原任务身份；再次核对会生成第 ${previous.revision+1} 版，确认前会重新核验费率与政策。`);
            }},'返回修改'),el('button',{class:'button dispatch-primary',id:'confirm-task',type:'button',disabled:!catalog.dispatchEnabled||consumedDraftId===draft.draftId,onclick:confirm},'打开派工确认')));
        content.replaceChildren(grid); content.querySelector('h2').setAttribute('tabindex','-1');content.querySelector('h2').focus();
        const slot=document.getElementById('plan-resource-slot');
        if(slot){
            if(!planReference)planReference=mountPlanReference(slot,{onOpenResources:onResources?()=>{close();onResources();}:null});
            else slot.append(planReference.element);
            planReference.setExecution({executorId:e.executorId,connectionId:e.connectionId,providerId:e.providerId,modelId:e.modelId,reasoningEffort:e.reasoningEffort??null},draft.draftId+':'+draft.digest);
        }
        if(!catalog.dispatchEnabled)showNotice('当前安装仅支持查看和准备任务，尚未启用派工。');
    }
    async function confirm() {
        if(busy||!draft||isDemo())return;
        const {draftId,digest}=draft;
        if(consumedDraftId===draftId){showNotice(`本方案已提交派工，不能再次确认。结果不明时请按操作编号 ${draft.operationId} 查询原回执，不会重复派工。`,true);return;}
        if(recommendation){
            // The explanation the user read must still match the snapshot; a
            // changed catalog or policy waits for a new review instead of
            // dispatching on an outdated reason.
            try{
                const check=await desktopRequest('recommend',{intent:intentFromForm(),constraints:constraintsFromForm(),previous:{digest:recommendation.digest,catalogId:recommendation.catalog.catalogId,policyVersion:recommendation.policy.version,selection:recommendation.recommended?.selection??null}});
                if(check.drift&&check.drift.blockedForDispatch){showNotice(`能力快照或政策已变化（${check.drift.codes.join('、')}）；请返回修改后重新核对，不会按旧解释派工。`,true);return;}
            }catch(error){
                if(isUnsupportedRecommendation(error)){recommendationSupported=false;recommendationPanel.hidden=true;}
                else showNotice('未能重新核对推荐；仍按已核对的约定继续，未按推荐派工。');
            }
        }
        busy=true;sourceChanged();const button=document.getElementById('confirm-task');button.disabled=true;showNotice('请在本机确认窗口核对，尚未派工。');
        try {
            try {localStorage.setItem(receiptKey,draftId);}catch{}
            const receipt=await desktopRequest('dispatch',{draftId,digest});
            // One agreement, one dispatch: the confirmation stays spent even if
            // the returned receipt is later found to be uncertain.
            consumedDraftId=draftId;renderReceipt(receipt);showNotice('');
        } catch(error){
            const outcome=confirmFailure(error,{taskId:draft.taskId,operationId:draft.operationId});
            if(!outcome.consumed){try{localStorage.removeItem(receiptKey);}catch{}}
            // A hand-off that may have happened spends the confirmation even
            // when no readable receipt came back: the page keeps the request
            // identity and offers queries instead of a second confirm.
            if(outcome.consumed)consumedDraftId=draftId;
            if(outcome.receipt)renderReceipt({requestId:draftId,taskId:draft.taskId,operationId:draft.operationId,state:'outcome_unknown',message:outcome.text});
            else showNotice(outcome.text,outcome.tone==='error');
        }
        finally{busy=false;sourceChanged();if(stage==='review')button.disabled=!catalog.dispatchEnabled||isDemo()||consumedDraftId===draft.draftId;}
    }
    function renderReceipt(receipt) {
        setStage('receipt');clearTimeout(timer);
        document.getElementById('page-title').textContent='派工回执';document.querySelector('.page-intro').textContent='按原任务编号查询，连接恢复后继续核对。';
        open.textContent='派工回执';
        const signature=JSON.stringify(receipt),unchanged=receiptSignature===signature;receiptSignature=signature;
        if(!unchanged)content.replaceChildren(el('div',{class:'dispatch-receipt'},el('h2',{tabIndex:-1,role:'status'},receiptStatusText(receipt.state)),el('p',{},receipt.message||(receipt.state==='submitted'?'受理回执不代表验收结果，请查看任务详情。':'请求登记不代表原生接单，请保留以下编号。')),
            el('dl',{class:'dispatch-facts'},el('dt',{},'任务编号'),el('dd',{class:'technical'},receipt.taskId),el('dt',{},'操作编号'),el('dd',{class:'technical'},receipt.operationId)),
            ...(receipt.state==='failed'&&receipt.retryable?[el('section',{'aria-label':'尚未派工的失败'},
                el('h3',{},'尚未派工，可修正后重新核对'),
                el('p',{},'这次核验在交给执行器之前就结束了：没有轮次、没有提示词、没有占用执行容量。'),
                el('p',{},'原任务与操作编号保持不变；修正后重新核对会生成新一版约定，不会自动换模型或换档位。'),
                ...(draft&&draft.draftId===receipt.requestId?[el('div',{class:'dispatch-actions'},el('button',{type:'button',class:'button',onclick:()=>renderReview()},'回到约定核对'))]:[]))]:[]),
            el('div',{class:'dispatch-actions'},el('button',{type:'button',class:'button',onclick:()=>queryReceipt(receipt.requestId)},'查询原请求'),
                ...(receipt.state==='submitted'?[el('button',{type:'button',class:'button',onclick:async event=>{event.currentTarget.disabled=true;showNotice('正在观察原执行状态，不会派工或改变模型…');try{await desktopRequest('observe',{requestId:receipt.requestId});close();await onTask(receipt.taskId);}catch(error){showNotice(error.message,true);}finally{event.target.disabled=false;}}},'更新执行状态')]:[]),
                el('button',{type:'button',class:'button dispatch-primary',onclick:async()=>{close();await onTask(receipt.taskId);}},'查看已保存任务')),
            ...(receipt.state==='outcome_unknown'?[el('section',{'aria-label':'结果不明时的处理'},
                el('h3',{},'保留原请求，先核对证据'),
                el('p',{},'目前无法确认原生准备或执行是否结束。没有轮次记录、没有回执或等待较长时间，都不能证明没有副作用。'),
                el('p',{},'原任务可能仍占用执行容量。请使用原操作编号查看恢复证据；能否恢复或关闭由后端根据证据判断。不要更换任务或会话重复派工。'),
                el('div',{class:'dispatch-actions'},...(typeof receipt.operationId==='string'&&receipt.operationId?[el('button',{type:'button',class:'button',onclick:event=>void showRecovery(receipt.operationId,event.currentTarget)},'查看恢复证据')]:[])))]:[]),
            el('p',{class:'dispatch-hint'},'连接中断不会自动重派。报告收到不代表原生停止或独立验收通过。'),
            ...(['submitted','failed'].includes(receipt.state)?[el('button',{class:'text-button',type:'button',onclick:async()=>{try{localStorage.removeItem(receiptKey);}catch{}document.getElementById('page-title').textContent='新建任务';document.querySelector('.page-intro').textContent='先明确约定，再启动执行。';open.textContent='新建任务';receiptSignature='';polls=0;renderEditor();showNotice('新派工仍须满足原任务的共享容量与停止规则。');await loadCatalog();}},'准备另一项任务')]:[])));
        if(receiptStillPending(receipt.state)){if(polls++<45)timer=setTimeout(()=>queryReceipt(receipt.requestId),2000);else showNotice('已停止自动刷新，结果仍未知。没有回执不等于没有副作用：请按操作编号核对恢复证据，不要重复派工。',true);}
    }
    async function showRecovery(identity,button) {
        button.disabled=true;
        try {const evidence=await desktopRequest('recovery_show',{identity});button.replaceWith(recoveryFacts(evidence));}
        catch(error){button.disabled=false;showNotice(error.message,true);}
    }
    function recoveryFacts(evidence) {
        const rows=[['原操作状态',evidence?.state?operationStateLabel(evidence.state):'无操作记录'],
            ['是否进入准备',evidence?.preparationEnteredAt?'已进入':'无记录'],
            ['是否进入派工',evidence?.dispatchEnteredAt?'已进入':'无记录'],
            ['派工请求状态',evidence?.dispatch?receiptStatusText(evidence.dispatch.state):'无记录'],
            ['派工租约',leaseLabel(evidence?.dispatch)],
            ['执行容量',evidence?.capacityHoldsOperation?'仍由原任务占用':'未占用'],
            ['结论',recoveryConclusionText(evidence?.conclusion)]];
        const list=el('dl',{class:'dispatch-facts'});
        for(const [term,value] of rows)list.append(el('dt',{},term),el('dd',{},value));
        return list;
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
