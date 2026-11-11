# WB40 · 使用与维护手册（安装 / 升级 / 回退 / 排障）

面向两类人：**使用者**（在自己机器上跑网关、用桌面外壳、让 Codex 派工）与**维护者**（改源码、打候选、发配对包）。本手册只写本仓库里真实存在、并且本轮实际跑过的命令；标「源码已备、未在本机执行」的部分不当作已验证。

## 1. 前置条件

| 项 | 要求 | 本轮实测 |
|---|---|---|
| 系统 | Windows 10/11 x64 | Windows，x64 |
| Node | ≥ 22.13（`engines` 声明），CI 用 24 | v24.19.0 |
| PowerShell | 5.1+（受限 Job Object 监督器需要） | 5.1 |
| .NET（桌面外壳） | .NET 10 Desktop Runtime（桌面包 `net10.0-windows`，`--no-self-contained`） | 10.0.12 |
| WebView2 | Evergreen Runtime | 随 `desktop/app/WEBVIEW2-LICENSE.txt` 记录 |
| 目录 | gateway 目录可写（SQLite、runs、logs、dist） | 是 |

网关本身只用 Node + 一个 SQLite 文件（`node:sqlite`，Node 24 内置），不需要额外数据库服务。

## 2. 安装

**方式 A：从配对包（推荐）**

```powershell
# 1) 校验完整性（每个 zip 旁有 .sha256）
Get-FileHash .\codex-workbuddy-gateway-v0.7.1.zip -Algorithm SHA256
# 2) 解包
tar -xf .\codex-workbuddy-gateway-v0.7.1.zip -C <安装根>
cd <安装根>\codex-workbuddy-gateway-v0.7.1\gateway
# 3) 按锁文件装运行时依赖（只装生产依赖，8462ms / 本机实测）
node scripts/bootstrap.mjs --install-root . --apply
# 4) 首次诊断
node scripts/doctor.mjs
npm run readiness
```

**方式 B：从源码**

```powershell
cd gateway
npm ci
npm run build
node scripts/bootstrap.mjs --install-root . --apply
```

**安装前先验包（不落地）**

```powershell
node scripts/candidate-installation.mjs check `
  --package .\codex-workbuddy-gateway-v0.7.1.zip `
  --expect-sha256 f160410a933fa3e90a659a82f188f3ad087eceb6c4338335036415256fc26631
# → ok: true, 782 files, problems: []
```

**配对包要成对使用**：桌面外壳与网关来自同一候选，共用 782 个文件逐字节相同。

```powershell
node scripts/verify-pairing.mjs .\codex-workbuddy-gateway-v0.7.1.zip `
  .\desktop\workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip
# → ok: true, shared: 782, mismatched: 0
```

## 3. 首次运行

1. **确认配置目录唯一**：若本机存在多个数据目录，网关会拒绝猜测；用 `WORKBUDDY_CONFIG_DIR` 明确指定（CI 里就是这么做的）。
2. `node scripts/doctor.mjs` 看配置、数据根、原生桥接与技能位置。
3. `npm run readiness` 起一个短命 MCP 进程真调 `workbuddy_health`；输出里 `observer.probes.tool` 必须是 `injected`，否则该层只能是 `unknown`（详见 [WB06](WB06_READINESS_FACTS.md)）。
4. 启动常驻服务与桌面外壳：`cd gateway; npm run workbench`，浏览器打开 `http://127.0.0.1:18493/workbench/`；桌面外壳用配对包里的 `desktop/app/WorkBuddy.Workbench.exe`。
5. 装技能（需你确认写入位置）：

```powershell
cd gateway
npm run skill:check     # 先看漂移，不写盘
npm run skill:install   # 写 Codex 技能位
npm run deepseek:skill:install
```

`skill:check` 会列出 `source / bundled / codex / dsh` 四份副本的漂移与逐条修复计划；旧目录会被移到 `<CODEX_HOME>/skill-backups/`。

## 4. 升级

1. 停掉常驻服务与桌面外壳。
2. **备份数据根**（SQLite + runs）；数据根不要随升级移动。
3. 解新包到**新目录**，`bootstrap --apply`，`doctor` + `readiness`。
4. 用同一 `WORKBUDDY_CONFIG_DIR` 启动新目录，确认任务列表与历史都在。
5. 技能：`npm run skill:check` → `skill:sync`（只更新仓库内副本）→ `skill:install`（写安装位）。
6. 旧目录保留到确认无回退需求为止。

