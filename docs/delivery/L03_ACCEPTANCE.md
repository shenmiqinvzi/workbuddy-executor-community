# L03 验收记录：请求归因与可复算统计

任务线：L03（D6-01 / D6-02 / D6-05 的 03 侧）。工作树 `E:\javaproject\workbuddy-finish\L03-statistics`，分支 `feat/finish-l03-statistics`。

## 1. 范围

本线交付“可复算的统计读取面”：

- 上游请求字段 → 本地账本：`gateway/src/usage-attribution.ts`
- 任务事实 → 指标：`gateway/src/task-metrics.ts`
- 只读聚合与窗口：`gateway/src/statistics-service.ts`
- 两个只读端点：`gateway/src/statistics-http.ts`
- 只读视图：`gateway/workbench/statistics.mjs`、`statistics.css`，以及 `index.html` / `app.mjs` 里的入口

明确不做（归属其他线或集成人）：统一 schema 与 migration、`TaskStore` 结构、`TaskApplicationService` 的方法面、01 的派工选择、02 的真实采集实现、04 的安装与升级、MCP 工具暴露（第 5 节列为可选）。

## 2. 基线与提交

| 项 | 值 |
| --- | --- |
| 基线提交 | `1f60374a889ae5acb442affff7a59f3e045a1277`（`chore: 建立 G0 统一开发基线`） |
| 基线 tree | `a45970de95336ed79d99b835fc582d467d9e2e7d` |
| 本线提交 | `b0ee3f7`（实现、测试、集成请求文档与页面入口） |
| 分支 | `feat/finish-l03-statistics` |
| 工作树 | `E:\javaproject\workbuddy-finish\L03-statistics` |

提交后 `git status --porcelain` 为空；未 push、未合 main、未发布、未部署。

## 3. 变更文件

新增（行数）：

- `gateway/src/usage-attribution.ts` 742
- `gateway/src/task-metrics.ts` 396
- `gateway/src/statistics-service.ts` 494
- `gateway/src/statistics-http.ts` 110
- `gateway/workbench/statistics.mjs` 236
- `gateway/workbench/statistics.css` 16
- `gateway/test/statistics.test.ts` 846（31 个用例）
- `gateway/test/statistics-page.test.ts` 46（3 个用例）
- `docs/delivery/L03_INTEGRATION_REQUEST.md`

接线（每处都实测，不是只报模块完成）：

- `gateway/src/workbench-http.ts` +15：可选 `statistics` 注入、统计路由分发、已知路径 405 判定
- `gateway/src/workbench-entry.ts` +8：组合根注入 `statisticsSources(store, attributeTaskUsageFromLedger)`
- `gateway/src/workbench-assets.ts` +2：`statistics.mjs` / `statistics.css` 白名单
- `gateway/scripts/package.mjs`：发布清单加入同两个文件
- `gateway/test/package.test.ts`：发布夹具补同两个文件（否则“每个运行时文件都必须打包”守卫会红）
- `gateway/workbench/index.html` +1：样式表
- `gateway/workbench/app.mjs` +48/−7：统计导航、挂载点、三态 `setView`

## 4. 验证

所有命令在 `E:\javaproject\workbuddy-finish\L03-statistics\gateway` 下执行；依赖按本树 `package-lock.json` 安装，未改版本。测试前清掉继承的 `WORKBUDDY_PYTHON`，并注入隔离环境（`WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR`、`WORKBUDDY_DB_FILE`、`TEMP`/`TMP` 指向 `outputs\finish-l03-20261105\env`），回环请求加 `NO_PROXY=127.0.0.1,localhost`。

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `npm ci --no-audit --no-fund` | 0 | 100 包；esbuild postinstall 被 allow-scripts 跳过（warning，不影响 tsc/tsx） | — |
| `npm run build`（`tsc -p tsconfig.json`） | 0 | 无诊断 | — |
| `npx tsx --test test/statistics.test.ts` | 0 | 31 tests / 31 pass / 0 fail | `logs\statistics-test.log` |
| `npx tsx --test test/statistics-page.test.ts` | 0 | 3 tests / 3 pass / 0 fail | `logs\statistics-page-test.log` |
| `npx tsx --test test/package.test.ts` | 0 | 12 tests / 12 pass / 0 fail | `logs\package-test.log` |
| `npm test`（全量） | 0 | 1082 tests / 1069 pass / 0 fail / 13 skipped | `logs\full-suite-final.log` |
| `node dist/workbench-entry.js` + curl（回环冒烟） | 0 | 见 4.1 | `smoke\server.log`、`evidence\smoke.json` |
| `node evidence/contract-envelope.mjs` | 0 | 见 4.2 | `evidence\contract-envelope.json` |

