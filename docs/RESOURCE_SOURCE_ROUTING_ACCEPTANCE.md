# 真实资源来源联调与路由核验（D3-01 / D3-02）

本轮按 `docs/FUTURE_DEVELOPMENT_PLAN.md` 的 D3-01、D3-02 推进：核对本机 WorkBuddy2API 的真实入口与鉴权，
用真实来源代码验证「来源 → 正式采集器 → 独立持久缓存 → 官方只读 HTTP」这条链路，并为路由核验建立独立的、
版本化的证据文档与失效回退。资源页本身本轮不重做。

结论先说清楚三点：

1. **token 与积分两条链路都跑通了，但真实账号池尚未参与**。本机具备真实 hub 代码与生产实例，但网关侧
   **没有把统计连接注入部署配置**（缺 `WORKBUDDY_QUOTA_SOURCE_URL` / `WORKBUDDY_QUOTA_API_KEY` /
   `WORKBUDDY_QUOTA_PANEL_TOKEN` 与 `WORKBUDDY_CREDIT_SOURCE_URL` / `WORKBUDDY_CREDIT_API_KEY`），因此
   正式部署下的真实只读联调未发生；本轮跑通的是「真实 hub 代码 + 隔离实例 + 空账号池」。
2. **路由仍然无法被证明到任务级**。上游载荷只有「账号 × 模型」聚合，没有任何任务、会话或 provider 维度，
   所以 `routing_unverified` 保留，本轮交付的是一个把这句话写进契约的证据文档，而不是一个"已核验"的标记。
3. 运行文件已经变化（新增路由证据资源），候选包已重建并核对；旧包哈希不适用于新包。

## 1. 基线与环境

| 项目 | 值 |
| --- | --- |
| 集成基线 | `E:\javaproject\workbuddy-resource-integration`，分支 `integration/resource-center`，HEAD `98a39f2` |
| 本轮工作树 | `E:\javaproject\workbuddy-resource-source-integration`，分支 `feat/resource-source-routing` |
| 源码提交 | `ec917c3`（运行代码）；本验收记录随仓库提交，**不进入候选包**（包只收运行文件，不含 `docs/`） |
| 证据目录 | `E:\javaproject\outputs\resource-source-routing-20261104` |
| 隔离 hub 实例 | 本机 `wb_proxy.py` 源码 + 本轮随机 `--api-key` / `--panel-password` + 空 `--accounts-dir`，仅监听 `127.0.0.1` 的临时端口 |
| 隔离网关实例 | `gateway/dist/workbench-entry.js`，独立 `WORKBUDDY_DB_FILE` / `WORKBUDDY_RUNS_DIR` / 端口 / 日志 |
| 生产实例 | **未触碰**。生产 hub（`pythonw.exe wb_proxy.py --port 8788`）只读 `/health` 一次用于确认部署形态，未发任何统计或面板请求 |

集成目录中 `M README.md`、`M ROADMAP.md` 属既有规划修改，本轮原样保留、未提交。

## 2. 本机 WorkBuddy2API 的事实（只读调查）

来源：`E:\javaproject\workbuddy2api-hub\wb_proxy.py`（21591 行）与 `wb_settings.py`。

| 事实 | 依据 |
| --- | --- |
| 生产实例：`pythonw.exe wb_proxy.py --port 8788`，仅 `127.0.0.1`，`/health` 返回 `accounts: 8`、`realm: cn` | 进程命令行 + `/health` |
| token 统计接口 | `GET /usage/remaining`，**面板路由** |
| 积分缓存接口 | `GET /v1/balance-summary`，**非面板路由**，只需 API 密钥 |
| 面板路由的鉴权 | `_key_ok()` 先看 `_panel_ok()`：**有效面板会话可单独放行**，API 密钥写错也照读 |
| 面板令牌 | 只能是 `POST /panel/login {password}` 返回的**会话令牌**（`X-Panel-Token`）；面板口令本身不是令牌 |
| 会话生命周期 | `PanelSessions` 纯内存、TTL 7 天，**hub 重启即全部失效** |
| token 载荷 | 顶层 8 键，`rows[]` 17 键，金额全部为整数或 null；`generated_at`/`reset_at` 为 epoch 秒 |
| 积分载荷 | `balance`（可为 null）、`unit: "credit"`、`realm`、`accounts_enabled`、`accounts_with_credit_data`、`updated_at`；`known === 0` 时 `balance` 为 null，不补零 |
| 路由维度 | **载荷里没有任务、会话、provider 或 API Key 范围标识** |

