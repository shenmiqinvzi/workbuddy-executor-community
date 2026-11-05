# 交付状态索引（唯一现状入口）

本文件是实施 `docs/parallel/DELIVERY_FINISH_20261105/` 规划包期间的唯一现状入口。每次 gate 只在此处与 `gates/Gn.json` 更新当前状态；`docs/PROGRESS.md` 保留为历史流水，不再作为现状判据。所有数字均来自本轮实际执行，未执行的一律写「未执行」并给出缺失条件。

## 阶段与 gate

| gate | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| G0 | 统一开发基线（合入 A/B/C、补公共清单、构建专项全量打包、建 01–04 工作树） | 已完成（2026-11-05） | 归档提交 `1f60374`；台账 `gates/G0.json` |
| 第一批 | L01 项目流程、L02 资源信任、L03 统计归因、L04 安装发行 | 已交付（四线均交 `HANDOFF.json`） | 交付 HEAD 见下表 |
| G1 | 第一批集成 gate（核验、合入、接线、检查、打包、候选实测） | 源码与合成候选通过；真实验收未执行 | 台账 `gates/G1.json`；归档提交哈希见 `outputs/finish-integration-20261105/G1/G1_RECEIPT.md` |
| 第二批 | L05 推荐、L06 模板通知导出 | 待开始 | 工作树在 G1 归档后创建 |
| G2 | 第二批集成 gate | 待开始 | |
| 第三批 | L07 自动政策、L08 验收加固 | 待开始 | 不预建工作树 |
| G3 | 第三批集成 + 端到端合成联调 + RC 影响表 | 待开始 | |
| 10 | 真实验收与第二台机器 | 未开始 | 需要用户授权与真实环境 |
| 11 | 最终复核与交付 | 未开始 | |

第一批四线全部合入 `integration/delivery-finish`，合并均为 `--no-ff` 保留原始提交，无冲突、无改写他线分支。

## 四条开发线（G0 建立，G1 收口）

| 线 | 任务文件 | 工作树 | 分支 | 交付 HEAD | 合入提交 | taskIds | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L01 | `01_PROJECT_WORKFLOW.md` | `E:\javaproject\workbuddy-finish\L01-project` | `feat/finish-l01-project` | `226af90`（1 提交，12 文件 1231+/55-） | `960ee3a` | D2-01–04；V02/V06/V10/V11；C01–05/C14/C16/C17 | 已合入 |
| L02 | `02_RESOURCE_TRUST.md` | `L02-resources` | `feat/finish-l02-resources` | `35d7e0e`（3 提交，16 文件 2902+/17-） | `6e71c93` | D3-01–04；C08–C11/C15；D6-01（仅接口面） | 已合入（三项 integration-request 已接线） |
| L03 | `03_USAGE_STATISTICS.md` | `L03-statistics` | `feat/finish-l03-statistics` | `31d6033`（2 提交，17 文件 3257+/8-） | `b52ce2b` | D6-01/02/05；V12；C12/C18 统计子项 | 已合入（五项 request 四项采纳，第 5 项未做） |
| L04 | `04_INSTALLATION_RELEASE_PREP.md` | `L04-installation` | `feat/finish-l04-installation` | `5527850`（1 提交，10 文件 1680+/39-） | `0dfe653` | D7-01/03；D1-01 准备 | 已合入（无 integration-request） |

四线相对 G0 基线合计 56 文件 9448+/119-；`desktop/` 变更文件数为 0，因此本轮不触发 C# 策略检查与桌面构建检查。共享入口、DB schema/migration、核心准入、MCP/HTTP 注册、全局导航、包白名单、`workbench-assets`、技能六文件一致性与总进度仍由集成人持有。

## G0 实测结果（本机，2026-11-05，Windows，Node 24.19.0）

