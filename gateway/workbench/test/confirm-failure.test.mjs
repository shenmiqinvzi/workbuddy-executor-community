import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmFailure, isDefiniteRefusal } from '../dispatch.mjs';

const identity = { taskId: 'desktop-task', operationId: 'desktop-send-op' };
const at = error => confirmFailure(error, identity);

test('a cancelled native confirmation sends nothing and keeps the agreement usable', () => {
    const outcome = at({ code: 'CONFIRMATION_CANCELLED', message: 'cancelled' });
    assert.equal(outcome.consumed, false);
    assert.equal(outcome.receipt, false);
    assert.match(outcome.text, /尚未派工/);
    assert.match(outcome.text, /原约定仍然有效/);
});

test('a refusal before the hand-off is definite: same identity, correct and check again', () => {
    for (const code of ['QUOTE_CHANGED', 'MODEL_UNVERIFIED', 'WORKSPACE_CONFLICT', 'SESSION_REQUIRED', 'DRAFT_EXPIRED', 'DISPATCH_NOT_ENABLED', 'SCOPE_NOT_DECLARED', 'PROJECT_IDENTITY_CHANGED']) {
        const outcome = at({ code, message: 'synthetic refusal' });
        assert.equal(outcome.consumed, false, code);
        assert.equal(outcome.tone, 'error');
        assert.match(outcome.text, /尚未派工/, code);
        assert.match(outcome.text, /synthetic refusal/, code);
        assert.match(outcome.text, /不会自动换模型/, code);
        assert.equal(isDefiniteRefusal(code), true, code);
    }
});

test('a spent plan is reported as spent, never as a refusal to retry', () => {
    const outcome = at({ code: 'PLAN_ALREADY_CONSUMED', message: 'already consumed' });
    assert.equal(outcome.consumed, true);
    assert.equal(outcome.receipt, false);
    assert.match(outcome.text, /同一份任务约定/);
    assert.match(outcome.text, /desktop-task/);
    assert.match(outcome.text, /desktop-send-op/);
});

test('an unreadable hand-off keeps the request identity and forbids a second confirm', () => {
    for (const error of [{ code: 'OUTCOME_UNKNOWN', message: 'connection lost' }, { code: 'DESKTOP_UNAVAILABLE' }, new Error('fetch failed'), undefined]) {
        const outcome = at(error);
        assert.equal(outcome.consumed, true);
        assert.equal(outcome.receipt, true);
        assert.match(outcome.text, /无法确认本次派工是否已经开始/);
        assert.match(outcome.text, /desktop-send-op/);
        assert.match(outcome.text, /不要重复派工/);
    }
});

test('a bare network failure is never described as a definite refusal', () => {
    assert.equal(isDefiniteRefusal(undefined), false);
    assert.equal(isDefiniteRefusal('ECONNRESET'), false);
    assert.equal(at(undefined).consumed, true);
});