与网关采集器的契约对照（`gateway/src/quota-observation.ts:196-218`、`gateway/src/credit-balance.ts:160-174`）：
字段名与取值类型逐项吻合；`numberOrNull` 要求非负安全整数，而 hub 的 `budget` 走 `int(round(avg))`、
`used` 由累计整数做前缀差，`remaining = max(0, budget - used)`，冷却时固定 0 —— 都是整数，因此**不需要**
改采集器语义来迁就来源。时间字段是 epoch 秒，`timestamp()` 接受。

## 3. 缺失条件（本轮无法完成的部分）

正式部署**没有**注入统计连接。本轮对 `ProgramData`、`AppData\Local`、`AppData\Roaming` 与项目目录做了
深度 6 的配置扫描（`*.json|*.env|*.cmd|*.bat|*.xml|*.ps1`，<400KB，排除 `node_modules` 与 hub 源码），
没有任何文件包含 `WORKBUDDY_QUOTA_SOURCE_URL`、`WORKBUDDY_QUOTA_PANEL_TOKEN` 或
`WORKBUDDY_CREDIT_SOURCE_URL`。

因此缺的不是代码，而是这三类部署注入：

- `WORKBUDDY_QUOTA_SOURCE_URL` / `WORKBUDDY_QUOTA_SOURCE_ID`：指向本机 hub 的 `http://127.0.0.1:8788`。
- `WORKBUDDY_QUOTA_API_KEY`：hub 的 API 密钥。
- `WORKBUDDY_QUOTA_PANEL_TOKEN`：`POST /panel/login` 换来的**会话令牌**（不是面板口令；hub 重启后需重新获取）。
- `WORKBUDDY_CREDIT_SOURCE_URL` / `WORKBUDDY_CREDIT_API_KEY` / `WORKBUDDY_CREDIT_SOURCE_ID`。

这些值只应进入受保护进程的启动环境。需要用户在本机决定是否注入；**不要**把密钥粘到聊天、文档、脚本参数或截图里。
补齐之后用第 12 节的命令即可复跑，届时才会出现真实的 `rows[]` 与真实余额。

### 3.1 本机现有授权条件的复核（2026-11-04 第二轮）

上一节的"没有注入"只说明**本项目没有把这些连接写进配置**，不等于机器上没有可用凭据。本轮按这个区分重新核对：

| 条件 | 事实 | 结论 |
| --- | --- | --- |
| 本机 hub 是否在跑 | `127.0.0.1:8788`（PID 12032，`pythonw.exe wb_proxy.py --port 8788`），`GET /health` → `{"ok":true,"realm":"cn","accounts":8,"accounts_ready":8,"api_key_required":true}` | 有可复用的统计服务 |
| 是否已有统计连接注入 | 深度 6 配置扫描无 `WORKBUDDY_QUOTA_*` / `WORKBUDDY_CREDIT_*` | **缺部署注入** |
| token 侧能否直接只读 | `/usage/remaining` 属面板路由，必须 `X-Panel-Token` 会话令牌；本机 `accounts/settings.json` 里 `panel_password_hash` 为空、`panel_password_default: true` | 要拿会话令牌必须登录取令牌，**本轮禁止自行登录生产面板** → 阻塞 |
| 积分侧能否用现有 Key | `settings.json` 中存在已启用（`enabled: true`）的 API Key 条目；`/v1/balance-summary` 只校验 API 密钥 | 技术上可读，但**无法从文件确认这些 Key 的使用授权是否覆盖本任务**，本轮未使用其值 |
| 现有授权是否覆盖本轮读取 | 无书面/环境层面的授权标记 | 未确认 |

