# 任务方案的资源参考（D3-03）

本记录说明工作台"核对并确认"步骤里新增的**资源参考**区域：它把当前执行选择与已保存的统计快照连起来，并明确写出这条关联能证明什么、不能证明什么。

- 关联依据是**只读声明文件**，不是一个猜测出来的映射。
- 页面上的数字来自网关已保存的快照，不是本任务的实测用量，也不是费用或硬上限。
- 无论关联是否成立，`routingVerified` 恒为 `false`：任务→模型的实际路由仍然不可证。

## 1. 为什么需要先定义关联规则

执行选择与统计连接使用**不同的命名空间**，仓库里也没有任何既有映射：

| 侧 | 身份字段 | 取值来源 |
| --- | --- | --- |
| 执行选择（WorkBuddy） | `executorId=workbuddy`、`connectionId=local-workbuddy`、`providerId=workbuddy-native`、`modelId=<原生模型 id>` | `gateway/src/collaboration.ts`、`desktop-dispatch-runtime.ts`、`task-contract.ts` |
| 执行选择（DSH） | `executorId=dsh`、`connectionId=<hostId>`、`providerId`、`modelId` | 同上 |
| 统计连接 | `connectionId=<source id>` | `WORKBUDDY_QUOTA_SOURCE_ID`（默认 `workbuddy2api-local`）/ `WORKBUDDY_CREDIT_SOURCE_ID` |

因此以下做法一律不采用：模型名相同即视为同池、字符串包含、显示名匹配、数组第一项、把 WorkBuddy 固定来源自动映射到任意本地统计连接、把面板登录成功当成 API Key 权限或任务路由证据。

**本轮采用的规则**：只有 `WORKBUDDY_RESOURCE_LINKS_FILE` 指向的声明文件里，同时匹配 `executorId` + `executionConnectionId` + `providerId` + **精确 `modelId`**（可再加 `realm`）的条目，才建立关联。

```json
{
  "schemaVersion": "workbuddy-executor/execution-links-1",
  "links": [
    {
      "executorId": "workbuddy",
      "executionConnectionId": "local-workbuddy",
      "providerId": "workbuddy-native",
      "models": ["synthetic-plan-model"],
      "realm": "cn",
      "quotaConnectionId": "stats-quota",
      "creditConnectionId": "stats-credit",
      "declaredAt": "2026-11-05T03:00:00.000Z",
      "note": "synthetic acceptance link"
    }
  ]
}
```

声明缺失、不可读、JSON 损坏、schema 不符、条目字段不合法时，都按"未建立关联"处理，并且不在响应里泄露文件路径或内容。工具与页面**从不写这个文件**。

## 2. 关联状态与用户可见文案

`buildPlanResourceReference()` 只输出以下状态之一：

| 状态 | 说明 | 页面表达 |
| --- | --- | --- |
| `unlinked` | 没有声明能匹配该执行选择 | 「尚未建立该执行来源与统计连接的关联。」，不显示任何额度数字，不推荐换模型，保留"查看网关资源汇总"入口 |
| `link_invalid` | 声明文件存在但不可用 | 同上，并提示声明文件不可读 |
| `linked_not_configured` | 已声明，但该统计连接不在当前快照里 | 明确"尚未配置/尚未采集"，不补零 |
| `linked_not_observed` | 连接已配置但还没有该模型的观测 | 明确"尚未观测到该模型"，不补零 |
| `linked_no_snapshot` | 连接登记过但当前没有可用快照 | 明确"没有可用快照" |
| `linked_rows_elsewhere` | 聚合行由别的连接持有，本连接只在 `connectionIds` 里 | **不借数值**：显示"汇总行由其他来源持有"，只列出持有者的连接 ID |
| `linked` | 主证据就是本连接 | 展示读数、来源/快照身份、时间、新鲜度、覆盖、估算属性、共享池限制与"路由未验证" |

`linked` 分支的读数只取 `observation.connectionId === link.quotaConnectionId` 的那一行；积分只取 `balance.connectionId === link.creditConnectionId`。`sources[]`、`connectionIds[]` 里的其他连接只作为独立证据列出，不参与数值、时间或有效期，也不会提升主来源等级。

## 3. 能说明什么、不能说明什么

能说明：

- 该执行选择在某份声明里被显式关联到某个统计连接；
- 该连接在当时保存的快照里报告了什么（token 估算、积分缓存、覆盖范围、时间与新鲜度）；
- 数据来自哪个快照、是否陈旧、采集是否失败、是否部分覆盖。

不能说明：

- 不能说明本任务实际可用额度（`resource_reference_only`、`not_task_usage`）；
- 不能说明费用或硬费用上限（`not_a_spend_limit`）；积分不是货币，也不与 token 相加；
- 不能说明任务路由已验证（`routing_unverified`，`routingVerified` 恒 `false`）；
- 推理档位不单独计量，页面按"档位不单独计量"提示。

