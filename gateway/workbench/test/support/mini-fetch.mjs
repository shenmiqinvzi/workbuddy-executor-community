/**
 * 视图测试用的只读接口桩：按 URL 分发到两个合成响应，可切换成功/失败、
 * 延迟与取消观测。响应结构与真实接口同构（取自 demoDocuments），
 * 这样视图拿到的是合法 schema，测试失败只会来自行为本身。
 */
import { demoDocuments } from '../../resources-source.mjs';

const FAILURE = {
    status: 503,
    body: { ok: false, error: { code: 'RESOURCE_STORE_UNAVAILABLE', message: '合成失败：网关资源缓存暂不可读。' } },
};

function jsonResponse(status, body) {
    const payload = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return JSON.parse(payload);
        },
    };
}

function abortError() {
    const error = new Error('已取消读取');
    error.name = 'AbortError';
    return error;
}

/**
 * 等一段时间；signal 取消时立刻以 AbortError 失败，并计数一次真实取消。
 * 真实 fetch 的行为就是这样：取消后不再返回数据。
 */
function waitAbortable(ms, signal, control) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const onAbort = () => {
            if (settled) return;
            settled = true;
            control.aborts += 1;
            if (timer) clearTimeout(timer);
            reject(abortError());
        };
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        if (ms <= 0) {
            settled = true;
            return resolve();
        }
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, ms);
    });
}

export function createResourceFetch({ now }) {
    const control = {
        modes: { quota: 'ok', credit: 'ok' },
        delayMs: 0,
        calls: [],
        aborts: 0,
        documents: null,
    };

    async function fetchImpl(url, init = {}) {
        const kind = String(url).includes('quotas') ? 'quota' : 'credit';
        control.calls.push(kind);
        await waitAbortable(control.delayMs, init.signal, control);
        if (control.modes[kind] === 'fail') return jsonResponse(FAILURE.status, FAILURE.body);
        const documents = control.documents ?? demoDocuments(now);
        return jsonResponse(200, kind === 'quota' ? documents.quota : documents.credit);
    }

    return { control, fetchImpl };
}
