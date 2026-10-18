import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readNativeTurnFailure } from '../src/native-turn-failure.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const wake = { wakeId: 'wake-run-22222222-2222-4222-8222-222222222222', createdAt: '2026-10-16T04:15:38.000Z' };
function history(t: { after: (fn: () => void) => void }, rows: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-turn-failure-'));
  const project = path.join(dir, 'projects', 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), rows.map(row => JSON.stringify({ type: 'message', sessionId, timestamp: '2026-10-16T04:15:40.000Z', ...row })).join('\n'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const prompt = { role: 'user', content: [{type: 'input_text', text: `[CODEX_QUEUE_WAKE ${wake.wakeId}] task`}] };
const networkError = { role: 'assistant', status: 'incomplete', content: [{type: 'output_text', text: '502 network connection interrupted (read ECONNRESET)'}] };

test('correlates a native provider failure with the exact wake instead of losing it as missing output', t => {
  const dir = history(t, [prompt, networkError]);
  assert.match(readNativeTurnFailure(dir, sessionId, wake)!.error, /502.*ECONNRESET/);
});
test('ignores errors belonging to an older wake in the same native conversation', t => {
  const dir = history(t, [{...prompt, content:[{type:'input_text', text:'[CODEX_QUEUE_WAKE wake-run-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa]'}]}, networkError]);
  assert.equal(readNativeTurnFailure(dir, sessionId, wake), undefined);
});
test('does not treat ordinary partial output or successful error documentation as native failure', t => {
  const dir = history(t, [prompt, {...networkError, content:[{type:'output_text',text:'Implementing the requested feature'}]}, {...networkError,status:'completed'}]);
  assert.equal(readNativeTurnFailure(dir, sessionId, wake), undefined);
});
