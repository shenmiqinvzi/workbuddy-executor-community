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

### 1.1 同一执行选择的多条声明

声明文件的重复检查键是 `executorId + executionConnectionId + providerId + quotaConnectionId`。把统计连接也算进键里，是因为同一个执行选择同时指向两个统计来源在配置上是可能的；但也正因为如此，**同一个模型可能被两条声明同时覆盖**。

本轮把这条规则写死，避免再用数组顺序充当证据：

| 问题 | 规则 |
| --- | --- |
| 什么算"同一执行选择的重叠声明" | `executorId`、`executionConnectionId`、`providerId` 三者全等，且两条声明的 `models` 都包含当前 `modelId` |
| `models` 部分重叠 | 逐条独立判断。A `[alpha, beta]` + B `[beta, gamma]`：`alpha` 只走 A、`gamma` 只走 B、`beta` 判为歧义。一个模型的冲突不影响其他模型 |
| 同一执行身份的不同模型声明 | 正常共存。A `[alpha]` + B `[beta]` 各自唯一命中，都按 `linked` 显示 |
| 不同 `executionConnectionId` / `providerId` | 不构成同一执行选择的候选，互不干扰 |
| 候选只有 `realm` 不同 | 执行选择本身不含区域依据，因此仍是歧义；不会"取第一条"，也不会"`cn` 优先" |
| 候选 ≥ 2 条时怎么办 | 返回 `linked_ambiguous` / `multiple_declared_links`，`quota` 与 `credit` 均为 `null`，`attribution` 为 `none`，`association.candidates` 给出候选数 |
| 唯一声明但该连接对同一模型有多行 | `realm` 为 `null`（未限定区域）且该连接报告了 ≥2 行无法区分的观测时，返回 `linked_ambiguous` / `ambiguous_quota_observation`；同样不取第一行 |

这里选择**只拒绝当前执行选择的关联**，而不是整份声明文件。理由：冲突是模型级的局部事实，整份拒绝会让所有无关模型的有效关联一起失效，把"某一条声明写重了"放大成"整套关联不可用"，代价与证据不成比例。

### 1.2 声明区域同时约束 token 与积分

`realm` 不是标签，而是约束：声明指定 `cn` 时，token 读数与积分余额都必须来自 `cn`。

- 积分余额落在别的区域 → `creditState="realm_mismatch"`，不返回积分块；**不改写**余额的 `realm`，不与声明区域合并，也不与其他区域合并。
- 区域不符不等于"余额为零""未配置"或"尚未采集"，页面按这条区分表述。
- 区域不符只丢弃积分那一块；同一份响应里已正确关联的 token 证据照常保留。
- token 侧同样区分：声明区域内有该连接、有该模型，但读数落在别的区域 → `linked_realm_mismatch` / `observation_realm_mismatch`。
- `realm=null` 表示**声明未限定区域**：不施加区域过滤，并且**不等于 `cn`**。此时积分取该连接唯一的一份快照（每个连接只保存一份余额），`credit.realm` 报告余额的真实区域。
- 辅助查找（`reportedElsewhere`、聚合行是否属于本连接）遵守同一条区域约束，不会把另一区域的汇总行认成本方案的来源。

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
| `linked_realm_mismatch` | 声明限定了区域，该连接也报告了这个模型，但读数在别的区域 | 明确"声明区域内没有该模型的读数"，不显示读数，也不说成零、未配置或未采集 |
| `linked_ambiguous` | 覆盖该模型的声明 ≥2 条，或唯一声明下有 ≥2 行无法区分的观测 | 「关联声明存在冲突，无法确定该方案对应的统计来源。」：**不显示任何一条来源的额度**，说明不按声明顺序猜来源，保留"查看网关资源汇总"入口 |
| `linked` | 主证据就是本连接 | 展示读数、来源/快照身份、时间、新鲜度、覆盖、估算属性、共享池限制与"路由未验证" |

`linked` 分支的读数只取 `observation.connectionId === link.quotaConnectionId` 的那一行；积分只取 `balance.connectionId === link.creditConnectionId` 且 `balance.realm` 与声明区域一致的那一条。`sources[]`、`connectionIds[]` 里的其他连接只作为独立证据列出，不参与数值、时间或有效期，也不会提升主来源等级。

