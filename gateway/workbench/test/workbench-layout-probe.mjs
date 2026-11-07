/**
 * Workbench page layout probe.
 *
 * The page-layout probe next to it measures the task-preparation harness. This one
 * measures the real workbench document (`workbench/index.html?demo=1`): the task
 * list, its heading tools and the filter row, which is where the narrow window
 * clipping was reported.
 *
 * It serves the workbench directory itself, so no gateway, database or desktop
 * shell is involved, and it drives a local Chromium at explicit CSS viewports and
 * device scale factors. A viewport here is a browser viewport, not a window size:
 * the desktop shell clamps its own window width, so the shell rows in the report
 * come from the window evidence and the page rows come from here.
 *
 *   node workbench/test/workbench-layout-probe.mjs [--out DIR] [--sizes 320,390,533]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const DEFAULT_SIZES = [[1440, 900], [768, 1024], [533, 844], [390, 844], [320, 844]];
const SCENARIOS = [['normal', 'demo=1'], ['long', 'demo=1']];

function browserPath() {
  if (process.env.WORKBUDDY_PAGE_PROBE_BROWSER) return process.env.WORKBUDDY_PAGE_PROBE_BROWSER;
  const roots = [path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const found = fs.readdirSync(root).filter(name => name.startsWith('chromium_headless_shell')).sort().reverse();
    for (const name of found) {
      for (const candidate of [path.join(root, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), path.join(root, name, 'chrome-headless-shell-linux', 'chrome-headless-shell')]) if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const TYPES = new Map([['.html', 'text/html; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.woff2', 'font/woff2'], ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon']]);

/** Serves workbench/ at /workbench/; every gateway API path answers like an idle install. */
function serve() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/workbench/v1/')) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: { code: 'PROBE_NO_GATEWAY', message: 'layout probe' } }));
      return;
    }
    const relative = url.pathname.replace(/^\/workbench\/?/, '');
    const file = path.join(ROOT, relative === '' ? 'index.html' : relative);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES.get(path.extname(file)) ?? 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

class Cdp {
  constructor(socket) { this.socket = socket; this.next = 0; this.pending = new Map(); socket.addEventListener('message', event => { const message = JSON.parse(event.data); const waiting = message.id && this.pending.get(message.id); if (!waiting) return; this.pending.delete(message.id); message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result); }); }
  static async open(url) { const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('无法连接到本地浏览器'))); }); return new Cdp(socket); }
  send(method, params = {}, sessionId) { const id = ++this.next; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
  close() { try { this.socket.close(); } catch { /* already closed */ } }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function version(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return await response.json(); } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error('本地浏览器没有在预期时间内启动');
}

