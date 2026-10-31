import {desktopExact} from '../dist/desktop-dispatch.js';

// Private parent/child transport only. Nothing is registered on the HTTP server.
export function desktopCommandHandler(session, controls = null) {
    return async (method, parameters) => {
        if (method === 'catalog') { desktopExact(parameters, []); return session.catalog(); }
        if (method === 'latest') { desktopExact(parameters, []); return session.latest(); }
        if (method === 'preview') return session.preview(parameters);
        if (method === 'review' || method === 'commit') {
            desktopExact(parameters, ['draftId', 'digest']);
            if (typeof parameters.draftId !== 'string' || typeof parameters.digest !== 'string') throw Error('Invalid draft identity.');
            return method === 'review' ? session.review(parameters.draftId, parameters.digest) : session.commit(parameters.draftId, parameters.digest);
        }
        if (method === 'status' || method === 'observe') { desktopExact(parameters, ['requestId']); if (typeof parameters.requestId !== 'string') throw Error('Invalid receipt identity.'); return method === 'status' ? session.receipt(parameters.requestId) : session.observe(parameters.requestId); }
        if (controls && method === 'control_preview') return controls.preview(parameters);
        if (controls && method === 'control_requirements') return controls.requirements(parameters);
        if (controls && (method === 'control_review' || method === 'control_commit')) {
            desktopExact(parameters,['requestId','digest']);
            if(typeof parameters.requestId!=='string'||typeof parameters.digest!=='string')throw Error('Invalid control identity.');
            return method==='control_review'?controls.review(parameters.requestId,parameters.digest):controls.commit(parameters.requestId,parameters.digest);
        }
        if (controls && method === 'control_status') { desktopExact(parameters,['requestId']);if(typeof parameters.requestId!=='string')throw Error('Invalid control identity.');return controls.receipt(parameters.requestId); }
        if (controls && (method === 'control_list' || method === 'control_observe')) { desktopExact(parameters,['taskId','attemptId']);if(typeof parameters.taskId!=='string'||typeof parameters.attemptId!=='string'||parameters.taskId.length>200||parameters.attemptId.length>200)throw Error('Invalid task identity.');return method==='control_list'?controls.forAttempt(parameters.taskId,parameters.attemptId):controls.observe(parameters.taskId,parameters.attemptId); }
        throw Error('Unsupported desktop command.');
    };
}
export function installDesktopCommands(session, input = process.stdin, output = process.stdout, controls = null) {
    const handle = desktopCommandHandler(session, controls);
    let pending = 0, buffer = '', dropping = false;
    input.setEncoding('utf8');
    async function receive(line) {
        let id;
        try {
            if (Buffer.byteLength(line) > 70_000) throw Error('Desktop input exceeded its bound.');
            const message = JSON.parse(line); desktopExact(message, ['id', 'method', 'parameters']);
            if (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) throw Error('Invalid command identity.');
            id = message.id;
            if(pending>=8)throw Object.assign(new Error('请等待原请求完成后再查询。'),{name:'AdmissionError',code:'DESKTOP_BUSY'});
            pending++;
            try {
                const value = await handle(message.method, message.parameters);
                const reply = JSON.stringify({event:'desktop_command_result',id,ok:true,value});
                if (Buffer.byteLength(reply)>1_000_000) throw Error('Desktop result exceeded its bound.');
                output.write(reply+'\n');
            } finally {pending--;}
        } catch (error) {
            output.write(JSON.stringify({event:'desktop_command_result',id:id??null,ok:false,error:{code:typeof error.code==='string'?error.code:'DESKTOP_COMMAND_FAILED',message:error.name==='AdmissionError'?error.message:'无法完成本次操作。请保留原任务编号，检查连接后再查询。'}})+'\n');
        }
    }
    input.on('data', chunk => {
        for (const part of chunk.split(/(?<=\n)/)) {
            if (!dropping) buffer += part;
            if (Buffer.byteLength(buffer)>70_000) {buffer='';dropping=true;}
            if (part.endsWith('\n')) {if(!dropping)void receive(buffer.trimEnd());buffer='';dropping=false;}
        }
    });
}
