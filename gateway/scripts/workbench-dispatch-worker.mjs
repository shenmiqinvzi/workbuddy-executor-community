#!/usr/bin/env node
import {loadDotEnv} from '../dist/env.js';
import {loadConfig} from '../dist/config.js';
import {runDesktopDispatchWorker} from '../dist/desktop-dispatch-runtime.js';
const [id,...extra]=process.argv.slice(2);
if(extra.length||!id||!/^[a-f0-9-]{36}$/.test(id))throw Error('A single original desktop request identity is required.');
loadDotEnv();
await runDesktopDispatchWorker(loadConfig(),id);