## 4. 读取与生命周期

- 新增只读接口 `GET /workbench/v1/resources/plan-reference?executorId&connectionId&providerId&modelId[&reasoningEffort]`：
  - 未知参数、缺必填、`executorId` 非 `workbuddy|dsh`、超长 → 400 `INVALID_RESOURCE_QUERY`；
  - 非 GET → 405，`allow: GET, HEAD`；
  - 存储读失败 → 503 `RESOURCE_STORE_UNAVAILABLE`。
- 不改 `quota-1` / `credit-balance-1` / capacity 三条既有契约；新文档 schema 为 `workbuddy-executor/plan-resource-reference-1`。
- 前端 `gateway/workbench/plan-reference.mjs` 的 loader 绑定"执行选择的 key + 草稿身份（`draftId:digest`）"：换绑时 abort 旧请求并递增序号，迟到响应（成功或失败）都不再写界面；`reset()`（返回修改、关闭面板）同样作废在途请求。
- 刷新按钮只重新读取**已保存快照**，文案是「重新读取已保存快照」，不声称刷新了上游额度。
- 读取入口不触发上游采集、登录、账号刷新或模型请求；不调用派工接口；不创建或消费协作方案。

## 5. 不改动的边界

用户仍需明确选择模型、仍需原生确认，推荐不构成授权；资源区域不改变既有模型政策与准入检查，不静默更换执行器/来源/模型/档位，不新增公共写入口。资源读取失败不会让"确认"变宽松，也不会凭空新增派工限制。

## 6. 测试与验收

| 项 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 服务端关联与 HTTP | `npx tsx --test test/plan-resource-reference.test.ts` | 16/16 |
| loader 竞态与生命周期 | `npx tsx --test test/plan-reference-loader.test.ts` | 6/6 |
| 受影响批次（派工、结算、资源、HTTP、打包、桌面只读等 13 个文件） | `npx tsx --test …` | 140/140 |
| 工作台前端 | `npm run test:workbench` | 100/100 |
| 桌面策略 | `npm run desktop:test` | 70/70 |
| 类型检查 | `npm run typecheck:task-view` | exit 0 |
| 正式全量（隔离 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`） | `npm test` | 978 tests / 966 pass / 0 fail / 12 skipped |

界面验收：

- 浏览器（headless Chrome + CDP，合成桌面命令 stub）：**19/19**。覆盖关联读数（剩余 380、积分 42.5）、核对步骤仍可确认、720/420 无横向溢出、503 注入后保留旧快照并提示、返回与重开后重读、键盘焦点与回车刷新、未关联状态无数字、点击"查看网关资源汇总"切到资源视图。
- WebView2 实窗（候选包内 `WorkBuddy.Workbench.exe`，独立 profile 与合成库）：**19/19**。同上场景，另加"清空声明后窗口立即显示未关联、恢复声明后回到已关联"。
- 截图：`outputs/resource-plan-reference-20261105/shots/`（浏览器 8 张）与 `outputs/resource-plan-reference-20261105/webview/shots/`（8 张），均带"隔离合成数据 · 非真实额度"标记。

候选包：`outputs/resource-plan-reference-20261105/package-v2/codex-workbuddy-gateway-v0.7.1.zip`，567 文件，SHA-256 `c0349d799048385d3ee44db8a848f8a0904def5209a090e568bf98494dacd5a0`。首版 `package`（`74bf2fea…`）的 `dist/plan-resource-reference.js` 是打包前未重建的产物、缺 `linked_rows_elsewhere` 分支，已重建 dist 后重打包；`scripts/compare-runtime.mjs` 对 `package-v2` 逐文件比对 567/567 全等，浏览器与实窗两轮验收都在 `package-v2` 上重跑。

## 7. 仍未完成的

- **真实来源未声明关联**：本机没有可用的统计连接注入，也没有 `execution-links-1` 声明，真实窗口因此只能显示"未建立关联"。这不是缺陷，而是诚实状态。
- 任务→模型的实际路由仍不可证，`routing_unverified` 保持；D3-02 的"任务方案关联"部分不因本轮改状态。
- D3-01 真实账号池接入仍待外部条件；D3-04 运行中监督与停止隔离不变。

## 8. 复现

```powershell
# 1) 隔离库与合成快照
node E:\javaproject\outputs\resource-plan-reference-20261105\scripts\prepare.mjs

# 2) 浏览器验收
node E:\javaproject\outputs\resource-plan-reference-20261105\scripts\run-browser.mjs

# 3) 实窗验收（需要先解包候选包并 npm ci + npm run desktop:build）
node E:\javaproject\outputs\resource-plan-reference-20261105\webview\prepare-desktop.mjs
node E:\javaproject\outputs\resource-plan-reference-20261105\webview\webview-acceptance.mjs
```
