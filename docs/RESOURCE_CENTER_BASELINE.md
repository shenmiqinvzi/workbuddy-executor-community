# 资源中心统一开发基线（本地集成收尾）

记录日期：2026-11-04。范围：资源中心前端页 + 桌面只读资源适配缺陷修复的本地集成收尾。
本文件只描述"现在是什么状态、证据挂在哪里"，实现细节见 [RESOURCE_DESKTOP_READONLY_FIX.md](RESOURCE_DESKTOP_READONLY_FIX.md) 与 [RESOURCE_INTEGRATION_ACCEPTANCE.md](RESOURCE_INTEGRATION_ACCEPTANCE.md)。

## 1. 基线标识

| 项目 | 值 |
| --- | --- |
| 仓库 | `E:\javaproject\workbuddy-resource-integration` |
| 分支 | `integration/resource-center` |
| 本轮起点 | `0bb9ffe`（Record desktop resource acceptance defect） |
| 纳入方式 | `git merge --ff-only fix/desktop-readonly-resources`，无 cherry-pick 副本 |
| 纳入提交 | `c5cf788`（Fix desktop read-only resource facade）、`a8ce8f0`（Record the desktop read-only fix and new candidate acceptance） |
| 已验收候选包 | `E:\javaproject\outputs\resource-desktop-fix-20261104\package\codex-workbuddy-gateway-v0.7.1.zip` |
| 包 SHA-256 | `60b79f56f738c995cbda9117a009fa1b2aa3697efe672a69d68b1b95782358ce` |
| 包内文件数 | 552（发布清单 `RELEASE_MANIFEST.json`，侧车与包内副本同哈希 `7a1786fc…`） |
| 快照清单 | `gateway/SNAPSHOT_MANIFEST.json`，316 个跟踪文件 |

## 2. 状态分级

同一件事在不同层面含义不同，分开记，不互相代替。

| 层面 | 资源页与桌面只读修复 |
| --- | --- |
| 源码已实现 | 是。资源页四个前端模块与桌面只读 facade（`quotas` / `creditBalances` / `operations`）已在集成分支上 |
| 自动测试已通过 | 是。见第 3 节命令与结果，均为本轮在集成分支上实跑 |
| 浏览器 / 桌面实窗已验证 | 是，但**归属特定包**：浏览器 128/128、WebView2 71/71 都跑在 `60b79f56…` 这个包上，源码提交 `c5cf788` |
| 已纳入本地集成分支 | 是。`integration/resource-center` 现指向 `a8ce8f0` |
| 已部署生产 | 否。未改生产安装、`.env`、账号、模型政策或原生数据库 |
| 已正式发布 | 否。未推送、未合 main、未发布 |

## 3. 本轮验证命令与结果

| 命令（`gateway/` 目录） | 结果 | 退出码 |
| --- | --- | --- |
| `npm run build` | tsc 通过 | 0 |
| `npm run typecheck:task-view` | tsc 通过 | 0 |
| `npx tsx --test test/desktop-readonly-resources.test.ts` | 14/14 | 0 |
| `npx tsx --test test/quota-observation.test.ts test/credit-balance.test.ts test/quota-entry.test.ts test/capacity-resource.test.ts test/t4a-operation-admission.test.ts`（与上一行合并执行） | 合计 69/69 | 0 |
| `npx tsx --test test/workbench-http.test.ts test/workbench-assets.test.ts test/workbench-panel.test.ts test/package.test.ts test/task-application-service.test.ts test/evidence-consistency.test.ts`（需隔离 env） | 61/61 | 0 |
| `npm run test:workbench` | 100/100 | 0 |
| `node scripts/generate-snapshot-manifest.mjs` | 316 文件 | 0 |
| `node verify-snapshot.mjs` | `{"snapshotFilesVerified":316,"hashesMatch":true,"manifestCompleteness":"checked"}` | 0 |
| `git diff --check` | 无空白错误 | 0 |

`task-application-service`、`workspace-workers` 一类测试会走 `loadConfig`；本机存在多个 WorkBuddy 安装时报 `Multiple WorkBuddy installations or data directories found`（`src/config.ts:55`），属**环境歧义**，不是产品缺陷。设 `WORKBUDDY_CLI_ELECTRON` / `WORKBUDDY_CONFIG_DIR` 指向空样本（`outputs\resource-center-integration-20261104\env`）后通过。

## 4. 快照与源码一致性

- 修复改动过的 4 个文件与新增回归测试原先未同步到 `SNAPSHOT_MANIFEST.json`，`verify-snapshot.mjs` 报 `Snapshot mismatch: scripts/workbench-read-store.mjs`。
- 用仓库脚本重新生成后通过；清单变动 = 4 个已改文件 + 1 个新增测试文件。
- `capturedAt` 保持 `2026-10-23T00:39:39.586Z`，上游 provenance 字段原样保留（生成器默认继承，未传 `--captured-at`）。
- 未手写哈希、未修改验证器、未把 `dist` 加入 Git。

