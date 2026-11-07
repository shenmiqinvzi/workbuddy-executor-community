# 总回执 — forward 20261107 轮

> 交给复核方（Codex）的入口文件。字段按计划包 `10_验收标准与总回执.md` 的要求排列。
> 本文件不把「源码完成」「真实可用」「正式发行」混为一谈：下面每一行都标明证据档位。

## 1. 当前入口

| 项 | 值 |
|---|---|
| 集成树 | `E:\javaproject\workbuddy-forward-20261107\I-integration` |
| 分支 | `integration/forward-delivery` |
| 起点 | `134cdc7febbf858e89fb1010cf6b9d72da5edbe7`（`workbuddy-finish\R-review-fixes`，分支 `fix/delivery-review-r1-r4`） |
| 本轮最新提交 | 见 §3 末行（提交后如需精确 HEAD，用 `git rev-parse HEAD`；代码最后改动是 `cd631b3` 的 `workbench/attention.mjs` 与 `a44a80c` 的两条测试，其后为文档与 CI 文件，均不进发布包，见 §5 可复现性） |
| 证据根 | `E:\javaproject\outputs\forward-delivery-20261107\`（`A/ B/ C/ D/ I/ shared/`） |
| 续接入口 | `docs/forward/I_CHECKPOINT_2.md`、证据根 `RESUME.md` |
| 计划包 | `E:\javaproject\workbuddy-development-plan-20261107\`（10 个 md） |

## 2. 交付状态（按档位，不合并表述）

| 档位 | 状态 | 说明 |
|---|---|---|
| 源码（source） | 已推进 | 四线全部合入集成树；31 项中 28 项有本轮代码与测试 |
| 合成（synthetic） | 已推进 | 后端全量、工作台、桌面策略三套测试见 §4 |
| 本机（machine） | 局部 | 降级启动真跑、就绪诊断真跑、候选包生成与自检真跑 |
| 窗口（window） | **无** | 桌面壳 WebView 初始化失败，页面渲染/四尺寸/200%/读屏全部未实测 |
| 真实（live） | **无** | 本轮无真实派工、无真实模型调用 |
| 安装（installed） | **隔离根内成立** | 候选 final4 在 `I\candidate-final4-drill` 完成 install / upgrade / rollback-plan，`version-check` 744/744 `exact:true`；用户本机安装仍未做 |
| 发行（release） | **无** | 未推送、未合 main、未加许可宣示 |

结论口径：**M1-D（开发就绪）达成；M1-L（实际可用）未达成；M2-D 部分达成；M2-L 未达成；R 未开始。**

## 3. 合并与提交（集成树）

| 来源 | 提交 | 内容 |
|---|---|---|
| A-runtime | `11d96a5` `0f0a263` `c1b9f8d` `161097e` `27f92fd` `ecedc5c` `3a33d0a` | 启动阶段拆分、五层就绪诊断、两块生命周期空白、有界安装、两个偶发有界化、文档 |
| B-product | 9 提交（`19ef402` `bd6f3c1` `4e63b7a` `e26fe7a` `2cdb97b` `da5c43d` `58813cc` `4e22c2e` `bd9d632`） | 派工三结局、面板恢复、模板期限裁剪、导出比对、五尺寸探针、文档 |
| C-data | 10 提交（`b6edd38` `25787e8` `e49c5ea` `9e00fee` `7af4515` `9dcad9f` `a08fbc3` 等） | 来源能力声明、路由歧义、harness 调用事实、统计契约、quota-2 升版与 DSH sync 生产接线、导出路由 |
| D-automation | 8 提交（`6267e05` `8e35607` `07f7b79` `d50ae78` `70b1803` `ee1cfcc` `a162469` 等） | 六层披露、只读 probe、操作只读路由、幂等派工、socket 修复、文档 |
| I 集成 | `caa7a5fa` `15e23ae` `387a6f6` `02e7de8` `6774476` `804ce30` `1e0597c` `4b04bfa` `65c1d7a` `9898edb` `f47fb4b` `4c2bc16` `6f67b5d` `5ff65f5` `21764ec` `9759288` `cf7241a` `eaadd53` `79e8ba9` `7eee0fa` `cd631b3` `c299e7b` `27e89fc` `a44a80c` `1143d65` + 9 个 merge | local_check 生产端、歧义文案、就绪只读路由、降级启动、产品面接线、打包白名单、MCP 入口隔离、交付入口前移、清理误入日志、总回执与证据、请求归因账本接线、串行基线与可复现候选、桌面成品、IR-A5 记录损坏语义、IR-D3 表归属裁定、透传字段测试、CI 工作流（未跑）、九次合并 |

## 4. 验证（真实输出，命令与日志）

| 门 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 全量后端（串行，候选基线） | `$env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'; npx tsx --test --test-concurrency=1 test/**/*.test.ts` | **1444 tests / 1432 pass / 0 fail / 12 skipped**（exit 0，HEAD `1143d65`） | `I\full-suite-head2.log` |
| 全量后端（默认并发，三轮） | 同上但不加 `--test-concurrency=1` | 三轮均 **恰好 1 fail**（1429 pass / 12 skipped），每轮失败的用例不同且都能单跑通过（见 4.2） | `I\full-suite-final3.log`、`I\full-suite-final3b.log`、`I\full-suite-final3c.log` |
| 工作台 | `npm run test:workbench` | 165 tests / 165 pass / 0 fail（含 IR-A5 的 `IR-A5 an unreadable journal…`） | 终端 |
| 桌面策略 | `npm run desktop:test` | 122 pass / 0 fail | `A\desktop-policy-tests.log` |
| 类型 | `npx tsc --noEmit -p tsconfig.json`、`npm run typecheck:task-view` | 均 exit 0 | 终端 |
| 构建 | `npm run build` | exit 0 | `I\build-final4.log` |
| 候选复算（同一 tree 重打包） | `node scripts/package.mjs <tmp>` | ZIP SHA-256 = `5a791d66…9d39621a`（与候选一致） | `I\repro-head.log` |
| CI 配置 | `.github/workflows/forward-gate.yml`（本轮新增，未执行） | **未跑**：需要推送或第二台机器；不据此声明 CI 档 | — |
| 候选安装演练（隔离根） | `node scripts/candidate-installation.mjs drill --package <final4> --drill-root I\candidate-final4-drill --apply` | exit 0，`ok:true`；含 `truncated_archive`、`digest_mismatch_reported`、`unconfirmed_stop_blocks_install` 等负例全 ok | `I\candidate-final4-drill.log` |
| 候选升级演练 | `… upgrade-drill --package <final4> --drill-root <同上> --apply` | exit 0，`ok:true` | `I\candidate-final4-upgrade.log` |
| 候选回退计划 | `… rollback-plan --package <final4> --to <final3> --install-root <drill> --codex-home <drill>\codex-home` | exit 0，`ok:true`，给出步骤表 | `I\candidate-final4-rollback.log` |
| 安装根版本一致性 | `… version-check --install-root I\candidate-final4-drill\installation --package <final4>` | exit 0，`matched 744 / differing [] / missing [] / exact true / matches true` | `I\candidate-final4-version.log` |

