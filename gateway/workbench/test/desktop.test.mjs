import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { taskIdFromHash } from '../task-link.mjs';
import { desktopArguments } from '../../scripts/open-workbench.mjs';

test('desktop task links are bounded identities, not paths or executable markup', () => {
    assert.equal(taskIdFromHash('#taskId=task%20%3C%26%E4%B8%AD%E6%96%87%3E'), 'task <&中文>');
    for (const hash of ['#other=x', '#taskId=', '#taskId=..%2Fsecret', '#taskId=x%0Ay', '#taskId='+'x'.repeat(201)]) assert.equal(taskIdFromHash(hash), null);
});
test('desktop launcher uses the gateway database and shell-free argument boundaries', () => {
    const gateway=path.resolve('gateway with spaces'), node=process.execPath;
    const args=desktopArguments(['--task-id','task & <x>'],gateway,node,{WORKBUDDY_DB_FILE:'data/actual.sqlite'});
    assert.deepEqual(args,['--gateway-dir',gateway,'--node',node,'--database',path.join(gateway,'data/actual.sqlite'),'--runs-dir',path.join(gateway,'data/runs'),'--task-id','task & <x>']);
});
test('desktop startup rejects duplicate, unknown and unsafe options', () => {
    for(const args of [['--task-id','a','--task-id','b'],['--url','https://example.com'],['--task-id','../secret'],['--task-id','a\nline'],['--status','--status']]) assert.throws(()=>desktopArguments(args,path.resolve('gateway'),process.execPath,{}));
});