`statistics.test.ts` 覆盖的断言（按用例名）：

- envelope：完整合成行可解析；错 schema 版本被拒；未知字段/未知 limitation/重复行被拒；unavailable 带值、单位与币种混用、重试指向自身被拒。
- 账本：重放是 `duplicate` 且保留首次 `observed_at`；值或发生时间不同是冲突且保留原行；同一 request 在第二个 scope 下是独立行；缺表读为 absent 且不建表；从文件只读打开不建表不迁移；半开区间与排序；凭据形状与路径形状的 scope 被形状拒绝。
- 归因：全绑定且全 `reported` 才是 exact，同池其他客户端的行不计入；未绑定 attempt 或缺重试父降为 `connection_only`；无测量值即 `unavailable`，绝不记 0；估算与共享池写进 limitations；tokens/credits/currency 分组不相加；请求引用有上限并说明截断。
- 指标：六类时间、调用分组、验收、返工、恢复、干预、用量；乱序事件与迟到观察不改发生时间；legacy 任务无事件流时为 null 而非 0；checker_error / failed / 未记录分开计；返工按已发送轮次而非事件次数；一个 episode 不按两条事件计。
- 查询与聚合：from/to/limit 之外拒收；单任务摘要不写库；未知任务、非法 id、契约损坏各有独立失败码；分页封顶时如实标 truncated；概览的窗口、合计、归因计数与 `claims.savings/superiority=null`；无账本时全部 `unavailable`。
- HTTP：概览/详情/路径形状 id 的状态码；存储失败是 503 而不是空页。

`statistics-page.test.ts` 覆盖：未测量值渲染 `NA`（0 仍渲染 0）、单位与币种分行不合并、归因三态标签。

`workbench-assets.test.ts`、`workbench-http.test.ts`、`workbench-panel.test.ts` 在接线后仍通过（合计 56 pass，含本线两个文件）。

### 4.1 回环冒烟（合成数据，无模型请求）

合成库：1 个任务、2 条事件、1 行账本（tokens=1234），`sha256=c43ba262d5de90f7183a319c29edc22164805a99eef93917387184057b03beec`。以 `WORKBUDDY_WORKBENCH_PORT=18531` 启动 `node dist/workbench-entry.js`：

- `GET /workbench/v1/statistics?limit=50` → 200；`coverage.tasksRead=1`、`eventsRead=3`、`totals.usage=[{unit:"tokens",amount:1234}]`、`attribution.connection_only=1`、`claims.savings=null`、`claims.superiority=null`
- `GET /workbench/v1/statistics/tasks/task-smoke` → 200；`metrics.usage.tokens=1234`、`actualCredits=null`、`limitations` 含 `usage_attempt_binding_incomplete`、`required_checks_unavailable`
- `?limit=500`、`?limit=0` → 400 `INVALID_LIMIT`；`?from=yesterday`、`from>to` → 400 `INVALID_WINDOW`
- `tasks/..%2F..%2Fetc%2Fpasswd` → 400 `INVALID_TASK_ID`；`tasks/nope` → 404 `TASK_NOT_FOUND`；`/statistics/nope` → 404 `NOT_FOUND`
- `POST` → 405 且 `allow: GET, HEAD`
- `/workbench/statistics.mjs`、`.css` → 200 且 content-type 正确；`.map` → 404
- 停机后库 `sha256` 与种子完全一致、`-wal` 为 0 字节：所有 GET（含 200）未写任务、未写事件、未写契约

### 4.2 与 02 线的契约联调（合成 envelope）

`evidence/contract-envelope.json`：3 行 envelope（worker 2048、worker 重试 512、reviewer 共享池 unavailable）解析成功；多余字段 `extra` 被拒并给出字段路径；第 4 次写入是 `duplicate`（聚合仍 3 行，tokens 合计 2560，而不是 4608）；reviewer 行触发 `shared_pool_scope`，整体降为 `connection_only`（`measuredRecords=2/3`）；unavailable 行只计 `unavailableRecords=1`，不参与 `amount`。