积分状态（`creditState`）因此有：`available`、`not_observed`、`no_snapshot`、`not_configured`、`realm_mismatch`、`ambiguous`，以及无积分声明时的 `null`。`realm_mismatch` 与 `ambiguous` 都不返回 `credit` 块。

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
| 关联歧义与积分区域专项（本轮新增，18 项要求 → 19 项） | `npx tsx --test test/plan-resource-reference-conflicts.test.ts` | 修复前 **8 pass / 11 fail**，修复后 **19/19** |
| 正式全量（隔离 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`） | `npm test` | 本轮 **997 tests / 985 pass / 0 fail / 12 skipped**（412s，exit 0）；上一轮 978 / 966 / 0 / 12 |

界面验收：

- 浏览器（headless Chrome + CDP，合成桌面命令 stub）：**19/19**。覆盖关联读数（剩余 380、积分 42.5）、核对步骤仍可确认、720/420 无横向溢出、503 注入后保留旧快照并提示、返回与重开后重读、键盘焦点与回车刷新、未关联状态无数字、点击"查看网关资源汇总"切到资源视图。
- WebView2 实窗（候选包内 `WorkBuddy.Workbench.exe`，独立 profile 与合成库）：**19/19**。同上场景，另加"清空声明后窗口立即显示未关联、恢复声明后回到已关联"。
- 截图：`outputs/resource-plan-reference-20261105/shots/`（浏览器 8 张）与 `outputs/resource-plan-reference-20261105/webview/shots/`（8 张），均带"隔离合成数据 · 非真实额度"标记。

本轮针对两项缺陷的定向复验（不改界面结构，只补状态）：

- 浏览器：**27/27**（`outputs/resource-review-20261105/scripts/run-browser-fix.mjs`，报告 `reports/browser-fix.json`）。A 唯一声明仍显示 380 / 42.5 且可确认；B 两条声明覆盖同一选择时 `lines=0`、面板无 4242/8484、说明不按顺序猜来源、网关汇总入口仍在、确认不变、720 无溢出；把声明顺序颠倒结论完全一致；C token 正常而积分在 `intl` 时不显示积分行、不出现 777.25、明确"不表示余额为零"；D 返回修改、重开重读、注入 503 保留旧快照三条原有流程不变。
- WebView2 实窗：**20/20**（`outputs/resource-review-20261105/webview/webview-acceptance-fix.mjs`，报告 `webview/webview-acceptance.json`）。壳为独立构建产物、以 `--gateway-dir` 指向本轮候选包，页面与网关代码都取自包内；场景经改链接文件后点"重新读取已保存快照"切换，无需重启窗口。
- 截图：`outputs/resource-review-20261105/shots/`（浏览器 8 张：`A-unique-linked-1440|720`、`B-ambiguous-1440|720`、`B-ambiguous-reversed-1440`、`C-credit-realm-mismatch-1440|720`、`D-refresh-failure-1440`）与 `outputs/resource-review-20261105/webview/shots/`（7 张：`WA-unique-1440|720`、`WB-ambiguous-1440|720`、`WB2-ambiguous-reversed-1440`、`WC-credit-realm-mismatch-1440|720`），均带"隔离合成数据 · 非真实额度"标记。

候选包：`outputs/resource-plan-reference-20261105/package-v2/codex-workbuddy-gateway-v0.7.1.zip`，567 文件，SHA-256 `c0349d799048385d3ee44db8a848f8a0904def5209a090e568bf98494dacd5a0`。首版 `package`（`74bf2fea…`）的 `dist/plan-resource-reference.js` 是打包前未重建的产物、缺 `linked_rows_elsewhere` 分支，已重建 dist 后重打包；`scripts/compare-runtime.mjs` 对 `package-v2` 逐文件比对 567/567 全等，浏览器与实窗两轮验收都在 `package-v2` 上重跑。

本轮候选包：`outputs/resource-review-20261105/package/codex-workbuddy-gateway-v0.7.1.zip`，**568 文件**（多出 `test/plan-resource-reference-conflicts.test.ts`），SHA-256 `8135790747d50ad15031a2743ebc1a995c1659af9e4d5f7b1b1e20754423d1bc`。先 `npm run build` 与 `typecheck:task-view` 再打包；解包后包内 `verify-release.mjs` 报 568 文件 `hashesMatch: true`；`scripts/probe-package.mjs` 用包内网关验证两种新状态 9/9；旧包 `package-v2`（及更早的 `74bf2fea…`）原样保留未覆盖。

## 7. 仍未完成的

- **真实来源未声明关联**：本机没有可用的统计连接注入，也没有 `execution-links-1` 声明，真实窗口因此只能显示"未建立关联"。这不是缺陷，而是诚实状态。
- 任务→模型的实际路由仍不可证，`routing_unverified` 保持；D3-02 的"任务方案关联"部分不因本轮改状态。
- D3-01 真实账号池接入仍待外部条件；D3-04 运行中监督与停止隔离不变。

## 8. 复现

```powershell
# 1) 隔离库与合成快照（本轮：四份声明 + 五个连接）
node E:\javaproject\outputs\resource-review-20261105\scripts\prepare.mjs

# 2) 浏览器定向复验（A 唯一 / B 歧义 / C 积分区域 / D 原流程）
node E:\javaproject\outputs\resource-review-20261105\scripts\run-browser-fix.mjs

# 3) 包内网关接口（歧义、区域不符、唯一关联）
node E:\javaproject\outputs\resource-review-20261105\scripts\probe-package.mjs

# 4) 实窗定向复验（壳以 --gateway-dir 指向候选包）
node E:\javaproject\outputs\resource-review-20261105\webview\webview-acceptance-fix.mjs
```

上一轮脚本 `outputs/resource-plan-reference-20261105/scripts/prepare.mjs`、`run-browser.mjs`、`webview/prepare-desktop.mjs`、`webview/webview-acceptance.mjs` 保留未改，仍可复现第五轮的 19/19。
