# I 线集成处置表（本轮）

本文件回答「四条线提的集成请求，I 侧到底做了什么」。每条给：结论、落点（文件:行号级别）、验证、证据等级。

证据等级沿用 `docs/forward/README.md`：`implementation`（源码在、类型过）/ `synthetic`（合成夹具测试）/ `window`（真实窗口）/ `live`（真实执行器派工）/ `installed`（安装根）/ `CI`（远端流水线）/ `release`（发行）。本轮 I 侧新增接线最高只到 `synthetic`。

## IR-A（运行链路与安装）

| 请求 | 结论 | 落点 | 验证 |
| --- | --- | --- | --- |
| IR-A1 `StartupProgress.cs` 入包白名单 | 接受 | `gateway/scripts/package.mjs` 白名单 2 行（A02 自带）、`gateway/test/package.test.ts` | `test/package.test.ts` 通过 |
| IR-A2 `package.json` 加 `readiness` / `bootstrap` 别名 | 接受 | `gateway/package.json` scripts | `npm run` 可解析（见候选验证） |
| IR-A3 两脚本是否入候选包清单 | 接受：`scripts/readiness.mjs`、`scripts/bootstrap.mjs` 进入候选包 | `gateway/scripts/package.mjs` 文件清单 → 受管文件数 696 → 698 | `verify-release.mjs` 报 `verifiedFiles: 698` |
| IR-A4 就绪报告走只读 GET | 已接 | `gateway/src/workbench-http.ts` `READINESS_PATH`；`gateway/src/workbench-entry.ts` | `test/workbench-readiness-route.test.ts` 5/5；本机降级启动实跑 |
| IR-A5 不可读 journal 的 UI 语义 | 未接（本轮不做） | 需要动 `workbench/app.mjs` 的任务详情分支，与 B 线恢复体验耦合 | 无；记为遗留 |
| IR-A6 `respond()` 重复回答映射 409 语义 | 接受（MCP 侧以稳定错误码表达，HTTP 侧无该路由） | `gateway/src/server.ts` `workbuddy_respond_task` 包装：`INPUT_ALREADY_ANSWERED` | `test/run-journal.test.ts`（A 侧断言）+ `tsc` |
| IR-A7 `publishFileSync` 重试 | 仅告知，无需接线 | — | A 侧三条用例 |

A5 说明：MCP/HTTP 没有独立的「回答」写路由，重复回答在 MCP 工具层表现为 `{ok:false, code:"INPUT_ALREADY_ANSWERED", error:"…the first answer is kept…"}`。把它写成 409 需要一个 HTTP 写入口，而本轮工作台仍是只读面，故只在结构化错误码层落地。

## IR-B（产品主流程与工作台）

| 请求 | 结论 | 落点 | 验证 |
| --- | --- | --- | --- |
| B-1 `instantiateTemplate` 的 `policyMaxTimeoutSeconds` 需要调用方 | 接受并接线：新增桌面命令 `productivity_template_instantiate`，时限取自 **stored collaboration policy**，不接受请求体覆盖 | `gateway/scripts/workbench-desktop-commands.mjs`（新分支） | `test/desktop-command-template.test.ts` 5/5（policy 300 夹取 900 → 300；请求带 `timeoutSeconds`/`policyMaxTimeoutSeconds` 直接拒绝） |
| B-2 `draft.warnings[]` / `receipt.retryable` 透传 | 已天然满足：桌面命令把 `session.preview` / `session.receipt` 的返回值原样放进 `value` | `gateway/scripts/workbench-desktop-commands.mjs` `preview` / `status` 分支 | `test/desktop-dispatch.test.ts` 12/12（B 侧），`test/desktop-command-template.test.ts` 证明同一通道不裁剪字段 |
| B-3 `renderControlUnavailable()` 可能返回 `null` | 已满足 | `gateway/workbench/app.mjs:358` 已有 `if (unavailable)` | `node --test workbench/test/controls-render.test.mjs` |
| B-4 通知投递失败可查 | 接受：只读快照新增 `deliveryFailures` 与 `failures[]`，只来自已保存的账本条目 | `gateway/src/productivity-service.ts` `NotificationSnapshotView` / `readNotificationSnapshot` | `test/productivity-service.test.ts`、`test/notification-center.test.ts`、`test/notification-persistent.test.ts` 全绿 |
| B-5 `probe:pages` 脚本登记 | 接受 | `gateway/package.json` | `npm run probe:pages` → `{"ok":true,"sizes":5,"failures":[]}`（B 侧实跑） |
| B-6 `stateInfo().label` 不二次加工 | 已满足 | `gateway/workbench/app.mjs:51` 直接用 `info.label` | `npm run test:workbench` |

B-4 边界：这是「当前仍待办且已保存失败原因」的清单，不是每轮轮询计数器；页面渲染这组字段属 B 线 UI，本轮未画。

## IR-C（资源与真实计量）

C 线仍在收尾，未回执。已由 I 侧先行落地、C 不需要再动的部分：

- `local_check_finished` 生产端 = I 侧 `gateway/src/task-reviews.ts`（提交 `caa7a5fa`），契约 `docs/CALL_EVENT_CONTRACT.md`。
- 待 C 交付：`QUOTA_RESOURCE_SCHEMA` 升 `quota-2` 且消费端同时接受 `quota-1`（当前 `test/desktop-readonly-resources.test.ts` 仍在失败）；`recordHarnessToolCalls` 在 `src` 内 0 调用者，需接在 `gateway/src/dsh-coordinator.ts` 的 `sync()` 末端。

