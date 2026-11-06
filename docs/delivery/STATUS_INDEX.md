# 交付完成阶段现状（集成人维护，唯一现状入口）

本文件是 `workbuddy-executor` 交付完成阶段的唯一现状入口。分支 `integration/delivery-finish`，工作树 `E:\javaproject\workbuddy-finish\I-integration`。
只记录本轮可证事实：命令、退出码、计数、提交哈希、包摘要。`sourcePassed` 与 `liveReady` 分开；未执行的项写「未执行」，不预填通过。
原始日志、回执与解包候选在 `E:\javaproject\outputs\finish-integration-20261105\{G0,G1,G2,G3}\`（不入 Git）。

## 阶段与 gate

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| G0 | 集成分支、三线合入 A/B/C、基线提交、L01–L04 开工清单 | 已完成 |
| 第一批 | L01–L04 开发交付 | 已交付 |
| G1 | L01–L04 合入、接线、检查、候选包 | 已完成（源码与合成候选通过；真实验收未执行） |
| 第二批 | L05–L06 开发交付 | 已交付 |
| G2 | L05–L06 合入、接线、检查、候选包 | 已完成（源码与合成候选通过；真实验收未执行） |
| 第三批 | L07–L08 开发交付 | 已交付 |
| G3 | L07–L08 合入、接线、端到端合成联调、RC 冻结与影响表 | 已完成（源码与合成候选通过；真实验收未执行） |
| 10 | 真实验收（真实安装、登录、真实模型派工、生产政策） | 已完成（2026-11-06，两单真实派工各一次；五张异常卡；产物已纳入本树） |
| G3 后修复 | 10 发现的 R6/R8 无码拒绝 → 两个稳定错误码 + 回归；另出 RC2 | 已完成（`sourcePassed=true`；RC1 的 live 证据只属于 RC1） |
| RC2 真实验收（集成人执行） | 用户授权后在 RC2 上真实重装并用 WorkBuddy 桌面通道派一单 | 已完成（2026-11-06T08:23Z 安装、08:26Z 派工、08:28Z 结果为 `needs_review`；独立核验通过；未走完 review/accept，见 `RC2_LIVE_RUN.md`） |
| 11 | 交付检查 | 已完成（`265234a`，仅文档；`FINAL_REVIEW_INDEX.md` 648 行/八节 + K1–K8 矛盾） |

`sourcePassed=true`、`liveReady` 分两层：RC1 完成过一次真实安装 + 两单真实派工（DSH 与 WorkBuddy 各一单，均 accepted），但 10 的验收同时暴露三处缺陷（见「真实验收（10）归档与集成人核验」）。G3 后修复把这些缺陷中属代码的两处修掉并另出 RC2，**RC2 只做过源码与合成候选检查，未再进真实环境**。

## 八条开发线

| 线 | 分支 | 交付 HEAD | 提交数 | 变更规模 | 合入提交 |
| --- | --- | --- | --- | --- | --- |
| L01 项目身份 | `feat/finish-l01-project` | `226af908e5fd262fb16fac97e968206c6ea31c8b` | 1 | 12 文件 1231+/55- | `960ee3a43b6b56879c66c416ac5843eb12ddf2a1` |
| L02 资源可信 | `feat/finish-l02-resources` | `35d7e0e54ac80582fdc0ca196f2c416d9c71b95d` | 3 | 16 文件 2902+/17- | `6e71c930a0d6b9efe460835c2270fcb60090d54c` |
| L03 统计 | `feat/finish-l03-statistics` | `31d60330cca02ca8560c6bd05c33b99025c26005` | 2 | 17 文件 3257+/8- | `b52ce2bc4bf069e29645c62a9b158f09348d939d` |
| L04 安装与回退 | `feat/finish-l04-installation` | `5527850b6406046bae1a031d8887728fe4c4d2fa` | 1 | 10 文件 1680+/39- | `0dfe653bcffa62f1e29a93ad24d4b6993ca12989` |
| L05 推荐解释 | `feat/finish-l05-recommendation` | `fd56b132a8c2f2ec4c77f12142c74626153a527c` | 2 | 12 文件 1467+/4- | `dbb9b2fa95ddb35c5bf2e43496f9eeee4f6b3b32` |
| L06 模板/通知/导出 | `feat/finish-l06-productivity` | `5b31cb3980d943c7f2008345b3c3fbb85749343c` | 2 | 29 文件 4621+/13- | `4a3c9b46acf968ec668e2abd60bd3c9d7e451e4f` |
| L07 自动化政策 | `feat/finish-l07-automation` | `de8cf5de7ddab4f59fd056940a2cd8171cb9bba4` | 2 | 30 文件 3149+/13- | `3008d01c2bf4173d4884ae7d972671dabaca498a` |
| L08 独立验收 | `test/finish-l08-acceptance` | `7bbdfb47530ba2111cd7a9b5b996ee20c79b45e9` | 3 | 7 文件 1365+/0- | `05fa644dc1f73d5d0468328f459c097cd41a9d27` |

各线证据目录：`E:\javaproject\outputs\finish-l0x-20261105\`（含 `HANDOFF.json`、日志、合成证据）。L08 只新增测试与报告，未改任何业务源码。

## G0 实测结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `npm run build` | exit 0 |
| 类型检查 | `npm run typecheck:task-view` | exit 0 |
| A 专项 | `npx tsx --test test/candidate-installation.test.ts test/deployment.test.ts` | 25/25 pass，exit 0 |
| B 专项 | 五个桌面目录/会话测试文件 | 56/56 pass，exit 0 |
| workbench | `npm run test:workbench` | 103/103 pass，exit 0 |
| 全量 | `npm test` | 1048 tests / 1036 pass / 0 fail / 12 skipped，exit 0（363298ms） |
| 打包 | `node scripts/package.mjs` | 581 文件，sha256 `f8a94b78ec0b54056dac0bd3ad91c4f22c55e2f7d508307de1c7bb83662fc8c5` |
| 技能六文件 | `git diff --no-index --ignore-cr-at-eol --ignore-all-space` | 6/6 一致 |

全量首轮曾 5 失败，全部在 `test/package.test.ts`（`Missing release file scripts/candidate-installation.mjs`）：包白名单新增必需文件后测试夹具未同步；补齐夹具后第二轮通过。首轮日志未单独留盘，本文只据实记录计数。

## G1 实测结果

| 检查 | 结果 |
| --- | --- |
| 构建 / 类型检查 | exit 0 / exit 0 |
| 四线专项合跑（18 文件） | 169/169 pass，exit 0（64820ms） |
| `npm run test:workbench` | 117/117 pass，exit 0 |
| `test/package.test.ts` | 12/12 pass，exit 0 |
| 全量第一轮 | 1145 tests / 1132 pass / 1 fail / 12 skipped，exit 1（384652ms） |
| 该失败用例单跑 | `npx tsx --test --test-concurrency=1 test/run-worker.test.ts` → 5/5 pass，exit 0 |
| 全量第二轮 | 1145 tests / 1133 pass / 0 fail / 12 skipped，exit 0（383613ms） |
| 打包 | 634 文件 / 1 985 113 字节 / sha256 `390d54062ca990eab21758293643f8ad7eedc8c5b7ea2d8d4648e6f5bd9f3658` |
| 技能六文件 | 6/6 一致（L01 两侧各改 10 行后仍一致） |

第一轮唯一失败是 `test/run-worker.test.ts` 的 `an actual detached worker survives its launcher exiting and writes its final evidence`，报 `EPERM: operation not permitted, rename ...state.json.tmp -> state.json`。与 L01 HANDOFF 记录的同名失败一致；单独串行跑通过。**根因未定位**，不写因果结论。

## G2 实测结果

| 检查 | 结果 |
| --- | --- |
| 合入 | L05 `dbb9b2f`、L06 `4a3c9b4`，两次 ort 零冲突，合并后工作树干净 |
| 构建 / 类型检查 | exit 0 / exit 0 |
| 两线专项合跑（11 文件） | 100/100 pass，exit 0（18664ms） |
| `npm run test:workbench` | 117/117 pass，exit 0 |
| `npm run desktop:test` | `{"passed":92,"failed":0}`，exit 0（含 5 条新 recommend 策略用例） |
| `dotnet build desktop\WorkBuddy.Workbench.csproj -c Release` | exit 0，0 警告 0 错误（5.50s） |
| 全量第一轮 | 1217 tests / 1205 pass / 0 fail / 12 skipped，exit 0（374101ms） |
| 全量最终轮（改完测试字面量后） | 1217 tests / 1205 pass / 0 fail / 12 skipped，exit 0（307572ms） |
| 技能六文件 | 6/6 一致（L05 两侧各改 SKILL.md 与 `references/dispatch.md`） |
| 打包 | **672 文件 / 2 145 509 字节 / sha256 `44a75c822823d19fbe8efe11cbbb4664ef725aa6fa9e676acbb6187e4a2ac9de`** |

G2 两轮全量均 0 失败，本轮未复现 run-worker EPERM；该失败仍按「未定位」保留在 G1 记录中，不因本轮通过而关闭。

## G3 实测结果

| 检查 | 结果 |
| --- | --- |
| 合入 | L07 `3008d01`、L08 `05fa644`，两次 ort 零冲突；L08 合入前把两处集成改动 stash 再 pop，最终工作树干净 |
| 构建 / 类型检查 | exit 0 / exit 0 |
| 两线专项合跑（8 文件） | 76/76 pass，exit 0（99630ms） |
| `npm run test:workbench` | 139/139 pass，exit 0（4227ms，含 automation-view 8 例与 L08 任务面板 8 例） |
| `npm run desktop:test` | `{"passed":92,"failed":0}`，exit 0 |
| `dotnet build desktop\WorkBuddy.Workbench.csproj -c Release` | exit 0，0 警告 0 错误（3.46s） |
| 全量 | **1281 tests / 1269 pass / 0 fail / 0 cancelled / 12 skipped，exit 0（351328ms）** |
| 技能六文件 | 6/6 一致（L07 两侧改 SKILL.md 与 setup/execution/dispatch 三份 references） |
| 打包 | **694 文件 / 2 235 102 字节 / sha256 `658a20b196051fa25be1c669bb9b5c5574216cd30a6b223bd07efe2e90ba11b8`** |

G3 全量一轮即 0 失败，未复现 run-worker EPERM；该失败仍按「未定位」保留，不因本轮通过而关闭。

## 集成侧修复与接线

G0：不可信归档/损坏安装清单/清单截断/CLI 异常四类最小修复 + 2 条回归；包白名单新增三个脚本与 `installation-readiness` 产物；`test/package.test.ts` 夹具同步。

G1：
1. `gateway/scripts/package.mjs` 必需产物补 `installation-dependencies`、`installation-rollback`（L04 重写后的 CLI 依赖）。
2. `gateway/test/package.test.ts` 同步这两个模块的 src/dist 夹具。
3. `gateway/test/resource-connections.test.ts` 合成凭据字面量改为 `synthetic-credential-value-must-not-be-echoed`——原值命中打包器的访问令牌扫描，改夹具而不放宽扫描器。
4. L02 request ①：`docs/INTERFACE_CONTRACT.md` 登记三条只读接口与 routing 追加字段、`verified:false` 约束。
5. L02 request ②：`docs/RESOURCE_SOURCE_ROUTING_ACCEPTANCE.md` 登记 `WORKBUDDY_RESOURCE_LINKS_FILE`、`WORKBUDDY_RESOURCE_CONNECTIONS_FILE` 两个只读入口。

G2：
1. `gateway/scripts/workbench-desktop-commands.mjs` 接 `recommend`（L05 request ①）：只读调用 `recommendTask(parameters, await session.catalog(), Date.now())`，不建 attempt、不写任务库。
2. `gateway/desktop/DesktopControlPolicy.cs` 动作白名单加 `recommend` 并加形状校验（L05 request ②）：root 只允许 `intent/constraints/statistics/resources/previous`，`intent` 必为对象，`resources` 必为数组。
3. `gateway/desktop/test/Program.cs` 增 5 条策略正负例。
4. `gateway/test/package.test.ts` 同步 productivity 两个 workbench 文件。
5. `gateway/test/project-template.test.ts` 把 `C:\Users\someone` 改为 `C:\Users\example`（打包器的私有路径扫描允许占位名；断言不变）。

G3：
1. `gateway/scripts/package.mjs` 补 `scripts/automation.mjs` 与 `automation`/`automation-http`/`automation-cli` 的 src/dist 必需项，并把 `automation` 加入 scripts 允许规则——L07 的新入口原本不在包内，发布包会静默丢掉唯一写缝。
2. `gateway/test/package.test.ts` 同步上述脚本与三模块夹具（未同步时 5 个包用例会红）。
3. L07 的 8 条 integration-request 全部已在 L07 分支应用，逐条复核后原样采纳：`collaboration.ts` 的 `automatic` 模式与绑定门禁、`task-application-service.ts` 拒绝手工建 automatic 方案、`task-store.ts` 暴露 `database` 供自动化表、`workbench-http.ts` 六条只读路由、`workbench-entry.ts` 注入、`workbench-assets.ts` 与包白名单、`app.mjs`/`index.html` 导航、文档契约。
4. `docs/INTERFACE_CONTRACT.md` 登记六条自动化只读路由与「写入面只在本地 CLI」的约束（L07 文档请求）。
5. L08 的 contract request ①②③ 落在本文件与 `docs/D0_D1_DELIVERY_READINESS.md` 第 7 节；④（`workspace-protection.ts` 的 gitIndex 超时错误码）不改产品代码，作为已知问题登记，见下节第 10 条。

L06 自应用的七条共享改动逐条复核后采纳：包白名单与资产表、`index.html` 样式表、`workbench-entry.ts` 注入、`workbench-http.ts` 只读路由、桌面命令/宿主分派、C# 三文件、模板契约对齐 07。

## 任务分层登记

| 任务 | 完成层级 | 说明 |
| --- | --- | --- |
| D2-01/02 | 源码 + 合成 | 目录与会话诊断、可用性四态、迟到结果防护 |
| D2-03/04 | 源码 + 合成 | 项目身份准备与单次消费（L01）、推荐解释（L05） |
| D3-01/02 | 源码 + 合成 | 连接声明与只读入口；真实联调待 10 |
| D3-03/04 | 合成 | 余额/路由/归因展示，三层 `verified:false` |
| D4-01/02/03 | 源码 + 合成 | 推荐决策与解释；真实模型确认与派工归 10 |
| D5-01/02/03 | 源码 + 合成 | 自动政策的保存/修订/撤销/决策/审计与唯一写缝 CLI；真实派工未启用（`armed=false`）、四表未并入统一 migration |
| D6-01 | 仅接口面 | 归因缺口文档，真实数据源未接 |
| D6-02/05 | 合成 | 统计与模板/通知/导出 |
| 独立验收 | 合成 | L08 十二类异常、53 项中新增 20 项「合成通过/部分」，无一改判整项通过 |
| 真实安装、登录、真派工、生产政策 | 未执行 | 归 10 |

## 候选包与候选工具（G3，RC 候选）

| 项 | 值 |
| --- | --- |
| 网关包 | `gateway/outputs/release/codex-workbuddy-gateway-v0.7.1.zip`，694 文件，2 235 102 字节，sha256 `658a20b196051fa25be1c669bb9b5c5574216cd30a6b223bd07efe2e90ba11b8` |
| 技能包 | `workbuddy-executor-v0.7.1.zip`，6 文件，sha256 `e61be9ba03f48e555ed1a8441eb8d56f0013eb818cfdceb610015d26e0839db8` |
| Harness 技能包 | `deepseek-executor-v0.7.1.zip`，2 文件，sha256 `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13`（本轮未变） |
| 解包 | `E:\javaproject\outputs\finish-integration-20261105\G3\candidate\codex-workbuddy-gateway-v0.7.1\codex-workbuddy-gateway-v0.7.1`（695 项；压缩包内自带同名顶层目录） |

| 工具 | 结果 |
| --- | --- |
| `scripts/verify-release.mjs` | `verifiedFiles 694`、`hashesMatch true`，exit 0 |
| `candidate-installation.mjs check` | exit 0，`ok=true`，694 文件，`problems=[]`，`totalBytes 7 273 213` |
| `... preview` | exit 1（预期）：`safeToApply=false`，`create=694`，仅 `runtime_dependencies`、`desktop_application` 为 `ok:false` |
| `... version-check` | exit 0，`matches=true`，`exact=true`，`matched=694`（漏 `--package` 时 exit 1，属参数缺失） |
| `... dependencies` | exit 1，`blocksInstall=true`；非 ok：`production_dependencies:missing 0/94`、`workbuddy_data:mismatch`（合成 exe）、`desktop_shell:not_applicable`、`code_signing:not_applicable`；实测 .NET Desktop Runtime 10.0.12、WebView2 156.0.4314.58 |
| 包内 `npm ci --omit=dev` | exit 0，94 包（Windows 下需经 `cmd /c` 调用 npm） |
| `... drill --apply` | exit 0，4 步全 ok，5 项检查全 true |
| `... upgrade-drill --apply` | exit 0，17 步 / 17 检查全 ok，6 条负例 ok |
| `... rollback-plan`（对 G0 包） | exit 0，`safeToApply=true`，`replace=62 create=0 remove=113 keep=519 blocked=0` |
| `delivery-baseline.mjs` | exit 0，`readOnly=true`，`authorizesDispatch=false`，5 条限制（该脚本无 `--report`，加未知参数 exit 2） |
| `live-acceptance-fixture.mjs create/verify` | exit 0 / exit 0，`baselineSha256 bcc412a2…`，`authorized=false`，`problems=[]` |

### 推荐命令端到端探针

`outputs\finish-integration-20261105\G2\probe\host-recommend.mjs`（同一脚本复用于 G3）：合成库 + 解包候选宿主，走 stdin 私有通道发 `catalog`→`recommend`→`catalog`。
ready 帧含 `desktopCommands:true`、`productivity:true`；`recommend` 返回 `workbuddy-executor/recommendation-1`、`decision:"direct"`、`readOnly:true`、`authorization:{state:"none",requires:["preview","confirmation"]}`、`attempt:null`、`candidates:0`、`missing:[no_statistics_sample]`、digest 长 64；随后 `catalog` 仍成功，进程 exit 0，无失败。

### 候选网关 HTTP 冒烟

解包候选 + 自带依赖，端口 18493，`readOnly:true`：

| 请求 | 结果 |
| --- | --- |
| `GET /workbench/v1/health` | 200，`ready:true`，0.7.1，`capacity.limit=1`，`occupiedByTaskId:null` |
| `GET /workbench/v1/statistics` | 200，`statistics-1`，`snapshotOnly:true` |
| `GET /workbench/v1/templates` | 200，`productivity-1` |
| `GET /workbench/v1/notifications` | 200，`notification-1` |
| `GET /workbench/v1/resources/routing` | 200，`routing-evidence-1`，`routingVerified:false` |
| `GET /workbench/v1/automation`、`/policies`、`/decisions`、`/audit` | 200，`readOnly:true`，空库返回空数组 |
| `GET /workbench/v1/export-preview/task-missing` | 404 |
| `GET /workbench/automation.mjs`、`/workbench/automation.css` | 200（资产白名单生效） |
| `GET /workbench/` | 200 |
| `POST /workbench/v1/automation/policies` | 405，`allow: GET, HEAD` |

### 自动化唯一写缝（候选内实测）

解包候选 + 隔离数据库：

| 命令 | 结果 |
| --- | --- |
| `node scripts/automation.mjs --help` | exit 0，列出 12 个子命令与「policy 只收窄派工」的边界说明 |
| `... status` | exit 0：`enabled:false`、`armed:false`、`dispatcherWired:false`、`writeEntry:"local_cli_only"`、`httpWrites:false` |
| `... policy-create --workspace ws-synthetic ... --ttl-hours 1` | exit 0，生成 `policy-mDHBfEKa…`，`status:"active"`、`current:true`，`authorizationSource:"user:integration-probe"` |
| `... policy-list` | exit 0，列出该政策 |
| `... execute dec-missing --operation-id …` | exit 1，`AUTOMATION_NOT_ARMED`（未 arm 时拒绝自动派工） |
| 面板 `GET /workbench/v1/automation/policies` | 200，`readOnly:true`，投影同一政策，进程重启后仍为 `armed:false` |

端口由内置默认值决定，`WORKBENCH_PORT` 无效；解包候选必须先 `npm ci --omit=dev` 才能启动（缺 `zod`）。CLI 与网关都要求显式 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`，否则多安装机器直接拒绝运行。

