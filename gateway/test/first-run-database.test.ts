// A first install has no task database. The desktop host must refuse to invent
// one (a wrong WORKBUDDY_DB_FILE has to stay visible), but the refusal must name
// the variable that chose the path and the one command that creates it — the
// window can only render a bare stat error as "not connected".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GATEWAY = path.resolve(import.meta.dirname, '..');

function runHost(databasePath: string, configDir: string) {
    try {
        const stdout = execFileSync(process.execPath, ['scripts/workbench-desktop-host.mjs'], {
            cwd: GATEWAY,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
                ...process.env,
                WORKBUDDY_CONFIG_DIR: configDir,
                WORKBUDDY_DB_FILE: databasePath,
                WORKBUDDY_DESKTOP_DISPATCH_ENABLED: '0',
                WORKBUDDY_DSH_ENABLED: '0',
            },
        });
        return { code: 0, stdout, stderr: '' };
    } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
}

test('F-FIRST-RUN-1 a missing database is refused with the variable and the init command', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-first-run-'));
    const databasePath = path.join(home, 'state', 'tasks.sqlite');
    const result = runHost(databasePath, home);

    assert.equal(result.code, 2, 'the host must stop with its own exit code, not a stack trace');
    assert.match(result.stderr, /The configured task database does not exist yet/);
    assert.match(result.stderr, /WORKBUDDY_DB_FILE/);
    assert.match(result.stderr, /node scripts\/init-state\.mjs/);
    assert.match(result.stderr, /"reason":"task_database_missing"/);
    assert.equal(fs.existsSync(databasePath), false, 'the host must never create the ledger it was pointed at');
});

test('F-FIRST-RUN-2 init-state creates the database once and refuses to touch it again', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-init-state-'));
    const databasePath = path.join(home, 'state', 'tasks.sqlite');
    const env = { ...process.env, WORKBUDDY_CONFIG_DIR: home, WORKBUDDY_DB_FILE: databasePath };

    const created = execFileSync(process.execPath, ['scripts/init-state.mjs'], { cwd: GATEWAY, encoding: 'utf8', env, timeout: 60_000 });
    const report = JSON.parse(created);
    assert.equal(report.ok, true);
    assert.equal(report.event, 'task_database_initialized');
    assert.ok(report.tables >= 20, 'the schema bootstraps the full task store');
    const bytes = fs.statSync(databasePath).size;
    assert.equal(report.bytes, bytes);

    let refused: { status?: number } = {};
    try {
        execFileSync(process.execPath, ['scripts/init-state.mjs'], { cwd: GATEWAY, encoding: 'utf8', env, timeout: 60_000, stdio: 'pipe' });
    } catch (error) {
        refused = { status: (error as { status?: number }).status };
    }
    assert.equal(refused.status, 3, 'an existing ledger is never re-initialized');
    assert.equal(fs.statSync(databasePath).size, bytes, 'the refusal leaves the file byte-identical');
});
