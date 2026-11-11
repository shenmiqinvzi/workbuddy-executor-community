// Synthetic end-to-end check of the desktop preparation surface: the real
// parent/child command transport, the real dispatch session, a marked synthetic
// database and a fake native boundary. Nothing here opens a model, a native
// session or a real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const gateway = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(gateway, 'test', 'support', 'desktop-dispatch-fixture.mjs');
const built = fs.existsSync(path.join(gateway, 'dist', 'desktop-dispatch.js'));

function root() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-l01-e2e-'));
    fs.writeFileSync(path.join(directory, '.synthetic-workbench'), 'synthetic\n');
    fs.mkdirSync(path.join(directory, 'project'));
    fs.mkdirSync(path.join(directory, 'runs'));
    fs.mkdirSync(path.join(directory, 'state'));
    fs.mkdirSync(path.join(directory, 'env', 'config'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'env', 'WorkBuddy.exe'), 'synthetic\n');
    fs.writeFileSync(path.join(directory, 'env', 'config', 'workbuddy.db'), '');
    return directory;
}
function childEnv(directory: string) {
    const clean: NodeJS.ProcessEnv = {...process.env};
    for (const name of Object.keys(clean)) if (name.startsWith('WORKBUDDY_') || name.startsWith('WORKBENCH_')) delete clean[name];
    return {...clean, WORKBENCH_SYNTHETIC_ROOT: directory, WORKBUDDY_CLI_ELECTRON: path.join(directory, 'env', 'WorkBuddy.exe'), WORKBUDDY_CONFIG_DIR: path.join(directory, 'env', 'config'),
        WORKBUDDY_DB_FILE: path.join(directory, 'tasks.sqlite'), WORKBUDDY_RUNS_DIR: path.join(directory, 'runs'), WORKBUDDY_TOKEN_FILE: path.join(directory, 'unused-credentials.json'),
        WORKBUDDY_DESKTOP_STATE_DIR: path.join(directory, 'state'), NO_PROXY: '127.0.0.1,localhost'};
}
function stats(directory: string): Record<string, number> { try { return JSON.parse(fs.readFileSync(path.join(directory, 'actor-stats.json'), 'utf8')); } catch { return {}; } }
async function host(t: test.TestContext) {
    const directory = root();
    const child = spawn(process.execPath, [fixture], {cwd: gateway, env: childEnv(directory), stdio: ['pipe', 'pipe', 'pipe']});
    const waiting = new Map<string, (reply: any) => void>();
    let buffer = '';
    const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('synthetic host did not start: ' + buffer)), 20000);
        child.once('exit', code => { clearTimeout(timer); reject(Error('synthetic host exited early: ' + code + ' ' + buffer)); });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
                const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
                if (!line) continue;
                const message = JSON.parse(line);
                if (message.event === 'desktop_host_ready') { clearTimeout(timer); resolve(); continue; }
                if (message.event === 'desktop_command_result') waiting.get(message.id)?.(message);
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { buffer += chunk; });
    });
    await ready;
    let command: (method: string, parameters?: Record<string, unknown>) => Promise<any>;
    command = (method: string, parameters: Record<string, unknown> = {}) => new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { waiting.delete(id); reject(Error('no reply for ' + method)); }, 30000);
        waiting.set(id, reply => { clearTimeout(timer); waiting.delete(id); if (reply.ok === true) resolve(reply.value); else reject(Object.assign(Error(reply.error?.message ?? 'command failed'), {code: reply.error?.code})); });
        child.stdin.write(JSON.stringify({id, method, parameters}) + '\n');
    });
    t.after(() => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} setTimeout(() => { try { fs.rmSync(directory, {recursive: true, force: true}); } catch {} }, 500).unref(); });
    return {directory, command};
}
const terms = (catalog: any) => ({catalogId: catalog.catalogId, modelKey: catalog.models[0].key, workspace: null, projectId: null, title: 'Synthetic scoped task', objective: 'Update only the allowed files',
    allowedChanges: ['src/**'], permittedMetadata: [], checks: ['Independent check of the requested behavior'], maxAttempts: 1, timeoutSeconds: 600, sessionId: null});

test('a previewed agreement reaches the fake native boundary exactly once', {skip: !built, timeout: 90000}, async t => {
    try {
        await previewToBoundary(t);
    } catch (error) {
        // The CI runner only exposes annotations to anonymous readers, so the
        // failure has to name itself here instead of relying on a job log.
        const message = String((error as Error)?.message ?? error).replace(/\r?\n/g, ' ');
        try { fs.writeFileSync(path.join(gateway, 'ci-failure.txt'), message); } catch {}
        console.log(`::error::desktop-dispatch-e2e ${message.slice(0, 600)}`);
        throw error;
    }
});

async function previewToBoundary(t: test.TestContext): Promise<void> {
    const {directory, command} = await host(t);
    const first = await command('catalog');
    assert.deepEqual(first.projects, [], 'a fresh registry offers no remembered project');
    const project = path.join(fs.realpathSync.native(directory), 'project');
    const draft = await command('preview', {...terms(first), workspace: project});
    assert.equal(draft.revision, 1);
    assert.deepEqual(stats(directory), {}, 'preview prepares no model and no native attempt');
    assert.equal(await command('status', {requestId: draft.draftId}), null, 'preview leaves no dispatch record');

    const remembered = await command('catalog');
    assert.equal(remembered.projects.length, 1, 'the verified identity is remembered for the next visit');
    assert.equal(remembered.projects[0].realPath, project);
    assert.equal(remembered.projects[0].state, 'unverified');
    assert.equal(JSON.stringify(remembered.projects).includes('inode'), false);
    const byIdentity = await command('preview', {...terms(remembered), projectId: remembered.projects[0].projectId});
    assert.notEqual(byIdentity.taskId, draft.taskId);

    const receipt = await command('commit', {draftId: byIdentity.draftId, digest: byIdentity.digest});
    assert.ok(['launch_requested', 'dispatching', 'submitted'].includes(receipt.state), JSON.stringify(receipt));
    let settled = receipt;
    for (let attempt = 0; attempt < 60 && ['launch_requested', 'dispatching'].includes(settled.state); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        settled = (await command('status', {requestId: receipt.requestId})) ?? settled;
    }
    assert.equal(settled.state, 'submitted', JSON.stringify(settled));
    const counts = stats(directory);
    assert.equal(counts.workbuddyPreparations, 1, 'one native preparation for one agreement');
    assert.equal(counts.workbuddyPrompts, 1, 'one native attempt for one agreement');
    assert.equal(counts.dshSelections ?? 0, 0, 'a desktop queue task never selects a DSH model');
    assert.equal(counts.dshPrompts ?? 0, 0);

    const latest = await command('catalog');
    const again = await command('preview', {...terms(latest), workspace: project});
    await assert.rejects(command('commit', {draftId: again.draftId, digest: again.digest}), (error: any) => error.code === 'PLAN_ALREADY_CONSUMED');
    const revised = await command('preview', {...terms(latest), workspace: project, draftId: again.draftId, digest: again.digest, objective: 'Update only the allowed files, with the narrower check'});
    assert.equal(revised.revision, 2);
    assert.equal(revised.taskId, again.taskId, 'a revision keeps the task identity');
    assert.notEqual(revised.digest, again.digest);
    assert.equal(stats(directory).workbuddyPreparations, 1, 'revising still prepares nothing');
}