## 5. 回退

1. 停服务 → 指回旧目录 + 同 `WORKBUDDY_CONFIG_DIR` → 启动。
2. 技能回退：把 `<CODEX_HOME>/skill-backups/<name>-*` 移回安装位（`sync-skill.mjs` 的计划里会给出确切路径）。
3. 数据：若新版本已写过库，恢复备份而不是删表；`reconcile` 与 `recovery` 路径见 [WB09](WB09_RECOVERY_MATRIX.md)。
4. 不要用改摘要文件的方式「修好」就绪状态——那正是 WB06 要挡的伪证明。

## 6. 常见错误 → 具体操作

| 错误 / 现象 | 含义 | 操作 |
|---|---|---|
| `COMMAND_SPEC_REQUIRED` | 检查项不是五键 JSON 文本，或是裸命令行 | 改成 `{"executable":…,"args":[…],"cwd":…,"timeoutSeconds":…,"inputs":[…]}`；`inputs` 非空、`cwd` 在工作区内 |
| `COMMAND_SPEC_PATH` | 路径越界或占位符没替换 | 用真实绝对路径；`inputs` 相对 `cwd` 或同在工作区内 |
| `TASK_CONFLICT` | 同初始请求但约定不同，或契约任务想改检查项 | 复用原任务，或新建任务；契约任务改检查项需重新派工 |
| `ACTION_UNAVAILABLE` | 当前 `displayState` 不允许该操作 | 错误串里已列可用操作；按提示先取消/等原生结束/刷新 |
| `STOP_UNCONFIRMED` | 没有可信原生停止证据 | 先取消或等原生结束；不会因超时放行 |
| `REVIEW_REQUIRED` | 需要最新独立审查 | 打开详情里的最新 review，再验收 |
| `ERR_SQLITE_ERROR` + 「请保留原任务编号」 | 并发写超出锁等待预算 | 确认没有第二个进程用同一数据根；必要时 `WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS=30000` |
| `AUTOMATION_NOT_ARMED` | 自动模式未在进程内武装 | 这是预期：`enabled` ≠ `armed`，见 [ADR-01](ADR-01_AUTOMATION_MODES.md) |
| `readiness`：`toolResponsive unknown` | 观察者没注入探针 | 用 `npm run readiness`；别把旧摘要当就绪 |
| `candidateDeployed: another data directory` | 摘要属于另一个数据根 | 用本安装的数据根重跑；或删除外来摘要 |
| `verify-pairing` `ok:false` | 两侧同路径文件字节不同，或边车 sha256 不符 | 重新从同一候选打包；不要混用不同候选的网关与桌面 |
| 桌面外壳启动即退 | 缺 .NET 10 Desktop Runtime / WebView2 | 装运行时；`desktop:test` 能跑说明构建链没问题 |

## 7. 维护者日常

| 目的 | 命令 |
|---|---|
| 类型检查 + 全量后端套件 | `npm run build`；`cmd /c "node --import tsx --test test/**/*.test.ts > suite.log 2>&1"` |
| 工作台前端 | `npm run test:workbench` |
| 桌面策略 | `npm run desktop:test` |
| 技能一致性 | `npm run skill:check`（仓库内副本）/ `test/skill-copies.test.ts`（根与网关副本） |
| 验收矩阵口径 | `npm run acceptance:check` |
| 冻结候选 | `npm run build` → `npm run package -- <out>` → `npm run desktop:build` → `npm run desktop:package -- <out>\desktop` |
| 配对校验 | `npm run release:pairing -- <gateway.zip> <desktop.zip>` |
| 候选预检 | `npm run release:candidate -- check --package <zip> --expect-sha256 <sha>` |

## 8. 已验证 / 未验证

- **已验证（本机，最终解包目录）**：`tar` 解包 → `bootstrap --apply`（`npm ci --omit=dev`，8462ms）→ `probeToolStdio` 对解包后的 `dist/server.js` 返回 `responsive:true`；`candidate-installation check` `ok:true`；`verify-pairing` `ok:true`。
- **未验证（外部条件）**：真实安装位切换、常驻服务随开机启动、真实模型派工、桌面窗口 smoke、签名与 SmartScreen 表现。这些在验收矩阵里按 `blocked`/`unknown` 记录，不用手册文字替代证据。
