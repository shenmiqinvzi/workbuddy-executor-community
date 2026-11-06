# 交付完成阶段现状（集成人维护，唯一现状入口）

本文件是 `workbuddy-executor` 交付完成阶段的唯一现状入口。分支 `integration/delivery-finish`，工作树 `E:\javaproject\workbuddy-finish\I-integration`。
只记录本轮可证事实：命令、退出码、计数、提交哈希、包摘要。`sourcePassed` 与 `liveReady` 分开；未执行的项写「未执行」，不预填通过。
原始日志与回执在 `E:\javaproject\outputs\finish-integration-20261105\{G0,G1,G2}\`（不入 Git）。

## 阶段与 gate

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| G0 | 集成分支、三线合入 A/B/C、基线提交、L01–L04 开工清单 | 已完成 |
| 第一批 | L01–L04 开发交付 | 已交付 |
| G1 | L01–L04 合入、接线、检查、候选包 | 已完成（源码与合成候选通过；真实验收未执行） |
| 第二批 | L05–L06 开发交付 | 已交付 |
| G2 | L05–L06 合入、接线、检查、候选包 | 已完成（源码与合成候选通过；真实验收未执行） |
| 第三批 | L07–L08 | 待开始（G2 后创建工作树） |
| G3 | 第三批合入、端到端合成联调、RC 冻结与影响表 | 待开始 |
| 10 | 真实验收（真实安装、登录、真实模型派工、生产政策） | 未开始，集中由 10 办理 |
| 11 | 交付检查 | 未开始 |

## 六条开发线

| 线 | 分支 | 交付 HEAD | 提交数 | 变更规模 | 合入提交 |
| --- | --- | --- | --- | --- | --- |
| L01 项目身份 | `feat/finish-l01-project` | `226af908e5fd262fb16fac97e968206c6ea31c8b` | 1 | 12 文件 1231+/55- | `960ee3a43b6b56879c66c416ac5843eb12ddf2a1` |
| L02 资源可信 | `feat/finish-l02-resources` | `35d7e0e54ac80582fdc0ca196f2c416d9c71b95d` | 3 | 16 文件 2902+/17- | `6e71c930a0d6b9efe460835c2270fcb60090d54c` |
| L03 统计 | `feat/finish-l03-statistics` | `31d60330cca02ca8560c6bd05c33b99025c26005` | 2 | 17 文件 3257+/8- | `b52ce2bc4bf069e29645c62a9b158f09348d939d` |
| L04 安装与回退 | `feat/finish-l04-installation` | `5527850b6406046bae1a031d8887728fe4c4d2fa` | 1 | 10 文件 1680+/39- | `0dfe653bcffa62f1e29a93ad24d4b6993ca12989` |
| L05 推荐解释 | `feat/finish-l05-recommendation` | `fd56b132a8c2f2ec4c77f12142c74626153a527c` | 2 | 12 文件 1467+/4- | `dbb9b2fa95ddb35c5bf2e43496f9eeee4f6b3b32` |
| L06 模板/通知/导出 | `feat/finish-l06-productivity` | `5b31cb3980d943c7f2008345b3c3fbb85749343c` | 2 | 29 文件 4621+/13- | `4a3c9b46acf968ec668e2abd60bd3c9d7e451e4f` |

各线证据目录：`E:\javaproject\outputs\finish-l0x-20261105\`（含 `HANDOFF.json`、日志、合成证据）。
L07/L08 工作树在 G2 归档提交后创建，工作树与分支名以 `gates/G2.json` 为准；未创建前不写哈希。

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

L06 自应用的七条共享改动逐条复核后采纳：包白名单与资产表、`index.html` 样式表、`workbench-entry.ts` 注入、`workbench-http.ts` 只读路由、桌面命令/宿主分派、C# 三文件、模板契约对齐 07。

## 任务分层登记

| 任务 | 完成层级 | 说明 |
| --- | --- | --- |
| D2-01/02 | 源码 + 合成 | 目录与会话诊断、可用性四态、迟到结果防护 |
| D2-03/04 | 源码 + 合成 | 项目身份准备与单次消费（L01）、推荐解释（L05） |
| D3-01/02 | 源码 + 合成 | 连接声明与只读入口；真实联调待 10 |
| D3-03/04 | 合成 | 余额/路由/归因展示，三层 `verified:false` |
| D4-01/02/03 | 源码 + 合成 | 推荐决策与解释；真实模型确认与派工归 10 |
| D6-01 | 仅接口面 | 归因缺口文档，真实数据源未接 |
| D6-02/05 | 合成 | 统计与模板/通知/导出 |
| 真实安装、登录、真派工、生产政策 | 未执行 | 归 10 |

## 候选包与候选工具（G2）

| 项 | 值 |
| --- | --- |
| 网关包 | `gateway/outputs/release/codex-workbuddy-gateway-v0.7.1.zip`，672 文件，2 145 509 字节，sha256 `44a75c82…2ac9de` |
| 技能包 | `workbuddy-executor-v0.7.1.zip`，6 文件，sha256 `376714f3…0fb952` |
| Harness 技能包 | `deepseek-executor-v0.7.1.zip`，2 文件，sha256 `22909e1b…8d13`（本轮未变） |
| 解包 | `E:\javaproject\outputs\finish-integration-20261105\G2\candidate\`（694 项） |

| 工具 | 结果 |
| --- | --- |
| `scripts/verify-release.mjs` | `verifiedFiles 672`、`hashesMatch true`，exit 0 |
| `candidate-installation.mjs check` | exit 0，`ok=true`，672 文件，0 问题 |
| `... preview` | exit 1（预期）：`safeToApply=false`，`create=672`，仅 `runtime_dependencies`、`desktop_application` 为 `ok:false` |
| `... version-check` | exit 0，`matches=true`，`exact=true`（漏 `--package` 时 exit 1，属参数缺失） |
| `... dependencies` | exit 1，`blocksInstall=true`；纯包无 node_modules、合成 exe 导致 4 项非 ok；实测 .NET 10.0.12、WebView2 156.0.4314.58 |
| 包内 `npm ci --omit=dev` | exit 0，94 包（Windows 下需经 `cmd /c` 调用 npm） |
| `... drill --apply` | exit 0，4 步全 ok，5 项检查全 true |
| `... upgrade-drill --apply` | exit 0，17 步 / 17 检查全 ok，含只读回退计划 |
| `... rollback-plan`（对 G0 包） | exit 0，`replace=49 create=0 remove=91 keep=532 blocked=0` |
| `delivery-baseline.mjs` | exit 0，`readOnly=true`，`authorizesDispatch=false` |
| `live-acceptance-fixture.mjs create/verify` | exit 0 / exit 0，`baselineSha256 26518bb1…`，`authorized=false` |

### 推荐命令端到端探针

`outputs\finish-integration-20261105\G2\probe\host-recommend.mjs`：合成库 + 解包候选宿主，走 stdin 私有通道发 `catalog`→`recommend`→`catalog`。
ready 帧含 `desktopCommands:true`、`productivity:true`；`recommend` 返回 `workbuddy-executor/recommendation-1`、`decision:"direct"`、`readOnly:true`、`authorization:{state:"none",requires:["preview","confirmation"]}`、`attempt:null`、`candidates:0`、`missing:[no_statistics_sample]`、digest 长 64；随后 `catalog` 仍成功，进程 exit 0，无失败。

### 候选网关 HTTP 冒烟

解包候选 + 自带依赖，端口 18493，`readOnly:true`：

| 请求 | 结果 |
| --- | --- |
| `GET /workbench/v1/health` | 200，`ready:true`，0.7.1 |
| `GET /workbench/v1/statistics` | 200，`statistics-1`，`snapshotOnly:true` |
| `GET /workbench/v1/templates` | 200，`productivity-1`，`count:0` |
| `GET /workbench/v1/notifications` | 200，`notification-1` |
| `GET /workbench/v1/export-preview/task-does-not-exist` | 404 `TASK_NOT_FOUND`（空库如实 404） |
| `GET /workbench/productivity.mjs`、`.css` | 200（资产白名单生效） |
| `GET /workbench/` | 200 |
| `POST /workbench/v1/templates` | 405，`allow: GET, HEAD` |

端口由内置默认值决定，`WORKBENCH_PORT` 无效；解包候选必须先 `npm ci --omit=dev` 才能启动（缺 `zod`）。

## 外部条件与未决（不在 G2 关闭）

1. 真实安装、升级、生产切换、跨机器验收：未执行，归 10。
2. 真实登录、真实模型目录/费率、真实派工：未执行；G1/G2 全部为合成会话与本地通道。
3. 原 P0-1 未知：不关闭、不重派、不释放（按 T7D）；`workflow_capacity(slot=1)` 仍有占用记录。
4. `run-worker` detached 用例在高负载下偶发 `EPERM`：G2 两轮未复现，根因未定位。
5. L06 政策建议模板只能保存不能激活，等 07；Windows 通知横幅受系统设置影响；跨进程通知去重无锁。
6. L05 在共享入口落地前，正式壳降级为「面板隐藏、手工流程照旧」。
7. 请求级归因缺口（`request-attribution-1`）：上游只有账号×模型聚合，未接真实数据源。
8. 本机同时存在 `~/.workbuddy` 与 `~/.workbuddy-ai`，验证必须显式 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`；回环需 `NO_PROXY`。
9. 许可文件位置由权利人决定，仓库根与 `gateway/` 均无 LICENSE。

## 下一批开工条件（L07/L08）

1. 工作树由集成人从 G2 归档提交创建：`L07-automation`（`feat/finish-l07-automation`）、`L08-acceptance`（`test/finish-l08-acceptance`）；开工前先 `git rev-parse HEAD` 与 `git status --porcelain` 核对，不一致即停下。
2. 各自 `gateway/` 按本树 lockfile `npm ci`，不改版本；不共用集成树的 `dist`/数据库/runs/TEMP/profile/端口。
3. 清空继承的 `WORKBUDDY_*` 与 `NODE_TEST_CONTEXT`，自建 CLI/config 与数据库，回环设 `NO_PROXY`。
4. 共享入口、包白名单、`workbench-assets`、技能六文件、全局导航仍归集成人；需要接线写 integration-request，附精确补丁与验证入口。
5. 交付 `docs/delivery/Lxx_ACCEPTANCE.md` 与 `outputs\finish-lxx-20261105\HANDOFF.json`，含真实命令、退出码、计数、日志与失败历史；不预填通过。
