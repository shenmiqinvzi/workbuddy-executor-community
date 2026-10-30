import {desktopExact} from '../dist/desktop-dispatch.js';

// Private parent/child transport only. Nothing is registered on the HTTP server.
export function desktopCommandHandler(session) {
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
        throw Error('Unsupported desktop command.');
    };
}
export function installDesktopCommands(session, input = process.stdin, output = process.stdout) {
    const handle = desktopCommandHandler(session);
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