| 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 构建 | `npm run build` | exit 0 | `G0/logs/build.log` |
| 任务视图类型 | `npm run typecheck:task-view` | exit 0 | `G0/logs/typecheck-task-view.log` |
| A 专项 | `npx tsx --test test/candidate-installation.test.ts test/deployment.test.ts` | 25/25 通过，exit 0 | `G0/logs/special-a.log` |
| B 专项 | `npx tsx --test test/desktop-catalog-diagnostics.test.ts test/desktop-dispatch.test.ts test/desktop-dispatch-runtime.test.ts test/dsh-discovery.test.ts test/dsh-adapter.test.ts` | 56/56 通过，exit 0 | `G0/logs/special-b.log` |
| C 专项 | `npx tsx --test test/delivery-baseline.test.ts test/live-acceptance-fixture.test.ts` | 19/19 通过，exit 0 | `G0/logs/special-c.log` |
| 工作台 | `npm run test:workbench` | 103/103 通过，exit 0 | `G0/logs/workbench.log` |
| 打包白名单测试 | `npx tsx --test test/package.test.ts` | 12/12 通过，exit 0 | `G0/logs/package-test.log` |
| 全量 | `npm test` | 1048 项 / 1036 通过 / 0 失败 / 12 平台跳过，exit 0，363.3 秒 | `G0/logs/full-test.log` |

G0 首轮全量曾出现 5 项失败，全部在 `test/package.test.ts`：白名单新增三个脚本后，该测试的源树夹具未同步，`collectReleaseFiles` 报 `Missing release file scripts/candidate-installation.mjs`。已补夹具条目，`test/package.test.ts` 12/12 通过后重跑全量得到上表结果。首轮日志被同名通过轮覆盖，未单独留盘；首轮结论只以上述计数与失败标题为准，不并入通过轮。

## G1 实测结果（本机，2026-11-05，Windows，Node 24.19.0）

环境：清空继承的 `WORKBUDDY_*` 与 `NODE_TEST_CONTEXT`，`WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR` 指向 `outputs/finish-integration-20261105/G0/env/` 下的合成值，`NO_PROXY=127.0.0.1,localhost`。日志目录 `outputs/finish-integration-20261105/G1/logs/`。

| 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 构建 | `npm run build` | exit 0 | `build.log` |
| 任务视图类型 | `npm run typecheck:task-view` | exit 0 | `typecheck-task-view.log` |
| 四线专项（18 个文件合跑） | `npx tsx --test --test-concurrency=1 test/desktop-projects.test.ts test/desktop-dispatch-terms.test.ts test/desktop-dispatch.test.ts test/desktop-catalog-diagnostics.test.ts test/desktop-dispatch-e2e.test.ts test/resource-connections.test.ts test/resource-attribution.test.ts test/resource-snapshot-store.test.ts test/resource-trust-http.test.ts test/statistics.test.ts test/statistics-page.test.ts test/installation-dependencies.test.ts test/installation-rollback.test.ts test/candidate-installation.test.ts test/deployment.test.ts test/delivery-baseline.test.ts test/live-acceptance-fixture.test.ts test/package.test.ts` | 169/169 通过，exit 0，64.8 秒 | `specials-g1.log` |
| 工作台 | `npm run test:workbench` | 117/117 通过，exit 0，5.3 秒 | `workbench-g1.log` |
| 包白名单测试 | `npx tsx --test test/package.test.ts` | 12/12 通过，exit 0 | `package-test.log` |
| 全量第一轮 | `npm test` | 1145 项 / 1132 通过 / **1 失败** / 12 跳过，exit 1，384.7 秒 | `full-test.log` |
| 失败项单跑 | `npx tsx --test --test-concurrency=1 test/run-worker.test.ts` | 5/5 通过，exit 0 | `run-worker-single.log` |
| 全量第二轮 | `npm test` | 1145 项 / 1133 通过 / 0 失败 / 12 跳过，exit 0，383.6 秒 | `full-test-round2.log` |
| 技能六文件一致性 | 根 `SKILL.md`、`agents/openai.yaml`、`references/{setup,execution,dispatch,agent-hub}.md` 与 `gateway/skills/workbuddy-executor/` 同名副本逐一 `git diff --no-index --ignore-cr-at-eol --ignore-all-space --quiet` | 六个全部 exit 0，无差异 | `skill-copy-diff.log` |

唯一失败项：`test/run-worker.test.ts:94` 的 `an actual detached worker survives its launcher exiting and writes its final evidence`，报 `AssertionError: Error: Timed out waiting for the simulated worker; snapshot={... "error":"EPERM: operation not permitted, rename 'C:\\Users\\LENOVO\\AppData\\Local\\Temp\\wb-worker-test-...\\runs\\...\\state.json.<pid>.<rand>.tmp' -> '...\\state.json'"}`。

