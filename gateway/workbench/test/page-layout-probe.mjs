/**
 * Isolated page layout probe.
 *
 * Loads the real workbench stylesheets and the real page modules in a local
 * Chromium at a fixed viewport, then measures what the page itself does:
 * horizontal overflow, accessible names, the keyboard focus order and the
 * focus ring. It measures the page, never the desktop window, and it is a
 * convenience script rather than part of `npm run test:workbench`: a missing
 * browser must not turn a page regression into a false pass.
 *
 *   node workbench/test/page-layout-probe.mjs [--out DIR]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SIZES = [[1440, 900], [1280, 720], [768, 1024], [390, 844], [320, 844]];
const HARNESS = path.join(import.meta.dirname, 'support', 'page-harness', 'index.html');

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

const MEASURE = `(() => {
  const width = innerWidth;
  const overflow = [];
  for (const node of document.querySelectorAll('body *')) {
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    if (rect.right > width + 1 || rect.left < -1) overflow.push({ tag: node.tagName.toLowerCase(), id: node.id || null, cls: String(node.className || '').slice(0, 48) || null, right: Math.round(rect.right) });
  }
  return { width, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, overflow: overflow.slice(0, 10), overflowCount: overflow.length };
})()`;

const NAMES = `(() => {
  const name = node => {
    if (node.getAttribute('aria-label')) return node.getAttribute('aria-label').trim();
    const referenced = node.getAttribute('aria-labelledby');
    if (referenced) { const label = document.getElementById(referenced); if (label && label.textContent.trim()) return label.textContent.trim(); }
    if (node.id) { const label = document.querySelector('label[for="' + CSS.escape(node.id) + '"]'); if (label && label.textContent.trim()) return label.textContent.trim(); }
    const enclosing = node.closest('label');
    if (enclosing && enclosing.textContent.trim()) return enclosing.textContent.trim();
    if (node.getAttribute('placeholder')) return node.getAttribute('placeholder').trim();
    if (node.tagName === 'BUTTON' || node.tagName === 'SUMMARY') return node.textContent.trim();
    return '';
  };
  const scope = document.getElementById('task-compose') || document.body;
  const focusable = [...scope.querySelectorAll('button, input, select, textarea, summary, a[href]')].filter(node => !node.disabled && node.offsetParent !== null);
  const unnamed = focusable.filter(node => !name(node)).map(node => ({ tag: node.tagName.toLowerCase(), id: node.id || null, type: node.getAttribute('type') || null }));
  const danglingDescriptions = focusable.filter(node => {
    const ids = (node.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
    return ids.some(id => !document.getElementById(id));
  }).map(node => ({ id: node.id || null, describedby: node.getAttribute('aria-describedby') }));
  const liveRegions = [...document.querySelectorAll('[role="status"], [aria-live]')].length;
  const nav = document.querySelector('.dispatch-steps');
  return { focusable: focusable.length, unnamed, danglingDescriptions, liveRegions, stepperLabelled: nav ? nav.getAttribute('aria-label') : null, currentStep: nav ? (nav.querySelector('[aria-current]')?.textContent ?? null) : null };
})()`;

const ACTIVE = `(() => {
  const node = document.activeElement;
  if (!node || node === document.body) return { id: null, tag: 'body' };
  const style = getComputedStyle(node);
  return { id: node.id || null, tag: node.tagName.toLowerCase(), label: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40), outline: style.outlineStyle + ' ' + style.outlineWidth };
})()`;

/** Readability and tap-target floors, measured on what is actually painted. */
const AUDIT = `(() => {
  const visible = node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'; };
  const tiny = [], small = [];
  const scope = document.querySelector('.sheet') || document.body;
  for (const node of scope.querySelectorAll('p, li, dd, dt, label, button, textarea, select, input, h1, h2, h3, summary, span')) {
    if (!visible(node) || !node.textContent.trim() && node.tagName !== 'INPUT' && node.tagName !== 'TEXTAREA') continue;
    const size = parseFloat(getComputedStyle(node).fontSize);
    if (size && size < 12) tiny.push({ tag: node.tagName.toLowerCase(), cls: String(node.className || '').slice(0, 40), size });
    if (node.tagName === 'BUTTON' || node.tagName === 'SUMMARY') { const height = node.getBoundingClientRect().height; if (height < 24) small.push({ tag: node.tagName.toLowerCase(), id: node.id || null, cls: String(node.className || '').slice(0, 40), height: Math.round(height) }); }
  }
  return { tinyFonts: tiny.slice(0, 8), tinyFontCount: tiny.length, smallTargets: small.slice(0, 8), smallTargetCount: small.length };
})()`;


