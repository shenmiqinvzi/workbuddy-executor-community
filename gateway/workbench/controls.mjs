import {desktopRequest} from './dispatch.mjs';
import {currentReview} from './model.mjs';

const labels={cancel:'请求停止',rework:'提交返工',review:'开始独立审查',accept:'确认验收'};
const messages={requested:'操作已登记，正在启动。',started:'操作已启动，结果待确认；可更新原任务状态。',outcome_unknown:'结果尚未明确。请更新原任务状态，勿重复提交。',rejected:'操作未通过当前状态核验，请刷新后重新核对。'};
const el=(tag,props={},...children)=>{const node=document.createElement(tag);for(const [key,value] of Object.entries(props)){if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(key==='class')node.className=value;else if(key==='hidden')node.hidden=Boolean(value);else if(key==='disabled')node.disabled=Boolean(value);else node.setAttribute(key,String(value));}for(const child of children.flat())if(child!==null&&child!==undefined)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;};

export function controlCandidates(record) {
    const view=record?.view, attempt=view?.attempt, review=currentReview(record), state=view?.businessState;
    if(!view?.revision||!attempt?.id)return [];
    const result=[];
    if(['queued','working'].includes(state)&&view.remoteStopped!==true)result.push('cancel');
    if(['needs_review','blocked'].includes(state)&&view.remoteStopped===true&&Number.isInteger(attempt.number)&&Number.isInteger(attempt.limit)&&attempt.number<attempt.limit)result.push('rework');
    if(state==='needs_review'&&view.remoteStopped===true&&(!review||review.committedRevision!==view.revision||review.checks?.some(check=>check.status!=='passed'||check.actor==='worker')))result.push('review');
    if(state==='needs_review'&&view.remoteStopped===true&&review?.checks?.length&&review.checks.every(check=>check.status==='passed'&&check.actor!=='worker'))result.push('accept');
    return result;
}