- 与 L01 `HANDOFF.json` 记录的同名失败一致，都在全量并发负载下、只在 Windows 文件重命名环节出现；单跑与第二轮全量均通过。
- 归因仍是「未定位根因」：没有取得可复现的最小证据说明是高并发、杀软扫描还是别的机制，不写因果结论，也不以单跑通过宣布该问题不存在。
- 该失败不属于 L01–L04 新增模块的断言（`run-worker` 本线未改），但既然出现在本轮全量里就按失败保留，等后续 gate 观察是否复现。

## 集成侧在 G1 的修复与接线（均由集成人完成并验证）

1. `gateway/scripts/package.mjs`：必需文件清单加入 `installation-dependencies`、`installation-rollback` 的 `src`/`dist` 三类条目——L04 重写后的 `scripts/candidate-installation.mjs` 需要 `dist/installation-readiness.js`、`dist/setup.js`、`dist/installation-dependencies.js`、`dist/installation-rollback.js`；`gateway/test/package.test.ts` 夹具同步补齐，否则 5 个包用例会红。
2. `gateway/test/resource-connections.test.ts`：把合成凭据字面量 `"sk-synthetic-should-never-be-stored"` 改为 `"synthetic-credential-value-must-not-be-echoed"`。原值命中打包器的令牌扫描（`Possible access token in release file: test/resource-connections.test.ts`）。选择改夹具而非放宽扫描器：扫描器是保护，变量本身只用于断言「不被回显」，改值不损语义；复跑 12/12 通过。
3. L02 request ①（接口契约）：`docs/INTERFACE_CONTRACT.md` 登记 `/workbench/v1/resources/credit-balances`、`/workbench/v1/resources/routing`、`/workbench/v1/resources/plan-reference` 三条只读接口，并写明 routing 追加的 `layers`（三层各带 `verified`/`code`）、`connectionRegistry`（`workbuddy-executor/resource-connections-1`，`credentialEnv` 只接环境变量名）、`connectionDiagnostics`、`requestAttribution`（恒 `unavailable`，见 `workbuddy-executor/request-attribution-1`）四块字段，以及「三层全 `verified:false` 时只能显示已声明/已观测，不得写成已核验」的约束。
4. L02 request ②（配置入口）：`docs/RESOURCE_SOURCE_ROUTING_ACCEPTANCE.md` 新增「只读配置入口」一节，登记 `WORKBUDDY_RESOURCE_LINKS_FILE`（`execution-links-1`）与 `WORKBUDDY_RESOURCE_CONNECTIONS_FILE`（`workbuddy-executor/resource-connections-1`）：两者都只接受本机绝对路径 JSON、只读打开、`credentialEnv` 只接变量名、`sourceUrl` 仅回环、未设置时如实报 `not_declared`。
5. L02 request ③（分层登记）：见下节「任务分层登记」。
6. L03 五项 request：①`workbench-http.ts` 可选 `statistics` 注入 + `handleStatisticsRequest` + `isKnownPath` 两条判定；②`workbench-entry.ts` 组合根注入 `statisticsSources(store, ...)`；③`workbench-assets.ts` 与 `scripts/package.mjs` 登记 `statistics.mjs`/`statistics.css`；④`index.html` 一行样式表 + `app.mjs` 导航三态；四项均采纳。第 ⑤ 项（可选 `task-application-service.readTaskStatistics` 的 MCP 包装）**未做**，原因：本 gate 未要求，MCP 工具面属于核心注册面，留到 G3 统一评估。
7. `docs/` 下三处契约/验收文档改动与五份 `Lxx_ACCEPTANCE.md` 均不入发布包（`docs` 白名单只覆盖 `gateway/docs/` 的 13 个文件名），已核对 `package.mjs` 规则后确认。

## 任务分层登记（L02 request ③）

只登记「本轮能证到哪一层」，不把源码具备写成真实可用：

