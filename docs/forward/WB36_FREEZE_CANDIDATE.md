# WB36 · 冻结候选检查报告

本轮冻结的候选是隔离工作树 `E:/javaproject/workbuddy-forward-20261107/R-executor-plan-20261111`（分支 `feat/executor-plan-20261111`，基线提交 `0919201`）的工作区内容。**该候选尚未提交**：HEAD 仍是 `091920115e2c655e0024f00dc35b6b5ae5011d12`，工作区有 65 条改动路径，因此候选身份由「内容摘要 + 改动清单」而不是「提交号」绑定，见 §4。

## 1. 规定检查与结果

| 检查 | 命令（cwd = `gateway/`） | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 构建 | `npx tsc -p tsconfig.json` | 0 | dist 重建，无错误 | — |
| 任务视图类型 | `npm run typecheck:task-view` | 0 | 无错误 | — |
| 后端全量 | `node --import tsx --test test/**/*.test.ts` | 0 | **1563 tests / 1551 pass / 0 fail / 12 skipped**，408704ms | `outputs\executor-plan-20261111\suite-wb38.log` |
| 工作台 | `node --test workbench/test/*.test.mjs` | 0 | **169 / 169 pass** | `wb36-workbench.log` |
| 桌面策略 | `dotnet run --project desktop/test/PolicyTests.csproj -c Release` | 0 | **133 pass / 0 fail**（另有 1 条按权限跳过） | `wb36-desktop.log` |

跨版本对照（保留失败历史，不用较旧全绿覆盖较新两失败）：

| 日志 | tests | pass | fail | 说明 |
| --- | --- | --- | --- | --- |
| `suite-baseline2.log` | 1513 | 1501 | 0 | WB05 修复后的起点基线 |
| `suite-wb03b.log` | 1520 | 1504 | 4 | 三处负载相关失败，已逐条归因修复（见 WB00/WB06 记录） |
| `suite-wb13.log` | 1552 | 1540 | 0 | WB01/02/11/13 后 |
| `suite-freeze.log` | 1555 | 1542 | 1 | `desktop-dispatch-e2e` 在并发下遇 `ERR_SQLITE_ERROR`（锁等待预算 3s/5s 被 fsync 拖过），单独跑通过 |
| `suite-freeze2.log` | 1557 | 1545 | 0 | 引入 `src/sqlite-busy.ts`（默认 15s、可用 `WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS` 收紧）并补 2 条测试后全绿 |
| `suite-wb38.log` | 1563 | 1551 | 0 | 安装演练期间修掉 DSH 技能派生源的误报（`scripts/sync-skill.mjs` + 1 条新用例）后重跑，**当前候选的全绿证据** |

失败历史没有被覆盖：`suite-freeze.log` 与其失败名原样保留。

## 2. Skip 清单（12 条，逐条给出条件与替代证据）

| 类别 | 用例 | 跳过条件 | Windows 上的替代证据 |
| --- | --- | --- | --- |
| POSIX-only × 6 | `authenticated Unix socket RPC selects the host…`、`registry selection rejects public files…`、`socket timeout does not retry…`、`stale registry from a dead pid…`、`MCP health returns sanitized choices…`、`all Node launchers load the shipped example config…` | 夹具需要真实 Unix domain socket（`*.sock`）与 `chmod 0755` + `PATH=/usr/bin:/bin` 的 `#!/bin/sh` 启动器 | Windows 侧用命名管道 + ACL 校验的等价用例（`dsh-transport`/`workbench-http`/`private-path`）与 `.cmd` 启动器用例，本套件内全绿 |
| macOS 生命周期 × 6 | `setup restart uses the native application quit event…`、`a native root refusing quit…`、`a replacement native root or newly occupied port…`、`active or unavailable persisted status evidence…`、`an initialized empty desktop history…`、`archived, terminated, and error historical sessions…` | 夹具模拟 macOS 应用退出事件与端口接管时序 | 同类策略在 `desktop/test/PolicyTests.csproj`（133 条）与 `desktop-control-runtime`/`persistent-service` 用例中覆盖 |

没有「未解释」的跳过：每条跳过都带平台条件与替代证据；也没有把跳过当通过。

## 3. 源码影响范围（本轮相对 0919201）

- 新增源码：`gateway/src/command-spec.ts`、`gateway/src/readiness-probes.ts`、`gateway/src/sqlite-busy.ts`。
- 修改源码：`bounded-command.ts`、`coordinator.ts`、`deepseek-coordinator.ts`、`deepseek-server.ts`、`server.ts`、`task-store.ts`、`service-cli.ts`、`readiness.ts`、`workbench-entry.ts`、`workspace-protection.ts`、`workspace-workers.ts`、`desktop-control.ts`、`desktop-control-journal.ts`、`desktop-control-runtime.ts`、`desktop-dispatch-journal.ts`。
- 脚本：`bounded-job.ps1`、`readiness.mjs`、`sync-skill.mjs`（新）、`check-acceptance-matrix.mjs`（新）、`verify-pairing.mjs`（新）、`workbench-desktop-host.mjs`、`private-path.mjs`。
- 技能与快照：根 `SKILL.md`、`references/dispatch.md`、网关副本两份、`SNAPSHOT_MANIFEST.json`（459 → 464 条目）。
- 测试：新增 10 个路径（9 个 `.test.ts` + `test/support/command-spec.ts`）、修改 10 个文件；净增 50 条用例（1513 → 1563）。

风险面集中在四处，均已在对应任务卡里单列：命令检查的结构化预检（WB03）、监督器阶段预算（WB05）、SQLite 锁等待预算（本轮，属等待预算而非放宽校验）、就绪探针只读边界（WB06）。

## 4. 候选身份

| 项 | 值 |
| --- | --- |
| 基线提交 | `091920115e2c655e0024f00dc35b6b5ae5011d12` |
| 分支 | `feat/executor-plan-20261111`（未提交，77 条改动路径） |
| 清单摘要（按最终 `SNAPSHOT_MANIFEST.json` 的 `path:sha256` 排序后 sha256） | `7b81cdae4f03d2f414b269ac19ec930a9a8ea545e903c49ff44426d5c5d3d75c`（464 文件）；发布产物见 [WB37](WB37_PAIRED_RELEASE.md) |
| 运行环境 | Windows `win32 x64`，Node `24.19.0`，npm `11.17.0`，.NET SDK（`dotnet` 在 `C:\Program Files\dotnet`） |

复现命令（干净检出后，`gateway/` 下）：

```powershell
npm ci
npx tsc -p tsconfig.json
npm run typecheck:task-view
node --import tsx --test test/**/*.test.ts
node --test workbench/test/*.test.mjs
dotnet run --project desktop/test/PolicyTests.csproj --configuration Release
```

## 5. 未覆盖

- 提交与远端 CI 回执：工作区未提交、未推送（用户未要求），WB42 的「最终 HEAD 的 CI 成功回执」仍是外部条件。
- 实机/实窗：本报告只证明源码级候选自洽，不证明安装后的运行身份，也不证明真实窗口。
- 序列化耗时：全量 454811ms 为本机与当前并发度下的数值，不作跨机承诺。