## IR-D（自动政策与恢复）

| 请求 | 结论 | 落点 |
| --- | --- | --- |
| D-1 工作台进程内正式只读 probe | 接受 | `gateway/src/server.ts`：`TaskApplicationService` 第 6 参 `{ probe: createReadOnlyProbe({db, env, catalog}), probeKind:"read_only_local", armed:false }` |
| D-2 导航与 405 覆盖自动化路径 | 已满足 | `gateway/src/workbench-http.ts:390-391` 已含 `AUTOMATION_PATH` 与其子路径；`handleAutomationRequest` 在 `:423-428` 接入 |
| D-3 `automation_*` 四表入统一迁移 | 未接（本轮不做） | 四表由 `automation.ts` 自己的幂等建表路径保证；统一迁移改写会触碰既有安装根，风险大于收益，记为遗留 |
| D-4 组合根用真实 config/env | 已满足 | `gateway/scripts/workbench-desktop-host.mjs`、`gateway/src/workbench-entry.ts` 均从 `loadConfig()` / `process.env` 取值 |
| D-5 页面保留「受控政策执行，仍需每任务确认」 | B 侧页面文案已含；I 侧未改 | `gateway/workbench/automation.mjs` |

## 本轮 I 侧新增接线一览（供复核）

1. `gateway/src/server.ts`：read-only probe 注入（D-1）；重复回答映射 `INPUT_ALREADY_ANSWERED`（A-6）。
2. `gateway/scripts/workbench-desktop-commands.mjs`：`productivity_template_instantiate`（B-1），模板时限只来自存储政策。
3. `gateway/src/productivity-service.ts`：通知快照 `deliveryFailures` / `failures[]`（B-4）。
4. `gateway/package.json`：`readiness`、`bootstrap`、`probe:pages` 三个别名（A-2、B-5）。
5. `gateway/test/desktop-command-template.test.ts`：新增 5 条合成断言。
6. `gateway/test/productivity-service.test.ts`：导出夹具补真实三条事件（原夹具只给游标，计数改为「实际读取条数」后必然为 0）。
7. `gateway/src/read-only-probe.ts`：read-only probe 的门面（新增）。`server.ts` 只能从这里拿到不可派工的观测接口，自动化模块的名字不再出现在 MCP 入口——`test/automation-policy.test.ts:340` 那条「server.ts 不得暴露自动化写工具」的断言就是这么守住的，改回直接 import `./automation.js` 会立刻红。
8. `gateway/scripts/package.mjs` + `gateway/test/package.test.ts`：候选包必须带 `scripts/readiness.mjs`、`scripts/bootstrap.mjs`、`src/readiness.ts`、`dist/readiness.js`、`src/installation-bootstrap.ts`、`dist/installation-bootstrap.js`；打包夹具同步补齐，否则发布包在别人机器上无法自诊断也无法自举依赖。

## IR-C 处置（C 线在合入后补齐）

| 请求 | 结论 | 落点 | 验证 |
| --- | --- | --- | --- |
| C-1 quota 文档契约升版 | 接受：`QUOTA_RESOURCE_SCHEMA` 升 `workbuddy-executor/quota-2`，逐来源 `readings[]` 必填并逐项校验；`workbuddy-executor/quota-1` 作为旧文档只声明「没有逐来源读数」，不伪造 | `gateway/src/quota-observation.ts`、`gateway/workbench/resources-model.mjs`、`gateway/src/statistics-contract.ts` | `test/desktop-readonly-resources.test.ts` 27/27、`test/workbench-http.test.ts`、`workbench/test/resources-model.test.mjs` |
| C-2 `tool_call_finished` 生产端 | 接受：接在 `gateway/src/dsh-coordinator.ts` 的 `sync()` 末端，只从真实 Harness 事件流产出，`observeOnly` 不写 | `gateway/src/dsh-coordinator.ts`、`gateway/src/statistics-harness-calls.ts` | `test/dsh-harness-call-events.test.ts`、`test/statistics-harness-calls.test.ts` |
| C-3 打包守卫夹具 | 已改 `example`，勿回滚 | `gateway/test/statistics-call-events.test.ts:78` | 11/11 |
| C-4 `docs/RESOURCE_DOCUMENT_CONTRACT.md` | 接受 | 见该文件 | — |

> 合入期还发现一条**构建纪律**：`gateway/scripts/workbench-read-store.mjs:7` 从 `../dist/quota-observation.js` 读，源码改了不 `npm run build`，桌面只读路径就会读出版本漂移（本轮真的发生过，`desktop-readonly-resources` 报 `quota-1` vs `quota-2`）。所以「改 `src` → `npm run build` → 再跑该文件」是硬顺序，已写进 `TOTAL_RECEIPT.md` §4.1。

## 仍然缺口（不得在本轮被读成已完成）

- 真实窗口：桌面壳 WebView 初始化仍停 `webview` 阶段，`ready=false`；B-3/B-5/B-6 的视觉效果、五尺寸截图、读屏朗读本轮**没有**在真实窗口里验证。
- 真实派工：RC6 之后没有新的真实执行器任务；`live` 一档仍是 RC1/RC2 的旧记录。
- 安装：只做了隔离安装根与候选包自检，未在这台机器上安装 RC6/本轮候选。
- 自动模式：`armed` 未开，`hardCap` 恒 `unsupported`，逐任务选择层与容量层仍是常量声明。
- 异机 / CI / 许可 / 发行：全部未做。