| 任务 | 本轮可证的层级 | 未满足的部分 |
| --- | --- | --- |
| D3-01 / D3-02 | 源码 + 合成验证：连接注册表、信任分层、只读路由证据均由合成夹具驱动并通过 132 项资源套件 | 真实账号池、真实余额来源、真实 UI 点击未执行（10） |
| D3-03 / D3-04 | 合成通过：快照存储、归因投影、风险与限制展示 | 运行中监督与真实来源联调未执行 |
| D6-01 | 仅接口面：已登记三条只读接口与字段语义 | 请求级归因不可用（上游只给账号×模型聚合），已出缺口文档与待办 |
| D6-02 / D6-05 | 统计服务、只读统计视图、CSV 之外的聚合均合成验证 | 真实浏览器点击、真实账本规模未验证 |

## 候选包（G1）

- 网关包：`gateway/outputs/release/codex-workbuddy-gateway-v0.7.1.zip`，**634 个业务文件，1 985 113 字节，SHA-256 `390d54062ca990eab21758293643f8ad7eedc8c5b7ea2d8d4648e6f5bd9f3658`**（`.sha256` 与 `.manifest.json` 同目录）
- 技能包：`workbuddy-executor-v0.7.1.zip`，6 文件，SHA-256 `9988ec8b173869234de72daa3794cd186828c05fd66eacc14fa806eb2df3b666`（L01 改了 `SKILL.md`，故与 G0 不同）
- Harness 技能包：`deepseek-executor-v0.7.1.zip`，2 文件，SHA-256 `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13`（未变）
- G0 的旧发布产物（581 文件）已移到 `outputs/finish-integration-20261105/G0/release/` 留档；打包器拒绝覆盖既有 release 输出，重打包前必须先移走。

解包目录 `outputs/finish-integration-20261105/G1/candidate/codex-workbuddy-gateway-v0.7.1/`（635 项，含 `RELEASE_MANIFEST.json`）实际执行：

| 工具 | 结果 |
| --- | --- |
| 包内 `scripts/verify-release.mjs` | `{"version":"0.7.1","verifiedFiles":634,"hashesMatch":true}`，exit 0 |
| `candidate-installation.mjs check --package <zip> --expect-sha256 390d54…` | exit 0，`ok=true`，files=634，problems=0 |
| `... preview --install-root <空目录> --codex-home <自建>` | exit 1（预期）：`safeToApply=false`，create=634、update/unchanged/blocked/unmanaged/managedDrift 全 0；8 项要求里只有 `runtime_dependencies`、`desktop_application` 为 `ok:false` |
| `... version-check --install-root <解包根>` | exit 0，`matches=true`，identities 一条 `exact=true version=0.7.1` |
| `... dependencies --install-root <解包根> --workbuddy-app <合成 exe> --workbuddy-config <G0 env>` | exit 1，`blocksInstall=true`：11 项探针中 `production_dependencies:missing`、`workbuddy_data:mismatch`、`desktop_shell:not_applicable`、`code_signing:not_applicable` 非 ok（未装依赖的纯包，属预期） |
| `... drill --drill-root <空目录> --apply` | exit 0；steps 4/4、checks 5/5、negatives ok（install_repeat 的 `unchanged=true`） |
| `... upgrade-drill --drill-root <空目录> --apply` | exit 0；steps 17/17、checks 17/17、negatives ok；`rollback_plan_is_read_only` 计数 `replace=2 create=0 remove=1 keep=632 blocked=0` |
| `... rollback-plan --package <新> --to <G0 zip> --install-root <解包根> --codex-home <自建>` | exit 0，`safeToApply=true`，`replace=42 create=0 remove=53 keep=539 blocked=0` |
| `scripts/delivery-baseline.mjs --source-root <解包根> --candidate-archive <zip>` | exit 0，`readOnly=true`、`authorizesDispatch=false`，limitations 5 条 |
| `scripts/live-acceptance-fixture.mjs create --parent <目录>` | exit 0，`authorized=false`、`preparedOnly=true`，`baselineSha256=1d49ab9c966cbe51be3dc8acd765995210a6ef0568d4d9f2a24c97b48cfcd59a` |
| `... verify --root <夹具> --baseline-sha256 <外部摘要>` | exit 0，`{ok:true, preparedOnly:true, authorized:false, problems:[]}` |
| 包内 `npm ci --omit=dev` | exit 0，`added 94 packages`，用于启动冒烟 |