/** The host remains authoritative; these are candidate controls, not grants. */
export function renderDesktopControls(record,{refresh}) {
    const view=record.view, taskId=record.taskId, attemptId=view.attempt.id, revision=view.revision;
    const candidates=controlCandidates(record), review=currentReview(record);
    const root=el('section',{class:'task-controls','aria-label':'任务操作'});
    const heading=el('h3',{},'任务操作');
    const note=el('p',{class:'task-controls-note'},'操作前会再次核对当前轮次和任务状态。');
    const status=el('p',{class:'task-controls-status',role:'status','aria-live':'polite'});
    const actions=el('div',{class:'task-control-actions'});
    const feedback=el('textarea',{id:'control-feedback',rows:'3',maxlength:'4000',placeholder:'说明需要修正的问题和验收标准'});
    const feedbackSubmit=el('button',{class:'button dispatch-primary task-control-submit',type:'button',onclick:()=>void submit('rework')},'核对返工');
    const feedbackPanel=el('div',{class:'task-control-feedback',hidden:true},el('label',{for:'control-feedback'},'返工要求'),feedback,feedbackSubmit);
    const reviewPanel=el('div',{class:'task-control-review',hidden:true}),reviewNote=el('textarea',{id:'control-review-note',rows:'3',maxlength:'4000',placeholder:'说明你实际检查的内容与结果'}),reviewFiles=el('textarea',{id:'control-review-files',rows:'3',placeholder:'例如 src/example.js，每行一个项目内文件'}),requirementsList=el('div',{class:'task-control-requirements'});
    const reviewSubmit=el('button',{class:'button dispatch-primary task-control-submit',type:'button',onclick:()=>void submit('review')},'核对独立审查');
    reviewPanel.append(el('p',{class:'task-controls-note'},'请先在项目中阅读实际交付文件并完成必要检查，再逐项记录真实判断。原约定中的命令会在确认后运行。'),requirementsList,el('label',{for:'control-review-files'},'已检查文件（每行一个）'),reviewFiles,el('label',{for:'control-review-note'},'独立检查说明'),reviewNote,reviewSubmit);
    const buttons=new Map();let busy=false,receipts=[],requirements=[],observeButton;
    function setBusy(value){busy=value;for(const [kind,button] of buttons)button.disabled=value||receipts.some(r=>r.kind===kind&&r.state!=='rejected'&&(kind!=='review'||r.state!=='succeeded'||r.revision===revision));feedback.disabled=value;feedbackSubmit.disabled=value||Boolean(buttons.get('rework')?.disabled);reviewSubmit.disabled=value||Boolean(buttons.get('review')?.disabled);reviewPanel.querySelectorAll('textarea,select').forEach(control=>control.disabled=value);if(observeButton)observeButton.disabled=value;}
    function describe(receipt) {
        if(receipt.state==='succeeded')return receipt.kind==='cancel'?(view.remoteStopped===true?'原生停止已确认。':'停止请求已提交，更新执行状态以确认原生停止。'):receipt.kind==='rework'?'返工请求已提交，请更新执行状态。':receipt.kind==='review'?'独立审查已保存，请查看检查结果。':'验收操作已提交，请刷新任务查看结果。';
        return receipt.message||messages[receipt.state]||'操作状态待核查。';
    }
    async function loadReceipts() {
        try {receipts=await desktopRequest('control_list',{taskId,attemptId});if(!root.isConnected)return;setBusy(busy);if(receipts.length)status.textContent=describe(receipts[0]);}
        catch(error){if(root.isConnected)status.textContent=error.message||'回执暂不可用，请稍后刷新。';}
    }
    async function observe() {
        if(busy)return;
        setBusy(true);status.textContent='正在更新原任务状态…';
        try {await desktopRequest('control_observe',{taskId,attemptId});await refresh(taskId);}
        catch(error){status.textContent=error.message||'状态更新失败，请稍后重试。';}
        finally {if(root.isConnected)setBusy(false);}
    }
    async function poll(requestId) {
        for(let count=0;count<30&&root.isConnected;count++) {
            await new Promise(resolve=>setTimeout(resolve,2000));if(!root.isConnected)return;
            try {const receipt=await desktopRequest('control_status',{requestId});if(!receipt)throw Error('原回执暂不可用。');status.textContent=describe(receipt);if(!['requested','started'].includes(receipt.state)){await loadReceipts();if(receipt.state==='succeeded')await refresh(taskId);return;}}
            catch(error){status.textContent=error.message||'回执暂不可用，请稍后查询。';return;}
        }
        if(root.isConnected)status.textContent='操作仍在处理中。可稍后更新原任务状态。';
    }
    async function submit(kind) {
        if(busy)return;
        if(kind==='rework'&&!feedback.value.trim()){feedback.focus();status.textContent='请填写具体返工要求。';return;}
        if(kind==='review'&&!reviewNote.value.trim()){reviewNote.focus();status.textContent='请填写实际独立检查说明。';return;}
        const inspectionFiles=kind==='review'?reviewFiles.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean):null;
        const semanticChecks=kind==='review'?[...requirementsList.querySelectorAll('select')].map(select=>({checkId:select.dataset.checkId,status:select.value})):null;
        if(kind==='review'&&semanticChecks.some(check=>!check.status)){status.textContent='请逐项选择真实的验收结果。';return;}
        if(kind==='review'&&semanticChecks.length&&!inspectionFiles.length){reviewFiles.focus();status.textContent='请填写实际检查的项目文件。';return;}
        setBusy(true);status.textContent='正在核对当前任务…';
        try {
            const preview=await desktopRequest('control_preview',{kind,taskId,attemptId,revision,feedback:kind==='rework'?feedback.value.trim():kind==='review'?reviewNote.value.trim():null,reviewId:kind==='accept'?review.reviewId:null,inspectionFiles,semanticChecks});
            const receipt=await desktopRequest('control',{requestId:preview.draft.requestId,digest:preview.digest});
            status.textContent=describe(receipt);await loadReceipts();if(['requested','started'].includes(receipt.state))void poll(receipt.requestId);
        } catch(error){status.textContent=error.code==='CONFIRMATION_CANCELLED'?'操作已取消，任务没有改变。':error.message||'操作未完成，请查询原任务。';}
        finally {if(root.isConnected)setBusy(false);}
    }
    async function prepareReview() {
        if(busy)return;setBusy(true);status.textContent='正在读取原验收要求…';
        try {
            const snapshot=await desktopRequest('control_requirements',{taskId,attemptId,revision});requirements=snapshot.requirements;
            requirementsList.replaceChildren();
            for(const check of requirements){
                const row=el('div',{class:'task-control-requirement'},el('p',{},check.definition));
                if(check.kind==='semantic'){
                    const select=el('select',{'aria-label':'验收结果：'+check.definition},el('option',{value:''},'请选择实际结果'),el('option',{value:'passed'},'通过'),el('option',{value:'failed'},'未通过'),el('option',{value:'unknown'},'无法判断'));
                    select.dataset.checkId=check.id;row.append(select);
                }else row.append(el('p',{class:'task-controls-note'},'确认后执行此原约定命令。'));
                requirementsList.append(row);
            }
            reviewPanel.hidden=false;feedbackPanel.hidden=true;status.textContent='请完成独立检查后填写结果。';reviewNote.focus();
        }catch(error){status.textContent=error.message||'无法读取原验收要求，请刷新任务。';}
        finally{if(root.isConnected)setBusy(false);}
    }
    for(const kind of candidates){
        const button=el('button',{class:'button task-control-button',type:'button',onclick:()=>{if(kind==='rework'&&feedbackPanel.hidden){feedbackPanel.hidden=false;reviewPanel.hidden=true;feedback.focus();return;}if(kind==='review'&&reviewPanel.hidden){void prepareReview();return;}void submit(kind);}},labels[kind]);
        buttons.set(kind,button);actions.append(button);
    }
    if(view.remoteStopped!==true){observeButton=el('button',{class:'text-button task-control-observe',type:'button',onclick:()=>void observe()},'更新执行状态');actions.append(observeButton);}
    root.append(heading,note,actions,feedbackPanel,reviewPanel,status);
    queueMicrotask(()=>{if(root.isConnected)void loadReceipts();});
    return root;
}