/** Overflow plus the reachability of the controls a narrow window may clip. */
const MEASURE = `(() => {
  const width = innerWidth;
  const overflow = [];
  let localScroll = 0;
  // Content inside a horizontally scrollable box that itself fits is reachable by
  // scrolling that box; it is not viewport clipping.
  const insideScroller = node => {
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
      if (parent.getBoundingClientRect().right <= width + 1) return true;
    }
    return false;
  };
  for (const node of document.querySelectorAll('body *')) {
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (rect.right > width + 1 || rect.left < -1) {
      if (insideScroller(node)) localScroll++;
      else overflow.push({ tag: node.tagName.toLowerCase(), id: node.id || null, cls: String(node.className || '').slice(0, 48) || null, left: Math.round(rect.left), right: Math.round(rect.right) });
    }
  }
  const reach = selector => {
    const node = document.querySelector(selector);
    if (!node) return { selector, present: false };
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { selector, present: true, visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0, left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), insideViewport: rect.left >= -1 && rect.right <= width + 1 };
  };
  const controls = ['#new-task', '#search', '#state-filter', '#workspace-filter', '#executor-filter', '.page-heading h1', '#list-count', '#refresh'].map(reach);
  return {
    width,
    dpr: devicePixelRatio,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalScroll: document.documentElement.scrollWidth > width + 1,
    overflow: overflow.slice(0, 12),
    overflowCount: overflow.length,
    localScrollCount: localScroll,
    clippedControls: controls.filter(control => control.present && control.visible && !control.insideViewport),
    missingControls: controls.filter(control => !control.present),
    controls,
  };
})()`;

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(import.meta.dirname, '..', '..', '..', 'outputs', 'forward-delivery-20261107', 'workbench-layout');
  const sizeIndex = process.argv.indexOf('--sizes');
  const sizes = sizeIndex > 0
    ? process.argv[sizeIndex + 1].split(',').map(pair => { const [w, h] = pair.split('x').map(Number); return [w, h || 844]; })
    : DEFAULT_SIZES;
  const executable = browserPath();
  if (!executable) throw new Error('找不到本地 Chromium（可用 WORKBUDDY_PAGE_PROBE_BROWSER 指定）');
  fs.mkdirSync(out, { recursive: true });
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-probe-'));
  const port = 9900 + Math.floor(Math.random() * 300);
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const report = { browser: executable, origin, root: ROOT, sizes: [], startedAt: new Date().toISOString(), failures: [] };
  let client;
  try {
    const info = await version(port);
    client = await Cdp.open(info.webSocketDebuggerUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => client.send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await page('Runtime.enable'); await page('Page.enable');
    for (const [width, height] of sizes) {
      for (const scale of [1, 2]) {
        const label = `${width}x${height}@${scale}x`;
        await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
        const entry = { viewport: `${width}×${height}`, deviceScaleFactor: scale, label, scenarios: {} };
        for (const [key, query] of SCENARIOS) {
          const url = `${origin}/workbench/index.html?${query}${key === 'long' ? '&scenario=long' : ''}`;
          await page('Page.navigate', { url });
          let ready = false;
          for (let attempt = 0; attempt < 200 && !ready; attempt++) {
            await sleep(50);
            try { ready = await evaluate("Boolean(document.querySelector('.task-row, .empty, #list-count'))"); } catch { /* still loading */ }
          }
          if (!ready) throw new Error('工作台页面没有加载：' + label);
          if (key === 'long') await evaluate("(() => { const select = document.getElementById('demo-scenario'); if (!select) return false; select.value = 'long'; select.dispatchEvent(new Event('change')); return true; })()");
          await sleep(400);
          entry.scenarios[key] = await evaluate(MEASURE);
          // The compose panel and the task detail are the two surfaces a narrow
          // window can push sideways; measure them on the same page.
          entry.scenarios[key].stages = {};
          await evaluate("(() => { const button = document.querySelector('#new-task'); if (button) button.click(); return Boolean(button); })()");
          await sleep(500);
          entry.scenarios[key].stages.compose = await evaluate(MEASURE);
          await evaluate("(() => { const close = document.querySelector('#task-compose [data-close], #task-compose .compose-close, #new-task'); if (close && close.id === 'new-task') close.click(); return true; })()");
          await sleep(300);
          await evaluate("(() => { const row = document.querySelector('.task-row'); if (row) row.click(); return Boolean(row); })()");
          await sleep(500);
          entry.scenarios[key].stages.detail = await evaluate(MEASURE);
          const shot = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          const file = path.join(out, `workbench-${key}-${width}x${height}@${scale}x.png`);
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
          entry.scenarios[key].screenshot = path.basename(file);
        }
        report.sizes.push(entry);
      }
    }
  } finally {
    client?.close();
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5000); } });
    server.close();
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); break; } catch { await sleep(150); }
    }
  }
  for (const entry of report.sizes) {
    for (const [scenario, value] of Object.entries(entry.scenarios)) {
      for (const [stage, measure] of [['list', value], ...Object.entries(value.stages ?? {})]) {
        if (measure.horizontalScroll) report.failures.push({ viewport: entry.label, scenario, stage, kind: 'horizontal-scroll', detail: { scrollWidth: measure.scrollWidth, width: measure.width } });
        if (measure.overflowCount) report.failures.push({ viewport: entry.label, scenario, stage, kind: 'horizontal-overflow', detail: measure.overflow });
        if (measure.clippedControls.length) report.failures.push({ viewport: entry.label, scenario, stage, kind: 'clipped-control', detail: measure.clippedControls });
        if (measure.missingControls.length) report.failures.push({ viewport: entry.label, scenario, stage, kind: 'missing-control', detail: measure.missingControls });
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.failures.length === 0;
  fs.writeFileSync(path.join(out, 'workbench-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, sizes: report.sizes.length, failures: report.failures.slice(0, 20), out }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

await main();
