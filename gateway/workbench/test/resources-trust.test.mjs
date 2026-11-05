/**
 * 证据分层（路由证据）前后端契约的回归：
 *   1. 模型层只转写、不升级：三层证据必须各自带层级与“未核验”，
 *      任何一层声称已验证都整份拒收；
 *   2. 读取层单独读 /routing，失败不换成演示数据，也不拖累另两个分区；
 *   3. 视图层把三层并排渲染，证据读取失败时额度与积分照常显示。
 * 这里不模拟浏览器布局，只看 DOM 文本与状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { byId, createHost, installMiniDom, textOf } from './support/mini-dom.mjs';
import { createResourceFetch } from './support/mini-fetch.mjs';
import {
    ROUTING_SCHEMA,
    ResourceSchemaError,
    buildTrustView,
    diagnosticLabel,
    parseRoutingDocument,
} from '../resources-model.mjs';
import { DemoResourceSource, ResourceSource, demoDocuments, demoRouting } from '../resources-source.mjs';

installMiniDom();
const { mountResources } = await import('../resources.mjs');

const ISO_1 = '2026-11-04T09:00:00.000Z';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 1500) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('等待视图状态超时');
        await sleep(5);
    }
}

function router(routes) {
    const calls = [];
    const fetchImpl = async url => {
        const kind = String(url).includes('/routing') ? 'routing' : String(url).includes('quotas') ? 'quotas' : 'credit-balances';
        calls.push(kind);
        const route = routes[kind] ?? routes.default;
        if (!route) throw new Error('未配置的路由：' + kind);
        if (route instanceof Error) throw route;
        return {
            ok: route.status >= 200 && route.status < 300,
            status: route.status,
            async json() {
                return route.body;
            },
        };
    };
    return { calls, fetchImpl };
}

test('路由证据文档必须三层都在，且三层都不允许标记为已验证', () => {
    const document = parseRoutingDocument(demoRouting());
    assert.equal(document.schemaVersion, ROUTING_SCHEMA);
    assert.deepEqual(Object.keys(document.layers).sort(), ['configuration', 'executionSelection', 'requestRouting']);
    for (const layer of Object.values(document.layers)) {
        assert.equal(layer.verified, false);
    }
    assert.equal(document.routingVerified, false);

    const promoted = structuredClone(document);
    promoted.layers.requestRouting.verified = true;
    assert.throws(() => parseRoutingDocument(promoted), error => error instanceof ResourceSchemaError && /requestRouting\.verified/.test(error.message));

    const unknownLevel = structuredClone(document);
    unknownLevel.layers.configuration.level = 'confirmed_by_operator';
    assert.throws(() => parseRoutingDocument(unknownLevel), /layers\.configuration\.level/);

    const missingLayer = structuredClone(document);
    delete missingLayer.layers.executionSelection;
    assert.throws(() => parseRoutingDocument(missingLayer), /layers\.executionSelection/);

    const wrongSchema = { ...structuredClone(document), schemaVersion: 'workbuddy-executor/routing-evidence-2' };
    assert.throws(() => parseRoutingDocument(wrongSchema), /schemaVersion/);
});

test('视图模型把声明、观测与请求归因分开，不给任何一层加“已验证”', () => {
    const view = buildTrustView(parseRoutingDocument(demoRouting()));

    assert.equal(view.routingVerified, false);
    assert.deepEqual(view.layers.map(layer => layer.id), ['configuration', 'executionSelection', 'requestRouting']);
    assert.equal(view.layers[0].levelLabel, '仅网关观测');
    assert.equal(view.layers[1].levelLabel, '仅声明');
    assert.equal(view.layers[2].levelLabel, '不可用');
    assert.match(view.layers[2].reasonLabel, /upstream_payload_lacks_request_identity/);
    for (const layer of view.layers) {
        assert.equal(layer.verified, false);
        assert.equal(layer.verifiedText, '未核验');
    }

    // 声明只暴露环境变量名与是否设置，不回显任何凭据值。
    const credentials = view.configuration.connections[0].credentials;
    assert.deepEqual(credentials.map(item => item.envVar), ['WORKBUDDY_QUOTA_API_KEY', 'WORKBUDDY_QUOTA_PANEL_TOKEN']);
    assert.ok(credentials.every(item => typeof item.present === 'boolean'));
    assert.equal(JSON.stringify(view).includes('sk-'), false);

    // 归因字段一律 null，且已知范围明确写出“任务/会话/单次请求”仍未知。
    assert.deepEqual(view.attribution.fields.map(field => field.value), [null, null, null, null, null, null, null]);
    assert.deepEqual(view.attribution.knownAt.filter(item => item.known).map(item => item.key), ['connection', 'pool', 'modelAggregate']);
    assert.equal(view.attribution.todo.length, 10);
    assert.ok(view.limitations.every(item => item.known), 'all limitation codes must have a label');
});

test('诊断码带上游错误码时仍能解释，未知码保留原文', () => {
    assert.equal(diagnosticLabel('declared_and_observed'), '声明与观测一致（只说明两边对上了，不代表请求命中）');
    assert.equal(diagnosticLabel('observed_source_error:UPSTREAM_TIMEOUT'), '观测侧采集报错：UPSTREAM_TIMEOUT');
    assert.equal(diagnosticLabel('credential_reference_missing'), '声明缺少凭据引用，只登记连接但无法采集');
    assert.equal(diagnosticLabel('models_not_supported'), '这类连接不支持模型限制，声明里的 models 被忽略');
    assert.match(diagnosticLabel('something_new'), /未识别的诊断码/);
});

test('网关给出的未声明连接是对象数组，页面只转写连接标识', () => {
    const document = demoRouting();
    document.connectionDiagnostics.undeclaredObserved = [
        { connectionId: 'synthetic-undeclared-one', resource: 'quota' },
        { connectionId: 'synthetic-undeclared-two', resource: 'credit' },
    ];
    const view = buildTrustView(document);
    assert.deepEqual(view.diagnostics.undeclaredObserved, ['synthetic-undeclared-one', 'synthetic-undeclared-two']);
    assert.equal(JSON.stringify(view).includes('[object Object]'), false);
});

test('读取层单独读路由证据，且不把结构不符的文档当成可用证据', async () => {
    const ok = router({ routing: { status: 200, body: demoRouting() } });
    const source = new ResourceSource({ fetchImpl: ok.fetchImpl, now: () => new Date(ISO_1) });
    const read = await source.readRouting();
    assert.deepEqual(ok.calls, ['routing']);
    assert.equal(read.view.layers.length, 3);
    assert.equal(source.kind, 'live');

    const broken = router({ routing: { status: 200, body: { schemaVersion: 'unknown' } } });
    const failing = new ResourceSource({ fetchImpl: broken.fetchImpl });
    await assert.rejects(() => failing.readRouting(), error => error.code === 'UNKNOWN_SCHEMA');
});

test('readAll 仍然只读两个分区，不因证据分区而多打一次上游', async () => {
    const documents = demoDocuments();
    const scene = router({
        quotas: { status: 200, body: documents.quota },
        'credit-balances': { status: 200, body: documents.credit },
    });
    const source = new ResourceSource({ fetchImpl: scene.fetchImpl });
    const result = await source.readAll();
    assert.equal(result.ok, true);
    assert.deepEqual(scene.calls, ['quotas', 'credit-balances']);
    assert.equal(result.routing, undefined);
});

test('演示数据同样提供三层证据，且没有一层被标成已验证', async () => {
    const demo = new DemoResourceSource({ now: () => new Date(ISO_1) });
    const read = await demo.readRouting();
    assert.equal(read.view.layers.length, 3);
    assert.ok(read.view.layers.every(layer => layer.verified === false));
    assert.equal(read.view.attribution.fields.every(field => field.value === null), true);
    assert.equal(JSON.stringify(read.view).includes('已验证'), false);
});

function setup() {
    const clock = { iso: ISO_1 };
    const now = () => new Date(clock.iso);
    const stub = createResourceFetch({ now });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub.fetchImpl;
    const host = createHost();
    const widget = mountResources(host, { now });
    return {
        clock,
        stub,
        host,
        widget,
        text: () => host.textContent,
        restore: () => { globalThis.fetch = originalFetch; },
    };
}

test('视图把三层证据并排渲染，并逐个标注未核验', async t => {
    const scene = setup();
    t.after(scene.restore);

    await scene.widget.refresh();
    await until(() => scene.widget.state.routing !== null);

    const layers = scene.host.querySelectorAll('.resource-layer');
    assert.equal(layers.length, 3);
    assert.deepEqual(layers.map(layer => layer.dataset.layer), ['configuration', 'executionSelection', 'requestRouting']);
    assert.equal(layers.filter(layer => layer.textContent.includes('未核验')).length, 3);

    const text = scene.text();
    assert.match(text, /证据分层/);
    assert.match(text, /配置：连接 → 池 → 模型/);
    assert.match(text, /执行选择（声明）/);
    assert.match(text, /实际请求路由/);
    assert.match(text, /请求归因（上游未提供请求归因）/);
    assert.match(text, /待办（10 条，转 10 真实验收）/);
    assert.doesNotMatch(text, /已验证/);
    assert.match(textOf(scene.host, 'resource-trust-status'), /上次成功读取/);
});

test('证据分区读取失败时，额度与积分照常显示且不换成演示数据', async t => {
    const scene = setup();
    t.after(scene.restore);
    scene.stub.control.modes = { quota: 'ok', credit: 'ok', routing: 'fail' };

    await scene.widget.refresh();
    await until(() => scene.widget.state.routingError !== null);

    assert.notEqual(scene.widget.state.quota, null);
    assert.notEqual(scene.widget.state.credit, null);
    assert.equal(scene.widget.state.routing, null);
    assert.equal(scene.widget.state.routingError.code, 'RESOURCE_STORE_UNAVAILABLE');

    const text = scene.text();
    assert.match(text, /证据分层：网关资源缓存不可读/);
    assert.match(text, /Token 额度/);
    assert.match(text, /积分/);
    // 另一个分区失败不能把这次的证据失败算成“两个分区都失败”。
    assert.doesNotMatch(scene.text(), /两个分区都失败/);
    assert.match(textOf(scene.host, 'resource-mode'), /真实读取/);
});

test('切换演示数据后仍显示三层证据，且页面整体标注演示', async t => {
    const scene = setup();
    t.after(scene.restore);
    scene.widget.setMode('demo');
    await scene.widget.refresh();
    await until(() => scene.widget.state.routing !== null);

    assert.equal(scene.stub.control.calls.length, 0);
    const text = scene.text();
    assert.match(text, /演示数据/);
    assert.equal(scene.host.querySelectorAll('.resource-layer').length, 3);
    assert.match(text, /上游未提供请求归因/);
});
