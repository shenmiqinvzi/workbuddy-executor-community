#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectPackageSources, assertSafeContent } from './package.mjs';
import { zipDirectory } from './zip.mjs';

const appFiles = ['WorkBuddy.Workbench.exe', 'WorkBuddy.Workbench.dll', 'WorkBuddy.Workbench.deps.json', 'WorkBuddy.Workbench.runtimeconfig.json', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'runtimes/win-x64/native/WebView2Loader.dll', 'WEBVIEW2-LICENSE.txt'];
const guideName = 'PREVIEW-START-HERE.md';
export const previewGuide = (version) => `# WorkBuddy 桌面预览 · 启动说明（v${version}）

这个预览包**故意不携带 \`node_modules\`**：网关依赖需要你在解包后安装一次。工作台启动时会先检查依赖，缺什么会在窗口里直接指出目录和恢复命令，不会自动安装，也不会写全局配置。

## 1. 解包

把 zip 解到任意本地目录，得到：

- \`gateway\\\`：网关与工作台资源（含 \`scripts\\bootstrap.mjs\`）
- \`gateway\\desktop\\app\\WorkBuddy.Workbench.exe\`：桌面壳
- \`RELEASE_MANIFEST.json\`：本包清单（桌面校验入口读它）

## 2. 安装网关依赖（必须做一次）

先确认当前目录是**解包目录**（能看到 \`gateway\` 目录和 \`RELEASE_MANIFEST.json\` 的那一层），再任选一种：

\`\`\`powershell
# 方式 A：走网关自带引导（复用本地 npm 缓存，缺什么装什么）
# --apply 必须带：不带时引导只打印计划并以 0 退出，node_modules 不会出现
node gateway\\scripts\\bootstrap.mjs --install-root gateway --apply

# 方式 B：直接走 npm
cd gateway
npm ci --omit=dev
\`\`\`

命令里的路径含空格时，用引号把脚本路径和安装根分别括起来：

\`\`\`powershell
node "gateway\\scripts\\bootstrap.mjs" --install-root "gateway" --apply
\`\`\`

装完确认：\`gateway\\node_modules\\zod\\package.json\` 与 \`gateway\\node_modules\\@modelcontextprotocol\\sdk\\package.json\` 都存在；引导输出里应有 \`"apply": true\` 与 \`npm_ci\` 成功记录。

## 3. 运行前置

| 需要 | 检查方式 |
| --- | --- |
| Windows x64 | — |
| Node.js ≥ 22.13 | \`node --version\` |
| .NET Desktop Runtime 10 | 双击 exe 不报缺运行库 |
| WebView2 Runtime | 系统已装（多数 Win11 自带） |

## 4. 启动与自检

1. 先校验包完整性（**安装依赖前就能跑**，只读，不改任何文件）：\`node gateway\\scripts\\verify-desktop.mjs\`，应输出 \`"hashesMatch": true\`。
2. 双击 \`gateway\\desktop\\app\\WorkBuddy.Workbench.exe\`；窗口标题应为「WorkBuddy · 任务工作台」。
3. 单独下载的**网关 ZIP** 才有自己的校验入口：在网关解包根跑 \`node scripts\\verify-release.mjs\`。桌面包里 \`gateway\` 目录下没有 \`RELEASE_MANIFEST.json\`（清单只在包根），所以在桌面包里跑它会报 ENOENT，属预期。

首次打开时若提示缺少任务库，先核对窗口报告的路径。确认要初始化全新的任务库后，在 \`gateway\` 目录运行 \`node scripts/init-state.mjs\`。已有任务库应使用其原路径。

## 5. 窗口报错怎么读

| 窗口提示 | 含义 | 处理 |
| --- | --- | --- |
| 网关依赖未安装 / 不完整（附目录与缺失列表） | \`node_modules\` 不存在或缺包 | 回第 2 步 |
| 未找到 Node.js | 找不到 node.exe | 安装 Node.js，或设 \`WORKBUDDY_NODE_EXE\` |
| 网关目录不完整 | 缺 \`scripts\\workbench-desktop-host.mjs\` | 重新解压 |
| 需要 Microsoft Edge WebView2 Runtime | 系统缺 WebView2 | 安装官方运行时 |
| 工作台暂时无法连接 | 宿主启动失败等其他原因 | 看窗口「启动进度」里的失败阶段，再按提示处理 |
`;
export async function createDesktopPackage(gateway, output, version) {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid desktop package version.');
    gateway = path.resolve(gateway); output = path.resolve(output);
    const name = 'workbuddy-desktop-v' + version, archive = path.join(output, name + '.zip');
    await fs.mkdir(output, { recursive: true });
    for (const target of [archive, archive + '.sha256']) {
        try { await fs.lstat(target); throw new Error('Refusing to replace a desktop archive or checksum.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const sources = await collectPackageSources(gateway);
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-desktop-package-'));
    const entries = [];
    async function copyFrom(relative, destination, source, root, scan = true) {
        let current = root;
        for (const part of relative.split('/')) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked desktop package input.'); }
        if (!(await fs.stat(source)).isFile()) throw new Error('Missing desktop package file.');
        const bytes = await fs.readFile(source);
        if (scan) assertSafeContent(relative, bytes.toString('utf8'));
        const target = path.join(stage, destination); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
        entries.push({ path: destination, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    async function write(relative, text) {
        const target = path.join(stage, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text, 'utf8');
        const bytes = Buffer.from(text, 'utf8');
        entries.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    try {
        for (const entry of sources) await copyFrom(entry.relative, 'gateway/' + entry.relative, entry.source, entry.root);
        for (const relative of appFiles) await copyFrom('desktop/app/' + relative, 'gateway/desktop/app/' + relative, path.join(gateway, 'desktop/app/' + relative), gateway, false);
        await write(guideName, previewGuide(version));
        await fs.writeFile(path.join(stage, 'RELEASE_MANIFEST.json'), JSON.stringify({ project: 'workbuddy-desktop', version, prerequisites: ['Windows x64', '.NET Desktop Runtime 10', 'WebView2 Runtime', 'Node.js >=22.13 and installed gateway dependencies'], coverage: { gateway: sources.length, app: appFiles.length, guide: 1 }, files: entries }, null, 2));
        await zipDirectory(stage, archive, name);
        const sha256 = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
        await fs.writeFile(archive + '.sha256', sha256 + '  ' + path.basename(archive) + '\n', { flag: 'wx' });
        return { archive, sha256, files: entries.length, bytes: (await fs.stat(archive)).size };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const gateway = path.resolve(import.meta.dirname, '..');
    console.log(JSON.stringify(await createDesktopPackage(gateway, process.argv[2] || path.join(gateway, 'outputs/desktop-release'), '0.7.1-t7d-desktop-preview')));
}