## RC 冻结与影响表（G3）

RC 冻结对象：归档提交（`gates/G3.json` 记录的集成树 HEAD）、上述 694 文件包与两份技能包。

| 冻结后若改动 | 需重跑 | 不得宣称 |
| --- | --- | --- |
| `gateway/src/**`、`gateway/scripts/**` | build、typecheck、受影响专项、全量、打包、候选工具与冒烟 | 包摘要不变 |
| `gateway/desktop/**`（C#） | `desktop:test`、`dotnet build`、包内 desktop 资产、安装演练 | 桌面壳未变 |
| 根技能六文件 | 技能副本一致性、技能包重打、安装演练的 skill 检查 | 六文件仍一致 |
| `gateway/scripts/package.mjs` / `test/package.test.ts` | 打包、`test/package.test.ts`、verify-release、check | 包内容与白名单不变 |
| `docs/**` 仅文档 | 无代码检查需要，但影响表与状态需同步更新 | 文档变更等于功能变更 |

本轮没有真实环境证据被引入，因此冻结不改变 `liveReady=false`。

## 外部条件与未决（不在 G3 关闭）

1. 真实安装、升级、生产切换、跨机器验收：未执行，归 10。
2. 真实登录、真实模型目录/费率、真实派工：未执行；G0–G3 全部为合成会话与本地通道。
3. 原 P0-1 未知：不关闭、不重派、不释放（按 T7D）；`workflow_capacity(slot=1)` 仍有占用记录。
4. `run-worker` detached 用例在高负载下偶发 `EPERM`：G2/G3 未复现，根因未定位。
5. L06 政策建议模板只能保存不能激活（L07 只做到契约对齐与 `policy_activation_unsupported`）；Windows 通知横幅受系统设置影响；跨进程通知去重无锁。
6. L05 的正式壳在共享入口落地前，未接线时降级为「面板隐藏、手工流程照旧」；G2 已接线，真实宿主仍需复验。
7. 请求级归因缺口（`request-attribution-1`）：上游只有账号×模型聚合，未接真实数据源。
8. 本机同时存在 `~/.workbuddy` 与 `~/.workbuddy-ai`，验证必须显式 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`；未设时 L08 记录 172 例以安装歧义失败（来源 `src/config.ts:55`）。回环需 `NO_PROXY`。
9. 许可文件位置由权利人决定，仓库根与 `gateway/` 均无 LICENSE。
10. L08 ④：`gateway/src/workspace-protection.ts` 的 gitIndex 5 秒超时仍会抛未归一化的 `Error: spawnSync git ETIMEDOUT`（O6），本轮不改产品代码，登记为已知问题；建议后续包成稳定的 `AdmissionError` 码或可配置超时。
11. L07 的四张自动化表（`automation_meta/policies/decisions/audit`）由自动化服务自建，未并入统一 migration；schema_version>1 时以 `AUTOMATION_SCHEMA_UNSUPPORTED` 拒绝启动该服务。归属待 09/10 决定。
12. L08 记录的产品缺陷：O1 缺模型时合同路径报 `PLAN_STALE`、legacy 路径报 `MODEL_SELECTION_REQUIRED`；O3 `formatTime(0)` 显示「未提供」；O4 `runs/` 含非 `run-*` 条目时不能按目录数推断派发次数。均未修，未改判任何 53 项。

## 收尾：给 10 与 11 的入口

- 真实环境验收清单与操作卡：`docs/D1_LIVE_ACCEPTANCE_PLAN.md`、`docs/delivery/L08_ACCEPTANCE.md` 第 8 节（10 张真实异常操作卡）。
- 53 项矩阵：`docs/D0_D1_DELIVERY_READINESS.md`（第 2 节原文 + 第 5/6/7 节增量登记）。
- 交付检查：`docs/delivery/L0x_ACCEPTANCE.md` 八份、`outputs\finish-l0x-20261105\HANDOFF.json` 八份、`gates/G0–G3.json` 四份、本文件。
- 边界：未推送、未合并 main、未发布、未部署；生产容量仍为 1，任何真实派工需按 AGENTS 展示执行器/来源/精确模型/推理/已知费用并取得确认。

## 真实验收（10）归档与集成人核验（2026-11-06）

产物：`E:\javaproject\workbuddy-finish\F10-live`（分支 `docs/live-acceptance`，HEAD `91af89ee9d5a3358f65a6e0e7699c9100f91d732`，未提交）。三份文档由集成人复制进本树并在本次提交归档：`docs/delivery/EXTERNAL_CONDITIONS.md`、`LIVE_ACCEPTANCE_EVIDENCE_INDEX.md`、`LIVE_ACCEPTANCE_SUMMARY.md`；原始证据留在 `E:\javaproject\outputs\finish-live-20261106`（284 文件，不入 Git）。

已发生的真实动作（以 `LIVE_ACCEPTANCE_SUMMARY.md` 与库内记录为准）：

| 项 | 事实 |
| --- | --- |
| 真实安装 | `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1`，install `2026-11-06T03:18:09.022Z`；`doctor` codeHash `ac2a673f…`；`.env` 335B、`data\workbuddy-mcp.toml` 465B（= 清单 snippetHash） |
| 技能安装位 | 安装前 4/6 与 RC 不同；安装后六文件与 RC 一致；旧版备份 `workbuddy-executor-I5FgPH` |
| DSH 单 | task `d1-dsh-5f82573e-b87a-4ff1-acd9-ec8d541243f5`，attempt `run-4fc382d9…`，`deepseek-v4.1-flash`/`high`/credits x0.00（观测），review `review-684133fe…`，accepted `05:55:54.478Z` |
| WorkBuddy 单 | task `d1-workbuddy-2fec4908-eb45-45eb-8852-8e8411b0cacf`，attempt `run-bc7288ad…`，`deepseek-v4.1-flash-sg`/`null`/credits x0.11（相对倍率，非金额），review `review-a7598513…`，accepted `06:15:38.488Z` |
| 异常卡 | R7 同 operationId 换执行器 → `OPERATION_CONFLICT` 且无副作用；R4 领取后取消 → 原生空闲、`clamp.mjs` 未变；R8 预算耗尽返工被拒后 accepted；R6 外来会话被拒 → 任务 `blocked`、操作 `outcome_unknown`、容量被占；R3 `STOP_UNCONFIRMED` 阻挡重启，停止折入后通过 |
| 未做 | R1/R2/R5/R9/R10（需人为中断、再造成 outcome_unknown、拖满 600 秒、伪造历史 attempt、故障注入）；第二台机器未执行 |
| 用户当日决定 | R6 blocked 任务按 T7D 原样保留（recovery-cli show/observe 均 exit 0、`available:[]`）；`config.toml` 本轮不合并（始终 7,449B、0 处 `workbuddy_rc`）；网关自登记常驻服务保留（PID 11672，`data\persistent-service.json`，cdpPort 18491，workers 4） |

集成人独立核验（自写探针 `outputs\finish-integration-20261105\G3-probe\verify-live10.mjs`，把 `tasks.sqlite`+`-wal`+`-shm` 复制到临时目录只读查询）：

- 6 个任务：两单 accepted、R4a/R4b cancelled、R8 accepted、R6 blocked（`attempt_id=null`）；`task_closed` 5 条，R6 无。
- `workflow_capacity` 仅 1 行，指向 R6 任务 `d1-workbuddy-2cc8e262-54f5-43a0-8511-b3febf0d4101` / `card-r6-foreign-session-1793948211334`；该 send 操作状态 `outcome_unknown`（全库唯一）。
- 42 条 `task_operations`，其余 send/queue/review/accept 均 `succeeded` 或 `rejected`。
- 两单最终 `revision` = `DNbnQevDQ_eiY3Fy`、`nViAz0BiNEdMDcsL`，与报告一致。

集成人发现的证据问题（报告未自述）：

1. `evidence\cards\r6\recovery-view.json`（952B）不是恢复视图 JSON，而是一次失败调用的 PowerShell 转录：`workbuddy-call.mjs` 收到未加引号的 `{operationId:…}` 后 `SyntaxError: Expected property name or '}' in JSON at position 1`。报告里「证据：recovery-view.json」不成立，R6 的恢复视图实际未落成可解析文件。
2. `evidence\get-task-1.json`、`evidence\workbuddy-models.json` 是 UTF-16LE 重定向产物，不是 UTF-8 JSON（34 个 evidence JSON 中这 3 个不可解析，其余 31 个合法）。
3. 三份文档在 F10-live 里一直未提交（本次由集成人归档，不改 10 的分支）。

由验收暴露、并经源码核对确认的产品缺陷（O6 系列）：

- R6：`gateway/src/workspace-workers.ts` 的会话改绑冲突抛普通 `Error`，`coordinator.ts:38` 的 `failureCause()` 只认 `AdmissionError.code` 或 errno 风格码 → blocked 原因不含原因码。
- R8：`gateway/src/coordinator.ts` 的轮数上限同样抛无码 `Error`。
- R6 的 send 操作在「准备阶段」失败仍落 `outcome_unknown`：`src/operation-admission.ts` 在准备前就进入 `effect_started`，失败一律按未知效果处理 → 容量被占、必须走 reconcile/close 流程。属设计取舍，本轮不动。

## G3 后修复与 RC2（2026-11-06）

代码（两处，均只把无码拒绝换成稳定码，消息不变）：

| 文件 | 改动 |
| --- | --- |
| `gateway/src/workspace-workers.ts` | 会话已绑到其它项目时抛 `new AdmissionError("WORKSPACE_CONFLICT", "This native session is already registered for another workspace")`；新增 `import { AdmissionError } from "./collaboration.js"`（无环：`collaboration.ts` 只 import `task-contract.js`） |
| `gateway/src/coordinator.ts` | 轮数上限改抛 `new AdmissionError("ATTEMPT_LIMIT", 原文案)` |

连带效果：`failureCause()` 现在能把 `WORKSPACE_CONFLICT` / `ATTEMPT_LIMIT` 写进 `blocking_reason`（`Contract preparation failed (WORKSPACE_CONFLICT); …`），MCP 结果在 `server.ts` 的错误分支多一个 `code` 字段；操作状态机不变（仍按 `effect_started` 语义判未知）。

回归：`gateway/test/workspace-workers.test.ts` 新增「a native session cannot be re-bound to another project and reports a stable code」；`gateway/test/finish-acceptance-admission-anomalies.test.ts` 的预算耗尽用例由 `/attempt limit/i` 改为断言 `AdmissionError` + `ATTEMPT_LIMIT`。

检查（隔离环境同 G3；日志 `outputs\finish-integration-20261105\G3-fix\logs\`）：

| 检查 | 结果 |
| --- | --- |
| `npm run build` | exit 0 |
| 受影响两文件 | 23/23 pass，exit 0 |
| 全量 `npm test` | 1282 tests / 1269 pass / **1 fail** / 12 skipped，exit 1；失败为 `test/command-cleanup.test.ts:24` 的真实嵌套 Job 清理用例（`recovered.length` 期望 1 得 0），单文件复跑两次均 4/4 通过 → 高负载下的时序问题，未定位根因 |
| RC2 打包 | `codex-workbuddy-gateway-v0.7.1.zip` 694 文件 / 2,236,003 字节 / sha256 `9e146b93fe40ff3b7086e4117c89dd0e2b81f81c61a585cfba4b003ef4411eee`；技能包与 Harness 技能包摘要同 G3 |
| 解包 `verify-release` | `{"version":"0.7.1","verifiedFiles":694,"hashesMatch":true}` exit 0 |
| `check --expect-sha256 9e146b…` | exit 0，`ok=true`、`problems=[]`、`totalBytes 7,275,426` |
| `version-check` | exit 0，`matches=true`、`exact=true`、`matched=694` |
| `drill --apply` | exit 0，steps 4/4、checks 5/5、negatives 6/6 |
| `upgrade-drill --apply` | exit 0，steps 17/17、checks 17/17、negatives 6/6 |

RC2 影响表：与 RC1 只差上面两个错误码与两处测试文本。RC1 已覆盖的真实结论（真实安装、技能安装位、两单真实派工与验收、五张卡的事件链）在 RC2 上仍然成立（未改这些路径）；但「R6/R8 的无码现象已修」必须在 RC2 上重验才算数。建议的重验方式：在库副本上重放 R6（准备阶段即失败、不派工、无模型费用），确认 `blocking_reason` 带 `WORKSPACE_CONFLICT`、操作错误码带 `WORKSPACE_CONFLICT`；R8 可用预算 1 的任务直接复跑。

仍未修（登记，不在本轮关闭）：R6 准备期失败落 `outcome_unknown` 并占容量；`continueAdmitted` 里其余无码 `Error`（已取消任务、无会话、活跃 worker、缺 provider 返回值）保持原样；L08 的 O1/O3/O4；L07 四表未并入统一 migration；gitIndex 5 秒超时错误码（`workspace-protection.ts`）。

## 10 证据修复与 RC2 拒绝重放（2026-11-06）

两件事都只发生在合成环境，没有打开真实库、没有派工、没有改真实配置。

**一、RC2 解包产物上的两处拒绝重放**（探针 `outputs\finish-integration-20261105\G3-fix\probe\probe-rc2-replay.mjs`，跑的是解包候选的 `dist`，不是源码树）：

| 场景 | 构造 | 结果 |
| --- | --- | --- |
| R6 | `WorkspaceWorkers` 在临时 runs 目录里把一个会话绑到项目 A，再用项目 B 调 `select` | exit 0；抛 `AdmissionError` / `WORKSPACE_CONFLICT` / 原文案；`failureCause()` 返回 `WORKSPACE_CONFLICT`；注册表仍 1 条 |
| R8 | 合成库写入 attempt=1 的任务，`maxTaskAttempts=1`，调 `coordinator.continue` 并带 `expectedRevision` 与 `expectedAttemptId:null` | 抛 `AdmissionError` / `ATTEMPT_LIMIT` / 原文案；`failureCause()` 返回 `ATTEMPT_LIMIT` |

结论：**两个稳定码在 RC2 的发布产物里成立**。这不等于「RC2 已真实验收」——真实安装与派工仍只在 RC1 上做过；要那一步得另装 RC2。

**二、三份坏证据的修复**（详见 `docs/delivery/LIVE_EVIDENCE_REPAIR.md`，产物在 `outputs\finish-integration-20261105\G3-fix\evidence-repair\`）：

| 文件 | 处理 | 结果 |
| --- | --- | --- |
| `cards/r6/recovery-view.json` | 用 RC2 的 `dist/recovery-cli.js` 对库副本跑 `show`/`observe` | 两份各 4667B 的合法 JSON，`available:[]`，sha `5a4feca1…`；报告的说法这次有文件支撑 |
| `workbuddy-models.json` | UTF-16LE → UTF-8 转码，内容未改 | 23 条模型 + runtime 指纹，sha `2ebda8f8…`；未重查真实客户端 |
| `get-task-1.json` | 无法按原路重采：`workbuddy_get_task` 对 DSH 任务报「The original DSH adapter is unavailable」，`deepseek_get_task` 报「Unknown DeepSeek task」（本沙箱无其运行库） | 给库副本投影 `task-projection-1`（51 事件/10 操作），sha `92b4e999…`；**10 报告中该单「任务详情」应改述为库内投影，不宣称是 `get` 捕获** |

两处修正同时说明：原三份文件都是 PowerShell 重定向 + 参数未加引号造成的（UTF-16 与转录），不是判断错误，但「有文件」不等于「文件成立」。