### 4.1 全量后端套件的两个已知非回归噪声

1. **配置目录歧义**：不设 `WORKBUDDY_CONFIG_DIR` 时本机同时存在 `%USERPROFILE%\.workbuddy-ai` 与 `%USERPROFILE%\.workbuddy`，`loadConfig()` 按设计抛错，180 条用例构造即失败（起点树同样失败，已证非本轮回归）。本文件所有全量数字都在固定 `WORKBUDDY_CONFIG_DIR` 下取得。
2. **`dist` 陈旧**：`scripts/workbench-read-store.mjs:7` 从 `../dist/quota-observation.js` 读，源码改了不重建 `dist` 会让桌面只读路径读出版本漂移（本轮确实出现过，`npm run build` 后消失）。因此「改了 `src` 就要 build 再跑该文件」。

### 4.2 默认并发下的一枚轮转失败（不是逻辑回归）

默认并发（每个测试文件一个子进程并行）连跑三轮，每轮都恰好 1 条失败，且三轮各不同：

| 轮 | 失败用例 | 单跑该文件 |
|---|---|---|
| 1 | `test/statistics.test.ts:304` `ledger read: the statistics file reader never creates or migrates the ledger` | 修后 68/68（这是**真回归**：`TaskStore` eager 建 `usage_records`，已改懒建） |
| 2 | `test/desktop-queue.test.ts:141` `active queue listeners are visible only during native claim wait` | 24 tests / 24 pass |
| 3 | `test/desktop-dispatch-e2e.test.ts:73` `a previewed agreement reaches the fake native boundary exactly once` | 1 tests / 1 pass（同 E4） |

