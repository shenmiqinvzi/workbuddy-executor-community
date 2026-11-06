# L05 验收：可解释推荐

## 1. 范围

本线交付第二批任务 `D4-01`、`D4-02`、`D4-03` 与跨线收口 `D2-04` 的 05 侧：在不调用模型、不创建原生轮次、不自动确认的前提下，给出可审计的“直接处理 / 交给执行器 / 先等人决定”解释，接入桌面预览与确认链路，并保留原有准入与派工语义。

负责文件（本线新增或拥有）：`gateway/src/recommendation.ts`、`gateway/test/recommendation.test.ts`、`gateway/workbench/test/recommendation-view.test.mjs`、`gateway/workbench/dispatch.mjs`、`gateway/workbench/dispatch.css`、根技能六文件及其发布副本、`docs/delivery/L05_RULES.md`、`docs/delivery/L05_INTEGRATION_REQUEST.md`、本文件。

不在本线：真实模型选择确认与实际派工（归 10）、总进度与共享入口接线（`scripts/workbench-desktop-commands.mjs`、`desktop/DesktopControlPolicy.cs` 等由集成人采纳 `L05_INTEGRATION_REQUEST.md`）、06 的模板/通知/导出。

## 2. 基线与提交

| 项 | 值 |
|---|---|
| 基线提交 | `af9bab6f095c19b1ff98b12450e493544a75138d`（`Integrate the first delivery batch and record gate G1`） |
| 基线 tree | `d919434fe8d84a6e5a7ff242b8fdafcb0f2f0abd`（开工时实测，工作树为空） |
| 分支 | `feat/finish-l05-recommendation` |
| 工作树 | `E:\javaproject\workbuddy-finish\L05-recommendation` |
| 实现提交 | `0ea8a49`（`feat: explain executor recommendations before dispatch`，11 个文件、+1363/−4） |
| 验收记录提交 | 本文件与 `HANDOFF.json` 所在的第二个提交（仅文档，SHA 记于外部 `HANDOFF.json`） |

提交后 `git status --porcelain` 为空；未 push、未合 main、未发布、未部署。

## 3. 变更文件

| 文件 | 变更 | 内容 |
|---|---|---|
| `gateway/src/recommendation.ts` | 新增 521 行 | 纯函数评估器：`recommendTask(parameters, catalog, now)`，schema `workbuddy-executor/recommendation-1`，`explanationVersion=1` |
| `gateway/test/recommendation.test.ts` | 新增 279 行 | 18 个单元用例，含源码静态断言（无 fs/net/http/子进程/`fetch(`/`Date.now(`） |
| `gateway/workbench/dispatch.mjs` | +124/−4 | “评估选择”面板、候选回填、确认前漂移门、宿主缺失时静默降级 |
| `gateway/workbench/dispatch.css` | +11 | 面板与列表样式（含 640px 收窄） |
| `gateway/workbench/test/recommendation-view.test.mjs` | 新增 188 行 | 6 个视图用例（解释/降级/回填/漂移阻断/正常派工/统计与资源入面板） |
| `SKILL.md`、`references/dispatch.md` | +2、+46 | 技能说明：口径、字段、分档、未知费用、硬限拒绝、漂移与“推荐不等于授权” |
| `gateway/skills/workbuddy-executor/SKILL.md`、`.../references/dispatch.md` | 同步 | 发布副本与根文件逐字一致（SHA-256 相同） |
| `docs/delivery/L05_RULES.md` | 新增 50 行 | 14 行规则决策表 + 断言 + 测试对应 |
| `docs/delivery/L05_INTEGRATION_REQUEST.md` | 新增 98 行 | `recommend` 动作的两处共享入口 patch、参数/返回契约、可选打包清单与验证步骤 |

## 4. 实现要点

