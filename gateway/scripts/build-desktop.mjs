#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Build the desktop application on Windows with .NET SDK 10.');
const gateway = path.resolve(import.meta.dirname, '..');
const output = path.join(gateway, 'desktop', 'app');
if (fs.existsSync(output)) {
    if (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output).toLowerCase() !== output.toLowerCase()) throw new Error('Refusing a linked desktop output directory.');
    // Only generated app files live here; WebView2 user data lives in LocalAppData.
    fs.rmSync(output, { recursive: true, force: true });
}
for (const args of [
    ['restore', 'desktop/WorkBuddy.Workbench.csproj', '--locked-mode', '--source', 'https://api.nuget.org/v3/index.json'],
    ['publish', 'desktop/WorkBuddy.Workbench.csproj', '--configuration', 'Release', '--no-restore', '--no-self-contained', '--output', 'desktop/app'],
]) {
    const result = spawnSync('dotnet', args, { cwd: gateway, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!fs.existsSync(path.join(gateway, 'desktop/app/WorkBuddy.Workbench.exe'))) throw new Error('Desktop executable was not produced.');
console.log(JSON.stringify({ built: true, directory: 'desktop/app', prerequisites: ['Windows', '.NET Desktop Runtime 10', 'WebView2 Runtime', 'gateway Node.js dependencies'] }));
