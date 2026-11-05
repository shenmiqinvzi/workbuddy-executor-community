# 真实来源只读验收工具（resource-source-acceptance）

本文说明 `gateway/scripts/resource-source-acceptance.mjs`：它把「真实 token 统计 / 积分缓存」的验收从一次性脚本变成仓库内可重复运行的工具。工具只读取、不写上游，不登录面板，不发模型请求；它证明的是「这条已经注入的统计连接，能否走完采集 → 隔离缓存 → 正式只读 HTTP」，不代表账号池或任务级路由已经核实。

## 1. 两段式设计

| 模式 | 命令 | 行为 | 退出码 |
| --- | --- | --- | --- |
| 条件检查 | `node scripts/resource-source-acceptance.mjs --check` | 只读环境变量与构建产物，判断 URL 是否为回环 origin、凭据字段是否存在；不发任何请求，不登录 | `0` 请求的来源全部就绪；`2` 有缺项 |
| 显式执行 | `node scripts/resource-source-acceptance.mjs --execute` | 在条件具备时跑一次有界只读验收 | `0` 全过；`1` 有检查失败；`2` 缺条件或该侧未执行 |

`--source token|credit|both` 指定来源（默认 both），`--timeout-ms` 覆盖上游超时（默认 5000），`--state-dir` 复用指定隔离目录，`--keep` 保留该目录供检查。缺条件的一侧写进 `notExecuted`，`accepted` 只在所有请求来源都执行且全过时才为 true——少一侧永远不算通过。

`--check` 与 `--execute` 都不接受把「口令当会话令牌」：token 侧要求 `WORKBUDDY_QUOTA_PANEL_TOKEN`，它只能来自 `POST /panel/login` 的会话令牌。

## 2. 条件字段

| 来源 | 变量 | 说明 |
| --- | --- | --- |
| token | `WORKBUDDY_QUOTA_SOURCE_URL` | 必须 `http://127.0.0.1:<port>/` 或 `http://[::1]:<port>/`，不得带路径或查询 |
| token | `WORKBUDDY_QUOTA_API_KEY` | 统计 API 密钥 |
| token | `WORKBUDDY_QUOTA_PANEL_TOKEN` | 面板会话令牌（非口令） |
| credit | `WORKBUDDY_CREDIT_SOURCE_URL` | 同上的回环限制 |
| credit | `WORKBUDDY_CREDIT_API_KEY` | 统计 API 密钥 |

另需 `gateway/dist/` 已构建（`npm run build`）。条件检查报告把每个字段标成 `present` / `missing` / `invalid`，`invalid` 带 `not_loopback` 或 `url_has_path_or_query` 这类具体原因，并在 `actions` 里给出「在本机受保护进程里补哪个变量」的一句话。

## 3. 执行时用的是正式链路

`--execute` 不使用任何替代实现：

1. 正式 `TaskStore` 打开一个临时隔离数据库，正式 `TaskApplicationService` 装配；
2. 正式 `WorkbenchHttpServer.listen(0)` 只绑回环，正式 `serveWorkbenchAsset` 提供页面资源；
3. 正式 `WorkBuddyQuotaCollector` / `WorkBuddyCreditBalanceCollector` 各跑**一次**采集（`intervalMs` 设为一小时，避免工具停在那里轮询），失败按采集器自身语义落库；
4. 用工具自带的 HTTP 读取比对库与接口，全程包一层 `fetch` 记录器，只记 `{method, path}`，用来证明 GET 期间上游请求没有增加、也没有出现非 GET。

隔离目录默认是系统临时目录下的 `resource-source-acceptance-*`，结束即删；数据库、runs、端口都是本轮自建，生产网关、生产任务库与部署配置不参与。

## 4. 检查项

公共项（每条执行必出现）：

| id | 断言 |
| --- | --- |
| `isolated_service_listening` | 只绑回环并报出实际端口 |
| `no_model_requests` | 上游请求只有 `GET /usage/remaining` 与 `GET /v1/balance-summary` |
| `get_does_not_collect` | 三次 GET 期间上游请求计数不变 |
| `database_unchanged_by_reads` | 读取前后数据库文件 sha256 相同 |
| `routing_links_this_connection` | `routing-evidence-1` 的 `connections[]` 含本次连接 |
| `routing_primary_is_traceable` | 每条映射都有 `primaryConnectionId` 与非空 `sources[]` |
| `routing_never_claims_verification` | `routingVerified === false`（恒真，不得被本轮修复升级） |
| `unknown_states_are_not_upgraded` | `observed` 只能来自 `snapshot_fresh` / `cache_fresh` |
| `services_closed` | 报告写出前自建服务与存储已关闭 |
| `acceptance_completed` | 只在工具自身异常时出现并失败 |

