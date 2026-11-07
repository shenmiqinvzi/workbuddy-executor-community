# 资源文档契约（quota-2 / quota-1 兼容、credit-balance-1）

本文说明工作台只读资源端点返回的**文档形状、版本规则与旧文档读法**，读者是消费端（`gateway/workbench/*.mjs`、打包后的自带界面）与后续维护者。资源数值本身的来源能力见 `docs/forward/C_LINE_RECEIPT.md`。

## 1. 两份文档，两个版本号

| 文档 | 端点 | 当前 schema | 旧版本 |
| --- | --- | --- | --- |
| 配额（token 池） | `GET /workbench/v1/resources/quotas` | `workbuddy-executor/quota-2` | `workbuddy-executor/quota-1`（只读兼容） |
| 区域积分余额 | `GET /workbench/v1/resources/credit-balances` | `workbuddy-executor/credit-balance-1` | 无 |

`quota-2` 相对 `quota-1` 只加了一个必填字段：每个合并观测行上的 `readings`。因为这是新增必填字段，属于破坏性变更，所以升版本；旧文档不会被重写、不需要迁移，读的时候按旧版本解释。

## 2. quota-2 形状

顶层恰好 8 个键：

```
schemaVersion  "workbuddy-executor/quota-2"
readOnly       true
connections    []   每项 8 键：connectionId status errorCode snapshotId collectedAt sourceObservedAt expiresAt freshness
observations   []   每项 20 键：quota-1 的 19 键 + readings
truncated      boolean
attribution    "connection_only"
actualTaskCredits  null
actualTaskTokens   null
```

每个 observation 的 `readings` 是**逐来源读数**，每项恰好 8 键：

```
connectionId snapshotId realm availability sourceObservedAt used budget remaining
```

规则：

- `readings` 与 `connectionIds` 同源同序（按 connectionId 升序），数组长度等于合并进这一行的来源数。
- 合并行本身（`availability`/`used`/`budget`/`remaining`/`resetAt`）仍然是**单一具名来源**的读数，沿用 L02 的取值规则；多来源读数不一致时由 `GET /workbench/v1/resources/routing` 的 `ambiguities` 表达，不在合并行里取平均、也不取数组第一项。
- 单来源时 `readings` 长度为 1，与该行数值一致；这不是巧合，是同一次读取。
- `availability` 只能是 `available|exhausted|unknown`；`used/budget/remaining` 是 `null` 或有限非负数；`sourceObservedAt` 是 `null` 或严格 ISO-8601（UTC，`Z`）。

## 3. quota-1 旧文档怎么读

- 版本号是 `quota-1` 的文档照常返回 `200`，顶层与行键按 quota-1 校验（不要求 `readings`）。
- 消费端必须输出 `readingsSource: "legacy_document"`、`readingsMissing: true`、`readings` 为 `null`，并给出文案「旧文档（quota-1）没有逐来源读数，合并行为单一读数」。
- **不得**用合并行的数值伪造一条 reading：那会把"单来源读数"包装成"逐来源证据"。
- 未知版本（例如 `quota-9`）直接拒绝：`quota.schemaVersion` 报错，错误码路径 `ResourceSchemaError`，HTTP 层返回既有失败语义，不降级猜测。

## 4. 校验与失败语义

校验是封闭的（键集必须精确匹配，多键少键都算损坏）：

- `scopeId` 必须匹配 `^pool-[a-f0-9]{32}$`；`snapshotId` 必须匹配 `^[A-Za-z0-9_-]{20,100}$`（生产端 `savedSnapshot` 与消费端 `parseQuotaReading` 同规则）。
- `limitations` 只能取固定码表，`method` 只能取两个固定字符串，`valueKind` 只能取 `estimated|unavailable`。
- 任一校验失败，端点返回既有错误体（`error.code` 大写、`retryable:false`），**不返回半份文档**；工作台界面显示失败态，不显示 0。
- 数据陈旧不算失败：连接 `freshness: "stale"` 与读数照常返回，界面标注陈旧时间。

## 5. 生产端与消费端

- 生产：`gateway/src/quota-observation.ts`（`QUOTA_RESOURCE_SCHEMA`、`QUOTA_LEGACY_SCHEMAS`、`readQuotaResources`）与 `gateway/src/credit-balance.ts`。
- 消费：`gateway/workbench/resources-model.mjs`（`parseQuotaDocument`、`parseQuotaObservation`、`parseQuotaReading`、`buildQuotaView`）、`gateway/workbench/resources-source.mjs`（演示文档，已同步 `readings`）。
- 服务：`gateway/src/workbench-http.ts`（I 属主）只做路由与只读转发；GET 不触发来源请求、不写任务库。

## 6. 最小验证

```
cd gateway
npx tsc --noEmit -p tsconfig.json
npx tsx --test test/quota-observation.test.ts test/desktop-readonly-resources.test.ts test/resource-routing.test.ts
node --test workbench/test/resources-model.test.mjs workbench/test/resources-view.test.mjs
```

实际计数（2026-11-07，本分支 `7af4515`）：`quota-observation` + `desktop-readonly-resources` + `resource-routing` 三个文件合计 42/42（tests 42、pass 42、fail 0），`workbench/test/resources-*.test.mjs` 四个文件 42/42。
