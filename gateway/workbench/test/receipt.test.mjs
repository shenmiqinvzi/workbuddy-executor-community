import test from 'node:test';
import assert from 'node:assert/strict';
import { leaseLabel, receiptStatusText, receiptStillPending } from '../dispatch.mjs';

test('a pending receipt is reported as a request that was sent, never as work in progress', () => {
    assert.equal(receiptStatusText('dispatching'), '派工请求已发出，等待回执');
    assert.equal(receiptStillPending('dispatching'), true);
    assert.equal(receiptStillPending('launch_requested'), true);
});

test('unknown and settled receipts never claim the original effect ended', () => {
    assert.equal(receiptStatusText('outcome_unknown'), '派工结果尚未明确');
    assert.equal(receiptStillPending('outcome_unknown'), false);
    assert.equal(receiptStatusText('submitted'), '派工已受理');
    assert.equal(receiptStillPending('submitted'), false);
    assert.equal(receiptStillPending('failed'), false);
});

test('a dispatch lease is described by its evidence, never as progress', () => {
    assert.equal(leaseLabel(null), '无记录');
    assert.equal(leaseLabel({ settlement: 'live' }), '所有者仍在运行，心跳正常');
    assert.equal(leaseLabel({ settlement: 'stuck' }), '所有者进程仍在，但心跳已停止');
    assert.equal(leaseLabel({ settlement: 'abandoned' }), '所有者进程已退出，未见回执');
    assert.equal(leaseLabel({ settlement: 'lease_unavailable' }), '无租约记录');
    assert.equal(leaseLabel({ settlement: 'anything-else' }), '无租约记录');
});

test('an unrecognized receipt state falls back to a query hint instead of a status guess', () => {
    assert.equal(receiptStatusText('something-else'), '请查询原派工请求');
    assert.equal(receiptStatusText(undefined), '请查询原派工请求');
    assert.equal(receiptStillPending(undefined), false);
});
