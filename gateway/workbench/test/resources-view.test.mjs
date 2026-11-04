/**
 * 资源视图的行为回归：用真实视图模块 + 最小 DOM + 只读接口桩，
 * 验证“失败不冒充成功时间”“离页取消在途请求”“切源不串数据”等视图状态。
 *
 * 这里的断言只看视图状态与渲染文本，不模拟浏览器布局。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { byId, createHost, installMiniDom, textOf } from './support/mini-dom.mjs';
import { createResourceFetch } from './support/mini-fetch.mjs';
import { formatStamp } from '../resources-model.mjs';

installMiniDom();
const { mountResources } = await import('../resources.mjs');

const ISO_1 = '2026-11-04T09:00:00.000Z';
const ISO_2 = '2026-11-04T09:02:00.000Z';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 1500) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('等待视图状态超时');
        await sleep(5);
    }
}

function setup({ iso = ISO_1 } = {}) {
    const clock = { iso };
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
        notice: () => textOf(host, 'resource-notice') ?? '',
        restore: () => { globalThis.fetch = originalFetch; },
    };
}

test('首次读取就双双失败：不声称存在快照', async () => {
    const scene = setup();
    scene.stub.control.modes = { quota: 'fail', credit: 'fail' };

    await scene.widget.refresh();

    assert.equal(scene.widget.state.quota, null);
    assert.equal(scene.widget.state.credit, null);
    assert.equal(scene.widget.state.attempted, true);
    assert.equal(scene.widget.state.attemptAt, formatStamp(ISO_1));

    const notice = scene.notice();
    assert.match(notice, /本次读取尝试/);
    assert.match(notice, /两个分区都没有可展示的快照/);
    assert.doesNotMatch(notice, /保留了/);
    assert.doesNotMatch(notice, /上次成功/);

    assert.equal(textOf(scene.host, 'resource-quota-status'), '本次读取没有取得 token 快照');
    assert.equal(textOf(scene.host, 'resource-credit-status'), '本次读取没有取得积分快照');
    assert.equal(textOf(scene.host, 'resource-read-stamp'), '本次读取尝试 ' + formatStamp(ISO_1));
    assert.equal(byId(scene.host, 'resource-body').getAttribute('aria-busy'), 'false');
    scene.restore();
});

test('成功后再双失败：保留原数值与原成功时间，尝试时间单独显示', async () => {
    const scene = setup();
    await scene.widget.refresh();
    const firstRemaining = scene.widget.state.quota.view.rows[0].remainingText;
    const firstAt = formatStamp(ISO_1);
    assert.equal(scene.widget.state.quota.at, firstAt);

    scene.stub.control.modes = { quota: 'fail', credit: 'fail' };
    scene.clock.iso = ISO_2;
    await scene.widget.refresh();

    assert.equal(scene.widget.state.quota.view.rows[0].remainingText, firstRemaining);
    assert.equal(scene.widget.state.quota.at, firstAt);
    assert.equal(scene.widget.state.credit.at, firstAt);
    assert.equal(scene.widget.state.attemptAt, formatStamp(ISO_2));
    assert.notEqual(scene.widget.state.attemptAt, scene.widget.state.quota.at);

    const notice = scene.notice();
    assert.ok(notice.includes('保留了 ' + firstAt + ' 的成功快照'), notice);
    assert.ok(!notice.includes('保留了 ' + formatStamp(ISO_2) + ' 的成功快照'), notice);
    assert.match(notice, /未用演示数据替代/);
    assert.equal(textOf(scene.host, 'resource-quota-status'), '上次成功读取 ' + firstAt);
    assert.equal(textOf(scene.host, 'resource-credit-status'), '上次成功读取 ' + firstAt);
    scene.restore();
});

test('单侧失败：两个分区分别说明本次结果与旧快照时间', async () => {
    const scene = setup();
    await scene.widget.refresh();

    scene.clock.iso = ISO_2;
    scene.stub.control.modes = { quota: 'ok', credit: 'fail' };
    await scene.widget.refresh();

    assert.equal(scene.widget.state.quotaError, null);
    assert.equal(scene.widget.state.creditError?.code, 'RESOURCE_STORE_UNAVAILABLE');
    assert.equal(scene.widget.state.quota.at, formatStamp(ISO_2));
    assert.equal(scene.widget.state.credit.at, formatStamp(ISO_1));
    assert.equal(textOf(scene.host, 'resource-quota-status'), '上次成功读取 ' + formatStamp(ISO_2));
    assert.equal(textOf(scene.host, 'resource-credit-status'), '上次成功读取 ' + formatStamp(ISO_1));

    const notice = scene.notice();
    assert.match(notice, /积分接口读取失败/);
    assert.ok(notice.includes('该分区保留了 ' + formatStamp(ISO_1) + ' 的成功快照'), notice);
    assert.ok(notice.includes('另一分区已在本次读取中更新（' + formatStamp(ISO_2) + '）'), notice);
    assert.match(notice, /失败分区没有替换成演示数据/);
    scene.restore();
});

test('首次单侧失败：失败分区说明没有快照，另一分区说明本次更新', async () => {
    const scene = setup();
    scene.stub.control.modes = { quota: 'ok', credit: 'fail' };
    await scene.widget.refresh();

    assert.ok(scene.widget.state.quota);
    assert.equal(scene.widget.state.credit, null);
    assert.equal(textOf(scene.host, 'resource-credit-status'), '本次读取没有取得积分快照');

    const notice = scene.notice();
    assert.ok(notice.includes('该分区没有可展示的快照'), notice);
    assert.ok(notice.includes('另一分区已在本次读取中更新（' + formatStamp(ISO_1) + '）'), notice);
    assert.doesNotMatch(notice, /保留了/);
    scene.restore();
});

test('失败后恢复：清除失效错误并更新对应分区成功时间', async () => {
    const scene = setup();
    scene.stub.control.modes = { quota: 'ok', credit: 'fail' };
    await scene.widget.refresh();
    assert.match(scene.notice(), /积分接口读取失败/);

    scene.stub.control.modes = { quota: 'ok', credit: 'ok' };
    scene.clock.iso = ISO_2;
    await scene.widget.refresh();

    assert.equal(scene.widget.state.creditError, null);
    assert.equal(scene.widget.state.quotaError, null);
    assert.doesNotMatch(scene.notice(), /读取失败/);
    assert.equal(scene.widget.state.credit.at, formatStamp(ISO_2));
    assert.equal(textOf(scene.host, 'resource-credit-status'), '上次成功读取 ' + formatStamp(ISO_2));
    scene.restore();
});

test('离开资源页会取消在途请求，迟到结果不写入', async () => {
    const scene = setup();
    scene.stub.control.delayMs = 120;
    scene.widget.setVisible(true);
    await until(() => scene.stub.control.calls.length >= 2);
    assert.equal(scene.widget.state.loading, true);

    scene.widget.setVisible(false);

    assert.ok(scene.stub.control.aborts >= 2, '两个在途请求都应被取消');
    assert.equal(scene.widget.state.loading, false);
    assert.equal(textOf(scene.host, 'resource-read-stamp'), '尚无读取尝试');

    await sleep(200);
    assert.equal(scene.widget.state.attemptAt, null);
    assert.equal(scene.widget.state.quota, null);
    assert.equal(scene.widget.state.credit, null);
    assert.equal(scene.widget.state.attempted, false);
    scene.restore();
});

test('返回资源页会重新读取一次，不会卡在正在读取', async () => {
    const scene = setup();
    scene.stub.control.delayMs = 60;
    scene.widget.setVisible(true);
    await until(() => scene.stub.control.calls.length >= 2);
    scene.widget.setVisible(false);
    const callsAfterLeave = scene.stub.control.calls.length;

    scene.stub.control.delayMs = 0;
    scene.widget.setVisible(true);
    await until(() => scene.widget.state.quota !== null && scene.widget.state.loading === false);

    assert.ok(scene.stub.control.calls.length > callsAfterLeave, '返回页面应重新发起读取');
    assert.ok(scene.widget.state.quota.view.rows.length > 0);
    assert.equal(scene.widget.state.attemptAt, formatStamp(ISO_1));
    assert.equal(textOf(scene.host, 'resource-read-stamp'), '本次读取尝试 ' + formatStamp(ISO_1));
    scene.restore();
});

test('切换真实/演示来源后旧响应不污染新来源', async () => {
    const scene = setup();
    scene.stub.control.delayMs = 120;
    scene.widget.setVisible(true);
    await until(() => scene.stub.control.calls.length >= 2);

    scene.widget.setMode('demo');
    await until(() => scene.widget.state.quota !== null && scene.widget.state.loading === false);
    await sleep(200);

    assert.equal(scene.widget.state.mode, 'demo');
    assert.equal(scene.widget.state.quota.view.rows[0].modelId, 'sample-model-alpha');
    assert.equal(scene.widget.state.quotaError, null);
    assert.match(scene.notice(), /演示数据/);
    scene.restore();
});

test('销毁后迟到响应不改动视图', async () => {
    const scene = setup();
    scene.stub.control.delayMs = 80;
    scene.widget.setVisible(true);
    await until(() => scene.stub.control.calls.length >= 2);

    scene.widget.destroy();
    assert.equal(scene.host.children.length, 0);

    await sleep(200);
    assert.equal(scene.host.children.length, 0);
    scene.restore();
});