判定：轮 2/3 属机器级争用（SQLite 写、目录读与 pid 活跃判定的时序），**同一提交在 `--test-concurrency=1` 下 0 失败**。三轮结果与串行结果都保留，不用串行那次掩盖并发的三次红。

### 4.3 本机真实运行证据（machine 档，合并后复跑）

| 端点 | 结果 | 证据 |
|---|---|---|
| 进程 | 不退出，stdout `{"ok":false,"event":"workbench_http_degraded","port":18999,"code":"CONFIG_UNRESOLVED","readOnly":true}` | `shared\degraded-entry-final.log` |
| `GET /workbench/v1/health` | 200，`ready:false`、`degraded.code=CONFIG_UNRESOLVED`、`capabilities.taskEventsHttp:false` | `shared\degraded-health-final.json` |
| `GET /workbench/v1/readiness` | 200，`selection.state=ambiguous`、候选 `%USERPROFILE%\.workbuddy-ai` 与 `%USERPROFILE%\.workbuddy`、五层 unknown/absent | `shared\degraded-readiness-final.json` |
| `GET /workbench/v1/tasks` | 503 `SURFACE_DEGRADED`，正文就是新的歧义文案（点名候选与两个环境变量、声明不代选不回退） | `shared\degraded-tasks-503-final.json` |
| `node scripts/readiness.mjs`（独立进程） | exit 1，分层状态 + 候选 + 4 条 `Suggested` 命令，未写任何配置文件 | `I\readiness-ambiguous.txt` |
| 同命令固定 `WORKBUDDY_CONFIG_DIR` | exit 1，`backend: desktop-queue`、`config: environment`，`nativeOnline=absent`、`desktopPageReady=absent` | `I\readiness-pinned.txt` |

边界：以上**不**证明桌面壳页面渲染了这些数据（窗口一档仍是 0）。

### 4.4 没跑的门，以及为什么

`npm run verification:preflight` 在未配置的树上直接 `ERR_SQLITE_ERROR: unable to open database file`（`scripts/verification-preflight.mjs:22`）。它按设计要连已配置的库，而本机未安装本轮候选，固定 `WORKBUDDY_CONFIG_DIR` 去跑会打开真实数据目录并可能建表——这属于安装/真实环境动作（外部条件 A2），本轮不越界，记为未跑。

`npm run deployment:check` 同理不跑：`src/deployment-acceptance.ts` 的 `runDeploymentCheck()` 先 `loadConfig()` 再 `diagnose()`，会打开真实数据库；它要求 `--machine-label` 与三个真实任务编号（`--normal-task/--rework-task/--cancel-task`），而本轮没有真实派工，跑出来的 `scenarios` 只能是 `pending`。缺的正是外部条件 A1/A2。

## 5. 候选包（本机生成，非发行）

