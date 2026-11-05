# 交付状态索引（唯一现状入口）

本文件是实施 `docs/parallel/DELIVERY_FINISH_20261105/` 规划包期间的唯一现状入口。每次 gate 只在此处与 `gates/Gn.json` 更新当前状态；`docs/PROGRESS.md` 保留为历史流水，不再作为现状判据。所有数字均来自本轮实际执行，未执行的一律写「未执行」并给出缺失条件。

## 阶段与 gate

| gate | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| G0 | 统一开发基线（合入 A/B/C、补公共清单、构建专项全量打包、建 01–04 工作树） | 已完成（2026-11-05） | 本文件所在提交即 G0 归档；台账见 `gates/G0.json` |
| 第一批 | L01 项目流程、L02 资源信任、L03 统计归因、L04 安装发行 | 待开始 | 四条线工作树已建立在 G0 基线提交上 |
| G1 | 第一批集成 gate | 待开始 | 依赖 L01–L04 交付 `HANDOFF.json` |
| 第二批 | L05 推荐、L06 模板通知导出 | 待开始 | 不预建工作树 |
| G2 | 第二批集成 gate | 待开始 | |
| 第三批 | L07 自动政策、L08 验收加固 | 待开始 | 不预建工作树 |
| G3 | 第三批集成 + 端到端合成联调 + RC 影响表 | 待开始 | |
| 10 | 真实验收与第二台机器 | 未开始 | 需要用户授权与真实环境 |
| 11 | 最终复核与交付 | 未开始 | |

## 四条开发线（G0 建立）

| 线 | 任务文件 | 工作树 | 分支 | taskIds | 拥有模块（摘要） | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| L01 | `01_PROJECT_WORKFLOW.md` | `E:\javaproject\workbuddy-finish\L01-project` | `feat/finish-l01-project` | D2-01–04；V02/V06/V10/V11；C01–05/C14/C16/C17 | `desktop-dispatch*.ts`、`workbench/dispatch.mjs`、本线新增项目/目录视图与定向测试；根技能六文件与 gateway 发布副本 | 待开始 |
| L02 | `02_RESOURCE_TRUST.md` | `E:\javaproject\workbuddy-finish\L02-resources` | `feat/finish-l02-resources` | D3-01–04；C08–C11/C15 | `resource-routing`、`plan-resource-reference`、`quota-observation`、资源采集/统计客户端、`workbench/resources*`、`plan-reference`、`resource-source-acceptance.mjs` | 待开始 |
| L03 | `03_USAGE_STATISTICS.md` | `E:\javaproject\workbuddy-finish\L03-statistics` | `feat/finish-l03-statistics` | D6-01/02/05；V12；C12/C18 统计子项 | 新增 `usage-attribution`/统计模块、只读统计视图、定向测试 | 待开始 |
| L04 | `04_INSTALLATION_RELEASE_PREP.md` | `E:\javaproject\workbuddy-finish\L04-installation` | `feat/finish-l04-installation` | D7-01/03；D1-01 准备 | `installation-readiness`/`deployment-safety`、安装与桌面构建打包专属脚本、依赖诊断、Windows 安装恢复文档 | 待开始 |

四线共同基线提交、HEAD 与 tree 见 `gates/G0.json`。共享入口、DB schema/migration、核心准入、MCP/HTTP 注册、全局导航、包白名单、`workbench-assets`、技能六文件一致性与总进度仍由集成人持有；需要接线时按 COMMON 提交 `integration-request`。

## G0 实测结果（本机，2026-11-05，Windows，Node 24.19.0）

| 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 构建 | `npm run build` | exit 0 | `logs/build.log` |
| 任务视图类型 | `npm run typecheck:task-view` | exit 0 | `logs/typecheck-task-view.log` |
| A 专项 | `npx tsx --test test/candidate-installation.test.ts test/deployment.test.ts` | 25/25 通过，exit 0 | `logs/special-a.log` |
| B 专项 | `npx tsx --test test/desktop-catalog-diagnostics.test.ts test/desktop-dispatch.test.ts test/desktop-dispatch-runtime.test.ts test/dsh-discovery.test.ts test/dsh-adapter.test.ts` | 56/56 通过，exit 0 | `logs/special-b.log` |
| C 专项 | `npx tsx --test test/delivery-baseline.test.ts test/live-acceptance-fixture.test.ts` | 19/19 通过，exit 0 | `logs/special-c.log` |
| 工作台 | `npm run test:workbench` | 103/103 通过，exit 0 | `logs/workbench.log` |
| 打包白名单测试 | `npx tsx --test test/package.test.ts` | 12/12 通过，exit 0 | `logs/package-test.log` |
| 全量 | `npm test` | 1048 项 / 1036 通过 / 0 失败 / 12 平台跳过，exit 0，363.3 秒 | `logs/full-test.log` |
| 打包 | `node scripts/package.mjs` | exit 0 | `logs/package.log` |
| 技能副本一致性 | 根 `SKILL.md`、`agents/openai.yaml` 与 `gateway/skills/workbuddy-executor/` 同名文件按行尾/空白规范化比对 | 无差异 | `logs/skill-copy-diff.log` |

G0 首轮全量曾出现 5 项失败，全部在 `test/package.test.ts`：白名单新增三个脚本后，该测试的源树夹具未同步，`collectReleaseFiles` 报 `Missing release file scripts/candidate-installation.mjs`（另 4 项为 `release archive uses a file allowlist...`、`complete release includes every Harness component...`、`release refuses a populated example secret...`、`release refuses token-like content...`，首轮计数 1048 项 / 1031 通过 / 5 失败 / 12 跳过）。已补夹具条目，`test/package.test.ts` 12/12 通过后重跑全量得到上表结果。首轮日志被同名的通过轮覆盖，未单独留盘；首轮结论只以上述计数与失败标题为准，不并入通过轮。

