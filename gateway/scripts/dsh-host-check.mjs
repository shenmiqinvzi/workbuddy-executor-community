#!/usr/bin/env node
// Load/unload the bridge against an explicitly selected installed DSH's Cordis
// and check its actual controller surface. Controllers/agents below are empty
// substitutes: this gate makes no native user session or provider request.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../deepseek-plugin/index.mjs';
import { SUPPORTED_VERSIONS } from '../deepseek-plugin/adapter.mjs';
import { DshClient } from '../dist/dsh-client.js';

const hostPackage = process.argv[2];
if (!hostPackage || !isAbsolute(hostPackage)) throw Error('Pass the installed DSH package.json as an absolute path');
const host = createRequire(hostPackage), load = name => import(pathToFileURL(host.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { SessionController } = await load('@deepseek-ai/dsh-api-session-controller');
const version = JSON.parse(await fs.readFile(host.resolve('@deepseek-ai/dsh-api-session-controller/package.json'), 'utf8')).version;
assert.ok(SUPPORTED_VERSIONS.includes(version));
for (const method of ['list', 'inspect', 'prompt', 'cancel', 'selectModel', 'modelCatalog', 'updateQueue']) assert.equal(typeof SessionController.prototype[method], 'function', `native method absent: ${method}`);
const parent = await fs.mkdtemp(join(tmpdir(), 'dsh-bridge-host-')), root = join(parent, 'private');
const ctx = new Context(); let fiber;
try {
  ctx.provide('profileContext', { name: 'desktop', dir: parent });
  ctx.provide('pluginPackages', { packageOf: () => ({ version }) });
  ctx.provide('agents', { get: () => undefined, list: () => [] });
  ctx.provide('sessionController', { list: async () => ({ items: [] }), inspect: async () => { throw Error('no fixture session'); }, create: async () => { throw Error('creation prohibited'); }, prompt: async () => { throw Error('inference prohibited'); }, cancel: () => ({ accepted: false }), updateQueue: async () => ({ accepted: false }), modelCatalog: async () => ({ groups: [] }), selectModel: async () => { throw Error('selection prohibited'); } });
  fiber = ctx.plugin(plugin, { root }); await fiber;
  const client = new DshClient(join(root, 'hosts'));
  const id = client.resolveHostId(); const health = await client.health(id);
  assert.equal(health.capabilities.automaticReview, false); assert.equal(health.version, version);
  assert.deepEqual(await client.models(id), { models: [], pricingVerified: false });
  await fiber.dispose(); fiber = undefined;
  assert.equal(client.hosts().length, 0);
  console.log(JSON.stringify({ ok: true, hostVersion: version, nativeControllerSurface: true, loadedAndUnloaded: true, authenticatedTransport: true, storage: 'isolated', liveSessionsTouched: 0, modelRequests: 0, nativeExecutionVerified: false }));
} finally { await fiber?.dispose(); await ctx.fiber.dispose(); await fs.rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