处理方式（按任务要求，缺条件时一次性说明、不要在聊天里贴密钥）：

1. 若允许用现有 API Key 读积分：请在本机把 Key 通过受保护进程环境注入（例如在启动脚本里设置
   `WORKBUDDY_CREDIT_API_KEY`），不要发到聊天；确认后我按第 12 节重跑，只记录聚合结果（成功/失败、
   `coverage`、是否有 `balance`），**不导出余额数值**。
2. 若要做 token 侧真实联调：需要你本人执行一次 `POST /panel/login` 并把会话令牌注入受保护环境
   （令牌 7 天有效、hub 重启失效）；我不会代为登录。
3. 在此之前，token 与积分两条链路的"真实账号池"结论都保持**未验证**，第 4 节的结果只代表
   "真实 hub 源码 + 隔离实例 + 空账号池"。

过程说明：本轮为核对元数据读取 `settings.json` 时，`ConvertFrom-Json` 因编码问题报错并回显了文件内容到本机终端
（含 Key 行）。该输出未写入任何文件、截图或提交，本轮也未使用其中任何密钥值；后续不再读取该文件。


## 4. D3-01 联调结果（真实源码 + 隔离实例 + 空账号池）

两条链路分别报告，不互相代替。两轮结果文件：`real-source-results-source.json`（工作树构建）、
`real-source-results-package.json`（包内构建），各 **35 项检查全过**。

| 检查点 | token 链路 | 积分链路 |
| --- | --- | --- |
| 鉴权 | 正确 API 密钥 + 面板会话 → 200；缺面板令牌 → 401，记为 `source_unauthorized` | 只需 API 密钥 → 200；密钥错 → 401 |
| 连接状态 | `observed`，`fresh` | `observed`，`cacheFreshness: fresh` |
| 来源观察时间 | `sourceObservedAt` 有值（上游 `generated_at`） | 无成员时间 → `latestMemberObservedAt: null`，`balanceFreshness: unavailable` |
| 数据 | 空账号池 → `observations: []`（不编造任何模型行） | `balance: null`（**不是 0**），`coverage: unavailable` |
| 单位 | `tokens` | `credit`，`valueKind: reported_cache`（**不是货币**） |
| 归属 | `attribution: connection_only`，`actualTaskTokens/Credits: null` | 同上 |
| 限制 | 五条 limitations，含 `routing_unverified` | 五条 limitations，含 `routing_unverified` |
| 失败隔离 | token 侧 401 时积分侧仍 `observed` | 反之同样成立 |

只读语义：连续 5 次 GET（quotas / credit-balances / routing）期间，hub 的请求日志行数**不变**
（`before 35 → after 35`），说明页面读取只读缓存，不触发上游采集、不刷新积分、不发模型请求。

任务侧不受影响：整轮只读写本轮隔离库，未修改任何任务记录、revision、事件或容量事实。

## 5. D3-02 路由核验：证据分层与结论

问题：资源页里的这个池，能否被当前选定的来源与模型使用？依据是什么？

| 证据层 | 本轮结果 |
| --- | --- |
| ① 来源声明 | 上游只声明「账号 × 模型的窗口用量与预算」，不含任务/会话/provider/Key 范围 |
| ② 配置与代码规则已核验 | 网关侧可核验：连接 ID → 来源地址（仅 loopback）→ 采集器 → 池 `scopeId`（`anonymize(origin, realm, uid)`）→ 模型 ID |
| ③ 请求层实际路由 | **无**：本轮不发模型请求，也没有可佐证的历史请求路由元数据 |

因此：**连接 → 池 → 模型** 这一层有证据（可查询、可追溯、随快照失效），
**任务 → 模型 / 会话 → provider / Key 权限范围 / 独占预留** 四层无法证明，继续保留 `routing_unverified`。
共享池可被该来源使用 ≠ 该任务独占余额或已预留额度。