async function main() {
  const override = process.argv.indexOf('--out');
  const out = override > 0 ? path.resolve(process.argv[override + 1]) : path.join(import.meta.dirname, '..', '..', '..', 'outputs', 'forward-delivery-20261107', 'B', 'evidence', 'pages');
  const executable = browserPath();
  if (!executable) throw new Error('找不到本地 Chromium（可用 WORKBUDDY_PAGE_PROBE_BROWSER 指定）');
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'page-probe-'));
  const port = 9500 + Math.floor(Math.random() * 400);
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const report = { browser: executable, harness: HARNESS, sizes: [], startedAt: new Date().toISOString(), failures: [] };
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
    const url = pathToFileURL(HARNESS).href;
    for (const [width, height] of SIZES) {
      await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await page('Page.navigate', { url });
      let ready = false;
      for (let attempt = 0; attempt < 150 && !ready; attempt++) { await sleep(50); try { ready = await evaluate('Boolean(globalThis.harness && globalThis.harness.ready)'); } catch { /* still loading */ } }
      if (!ready) throw new Error('隔离页面没有加载：' + width + '×' + height);
      const entry = { viewport: `${width}×${height}`, stages: {} };
      // The task panel: a record in review plus the unavailable-reasons block.
      entry.stages.panel = { measure: await evaluate(MEASURE), names: await evaluate(NAMES), audit: await evaluate(AUDIT) };
      const panelShot = await page('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, `panel-${width}x${height}.png`), Buffer.from(panelShot.data, 'base64'));
      entry.stages.panel.screenshot = `panel-${width}x${height}.png`;
      await evaluate('harness.openEditor()');
      entry.stages.edit = { measure: await evaluate(MEASURE), names: await evaluate(NAMES), audit: await evaluate(AUDIT) };
      await evaluate('harness.fill()');
      await evaluate('harness.review()');
      entry.stages.review = { measure: await evaluate(MEASURE), names: await evaluate(NAMES), audit: await evaluate(AUDIT) };
      // Keyboard order and the focus ring, measured from a clean focus state.
      await page('Runtime.evaluate', { expression: 'document.activeElement && document.activeElement.blur()' });
      entry.focusOrder = [];
      for (let index = 0; index < 10; index++) {
        await page('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await sleep(20);
        entry.focusOrder.push(await evaluate(ACTIVE));
      }
      const shot = await page('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, `dispatch-${width}x${height}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      entry.screenshot = path.basename(file);
      // The receipt step has its own headline and buttons; measure it too.
      await evaluate('harness.receipt()');
      entry.stages.receipt = { measure: await evaluate(MEASURE), names: await evaluate(NAMES), audit: await evaluate(AUDIT) };
      const receiptShot = await page('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, `receipt-${width}x${height}.png`), Buffer.from(receiptShot.data, 'base64'));
      entry.stages.receipt.screenshot = `receipt-${width}x${height}.png`;
      report.sizes.push(entry);
    }
  } finally {
    client?.close();
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5000); } });
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); break; } catch { await sleep(150); }
    }
  }
  for (const entry of report.sizes) {
    for (const [stage, value] of Object.entries(entry.stages)) {
      if (value.measure.overflowCount) report.failures.push({ viewport: entry.viewport, stage, kind: 'horizontal-overflow', detail: value.measure.overflow });
      if (value.names.unnamed.length) report.failures.push({ viewport: entry.viewport, stage, kind: 'unnamed-control', detail: value.names.unnamed });
      if (value.names.danglingDescriptions.length) report.failures.push({ viewport: entry.viewport, stage, kind: 'dangling-aria-describedby', detail: value.names.danglingDescriptions });
      if (value.audit?.tinyFontCount) report.failures.push({ viewport: entry.viewport, stage, kind: 'font-below-12px', detail: value.audit.tinyFonts });
      if (value.audit?.smallTargetCount) report.failures.push({ viewport: entry.viewport, stage, kind: 'target-below-24px', detail: value.audit.smallTargets });
    }
    const labelled = entry.focusOrder.filter(step => step.id || step.tag !== 'body');
    if (labelled.length < 6) report.failures.push({ viewport: entry.viewport, stage: 'focus', kind: 'focus-order-too-short', detail: entry.focusOrder });
    const noRing = entry.focusOrder.filter(step => step.tag !== 'body' && !/^(solid|dashed|dotted|double)/.test(step.outline.split(' ')[0] || ''));
    if (noRing.length) report.failures.push({ viewport: entry.viewport, stage: 'focus', kind: 'missing-focus-ring', detail: noRing });
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.failures.length === 0;
  fs.writeFileSync(path.join(out, 'page-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, sizes: report.sizes.length, failures: report.failures, out }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

await main();