## 5. 集成分支与已验收包的对应关系

问题：集成后的运行代码，是否就是浏览器 128 项与 WebView2 71 项验证过的代码？

结论：**运行文件一致，不需要新候选包。**

- 方法：用 `gateway/scripts/package.mjs` 导出的 `collectReleaseFiles()` 取当前集成分支的发布文件集合，对每个文件计算 SHA-256，与已验收包的 `RELEASE_MANIFEST.json` 逐条比对（脚本 `outputs\resource-center-integration-20261104\compare-runtime.mjs`，结果 `runtime-consistency.json`）。
- 在 `a8ce8f0` 上：552 / 552 文件路径与哈希全等，`identical: true`。
- 加入容量损坏态用例后：551 个文件仍逐字节一致，唯一差异是 `test/desktop-readonly-resources.test.ts`（回归测试，运行时不加载），`runtimeIdentical: true`。
- 逐项核对过的关键运行文件：桌面只读脚本 `scripts/workbench-read-store.mjs`；查询源码 `src/quota-observation.ts`、`src/credit-balance.ts`、`src/operation-admission.ts`、`src/capacity-view.ts` 与对应 `dist/*.js`；资源页 `workbench/resources.mjs`、`resources-model.mjs`、`resources-source.mjs`、`resources.css`；静态资源白名单 `dist/workbench-assets.js`；打包规则 `scripts/package.mjs`（`WORKBENCH_FILES`、`DIRECTORY_RULES`）。
- 因此 §2 的实窗结论仍成立，证据明确挂在包 `60b79f56…` / 源码 `c5cf788` 上，不改写为"测过新包"。

## 6. 证据归属

| 证据 | 位置 | 归属 |
| --- | --- | --- |
| 修复说明与验收细节 | `docs/RESOURCE_DESKTOP_READONLY_FIX.md` | 源码 `c5cf788` |
| 桌面 host 资源接口 200 | `outputs\resource-desktop-fix-20261104\desktop\desktop-host-results.json` | 包 `60b79f56…` |
| 浏览器 128/128 | `outputs\resource-desktop-fix-20261104\browser\reports\{scenarios.json,checks.log,summary.json}` + `shots/` 20 张 | 包 `60b79f56…` |
| WebView2 71/71 | `outputs\resource-desktop-fix-20261104\desktop\{webview-acceptance.json}` + `shots/W01–W13` | 包 `60b79f56…` |
| 上一轮旧包失败事实 | `docs/RESOURCE_INTEGRATION_ACCEPTANCE.md`「2026-11-04 桌面实窗补充」 | 旧包 `70c94282…` |
| 本轮一致性核对 | `outputs\resource-center-integration-20261104\runtime-consistency.json` | 集成分支 HEAD |

旧包、旧报告与旧截图均在原位，未覆盖。截图内均标注「隔离合成数据 · 非真实额度」。

## 7. 已完成与未完成

本轮可记为完成：

1. 桌面 quota / credit / capacity 只读适配缺陷修复（三条链路实窗 200，容量为 `occupied:null` 的明确空闲事实）。
2. 该候选适用的浏览器与 WebView2 实窗子项（三宽度、键盘、故障恢复、竞态、导航、嵌入面板、关闭重开）。
3. 修复提交纳入本地集成分支。
4. 快照与源码一致性收尾。

仍待处理（不能因上面的完成而视为通过）：

- D3-01：当前真实上游来源联调（真实 token 统计链路、积分缓存、真实账号）。
- D3-02：可信 Key 路由、区域 / 模型限制与共享池映射；未核验范围继续只显示网关汇总。
- D3-03：任务方案关联（资源与任务方案的映射仍未实现）。
- D3-04：运行中任务监督与停止的端到端故障隔离。
- D0/D1 剩余验收。
- 主分支合入、生产部署、正式发布。

## 8. 下一项任务与前置条件

下一项：**D3-03 的任务方案关联**——把资源视图与任务方案（执行器 / 模型 / 区域）建立可核验映射，而不是继续扩展页面样式。

前置条件：

1. 需要一条已核验的任务方案到模型标识的真实映射来源（当前 `routing_unverified` 未解除，D3-02 未完成）。
2. 需要在隔离环境准备可重放的合成方案数据，包含已映射与未映射两类，避免把"未核验"渲染成"任务可用"。
3. 沿用本轮基线：`integration/resource-center` + 包 `60b79f56…`；若 D3-02 先提供真实路由证据，则先更新该证据再改前端，避免界面先于契约。

## 9. 复现

```powershell
cd E:\javaproject\workbuddy-resource-integration\gateway
npm run build
npx tsx --test test/desktop-readonly-resources.test.ts
npm run test:workbench
node scripts/generate-snapshot-manifest.mjs
node verify-snapshot.mjs

# 运行文件与已验收包的一致性核对（只读，不打包）
cd E:\javaproject\outputs\resource-center-integration-20261104
node compare-runtime.mjs
```
