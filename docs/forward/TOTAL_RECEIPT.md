# 总回执 — forward 20261107 轮

> 交给复核方（Codex）的入口文件。字段按计划包 `10_验收标准与总回执.md` 的要求排列。
> 本文件不把「源码完成」「真实可用」「正式发行」混为一谈：下面每一行都标明证据档位。

## 1. 当前入口

| 项 | 值 |
|---|---|
| 集成树 | `E:\javaproject\workbuddy-forward-20261107\I-integration` |
| 分支 | `integration/forward-delivery` |
| 起点 | `134cdc7febbf858e89fb1010cf6b9d72da5edbe7`（`workbuddy-finish\R-review-fixes`，分支 `fix/delivery-review-r1-r4`） |
| 本轮最新提交 | `9759288`（代码提交止于 `21764ec`；`9759288` 只改 `docs/forward/**`，不进发布包，见 §5 可复现性） |
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
| 安装（installed） | **无** | 只有隔离安装根自举与候选自检 |
| 发行（release） | **无** | 未推送、未合 main、未加许可宣示 |

结论口径：**M1-D（开发就绪）达成；M1-L（实际可用）未达成；M2-D 部分达成；M2-L 未达成；R 未开始。**

## 3. 合并与提交（集成树）

| 来源 | 提交 | 内容 |
|---|---|---|
| A-runtime | `11d96a5` `0f0a263` `c1b9f8d` `161097e` `27f92fd` `ecedc5c` `3a33d0a` | 启动阶段拆分、五层就绪诊断、两块生命周期空白、有界安装、两个偶发有界化、文档 |
| B-product | 9 提交（`19ef402` `bd6f3c1` `4e63b7a` `e26fe7a` `2cdb97b` `da5c43d` `58813cc` `4e22c2e` `bd9d632`） | 派工三结局、面板恢复、模板期限裁剪、导出比对、五尺寸探针、文档 |
| C-data | 6 提交（`b6edd38` `25787e8` `e49c5ea` `9e00fee` `7af4515` 等） | 来源能力声明、路由歧义、harness 调用事实、统计契约、quota-2 升版与 DSH sync 生产接线 |
| D-automation | 8 提交（`6267e05` `8e35607` `07f7b79` `d50ae78` `70b1803` `ee1cfcc` `a162469` 等） | 六层披露、只读 probe、操作只读路由、幂等派工、socket 修复、文档 |
| I 集成 | `caa7a5fa` `15e23ae` `387a6f6` `02e7de8` `6774476` `804ce30` `1e0597c` `4b04bfa` `65c1d7a` `9898edb` `f47fb4b` `4c2bc16` `5ff65f5` `21764ec` + 5 个 merge | local_check 生产端、歧义文案、就绪只读路由、降级启动、产品面接线、打包白名单、MCP 入口隔离、交付入口前移、清理误入日志、总回执与证据、请求归因账本接线、五次合并 |

## 4. 验证（真实输出，命令与日志）

| 门 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 全量后端（串行，候选基线） | `$env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'; npx tsx --test --test-concurrency=1 test/**/*.test.ts` | **1442 tests / 1430 pass / 0 fail / 12 skipped**（exit 0） | `I\full-suite-serial.log` |
| 全量后端（默认并发，三轮） | 同上但不加 `--test-concurrency=1` | 三轮均 **1442 tests / 1429 pass / 1 fail / 12 skipped**，每轮失败的用例不同且都能单跑通过（见 4.3） | `I\full-suite-final3.log`、`I\full-suite-final3b.log`、`I\full-suite-final3c.log` |
| 工作台 | `npm run test:workbench` | 164 tests / 164 pass / 0 fail | 终端 |
| 桌面策略 | `npm run desktop:test` | 122 pass / 0 fail | `A\desktop-policy-tests.log` |
| 类型 | `npx tsc --noEmit -p tsconfig.json`、`npm run typecheck:task-view` | 均 exit 0 | 终端 |
| 构建 | `npm run build` | exit 0 | 终端 |

### 4.1 全量后端套件的两个已知非回归噪声

1. **配置目录歧义**：不设 `WORKBUDDY_CONFIG_DIR` 时本机同时存在 `%USERPROFILE%\.workbuddy-ai` 与 `%USERPROFILE%\.workbuddy`，`loadConfig()` 按设计抛错，180 条用例构造即失败（起点树同样失败，已证非本轮回归）。本文件所有全量数字都在固定 `WORKBUDDY_CONFIG_DIR` 下取得。
2. **`dist` 陈旧**：`scripts/workbench-read-store.mjs:7` 从 `../dist/quota-observation.js` 读，源码改了不重建 `dist` 会让桌面只读路径读出版本漂移（本轮确实出现过，`npm run build` 后消失）。因此「改了 `src` 就要 build 再跑该文件」。