## 候选包

- 网关包：`gateway/outputs/release/codex-workbuddy-gateway-v0.7.1.zip`，581 个业务文件，1 749 851 字节，SHA-256 `f8a94b78ec0b54056dac0bd3ad91c4f22c55e2f7d508307de1c7bb83662fc8c5`（`.sha256` 与 `.manifest.json` 同目录）
- 技能包：`workbuddy-executor-v0.7.1.zip`，6 文件，SHA-256 `2e5dcba6493f2efb64949a00c8571a1df51366ec012083eddb7b573fafebb4a6`
- Harness 技能包：`deepseek-executor-v0.7.1.zip`，2 文件，SHA-256 `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13`

从解包目录 `outputs/finish-integration-20261105/G0/candidate/codex-workbuddy-gateway-v0.7.1/` 实际执行：

| 工具 | 结果 |
| --- | --- |
| 包内 `scripts/verify-release.mjs` | 581 文件哈希全部匹配，exit 0 |
| `scripts/candidate-installation.mjs check --package <zip>` | exit 0，581 文件，declared 与实测摘要一致 |
| `... preview --install-root <空目录> --codex-home <自建>` | exit 1（预期）：`safeToApply=false`，create=581，blocked=0，unmanaged=0；8 项要求 6 通过，`runtime_dependencies`、`desktop_application` 为 false（包内不含 node_modules 与桌面可执行） |
| `... drill --drill-root <空目录> --apply` | exit 0；plan/install/install_repeat/uninstall 四步通过，installed/idempotent/uninstalled/envPreservedAfterUninstall/skillRemovedAfterUninstall 五项为 true |
| `scripts/delivery-baseline.mjs --source-root <解包根> --candidate-archive <zip>` | exit 0，`readOnly=true`、`authorizesDispatch=false` |
| `scripts/live-acceptance-fixture.mjs create --parent <目录>` | exit 0，`authorized=false`、`preparedOnly=true`，`baselineSha256=88f0f4dffc94e40a4b056ead8c1742d37e2a8aacbf12798f3ae36e6e95e916cf` |
| `... verify --root <夹具> --baseline-sha256 <外部摘要>` | exit 0，`ok=true`、`problems=[]` |
| 未修复样本的检查 | workbuddy 7 项中 5 项失败、dsh 7 项中 2 项失败，exit 1（样本按设计应先失败） |

预览退出码在管道中曾被 PowerShell 显示为 -1，改用 `Start-Process -PassThru` 复核为 **1**，与 `safeToApply=false` 一致。

## 集成侧对 A/B/C 的修复与回归

- `installation-readiness.ts`：<22 字节归档给出可读拒绝而不是 `ERR_OUT_OF_RANGE`；已安装记录不可解析时记入 `blocked(installed_manifest_unreadable)` 而不是硬抛或当作无漂移；`unmanaged` 清单超过 20000 项时置 `blocked(unmanaged_listing_truncated)` 并停止放行。
- `candidate-installation.mjs`：检查异常收敛为结构化失败输出。
- 回归：`test/candidate-installation.test.ts` 新增 2 例（空/截断归档、损坏安装记录）。超大目录截断只在 G0 一次性实测：20001 个文件的安装根预览得 `unmanaged` 列 20000 项 + `blocked=unmanaged_listing_truncated`、`safeToApply=false`、exit 1；该夹具创建需 30 秒，不加入自动套件。
- `package.mjs`：`candidate-installation.mjs`、`delivery-baseline.mjs`、`live-acceptance-fixture.mjs` 与 `installation-readiness` 的 `src`/`dist` 纳入必需文件与目录规则；`test/package.test.ts` 夹具同步补齐。四份新交付文档（`CANDIDATE_INSTALLATION_READINESS.md`、`TASK_PREPARATION_DIAGNOSTICS.md`、`D0_D1_DELIVERY_READINESS.md`、`D1_LIVE_ACCEPTANCE_PLAN.md`）不在 docs 白名单内，随源码提交但不入包。

## 外部条件与未决（不在 G0 关闭）

- 真实安装、升级、生产切换与跨机器验收：未执行，需用户明确授权与真实环境（10）。
- 已安装技能 + 真实 MCP 双端真实模型派工（D1-02）：未执行；D1 与安装的提前补验结果只归 G1。
- 第二台物理 Windows、签发与许可决定：未开始；许可由权利人决定，不代为授权。
- 原 P0-1 未知：按 T7D 决定不关闭、不重派、不释放；不以 TTL、换库、taskId、operationId 或替代会话绕过。
- 生产 `workflow_capacity(slot=1)` 仍存在占用，本轮未触碰生产者状态；生产共享容量维持 1。
- 真实资源账号池、任务→模型实际路由、D3-04 运行中监督仍需真实来源（10）。
- 本分支未推送、未合 main、未发布、未部署；原集成树 `README.md`、`ROADMAP.md` 的在途改动未被读取改写，其摘要前后一致。

## 下一批开工条件（L01–L04）

1. 先读 `COMMON.md`、`MASTER_PLAN.md`、本线与相邻线任务文件，只在自己的工作树提交。
2. 固定交付 `docs/delivery/Lxx_ACCEPTANCE.md` 与 `HANDOFF.json`（字段见 COMMON），证据放 `E:\javaproject\outputs\finish-lxx-20261105`。
3. 需要共享入口/包清单/schema 接线时写 `integration-request`，由集成人在集成分支实际接线并验证；不得直接改共享入口。
4. 依赖 `dist` 的检查先构建；断言真实测试数，空测试 exit 0 不算通过。