这正是 D6-01 要的边界：重复事件不重复累计，共享池他人消耗不计入本任务，缺测量值时不产生数字。

## 5. 失败历史（如实记录）

1. `usage-attribution.ts` 首次编译 `TS2345`：`nonEmptyText(value, max = ...)` 的默认值把形参窄化为字面量，已改为 `max: number`。
2. `workbench-http.ts` 首次 import `StatisticsSources` 从 `statistics-http.js` 取，`TS2724`；该类型定义在 `statistics-service.ts`，已改。
3. 首轮 `statistics.test.ts` 4 个失败：服务层未校验 taskId 形状（`task/../../etc/passwd` 落 `task_not_found`）、概览夹具的记录 taskId 与查询不一致、`errorBody` 用大写码查 `statusFor` 导致 400/503 落 500。分别以“服务层 id 形状守卫”“夹具对齐”“小写码取状态、大写码进 body”修复。
4. 首次全量 `npm test`：1082 tests / 174 fail，全部是继承宿主环境的 `Multiple WorkBuddy installations …`，与本线无关；注入隔离环境后降到 2 fail，即下一条。
5. 隔离后仅剩两个资产一致性守卫失败（`every workbench runtime file is served by the HTTP allowlist` / `ships in the release package`），因为新页面文件没登记；补白名单与发布清单后通过。
6. 补登记后全量仍有 5 fail：`package.test.ts` 的发布夹具是固定文件表，新加的两个 workbench 文件不在表里；补夹具后该文件 12 pass。
7. 一次全量跑在约 60% 处无摘要终止（`exit=-1`，日志停在契约测试中段），无 `not ok`、无断言输出；随后同样的命令与环境跑完并 0 fail。原因未定，记为一次未解释的进程中断，不作为通过证据。

## 6. 局限（未验证或无法验证的部分）

- 本树没有任何真实上游用量记录：所有数字都是合成夹具。真实请求归因覆盖率属于 10 的真实环境验收，这里不做结论。
- `calls` 目前恒为空数组：本树没有 `tool_call_finished` / `local_check_finished` 的生产者（全仓只有类型定义），因此指标里以 `event_stream_absent` / 空集合表达，不写 0。
- `usage.catalogRateLabel` 与 `activeReasoningSeconds` 恒为 null（目录费率与活跃推理时间没有来源），分别带 `catalog_rate_label_unavailable` / `active_reasoning_time_unavailable`。
- 页面未在真实浏览器里点过：模块函数有单元测试，页面消费的 HTTP 契约有回环冒烟，但“点开统计页看到什么”没有截图证据。
- 时间窗只支持 UTC ISO（必须以 `Z` 结尾），按任务 `createdAt` 过滤，不按事件时间过滤；跨时区解释由调用方负责。
- 未测节省、未测优劣一律为 `null` 并写明 `savings_not_measured` / `superiority_not_measured`；本线不提供任何“更省/更快”的结论。
- 账本 schema 由本线自带 `CREATE TABLE IF NOT EXISTS`，没有版本升级或回退机制；读取面在缺表时返回 `present:false` 并拒绝建表，已有数据库不会被回填。

## 7. 运行与部署状态

- 运行状态：只在回环冒烟中以 `node dist/workbench-entry.js` 跑过，端口 18531，进程已停止；`dist/` 为构建产物，未提交。
- 部署状态：未部署，未安装，未改任何 profile，未改 `E:\javaproject\workbuddy-resource-integration` 的既存改动。
- 发布状态：未打包、未 push、未合 main；`releaseReady` 未成立（真实环境验收在 10 线）。

## 8. 交接产物

- 本文件：`docs/delivery/L03_ACCEPTANCE.md`
- 集成 patch 与联调步骤：`docs/delivery/L03_INTEGRATION_REQUEST.md`
- 证据：`E:\javaproject\outputs\finish-l03-20261105\`（`HANDOFF.json`、`evidence\smoke.json`、`evidence\contract-envelope.json`、`evidence\seed.mjs`、`evidence\contract-envelope.mjs`、`logs\*`）