## 6. 源码交付

### 6.1 新增只读资源：`GET /workbench/v1/resources/routing`

- 文件：`gateway/src/resource-routing.ts`，schema `workbuddy-executor/routing-evidence-1`。
- 数据来源：只读 `quotas` 与 `credit-balances` 两份已存视图，**不新增探测、不访问上游、不另写一套资源判定**。
- 桌面只读 facade 无需改动：它已经代理 `store.quotas.read` / `store.creditBalances.read`，因此桌面与网关
  派生出的证据逐项相同（有测试固定这一点）。
- HTTP：只读、无查询参数（带参数 → 400 `INVALID_RESOURCE_QUERY`）、非 GET → 405、存储不可读 → 503
  `RESOURCE_STORE_UNAVAILABLE`（**不会**退化成"已核验"）。

文档结构（节选）：

| 字段 | 含义 |
| --- | --- |
| `routingVerified` | 恒 `false`：本轮没有、也无法从现有载荷得到任务级路由证据 |
| `basis` | 恒 `gateway_observation_only` |
| `connections[]` | 每条连接的 `resource`（quota/credit）、`status`、`errorCode`、`level`、`reason`、`snapshotId`、`sourceObservedAt`、`expiresAt` |
| `mappings[]` | 每个池范围一行：`scopeId`、`scopeKind`、`realm`、`modelId`（积分池为 `null`）、`unit`、`level`、`evidenceReason`、`primaryConnectionId`、`sources[]`、`connectionIds`、`availability` 或 `coverage` |
| `unresolved[]` | `task_to_model`、`session_to_provider`、`key_scope`、`exclusive_reservation`，每条带原因 |
| `invalidatesOn[]` | `connection_fingerprint_change`、`snapshot_expiry`、`source_error`、`configuration_change` |
| `limitations[]` | 含 `routing_unverified`、`shared_region_pool`、`task_attribution_unavailable`、`model_scope_unverified` |

证据等级（`level`）：`observed` > `expired` > `unavailable` > `unobserved`。

同一池被多条连接报告时，聚合视图只选中其中一条作为**主证据**（`primaryConnectionId`），该行的 `level`、
`evidenceReason`、`availability` / `coverage`、`sourceObservedAt`、`collectedAt`、`expiresAt` 全部取自这一条；
`connectionIds` 只表示"还有哪些来源报告过这个范围"，`sources[]` 逐条列出各来源自己的等级与原因，
**不做跨来源取强**——不会出现主数据来自失败连接、等级却借用另一条新鲜连接的情况。

`evidenceReason` 取值：`snapshot_fresh`、`snapshot_expired`、`source_time_unknown`、`source_error`、
`source_unavailable`、`no_snapshot`、`source_missing`、`cache_fresh`、`cache_expired`。


### 6.2 未知与失效回退

- 连接已配置但无快照 → `unobserved`，不产生映射行。
- 快照过期 → `expired` + `snapshot_expired`，映射保留但降级（页面仍可显示"陈旧"）。
- **有快照但来源时间缺失**（`sourceObservedAt: null`、`freshness: "unavailable"`）→ `unavailable` +
  `source_time_unknown`：这是"没有足够时间证据"，不是"已经确认过期"，两者不混用。
- 采集报错 → `unavailable` + `source_error` / `source_unavailable`，错误码原样带出，旧快照的
  `availability` 与 `sourceObservedAt` 保持不变（不会被错误状态改写）。
- 连接指纹变化（来源地址/凭据/ID 变更）→ 该连接重新登记、旧快照被替换，证据随之重算；
  `invalidatesOn` 把这条规则写进契约。
- 存储损坏 / 缺表 → 读取抛错 → 503，**不**降级为空映射。


### 6.3 本轮刻意不做

推荐、自动调度、硬费用控制、按任务分配额度、修改 `quota-1` / `credit-balance-1` 语义、改动上游 hub。

## 7. 验证