- **决策与理由**：`decision ∈ direct|delegate|wait`，附 `decisionReason.code/message/codes`。`direct` 只在范围 ≤3 项精确路径、检查 ≤3、`maxAttempts=1` 且目标明确时给出，`attempt` 恒 `null`、`nativeAttempt` 恒 `none`；用户显式选择优先于 direct 建议。
- **排除与缺失**：逐个候选记录 `policy_blocked`/`policy_requires_free`/`source_not_online`/`source_not_dispatchable`/`dispatch_not_enabled`/`catalog_expired`/`free_only_not_verified`；缺失分为 `blocks`/`limits` 两级。分类只据结构判断，不把“在线”当“可执行”。
- **费用**：`pricingVerified && credits` 才算已观测；`/^x0(\.0+)?( credits)?$/i` 且已核实才算零费率；未知既不是零也不是硬限。要求硬费用上限时明确 `hard_cost_cap_unsupported` 并 `wait`。
- **排序**：`rank.tier` 1 零费率+资源新鲜、2 零费率、3 已观测费率+资源新鲜、4 已观测费率、5 未知费用，同档按执行选择标识字典序；无 `score`，notes 声明不是质量排名。
- **资源与统计**：资源引用只采纳 `execution` 五项与候选完全相等的那份（不同模型的余量不会互相串用），`routingVerified` 恒 `false`，声明为路由时清空读数并标 `routing_claim_rejected`；统计按 `schemaVersion` 校验，保留样本量与时间窗，`claims.savings/superiority` 恒 `null`。
- **确定性**：`digest` 由输入与快照计算、不含 `generatedAt`；同一意图与同一快照重算得到同一 digest；`previous` 参与时输出 `drift`（`catalog_changed`/`policy_changed`/`selection_changed`/`snapshot_expired`/`snapshot_changed`）。
- **视图**：面板在“执行选择”内、来源与模型之前；先不带资源评估，再对前 5 个候选取 `plan-reference` 二次评估；确认前以 `previous` 重评，`blockedForDispatch` 时提示并中止本次确认；命令缺失或网络失败只提示，不阻断原有派工；`selectionTouched` 保证只有用户动过选择才提交 `constraints.selection`。

## 5. 验证（实测）

