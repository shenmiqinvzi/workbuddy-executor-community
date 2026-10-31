#!/usr/bin/env node
import {loadDotEnv} from '../dist/env.js';
import {loadConfig} from '../dist/config.js';
import {runDesktopControlWorker} from '../dist/desktop-control-runtime.js';
const [id,...extra]=process.argv.slice(2);
if(extra.length||!id||!/^[a-f0-9-]{36}$/.test(id))throw Error('A single original desktop control request identity is required.');
loadDotEnv();
await runDesktopControlWorker(loadConfig(),id);