命令均在 `gateway/` 下执行；隔离环境变量指向本轮证据目录的空样本（`env\WorkBuddy.exe` + `env\workbuddy-config`）。

| 命令 | 结果 |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run typecheck:task-view` | exit 0 |
| `npx tsx --test test/resource-routing.test.ts` | 10/10，exit 0 |
| `npx tsx --test test/resource-routing.test.ts test/resource-routing-consistency.test.ts` | 24/24，exit 0 |
| `npx tsx --test`（资源批次：routing×2 + quota-observation + credit-balance + quota-entry + capacity-resource + desktop-readonly-resources） | 76/76，exit 0 |
| `npm run test:workbench` | 100/100，exit 0 |
| `npx tsx --test`（HTTP/打包批次：workbench-http、workbench-assets、workbench-panel、package、task-application-service、evidence-consistency） | 61/61，exit 0 |
| `npm run desktop:test` | 70/70，exit 0 |
| `node scripts/generate-snapshot-manifest.mjs` + `node verify-snapshot.mjs` | 319 文件，`hashesMatch: true`，`manifestCompleteness: checked`，exit 0 |
| `node scripts/real-source-check.mjs`（工作树构建） | 35/35，exit 0（修复前的上一轮结果；修复后未变的行为未见回归） |
| `node scripts/verify-package-routing.mjs`（包内构建） | 34/34，exit 0 |
| `node scripts/desktop-routing-host-check.mjs`（正式 desktop host + 真实 SQLite） | 16/16，exit 0 |
| `npm test`（全量，隔离环境） | 935 tests / 922 pass / 1 fail / 12 skipped，见第 11.5 节 |

新增测试 `gateway/test/resource-routing.test.ts` 覆盖：空库不出映射、已配置未采集、观察到的池与模型、
过期降级、采集错误降级、同池多连接去重、桌面 facade 与网关结果相同、HTTP 只读与参数校验、
缺表时 503 而任务接口仍 200、以及"永不把计划升级为已执行路由"。

新增 `gateway/test/resource-routing-consistency.test.ts`（14 用例，真实存储驱动）覆盖证据一致性：
单连接新鲜 / 单连接过期 / 无来源时间、采集失败保留旧值、A 新鲜 + B 较新但失败不得借用、
可用状态冲突字段同源、主来源过期不被升级、同池多连接保留各自状态、积分缓存与成员新鲜度分离、
指纹变化后失效、损坏快照抛错、桌面与网关逐项一致、GET 只读不改任务事实、`routingVerified` 恒 `false`。


## 8. 候选包

| 项目 | 值 |
| --- | --- |
| 包（本轮最新） | `outputs\resource-source-routing-20261104\package-routing-fix\codex-workbuddy-gateway-v0.7.1.zip` |
| SHA-256 | `da637ece6ab393d5c03af2973613a39bf9d68dc55dc8f79b14d0b74f740d6b9a` |
| 包内校验 | `node scripts/verify-release.mjs` → `{"version":"0.7.1","verifiedFiles":558,"hashesMatch":true}` |
| 上一轮候选（保留未覆盖） | `…\package\codex-workbuddy-gateway-v0.7.1.zip`，`532f2b868a207cabd108f68d7261aa3af730a34b622973f1b1fa6d21cf9e4677`，557 文件 |
| 与上一轮候选的文件级差异 | 5 项：`CHANGED dist/resource-routing.d.ts`、`dist/resource-routing.js`、`dist/resource-routing.js.map`、`src/resource-routing.ts`，以及 `ADDED test/resource-routing-consistency.test.ts`；其余 553 个文件哈希不变 |
| 版本号 | 仍为 0.7.1，**同版本号、不同哈希**；以哈希区分 |

运行文件确实变化，所以按流程重建了候选并核对包内容；浏览器与 WebView2 的既有合成验收结论（128/128、71/71）
针对更早的候选包，本轮未机械重跑，因为它们不覆盖新增只读接口——新接口的验证以第 7 节的包级检查与
第 11.4 节的正式 desktop host 检查为准。


## 9. 子项状态

| 子项 | 状态 | 依据 |
| --- | --- | --- |
| D3-01 采集器 ↔ 真实来源契约 | **真实来源代码上验证通过** | 第 4 节；真实 `wb_proxy.py` + 隔离实例 |
| D3-01 正式部署的真实只读联调 | **未完成（缺部署注入，且授权未确认）** | 第 3、3.1 节 |
| D3-01 真实账号池的 rows / 余额 | **未验证** | 隔离实例账号池为空；生产 Key 未使用 |
| D3-02 连接 → 池 → 模型的证据结构 | **已实现并验证（含证据一致性修复）** | `routing-evidence-1`、24 项测试、包级 34 项、desktop host 16 项 |
| D3-02 未知与失效回退 | **已实现并验证** | 过期 / 来源时间缺失 / 报错 / 缺表 / 损坏五类降级；第 11 节 |
| D3-02 任务 → 模型的真实路由 | **不可证，保持 `routing_unverified`** | 上游载荷无任务/会话维度 |
| D3-02 请求层实际路由证据 | **缺** | 本轮不发模型请求 |

D3-01 与 D3-02 因此都**不标整体完成**：D3-01 缺正式连接注入与真实账号池，D3-02 缺任务级与请求层证据。
D3-03 的任务方案关联、D3-04 的监督/停止隔离、D0/D1、生产部署与正式发行保持各自状态。

## 11. 证据一致性修复（2026-11-04 第二轮）

### 11.1 问题一：多连接合并导致证据混用

复现（真实 `QuotaStore`）：连接 A 较早但新鲜、`available`；连接 B 较新、`exhausted`，随后 B 采集失败；
聚合视图选中 B 的数据、`connectionIds` 保留 `[B, A]`。

修复前 `buildRoutingEvidence` 在 `connectionIds` 上做 `reduce(stronger)`，于是映射等级借用 A 的 `observed`，
时间与可用性仍来自 B —— 一条"失败连接 + 新鲜等级"的混搭结论。

修复：`level` 只由聚合视图实际选中的那条连接（`observation.connectionId` / `balance.connectionId`）决定，
写进 `primaryConnectionId`；其余 `connectionIds` 只作来源引用，`sources[]` 逐条列出各自的等级与原因；
`upsert` 只追加来源，绝不改等级、时间或可用性。

修复前后对照（同一隔离库，`probe-routing-bugs.ts`）：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| B 较新但采集失败 | `level: observed`、`availability: exhausted` | `level: unavailable`、`reason: source_error`、`primary: B`、`availability: exhausted`（字段同源）、`sources: A=observed / B=unavailable` |

### 11.2 问题二：来源时间未知被误标为过期

复现：有快照但 `sourceObservedAt: null`、`freshness: "unavailable"` → 修复前 `level: expired`。

修复：`evaluateQuota()` 把四种情况分开—— 有快照且 `fresh` → `observed/snapshot_fresh`；
有快照但无来源时间 → `unavailable/source_time_unknown`；有快照且过期 → `expired/snapshot_expired`；
采集报错 → `unavailable/source_error|source_unavailable`。积分侧由 `cacheFreshness` 决定，另外用
`memberFreshness` 表达"成员余额本身的新鲜度"，两者不混。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 有快照、来源时间缺失 | `level: expired` | `level: unavailable`、`reason: source_time_unknown` |

有效期处理：quota 映射只在主证据 `snapshotId` 与连接快照一致时才引用该连接 `expiresAt`，否则保持 `null`；
积分侧引用 `balance.cacheExpiresAt`；`generatedAt` 不会延长任何快照有效期。

契约影响：仍在 `routing-evidence-1` 内，新增字段 `evidenceReason`、`primaryConnectionId`、`sources[]`
与连接级 `reason`，均为增量字段；`level` 语义收紧（不再跨连接取强），`expired` 不再覆盖"时间未知"。
版本号未升，改动已在第 11.1/11.2 与测试中固定；若下游已按旧语义解析 `expired`，需要按本节重新核对。

### 11.3 回归

新增 `gateway/test/resource-routing-consistency.test.ts`（14 用例，真实 `TaskStore` + 真实 service）。
**修复前该文件 4 pass / 10 fail**（`pre-fix-tests.log`），修复后 14/14。用例清单见第 7 节末段。

### 11.4 新候选包上的针对性验证

| 检查 | 结果 |
| --- | --- |
| `node scripts/verify-package-routing.mjs`（包内 `dist/` + 官方 `WorkbenchHttpServer`） | 34/34，exit 0：成功 / 来源时间未知 / 过期 / 采集失败 / 多连接冲突 / HTTP 参数与方法 / 容量路径 / 数据库不变 / 任务列表不变 |
| `node scripts/desktop-routing-host-check.mjs`（正式 `workbench-desktop-host.mjs` + 真实 SQLite） | 16/16，exit 0：routing 200 + 正确 schema + primary=B + `level: unavailable`、五个前端资源 200+MIME、数据库 sha256 前后一致、host 退出码 0 |

前端资源文件未改变，因此没有机械重跑浏览器 128 项与 WebView2 71 项；那两份结论只作旧包回归参考。
新接口与新运行代码的验收记录即本节两项。

### 11.5 全量测试与该计时失败的处理

`npm test`（隔离 env，`full-suite.log`）：935 tests / 922 pass / **1 fail** / 12 skipped，exit 1。
唯一失败是 `test/bounded-command.test.ts` 的
「intentional hang and its detached child end within bound with owned tree cleanup」（并行负载下 5667ms，
超出用例自身的 5s 界限）。

处理方式：单文件复跑 `npx tsx --test test/bounded-command.test.ts` → **6/6 pass，13.1s，exit 0**。
另在集成基线 `98a39f2` 上用同一命令跑全量做对照（`baseline-suite.log`）：**911 tests / 899 pass / 0 fail /
12 skipped，exit 0**——同一用例在基线全量里通过，说明它不是必然失败，只在并行负载下偶发超时。
本轮不把全量写成"通过"，也不通过放大超时或删断言让它变绿。

上一轮的失败是另一个计时用例（`run-worker.test.ts`），两次失败的共同点是并行负载下的挂起类计时断言，
位置都不在 `resource-routing.ts` 覆盖的路径上；本轮新增的 24 个真实存储用例会增加并行负载，
这是运行成本而不是路由证据语义的变化。


## 12. 复现


```powershell
# 1) 构建与测试
cd E:\javaproject\workbuddy-resource-source-integration\gateway
npm run build
npx tsx --test test/resource-routing.test.ts