| 项 | 值 |
|---|---|
| 路径 | `E:\javaproject\outputs\forward-delivery-20261107\I\candidate-final4\codex-workbuddy-gateway-v0.7.1.zip` |
| 字节 | 2,482,365 |
| 条目数 | 745（`candidate-installation` 计 744 个受管文件，`verify-release` 校验 744） |
| ZIP SHA-256 | `5a791d66896b85464087a38d358c9a5ff73e937574085a195a2aea809d39621a` |
| manifest | 120,216 B / SHA-256 `aa83d4929a83d32d00ed8fc46987c85bc7d78513d80677b53099c7aecef7875e` → 副本 `I\candidate-final4-manifest.json` |
| `verify-release.mjs` | `{"version":"0.7.1","verifiedFiles":744,"hashesMatch":true}` → `I\candidate-final4-verify.txt` |
| `candidate-installation.mjs check` | `ok:true`、`problems:[]`、`totalBytes 8121633` → `I\candidate-final4-check.json` |
| 对应提交 | `c299e7b`（含 IR-A5 的 `workbench/attention.mjs` 改动；`git status` 干净） |
| 桌面成品 | **本轮新生成**：`npm run desktop:build`（exit 0，`desktop/app/` 出 `WorkBuddy.Workbench.exe` + `WorkBuddy.Workbench.dll` + WebView2 DLL 与 `runtimes/win-x64/native/WebView2Loader.dll`）→ `npm run desktop:package`（exit 0）→ `workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip`，**752 文件 / 2,903,333 B / SHA-256 `cb3effed00af5e259fca41593a490df2ea2f63ea72fef1c5f8c49e560912c216`**（证据副本 `I\workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip` + `.sha256`，日志 `I\desktop-build.log`、`I\desktop-package.log`）。重打包得到同一 SHA（确定性）。**边界**：只证明「能构建、能打包、包内是本机 Release 产物」，不证明「装上能起窗口」——窗口层仍是 0（WebView 初始化失败、无普通桌面会话）。<br>注：`package-desktop.mjs:17` 有「拒绝覆盖已有桌面包」的守卫，重复执行同一路径会 exit 1 并打印 `Refusing to replace a desktop archive or checksum.`——这是设计，不是失败 |

> 更早的中间包 `outputs\candidate-cp2`（734 文件 / `61dc0456…`）、`candidate-final`（745 文件 / `b3a8a86a…`）、`candidate-final2`（`49c8ba09…`）、`candidate-final3`（745 文件 / `86018f5d…`，对应 `21764ec`）只保留作对照，**不是**本轮候选。final4 与 final3 的差异只有一处源码：`workbench/attention.mjs` 的「记录损坏」独立原因（IR-A5），其余为文档。

**可复现性**：同一 tree 重新打包得到同一 SHA-256（条目时间固定 1980-01-01，压缩参数固定；`docs/forward/**` 不在发布包白名单）。对照包 `I\candidate-repro-check`，说明 `I\candidate-reproducibility.md`。`27e89fc`（只加文档）与 `1143d65`（只加测试与 CI 文件）两次打包仍为 `5a791d66…`——测试与 CI 不在白名单。

**隔离安装根演练**（`I\candidate-final4-drill`，`--apply`；不改用户环境）：

| 步 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 安装 + 负例 | `drill --package <final4> --drill-root … --apply` | exit 0，`ok:true`；负例 `missing_build`/`persistent_service`/`unclosed_task`/`unconfirmed_stop_blocks_install`/`truncated_archive`/`digest_mismatch_reported` 全 `ok:true` | `I\candidate-final4-drill.log` |
| 升级 | `upgrade-drill --package <final4> --drill-root … --apply` | exit 0，`ok:true` | `I\candidate-final4-upgrade.log` |
| 回退计划 | `rollback-plan --package <final4> --to <final3> --install-root <drill> --codex-home <drill>\codex-home` | exit 0，`ok:true`，给出步骤表 | `I\candidate-final4-rollback.log` |
| 版本一致性 | `version-check --install-root <drill>\installation --package <final4>` | exit 0，`matched 744 / differing [] / missing [] / exact true / matches true` | `I\candidate-final4-version.log` |

