# 资源中心后端交付记录

日期：2026-11-04。范围：D3 并行开发准备；D0/D1 前置验收仍需完成，本记录不表示 D3 已全部交付或部署。

## 代码与边界

- 工作目录：`E:\javaproject\workbuddy-parallel-resource-backend`；分支 `feat/resource-center-backend`；基线 `5f8620e`。
- D3-04：`cdf4f25` 保留来源时间倒退或缺失时的旧快照，并记录 `source_invalid`，使有来源时间的 quota 旧快照和 credit 本地缓存显示 stale；旧代次或旧配置仍不能更新当前连接状态。quota 跨连接去重优先选择具有来源时间的记录，避免用本地采集时间冒充来源时间。附针对性回归。
- D3-01：核对现有两个采集器、固定统计 GET、缓存和 HTTP 接口，保留现有路径、字段及含义；没有改生产配置或服务。
- D3-02：源码只支持匿名网关账号范围或区域共享池去重，无法从这些统计证明实际 Key 到执行器、模型、区域或任务的路由。保留 `routing_unverified`，不可据此宣称任务可用、独占额度或任务费用。
- 此 worktree 复制了源目录未提交的 README、ROADMAP、PROGRESS 和 FUTURE_DEVELOPMENT_PLAN 规划改动供阅读；它们不属于后端提交，未提交、未回填。前端文件、静态白名单和打包清单未改；待 DSH 实际文件清单与提交到位后集成。

## 脱敏接口样例

以下是合成数据，时间、数值、匿名 ID 均为示例，不代表真实余额；保留接口的实际字段形状。GET/HEAD 只读缓存，允许的查询分别为 quota 的 `connectionId`、`modelId`、`limit`（1–200）和 credit 的 `connectionId`；未知参数拒绝。未配置连接返回空集合，不代表余额为零；缓存损坏返回 503。

`GET /workbench/v1/resources/quotas`：

```json
{
  "schemaVersion":"workbuddy-executor/quota-1", "readOnly":true,
  "connections":[{"connectionId":"example-quota","status":"observed","errorCode":null,"snapshotId":"abcdefghijklmnopqrstuvwx","collectedAt":"2026-11-04T01:00:00.000Z","sourceObservedAt":"2026-11-04T01:00:00.000Z","expiresAt":"2026-11-04T01:01:30.000Z","freshness":"fresh"}],
  "observations":[{"scopeId":"pool-0123456789abcdef0123456789abcdef","scopeKind":"gateway_pool","shared":true,"modelId":"example-model","realm":"cn","unit":"tokens","valueKind":"estimated","availability":"available","used":20,"budget":100,"remaining":80,"resetAt":null,"method":"historical_budget_minus_observed_usage","limitations":["routing_unverified","shared_pool","budget_estimated","gateway_observed_usage_only","task_attribution_unavailable"],"connectionId":"example-quota","snapshotId":"abcdefghijklmnopqrstuvwx","sourceObservedAt":"2026-11-04T01:00:00.000Z","collectedAt":"2026-11-04T01:00:00.000Z","connectionIds":["example-quota"]}],
  "truncated":false,"attribution":"connection_only","actualTaskCredits":null,"actualTaskTokens":null
}
```

Token 值是历史预算和网关观测用量的估算，非官方余额或任务可支配额度；null 是未知。`availability=exhausted` 需要冷却与未来恢复时间证据，零值本身不证明耗尽。`freshness` 依来源时间、过期时间和采集错误判断；缺来源时间为 unavailable。`truncated` 只反映本接口 limit 截断，不能证明来源完整覆盖：来源 schema 没有可核验的完整性标记，部分来源行、消失的账号或模型不能推定为零。相同匿名范围与模型跨连接去重，不汇总不同单位或池。

`GET /workbench/v1/resources/credit-balances`：

```json
{
  "schemaVersion":"workbuddy-executor/credit-balance-1","readOnly":true,
  "connections":[{"connectionId":"example-credit","status":"observed","errorCode":null,"snapshotId":"abcdefghijklmnopqrstuvwx","collectedAt":"2026-11-04T01:00:00.000Z","cacheFreshness":"fresh"}],
  "balances":[{"snapshotId":"abcdefghijklmnopqrstuvwx","connectionId":"example-credit","scopeId":"pool-0123456789abcdef0123456789abcdef","realm":"cn","unit":"credit","valueKind":"reported_cache","balance":50,"accountsEnabled":4,"accountsWithData":2,"coverage":"partial","latestMemberObservedAt":"2026-11-04T00:59:00.000Z","collectedAt":"2026-11-04T01:00:00.000Z","cacheExpiresAt":"2026-11-04T01:01:30.000Z","errorCode":null,"connectionIds":["example-credit"],"shared":true,"scopeKind":"gateway_region_pool","balanceFreshness":"unavailable","limitations":["shared_region_pool","routing_unverified","latest_member_timestamp_only","member_freshness_unavailable","task_attribution_unavailable"]}],
  "actualTaskCredits":null,"attribution":"connection_only"
}
```

积分不是 token 或货币；partial 数值仅是已知成员之和，unavailable 对应 null，complete 仅说明启用账号均有数值。`latestMemberObservedAt` 是成员时间最大值，不证明整个池新鲜；`balanceFreshness` 只能是 stale 或 unavailable，`cacheFreshness` 仅表示本地采集缓存。来源失败时保留末次快照并检查对应连接的 status、errorCode 和 freshness，不能只看数值。不同端点不假设共享池；去重引用 `connectionIds` 不证明 Key 路由。响应内 `errorCode` 是主记录的采集错误，不能替代检查各连接状态。

## 验证与缺口

- `npm run build`：退出码 0；TypeScript 编译当前源码。
- `node --require ./.test-userinfo.cjs --import tsx --test --test-concurrency=1 test/quota-observation.test.ts test/credit-balance.test.ts test/quota-entry.test.ts`：退出码 0，36/36 通过；合成 loopback HTTP、临时 SQLite、编译入口及只读 HTTP 证据。临时 preload 仅让 tsx 在沙箱中获得合成用户名，运行后已删除；直接运行因 `uv_os_get_passwd` 报 ENOMEM 退出 1。离线 `npm ci` 因本机 npm 缓存 EPERM 退出 1，随后将源目录已有 node_modules 复制到隔离目录用于验证。
- `git diff --check`：退出码 0。以上不证明真实来源、完整来源覆盖、实际 Key 路由或模型可用；现有测试验证资源故障下任务读取及任务记录不变，未在本轮对运行中真实任务的监督和停止做端到端故障注入。
- 真实只读联调需已授权、可用的 loopback 来源及既有 API Key；quota 统计如部署要求还需既有有效面板令牌，credit 来源须实现 `/v1/balance-summary`。需确认来源版本、数据范围、单位、时间与账号覆盖口径及授权后，使用隔离数据库/端口验证；不登录、不刷新上游、不请求模型，且不输出凭据或真实余额。本轮未取得可用连接并完成授权核验，未进行真实联调。既有历史积分联调记录不等于本轮重新验收。
- DSH 提交和实际资源文件清单到位后，再检查静态文件白名单、打包清单、前后端接口和跨端集成；D0/D1、真实监督/停止隔离及完整 D3 验收仍待安排。

## 集成提交

- 后端代码与测试：`cdf4f25`（基于 `5f8620e`）。
- 本记录作为独立文档提交；其提交号以 `git log -1 -- docs/RESOURCE_BACKEND_DELIVERY.md` 查询，避免文档自引用提交哈希。
- 不包含本地未提交规划文件，也未推送、合并或发布。