### 4.3 默认并发下的一枚轮转失败（不是逻辑回归）

默认并发（每个测试文件一个子进程并行）连跑三轮，每轮都恰好 1 条失败，且三轮各不同：

| 轮 | 失败用例 | 单跑该文件 |
|---|---|---|
| 1 | `test/statistics.test.ts:304` `ledger read: the statistics file reader never creates or migrates the ledger` | 修后 68/68（这是**真回归**：`TaskStore` eager 建 `usage_records`，已改懒建） |
| 2 | `test/desktop-queue.test.ts:141` `active queue listeners are visible only during native claim wait` | 24 tests / 24 pass |
| 3 | `test/desktop-dispatch-e2e.test.ts:73` `a previewed agreement reaches the fake native boundary exactly once` | 1 tests / 1 pass（同 E4） |

判定：轮 2/3 属机器级争用（SQLite 写、目录读与 pid 活跃判定的时序），**同一提交在 `--test-concurrency=1` 下 0 失败**。三轮结果与串行结果都保留，不用串行那次掩盖并发的三次红。

### 4.2 本机真实运行证据（machine 档，合并后复跑）

| 端点 | 结果 | 证据 |
|---|---|---|
| 进程 | 不退出，stdout `{"ok":false,"event":"workbench_http_degraded","port":18999,"code":"CONFIG_UNRESOLVED","readOnly":true}` | `shared\degraded-entry-final.log` |
| `GET /workbench/v1/health` | 200，`ready:false`、`degraded.code=CONFIG_UNRESOLVED`、`capabilities.taskEventsHttp:false` | `shared\degraded-health-final.json` |
| `GET /workbench/v1/readiness` | 200，`selection.state=ambiguous`、候选 `%USERPROFILE%\.workbuddy-ai` 与 `%USERPROFILE%\.workbuddy`、五层 unknown/absent | `shared\degraded-readiness-final.json` |
| `GET /workbench/v1/tasks` | 503 `SURFACE_DEGRADED`，正文就是新的歧义文案（点名候选与两个环境变量、声明不代选不回退） | `shared\degraded-tasks-503-final.json` |
| `node scripts/readiness.mjs`（独立进程） | exit 1，分层状态 + 候选 + 4 条 `Suggested` 命令，未写任何配置文件 | `I\readiness-ambiguous.txt` |
| 同命令固定 `WORKBUDDY_CONFIG_DIR` | exit 1，`backend: desktop-queue`、`config: environment`，`nativeOnline=absent`、`desktopPageReady=absent` | `I\readiness-pinned.txt` |

边界：以上**不**证明桌面壳页面渲染了这些数据（窗口一档仍是 0）。

### 4.3 没跑的门，以及为什么

`npm run verification:preflight` 在未配置的树上直接 `ERR_SQLITE_ERROR: unable to open database file`（`scripts/verification-preflight.mjs:22`）。它按设计要连已配置的库，而本机未安装本轮候选，固定 `WORKBUDDY_CONFIG_DIR` 去跑会打开真实数据目录并可能建表——这属于安装/真实环境动作（外部条件 A2），本轮不越界，记为未跑。

## 5. 候选包（本机生成，非发行）

| 项 | 值 |
|---|---|
| 路径 | `E:\javaproject\outputs\forward-delivery-20261107\I\candidate-final3\codex-workbuddy-gateway-v0.7.1.zip` |
| 字节 | 2,481,829 |
| 条目数 | 745（`candidate-installation` 计 744 个受管文件，`verify-release` 校验 744） |
| ZIP SHA-256 | `86018f5d0ee0ae84b966a0d6b9d830099cc0d4b19f4e200dc5837fcef9369593` |
| manifest | 120,216 B / SHA-256 `420372ed45adddaa2dbce5d1a5ca0a6c318ec6aff680296a4f8256dd530ff9cc` → 副本 `I\candidate-final3-manifest.json` |
| `verify-release.mjs` | `{"version":"0.7.1","verifiedFiles":744,"hashesMatch":true}` → `I\candidate-final3-verify.txt` |
| `candidate-installation.mjs check` | `ok:true`、`problems:[]`、`totalBytes 8120343` → `I\candidate-final3-check.json` |
| 对应提交 | `21764ec`（含账本接线；`git status` 除文档外干净） |
| 桌面成品 | 未生成（`npm run desktop:package` 需要 WebView2 构建产物与本机桌面环境；`desktop:test` 122 pass 只证明策略层） |

> 更早两个中间包 `outputs\candidate-cp2`（734 文件 / `61dc0456…`）与 `outputs\candidate-final`（745 文件 / `b3a8a86a…`）、`candidate-final2`（`49c8ba09…`）只保留作对照，**不是**本轮候选。