> 记一次自己的错误用法：第一次把 `--install-root` 指到 drill 根（不是 `installation` 子目录），输出 `matched 0` + 744 条 `missing`、exit 1。改成 `installation` 子目录后才是 744/744。这条留在日志里，免得复核方以为安装根本身不一致。

**边界**：以上都在隔离根内，**不是**用户本机安装；`verification:preflight`、`deployment:check` 仍因会打开真实库而未跑（§4.4）。

## 6. 本轮新增能力（每条都在 §4 有测试）

1. **`local_check_finished` 真实生产**：`TaskReviews.publishCallFact` 在 `checks()`/`runCommand()` 里写真实检查事实，去重键 `review-call:*`，字节取自真实输出文件，未测不写 0。契约 `docs/CALL_EVENT_CONTRACT.md`。
2. **五层就绪诊断 + 就绪只读路由**：`src/readiness.ts`、`scripts/readiness.mjs`、`GET /workbench/v1/readiness`（拒绝查询参数 400、观测失败 503、不回落磁盘版本）。
3. **配置无法解析时降级启动**：`workbench-entry` 分 `serveFull`/`serveDegraded` 两路，进程不退出，`health.ready=false` + `degraded.code=CONFIG_UNRESOLVED`，其余端点 503 `SURFACE_DEGRADED`。
4. **歧义拒绝说人话**：`ambiguityMessage()` 列出候选并点名两个环境变量，声明不代选、不回退。
5. **产品面接线**：模板实例化（时限只取存储政策）、通知失败原因透传、重复回答 `INPUT_ALREADY_ANSWERED`、MCP 进程只读 probe（经 `src/read-only-probe.ts` 门面，自动化模块不进 MCP 入口）。
6. **C 线两项**：quota 文档升 `workbuddy-executor/quota-2` 并兼容 quota-1（旧文档不伪造逐来源读数）；`tool_call_finished` 从真实 DSH `sync()` 事件流生产。
7. **请求归因账本真实接线**：`TaskStore.usage` 懒建（首次写入才建表，保持"从未记录 → 报告不存在"的语义）；`DshTaskCoordinator` 在派工被确认接受（`result.accepted === true` 且 `requestId` 匹配）之后写一条请求观测，每行 `valueKind="unavailable"`、`value=null`——上游从不发 token/credit，所以宁可标"没测到"也不写 0；账本写失败不把已接受的派工改成不确定。测试 `test/dsh-adapter.test.ts` 两条（已确认→两行、未确认→零行）。
8. **桌面成品可构建、可打包**：`desktop:build` → `desktop:package` 两条都 exit 0，产物含 `WorkBuddy.Workbench.exe`/`.dll` 与 WebView2 运行时 DLL（752 文件 / 2,903,333 B / `cb3effed…`）。仍**不**等于能起窗口：窗口层 0 未动。
9. **「记录损坏」在界面上是独立原因**（IR-A5）：任务的事件日志读不出来时，卡片标题写「这一轮的执行记录读不出来」，正文声明这既不是完成也不是失败、不重派/不重试/不关闭，并指向 `unreadable-journal` 来源；卡片带 `data-retryable="false"`/`data-dismissible="false"`。测试 `workbench/test/attention.test.mjs` 的 `IR-A5 an unreadable journal…`（工作台 165/165）。
10. **自动化表归属裁定**（IR-D3，选 b）：四张 `automation_*` 表仍由模块自建并自带 `AUTOMATION_SCHEMA_VERSION`；升级路径（更高版本**在建任何表之前**拒绝）、幂等、回滚、旧库补表四种语义写进 `docs/AUTOMATION_SCHEMA_OWNERSHIP.md`，引 `test/automation-policy.test.ts:348`/`:365` 为证。
11. **两条「不许被传输层吃掉」的字段**：桌面命令的 `preview`/`status` 把会话值原样交回（`test/desktop-command-template.test.ts` 的 `preview and status return the session value untouched…` 断言 `draft.warnings` 与 `receipt.retryable` 都在）；通知快照把「已保存的投递失败」列出来并**只**统计真正尝试过的（`test/productivity-http.test.ts` 的 `a saved delivery failure is reported…` 断言 `deliveryFailures=1` 而两条待办里没尝试过的那条不计）。

