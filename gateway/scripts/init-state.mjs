#!/usr/bin/env node
// A first install has no task database, and the desktop host must never create
// one: a wrong WORKBUDDY_DB_FILE has to stay a visible error rather than become
// an empty ledger that silently swallows tasks. This helper is the explicit,
// one-shot way to create it. It refuses any path that already exists, writes
// nothing outside that file, and prints what it created.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { TaskStore } from '../dist/task-store.js';
import { loadDotEnv } from '../dist/env.js';

loadDotEnv();
const config = loadConfig();
const target = config.dbFile;

if (fs.existsSync(target)) {
    console.error(JSON.stringify({
        ok: false,
        code: 'ALREADY_EXISTS',
        databasePath: target,
        message: 'Refusing to touch an existing task database. Point WORKBUDDY_DB_FILE at a new path instead.'
    }));
    process.exit(3);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
const store = new TaskStore(target);
const tables = store.database
    .prepare("select name from sqlite_master where type='table' order by name")
    .all()
    .map(row => row.name);
store.close();

console.log(JSON.stringify({
    ok: true,
    event: 'task_database_initialized',
    databasePath: target,
    bytes: fs.statSync(target).size,
    tables: tables.length
}, null, 2));