**可复现性**：同一 tree 重新打包得到同一 SHA-256。`21764ec` 与 `9759288`（只加文档）两次打包均为 `86018f5d…`，字节数均 2,481,829——`scripts/package.mjs` 固定条目时间 1980-01-01 与压缩参数；`docs/forward/**` 不在发布包白名单。对照包 `I\candidate-repro-check`，说明 `I\candidate-reproducibility.md`。

## 6. 本轮新增能力（每条都在 §4 有测试）

1. **`local_check_finished` 真实生产**：`TaskReviews.publishCallFact` 在 `checks()`/`runCommand()` 里写真实检查事实，去重键 `review-call:*`，字节取自真实输出文件，未测不写 0。契约 `docs/CALL_EVENT_CONTRACT.md`。
2. **五层就绪诊断 + 就绪只读路由**：`src/readiness.ts`、`scripts/readiness.mjs`、`GET /workbench/v1/readiness`（拒绝查询参数 400、观测失败 503、不回落磁盘版本）。
3. **配置无法解析时降级启动**：`workbench-entry` 分 `serveFull`/`serveDegraded` 两路，进程不退出，`health.ready=false` + `degraded.code=CONFIG_UNRESOLVED`，其余端点 503 `SURFACE_DEGRADED`。
4. **歧义拒绝说人话**：`ambiguityMessage()` 列出候选并点名两个环境变量，声明不代选、不回退。
5. **产品面接线**：模板实例化（时限只取存储政策）、通知失败原因透传、重复回答 `INPUT_ALREADY_ANSWERED`、MCP 进程只读 probe（经 `src/read-only-probe.ts` 门面，自动化模块不进 MCP 入口）。
6. **C 线两项**：quota 文档升 `workbuddy-executor/quota-2` 并兼容 quota-1（旧文档不伪造逐来源读数）；`tool_call_finished` 从真实 DSH `sync()` 事件流生产。
7. **请求归因账本真实接线**：`TaskStore.usage` 懒建（首次写入才建表，保持"从未记录 → 报告不存在"的语义）；`DshTaskCoordinator` 在派工被确认接受（`result.accepted === true` 且 `requestId` 匹配）之后写一条请求观测，每行 `valueKind="unavailable"`、`value=null`——上游从不发 token/credit，所以宁可标"没测到"也不写 0；账本写失败不把已接受的派工改成不确定。测试 `test/dsh-adapter.test.ts` 两条（已确认→两行、未确认→零行）。

## 7. 未满足项（逐条给阻塞原因）

| # | 项 | 阻塞原因 | 需要的外部条件 |
|---|---|---|---|
| 1 | 真实派工（双执行器、非空检查/审查/接受/关闭） | 每个真实任务需逐任务确认执行器/模型/推理档/费用 | A1/A4/A5 |
| 2 | 桌面窗口实测（渲染、四尺寸、200%、读屏） | 本机 WebView 初始化失败，无普通桌面会话 | A9 + 桌面环境 |
| 3 | 真实安装与升级/卸载 | 候选包自检通过，但安装会改变本机环境 | A2 |
| 4 | 异机复现 | 无第二台 Windows 与独立操作者 | A8 |
| 5 | 自动模式 arming 与 `hardCap` | 自动执行需显式授权；来源不支持硬上限时保持 unsupported | A7 |
| 6 | 许可、CI、发行 | 未获授权 | A9/A10 |
| 7 | 53 项矩阵改判 | 一条都没改判，见 `SCENARIO_INDEX.md` | 1–6 完成后自然推进 |

## 8. 已执行的外部动作

- 建立 5 个工作树与 5 个证据目录（本地文件操作）。
- `gateway/node_modules` 用目录联接指向起点树，避免四次重复安装。
- 生成候选包并解压校验（本地文件操作，未安装）。
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

# 候选包复算（期望 ZIP SHA-256 86018F5D0EE0AE84B966A0D6B9D830099CC0D4B19F4E200DC5837FCEF9369593）
npm run build
node scripts/package.mjs E:\javaproject\outputs\forward-delivery-20261107\I\repro-review
Get-FileHash E:\javaproject\outputs\forward-delivery-20261107\I\repro-review\codex-workbuddy-gateway-v0.7.1.zip -Algorithm SHA256
```

不看源码只看证据的读者：`E:\javaproject\outputs\forward-delivery-20261107\RESUME.md`（续接入口）→ 本文件 §2（状态分档）→ `SCENARIO_INDEX.md`（53 项）→ `TASK_LEDGER.md`（31 项）→ `I\ENV_FINDINGS.md`（环境噪声 E1–E5）→ `I\candidate-reproducibility.md`。