环境：Windows，node v24.19.0，npm 11.17.0；worktree 内 `npm ci` 后 100 个包。测试前置清理继承的 `WORKBUDDY_*` 与 `NODE_TEST_CONTEXT`，自建 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`/DB/token 指向 `outputs/finish-l05-20261105/fixture/`，回环设 `NO_PROXY=127.0.0.1,localhost`。

| 命令 | 退出码 | 计数 | 日志 |
|---|---|---|---|
| `npm run build`（`tsc -p tsconfig.json`） | 0 | — | `outputs/finish-l05-20261105/logs/build.log` |
| `npm run typecheck:task-view` | 0 | — | `outputs/finish-l05-20261105/logs/typecheck-task-view.log` |
| `npx tsx --test test/recommendation.test.ts` | 0 | 18 tests / 18 pass / 0 fail | 见下方说明 |
| `node --test workbench/test/*.test.mjs` | 0 | 123 tests / 123 pass / 0 fail | `outputs/finish-l05-20261105/logs/workbench-tests.log` |
| `npm test`（全量，`tsx --test test/**/*.test.ts`） | 0 | 1163 tests / 1151 pass / 0 fail / 12 skipped / 377.9s | `outputs/finish-l05-20261105/logs/full-tests-rerun.log` |
| 技能副本一致性（六文件 SHA-256 对比） | 0 | 6/6 SAME | `outputs/finish-l05-20261105/evidence/skill-files.json` |

说明：

- 专项 18 个用例的输出已并入全量日志（同文件同用例名）；单独运行记录见“失败历史”第 3 条。
- 空测试不算通过：本次每一项都带实际计数，`skipped 12` 是既有平台相关跳过（Windows/POSIX 分支），不是本线新增。
- 未跑 `desktop:test`（PolicyTests）：本线无 C# 变更；C# 白名单改动属集成请求，采纳时需附用例。

## 6. 失败历史（真实发生并已处理）

1. **首次 `npm run build` exit 1**：worktree 无 `node_modules`，找不到 `tsc`。执行 `npm ci --no-audit --no-fund`（added 100 packages，exit 0；esbuild postinstall 未被 allow-scripts 放行但有预编译二进制，tsx 可用）后 build exit 0。
2. **`node --test workbench/test/*.test.mjs` 首轮 exit 1**：`dispatch-diagnostics.test.mjs` 3 例、`dispatch-project.test.mjs` 1 例报 `TypeError: Cannot read properties of null (reading 'candidates')`。根因是旧测试桩对未知动作回 `{ok:true,value:null}`，面板拿到 `null` 仍继续渲染。修法：`refreshRecommendation` 增加 `if (!result || !Array.isArray(result.candidates))` 分支——按“宿主不支持”隐藏面板并返回，不报错、不影响手工流程。修后 123/123。
3. **专项首轮 5/6**：视图测试最后一例的 `answer` 内联对象括号不匹配（`SyntaxError`），另一例在面板尚未渲染时读 `#recommendation-decision.textContent` 抛空引用。改写为具名 `withResources()` 辅助函数并给 `until()` 加空值守卫后 6/6。
4. **全量首轮 172 fail**：全部为 `Multiple WorkBuddy installations or data directories found`（`gateway/src/config.ts:55`）——本机同时存在 `~/.workbuddy` 与 `~/.workbuddy-ai`。按 `COMMON.md` 要求设自建 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`（并自建 DB/token）后降到 1 fail。
5. **全量第二轮 1 fail**：`workbench-http.test.ts` 的 entry 子进程用例报 `status 400`。原因是我额外设置了 `WORKBUDDY_RUNS_DIR`，而该用例刻意只设 `WORKBUDDY_DB_FILE` 以验证“runs 目录默认在数据库旁”；去掉 `WORKBUDDY_RUNS_DIR` 后该用例通过。
6. **全量第三轮 1 fail（环境性波动）**：`run-worker.test.ts:94` 的 detached worker 在全量并发下等待超时（`promptCount=0`，快照仍 `queued`）；该用例单独连跑 3 次均通过（1.33s/1.41s/1.36s）。属既有测试的时序敏感，与本线改动无关；第四轮全量 1163/1151/0 fail。
7. **技能文档追补**：`references/dispatch.md` 首次写入时把示例段落留在了 DSH 小节之后、且测试名与实际不符；已按实际用例名重写“对应测试”表，并把示例移到独立小节。

## 7. 局限与未完成

- **产品可达性待集成**：`recommend` 桌面动作需要 `scripts/workbench-desktop-commands.mjs` 与 `desktop/DesktopControlPolicy.cs` 两处共享入口改动；本线只交 patch 与契约，未改这两处。因此**当前树上**：合成宿主（测试桩）能读到解释并重选；正式桌面壳在集成前会走“面板隐藏、手工流程照旧”的降级。
- **仅合成验证**：全部结论来自合成目录、合成统计、合成资源引用与测试桩；没有接真实 WorkBuddy 资源、真实会话或真实计费。`syntheticVerified=true`、`liveVerified=false`。
- **未做真实模型确认与派工**：归 10，本线不预授权、不代确认。
- **未验证 C# 侧**：patch 未落地，故未跑 `desktop:test`；采纳时需补 `Decode` 用例。
- **不做质量评分**：只有“费用是否已核实为零 + 资源引用是否新鲜”的分档；没有统计时如实说“不可用”，不宣称更省或更强。
- **explanationVersion=1**：口径若变（新增档位、改判定顺序）必须递增，否则旧 digest 会被误读为同一解释。

## 8. 运行与部署状态

| 维度 | 状态 |
|---|---|
| 源码完成 | 是（引擎、视图、技能、规则表、集成请求、测试） |
| 合成通过 | 是（专项 18 + 视图 6 + workbench 123 + 全量 1163） |
| 窗口通过 | 未做（本线不启动正式桌面壳） |
| 真实模型通过 | 未做（属 10） |
| 异机通过 | 未做 |
| 已合入 | 否（分支 `feat/finish-l05-recommendation`，未合 main） |
| 已部署 / 已发布 | 否 |

回环与进程：测试使用回环端口与临时目录，`npm test` 结束时进程自行退出；未留下常驻服务，未改本机 WorkBuddy profile、未安装桥接、未触碰 `~/.workbuddy*` 下的真实数据。

## 9. 证据

- 日志：`E:\javaproject\outputs\finish-l05-20261105\logs\`
- 合成环境与一致性证据：`E:\javaproject\outputs\finish-l05-20261105\evidence\`、`...\fixture\`
- 交接：`E:\javaproject\outputs\finish-l05-20261105\HANDOFF.json`