受控启动冒烟（解包候选 + 自带依赖，`WORKBUDDY_DB_FILE`/`WORKBUDDY_RUNS_DIR` 指向 `G1/run/smoke/` 下自建库，`node dist/workbench-entry.js` 打印 `{"ok":true,"event":"workbench_http_listening","port":18493,"backend":"desktop-queue","readOnly":true}`）：

| 请求 | 结果 |
| --- | --- |
| `GET /workbench/v1/health` | 200，`ready:true`，`packageVersion 0.7.1`，release `portability-20261018.1` |
| `GET /workbench/v1/statistics` | 200，`workbuddy-executor/statistics-1`，`readOnly:true`、`snapshotOnly:true`、`tasksRead:0`（空库如实为 0） |
| `GET /workbench/v1/resources/routing` | 200，`routing-evidence-1`，`routingVerified:false`，`basis:"gateway_observation_only"` |
| `GET /workbench/v1/resources/credit-balances` | 200，`credit-balance-1`，`connections:[]`、`actualTaskCredits:null`、`attribution:"connection_only"` |
| `GET /workbench/statistics.mjs`、`/workbench/statistics.css` | 200（资产白名单生效） |
| `GET /workbench/` | 200（875 字节）；`/workbench/index.html` 为 404，资产键是 `/workbench/`，属既有行为 |
| `POST /workbench/v1/statistics` | 405，`allow: GET, HEAD` |

冒烟按 PID `Stop-Process` 结束，未按进程名批量杀。启动前必须先 `npm ci --omit=dev`，否则 `dist/task-view-reader.js` 会报 `ERR_MODULE_NOT_FOUND: zod`。面板端口由内置默认 18493 决定，`WORKBENCH_PORT` 不生效。

## 外部条件与未决（不在 G1 关闭）

- 真实安装、升级、生产切换、回滚实跑与跨机器验收：未执行；本轮的 preview 非零退出、`dependencies` 阻断与 drill/upgrade-drill 均为隔离演练目录内的合成形态，不构成真实环境结论。
- 已安装技能 + 真实 MCP 双端真实模型派工（D1-02）：未执行；D1 与安装的提前补验结果只归 G1 的源码/合成层，不升级为可用。
- 第二台物理 Windows、代码签发与许可决定：未开始；许可位置由权利人决定。
- 原 P0-1 未知：按 T7D 决定不关闭、不重派、不释放；不以 TTL、换库、taskId、operationId 或替代会话绕过。
- 生产 `workflow_capacity(slot=1)` 仍存在占用；本轮只在自建合成库上做冒烟，未触碰生产生产者状态，生产共享容量维持 1。
- 真实资源账号池、请求级归因、任务→模型实际路由、D3-04 运行中监督仍需真实来源（10）。
- `test/run-worker.test.ts` 的 detached worker 重命名 EPERM：本轮全量第一轮复现一次、单跑与第二轮未复现，根因未定位。
- 本分支未推送、未合 main、未发布、未部署；原集成树 `README.md`、`ROADMAP.md` 的在途改动未被读取改写，其摘要与 G0 采集时一致。

## 下一批开工条件（L05/L06）

1. 集成人已把 G1 归档提交写入 `gates/G1.json` 与 `G1_RECEIPT.md`；L05、L06 工作树按 COMMON 从该归档提交创建，分支 `feat/finish-l05-recommendation`、`feat/finish-l06-productivity`。
2. 开工前各自 `git rev-parse HEAD` + `git status --porcelain` 核对，与回执不一致即停下，不 reset/checkout/切分支，不猜 SHA。
3. 只在自己的工作树提交，固定交 `docs/delivery/Lxx_ACCEPTANCE.md` 与 `outputs/finish-lxx-20261105/HANDOFF.json`（字段见 COMMON），证据同目录留盘。
4. 需要共享入口/包清单/schema 接线时写 `integration-request`，由集成人在集成分支实际接线并验证；不得直接改共享入口、包白名单、`workbench-assets` 或技能六文件。
5. 依赖 `dist` 的检查先构建；断言真实测试数与退出码，空测试 exit 0 不算通过；不重复跑与本线无关的全量与打包。
