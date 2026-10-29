#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function desktopArguments(args, gateway, node, env = process.env) {
    let taskId, status = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--status' && !status) status = true;
        else if (args[i] === '--task-id' && taskId === undefined && i + 1 < args.length) taskId = args[++i];
        else throw new Error('Usage: open-workbench.mjs [--task-id ID] [--status]');
    }
    if (taskId !== undefined && (taskId.length < 1 || taskId.length > 200 || /[\x00-\x1f\x7f/\\\uD800-\uDFFF]/.test(taskId))) throw new Error('Invalid task identifier.');
    // Resolve like config.ts: this gateway's .env and process variables, never
    // the caller's cwd. Reading a config does not open stores or call a model.
    const database = path.resolve(gateway, env.WORKBUDDY_DB_FILE?.trim() || './data/tasks.sqlite');
    const runs = path.resolve(gateway, env.WORKBUDDY_RUNS_DIR?.trim() || path.join(path.dirname(database), 'runs'));
    return ['--gateway-dir', gateway, '--node', node, '--database', database, '--runs-dir', runs, ...(taskId === undefined ? [] : ['--task-id', taskId]), ...(status ? ['--status'] : [])];
}

export async function openWorkbench(args = process.argv.slice(2)) {
    if (process.platform !== 'win32') return { opened: false, code: 'WINDOWS_REQUIRED' };
    const gateway = path.resolve(import.meta.dirname, '..');
    // env.js loads the same gateway-local .env with existing process precedence.
    const { loadDotEnv } = await import('../dist/env.js');
    loadDotEnv();
    const resolveOnly = args.length === 1 && args[0] === '--resolve-options';
    const parameters = desktopArguments(resolveOnly ? [] : args, gateway, process.execPath);
    if (resolveOnly) return { arguments: parameters };
    const exe = path.join(gateway, 'desktop', 'app', 'WorkBuddy.Workbench.exe');
    if (!fs.existsSync(exe)) return { opened: false, code: 'DESKTOP_NOT_BUILT', message: 'Run npm run desktop:build in this gateway.' };
    if (!fs.existsSync(parameters[5])) return { opened: false, code: 'TASK_DATABASE_NOT_FOUND', message: 'Use the actual executor WORKBUDDY_DB_FILE; no empty database was created.' };
    const status = args.includes('--status');
    const child = spawn(exe, parameters, { cwd: gateway, shell: false, detached: !status, windowsHide: false, stdio: status ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    if (status) {
        return await new Promise((resolve, reject) => {
            let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop status timed out.')); }, 12000);
            child.stdout.on('data', chunk => { if (output.length < 4096) output += chunk; }); child.stderr.resume();
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', code => { clearTimeout(timer); try { resolve(code === 0 ? JSON.parse(output) : { opened: false, code: 'DESKTOP_UNAVAILABLE' }); } catch { reject(new Error('Invalid desktop status.')); } });
        });
    }
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { opened: true, status: 'launch_requested', launcherPid: child.pid, taskId: args.includes('--task-id') ? args[args.indexOf('--task-id') + 1] : null };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(JSON.stringify(await openWorkbench())); }
    catch (error) { console.error(JSON.stringify({ opened: false, code: 'DESKTOP_START_FAILED', message: error.message })); process.exitCode = 1; }
}