## 7. 未满足项（逐条给阻塞原因）

| # | 项 | 阻塞原因 | 需要的外部条件 |
|---|---|---|---|
| 1 | 真实派工（双执行器、非空检查/审查/接受/关闭） | 每个真实任务需逐任务确认执行器/模型/推理档/费用 | A1/A4/A5 |
| 2 | 桌面窗口实测（渲染、四尺寸、200%、读屏） | 本机 WebView 初始化失败，无普通桌面会话 | A9 + 桌面环境 |
| 3 | 真实安装与升级/卸载 | 候选包自检通过，但安装会改变本机环境 | A2 |
| 4 | 异机复现 | 无第二台 Windows 与独立操作者 | A8 |
| 5 | 自动模式 arming 与 `hardCap` | 自动执行需显式授权；来源不支持硬上限时保持 unsupported | A7 |
| 6 | 许可、CI、发行 | 未获授权推送/建远端；CI 工作流本轮已写好但一次都没跑过 | A9/A10 |
| 7 | 53 项矩阵改判 | 一条都没改判，见 `SCENARIO_INDEX.md` | 1–6 完成后自然推进 |

## 8. 已执行的外部动作

- 建立 5 个工作树与 5 个证据目录（本地文件操作）。
- `gateway/node_modules` 用目录联接指向起点树，避免四次重复安装。
- 生成候选包并解压校验（本地文件操作，未安装）。
- 新增 `.github/workflows/forward-gate.yml`（把本轮手工门写成工作流；**只写不跑**，跑它需要推送或第二台机器）。
- **未** 调用任何真实模型、**未** 派工、**未** 安装、**未** 改 MCP/生产配置、**未** 推送。

## 9. 复核入口

```powershell
cd E:\javaproject\workbuddy-forward-20261107\I-integration
git log --oneline -10
git status --porcelain          # 期望为空
cd gateway
npx tsc --noEmit -p tsconfig.json
npm run typecheck:task-view
$env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'
npx tsx --test test/check-call-events.test.ts test/config-ambiguity.test.ts test/readiness.test.ts test/workbench-readiness-route.test.ts
npx tsx --test test/dsh-adapter.test.ts test/statistics.test.ts test/desktop-readonly-resources.test.ts test/workbench-http.test.ts
npx tsx --test --test-concurrency=1 test/**/*.test.ts   # 串行才是干净基线；默认并发每轮会有 1 枚争用失败
npm run test:workbench
npm run desktop:test
node scripts/readiness.mjs        # 未设 config：exit 1 + 候选清单，不写配置

# 候选包复算（期望 ZIP SHA-256 5A791D66896B85464087A38D358C9A5FF73E937574085A195A2AEA809D39621A）
npm run build
node scripts/package.mjs E:\javaproject\outputs\forward-delivery-20261107\I\repro-review
Get-FileHash E:\javaproject\outputs\forward-delivery-20261107\I\repro-review\codex-workbuddy-gateway-v0.7.1.zip -Algorithm SHA256
```

不看源码只看证据的读者：`E:\javaproject\outputs\forward-delivery-20261107\RESUME.md`（续接入口）→ 本文件 §2（状态分档）→ `SCENARIO_INDEX.md`（53 项）→ `TASK_LEDGER.md`（31 项）→ `I\ENV_FINDINGS.md`（环境噪声 E1–E5）→ `I\candidate-reproducibility.md`。
