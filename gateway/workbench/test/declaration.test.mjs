import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopCommandHandler } from '../../scripts/workbench-desktop-commands.mjs';

const taskId = 'desktop-task-1', attemptId = 'run-11111111-2222-3333-4444-555555555555', revision = 'rev-1';
const sentence = `declare native stop ${taskId} ${attemptId} ${revision}`;
const statement = '我在原生窗口看到会话已结束，任务栏没有运行中的会话。';
const handler = (declarations) => desktopCommandHandler(null, null, null, null, declarations);

test('a stop declaration is only accepted with the exact sentence the page showed', async () => {
    const calls = [];
    const run = handler({ declare: (input) => { calls.push(input); return { declarationId: 'declaration-1', ...input }; } });
    await assert.rejects(() => run('declare_native_stop', { taskId, attemptId, revision, statement, confirmation: 'yes' }), (error) => error.code === 'CONFIRMATION_REQUIRED');
    await assert.rejects(() => run('declare_native_stop', { taskId, attemptId, revision, statement, confirmation: sentence.trim() + ' ' }), (error) => error.code === 'CONFIRMATION_REQUIRED');
    assert.equal(calls.length, 0);
    const value = await run('declare_native_stop', { taskId, attemptId, revision, statement, confirmation: sentence });
    assert.equal(value.declarationId, 'declaration-1');
    assert.equal(calls[0].actor, 'local-interactive-user');
});

test('the declaration command refuses extra fields, thin statements and control characters', async () => {
    const run = handler({ declare: () => assert.fail('must not be called') });
    await assert.rejects(() => run('declare_native_stop', { taskId, attemptId, revision, statement, confirmation: sentence, confirm: true }));
    await assert.rejects(() => run('declare_native_stop', { taskId, attemptId, revision, statement: '短', confirmation: sentence }));
    await assert.rejects(() => run('declare_native_stop', { taskId: 'bad\nid', attemptId, revision, statement, confirmation: sentence }));
});

test('without a declaration provider the command stays unsupported', async () => {
    const run = handler(null);
    await assert.rejects(() => run('declare_native_stop', { taskId, attemptId, revision, statement, confirmation: sentence }), /Unsupported desktop command/);
});