# 2) 真实来源检查（隔离 hub + 隔离网关，随机凭据，空账号池）
cd E:\javaproject\outputs\resource-source-routing-20261104
$env:RUN_TAG='source'; node scripts\real-source-check.mjs
# 如需核对包内构建：
$env:RUN_TAG='package'
$env:GATEWAY_DIR='E:\javaproject\outputs\resource-source-routing-20261104\package\unpacked\codex-workbuddy-gateway-v0.7.1'
node scripts\real-source-check.mjs

# 3) 注入真实统计连接后重跑（会话令牌来自 POST /panel/login，不要写进脚本或聊天）
$env:WORKBUDDY_QUOTA_SOURCE_URL='http://127.0.0.1:8788'
$env:WORKBUDDY_QUOTA_API_KEY='<受保护进程环境>'
$env:WORKBUDDY_QUOTA_PANEL_TOKEN='<panel/login 会话令牌>'
$env:WORKBUDDY_CREDIT_SOURCE_URL='http://127.0.0.1:8788'
$env:WORKBUDDY_CREDIT_API_KEY='<受保护进程环境>'
```

清理：本轮所有 hub / 网关进程均由脚本 `taskkill /PID <自己的 pid> /T /F` 按 PID 结束，未按进程名批量结束；
生产 hub（PID 12032）与用户浏览器全程未动。