token 侧：`token_collection_reported`（记录 `status` 与失败码，被拒绝也要留痕）、`token_snapshot_persisted`、`token_rows_attributed`（每行 `connectionIds` 含本连接，并记录 `truncated`）、`token_units_kept`（`unit === 'tokens'`，`valueKind ∈ {estimated, unavailable}`）、`token_null_is_not_zero`、`token_availability_distinct`、`token_times_ordered`（`sourceObservedAt ≤ collectedAt`）、`token_routing_unverified`、`token_task_usage_absent`（`actualTaskTokens`/`actualTaskCredits` 为 null）、`token_http_serves_snapshot`、`token_http_matches_store`。

credit 侧：`credit_collection_reported`、`credit_snapshot_persisted`、`credit_unit_is_not_currency`（`unit === 'credit'`、`valueKind === 'reported_cache'`）、`credit_coverage_matches_counts`、`credit_null_balance_not_zero`（`accountsWithData === 0` 当且仅当 `balance === null`）、`credit_member_freshness_separate`（`balanceFreshness` 不会是 `fresh`）、`credit_times_ordered`、`credit_http_serves_snapshot`、`credit_http_matches_store`。

## 5. 输出与脱敏

报告是一个 JSON：`mode`、`executed`、`accepted`、`exitCode`、`sources`、`checks[]`、`notExecuted`、`stateDir`、`packageSchema`、`observations[]`、`note`。字段值只有布尔、状态码、schema 版本、coverage 枚举、ISO 时间与计数。

不进入报告的内容：URL 之外的凭据、`Authorization` 头、`X-Panel-Token`、账号 `uid`/昵称、余额数值、上游原始响应。错误只保留白名单字段里的 `code`（例如 `source_unauthorized`、`source_timeout`、`source_invalid`），异常对象的原始属性不落盘。回归里有一项专门断言：报告全文不含测试用的密钥、面板令牌、`Bearer`、账号名与余额数值。

## 6. 授权与凭据

工具不会自行发现凭据，也不会因为磁盘上存在某个 Key 就认为可以使用：它只读当前进程环境里已注入的变量。执行前需要用户明确这两件事，且**不要**把值发到聊天里：

1. 积分侧：把 `WORKBUDDY_CREDIT_SOURCE_URL` 与 `WORKBUDDY_CREDIT_API_KEY` 注入运行验收的受保护进程，并确认这份 Key 的读取授权覆盖本轮验收；
2. token 侧：由用户本人登录一次面板，把 `POST /panel/login` 返回的会话令牌注入同一进程的 `WORKBUDDY_QUOTA_PANEL_TOKEN`（会话在 hub 内存里，重启即失效，有效期内请勿外传）。

注入后在本机跑 `--check` 看到两侧 `ready: true`，再跑 `--execute --source both`，把 `reports/*.json` 留作证据。工具自身的进程退出即结束自建服务，不会碰生产 hub。

## 7. 已验证与未验证

已验证（隔离合成源，非真实账号池）：条件缺失 / 单侧执行 / 双源全通 / 401 / 超时 / 坏载荷 / 空上游不冒充通过 / 脱敏 / 服务与状态目录清理 / 命令行退出码，共 11 项回归；另有手工对 `fixture-hub.mjs` 的 35 项检查全过。数据类检查都要求样本非空，避免 `every()` 在零行时假通过。

候选包内也验过三轮：解包 `package-v6/codex-workbuddy-gateway-v0.7.1.zip`（560 文件，SHA-256 `5580742bddf2e492adc8d700e935fee85261818db08b3c0e83327b728e1a023d`）后跑 `verify-release.mjs`（560 文件 `hashesMatch: true`），补齐生产依赖，再用包内 `dist/` 与包内脚本跑 `--execute --source both` → 35 项全过、退出码 0，`--check` 退出码 0；输出中不含密钥、面板令牌或 `Bearer`。

未验证：真实账号池。本机 hub 在跑，但没有把统计连接注入部署，token 侧无会话令牌，积分侧既有 Key 的使用授权未确认。因此 D3-01 仍不完成，`routing_unverified` 保留——工具能跑通不等于真实来源已经证明。

## 8. 证据与回归位置

- 工具：`gateway/scripts/resource-source-acceptance.mjs`（由 `scripts/package.mjs` 的 `scripts` 白名单与 `REQUIRED_FILES` 收录，包内 `verify-release` 会检查它是否缺席）
- 回归：`gateway/test/resource-source-acceptance.test.ts`
- 本轮日志与探测脚本：`E:\javaproject\outputs\resource-acceptance-readiness-20261104\`
