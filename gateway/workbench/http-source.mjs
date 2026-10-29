import { validateRecord } from './model.mjs';
export class SourceError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
export class HttpSource {
    constructor(fetcher = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher; this.kind = 'live'; }
    async read(path, signal) {
        const response = await this.fetcher(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        let body;
        try {
            body = await response.json();
        }
        catch {
            throw new SourceError('INVALID_RESPONSE', '网关返回了无法读取的数据。');
        }
        if (!response.ok)
            throw new SourceError(body.error?.code || 'HTTP_ERROR', body.error?.message || '读取请求失败。');
        return body;
    }
    async health(signal) { const body = await this.read('/workbench/v1/health', signal); if (body.schemaVersion !== 'workbuddy-executor/stage-2' || typeof body.ready !== 'boolean')
        throw new SourceError('UNSUPPORTED_SCHEMA', '健康信息版本不受支持。'); return body; }
    async list(cursor, signal) {
        const body = await this.read('/workbench/v1/panel/tasks?limit=50' + (cursor ? '&afterTaskId=' + encodeURIComponent(cursor) : ''), signal);
        if (body.schemaVersion !== 'workbuddy-executor/panel-1' || !Array.isArray(body.tasks) || !(body.nextAfterTaskId === null || typeof body.nextAfterTaskId === 'string'))
            throw new SourceError('UNSUPPORTED_SCHEMA', '此网关尚未提供 panel-1 只读视图。请核对运行版本。');
        body.tasks = body.tasks.map(item => validateRecord(item) || item?.ok === false && typeof item.taskId === 'string' ? item : { ok: false, taskId: typeof item?.taskId === 'string' ? item.taskId : 'unknown-record', code: 'INVALID_RECORD', message: '任务数据结构不完整。' });
        return body;
    }
    async task(id, signal) { const body = await this.read('/workbench/v1/panel/tasks/' + encodeURIComponent(id), signal); if (!validateRecord(body) || !Array.isArray(body.reviews) || body.schemaVersion !== 'workbuddy-executor/panel-1' || body.taskId !== id)
        throw new SourceError('INVALID_RECORD', '任务详情与请求身份不一致。'); return body; }
    async events(id, after = 0, signal) { const body = await this.read('/workbench/v1/tasks/' + encodeURIComponent(id) + '/events?limit=100&afterEventId=' + after, signal); if (!Array.isArray(body.events) || !Number.isSafeInteger(body.nextEventId) || body.nextEventId < after || !body.events.every(e => e && e.taskId === id && Number.isSafeInteger(e.eventId) && e.eventId > after && e.eventId <= body.nextEventId && typeof e.type === 'string'))
        throw new SourceError('INVALID_EVENTS', '事件游标或任务身份不匹配。'); return body; }
}
