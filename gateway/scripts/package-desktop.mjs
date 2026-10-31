#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectReleaseFiles, assertSafeContent } from './package.mjs';
import { zipDirectory } from './zip.mjs';

const appFiles = ['WorkBuddy.Workbench.exe', 'WorkBuddy.Workbench.dll', 'WorkBuddy.Workbench.deps.json', 'WorkBuddy.Workbench.runtimeconfig.json', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'runtimes/win-x64/native/WebView2Loader.dll', 'WEBVIEW2-LICENSE.txt'];
export async function createDesktopPackage(gateway, output, version) {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid desktop package version.');
    gateway = path.resolve(gateway); output = path.resolve(output);
    const name = 'workbuddy-desktop-v' + version, archive = path.join(output, name + '.zip');
    await fs.mkdir(output, { recursive: true });
    for (const target of [archive, archive + '.sha256']) {
        try { await fs.lstat(target); throw new Error('Refusing to replace a desktop archive or checksum.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const files = await collectReleaseFiles(gateway);
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-desktop-package-'));
    const entries = [];
    async function copy(relative, destination, scan = true) {
        const source = path.join(gateway, relative);
        let current = gateway;
        for (const part of relative.split('/')) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked desktop package input.'); }
        if (!(await fs.stat(source)).isFile()) throw new Error('Missing desktop package file.');
        const bytes = await fs.readFile(source);
        if (scan) assertSafeContent(relative, bytes.toString('utf8'));
        const target = path.join(stage, destination); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
        entries.push({ path: destination, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    try {
        for (const relative of files) await copy(relative, 'gateway/' + relative);
        for (const relative of appFiles) await copy('desktop/app/' + relative, 'gateway/desktop/app/' + relative, false);
        await fs.writeFile(path.join(stage, 'RELEASE_MANIFEST.json'), JSON.stringify({ project: 'workbuddy-desktop', version, prerequisites: ['Windows x64', '.NET Desktop Runtime 10', 'WebView2 Runtime', 'Node.js >=22.13 and installed gateway dependencies'], files: entries }, null, 2));
        await zipDirectory(stage, archive, name);
        const sha256 = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
        await fs.writeFile(archive + '.sha256', sha256 + '  ' + path.basename(archive) + '\n', { flag: 'wx' });
        return { archive, sha256, files: entries.length, bytes: (await fs.stat(archive)).size };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const gateway = path.resolve(import.meta.dirname, '..');
    console.log(JSON.stringify(await createDesktopPackage(gateway, process.argv[2] || path.join(gateway, 'outputs/desktop-release'), '0.7.1-t7b-desktop-preview')));
}
