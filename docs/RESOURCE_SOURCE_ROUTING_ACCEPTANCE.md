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
| `connections[]` | 每条连接的 `resource`（quota/credit）、`status`、`errorCode`、`level`、`snapshotId`、`sourceObservedAt`、`expiresAt` |
| `mappings[]` | 每个池范围一行：`scopeId`、`scopeKind`、`realm`、`modelId`（积分池为 `null`）、`unit`、`level`、`connectionIds`、`availability` 或 `coverage` |
| `unresolved[]` | `task_to_model`、`session_to_provider`、`key_scope`、`exclusive_reservation`，每条带原因 |
| `invalidatesOn[]` | `connection_fingerprint_change`、`snapshot_expiry`、`source_error`、`configuration_change` |
| `limitations[]` | 含 `routing_unverified`、`shared_region_pool`、`task_attribution_unavailable`、`model_scope_unverified` |

证据等级（`level`）：`observed` > `expired` > `unavailable` > `unobserved`。同一池被多条连接报告时合并为一行、
保留全部连接 ID，并取最强等级与最新观察时间；连接级错误会向下传染到它报告的池，不会停留在"可用"。

### 6.2 未知与失效回退

- 连接已配置但无快照 → `unobserved`，不产生映射行。
- 快照过期 → `expired`，映射保留但降级（页面仍可显示"陈旧"）。
- 采集报错 → `unavailable`，错误码原样带出。
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
| `npx tsx --test test/resource-routing.test.ts test/desktop-readonly-resources.test.ts test/quota-observation.test.ts test/credit-balance.test.ts test/capacity-resource.test.ts` | 56/56，exit 0 |
| `npm run test:workbench` | 100/100，exit 0 |
| `npx tsx --test test/workbench-http.test.ts test/workbench-assets.test.ts test/workbench-panel.test.ts test/package.test.ts` | 34/34，exit 0 |
| `npm run desktop:test` | 70/70，exit 0 |
| `node scripts/generate-snapshot-manifest.mjs` + `node verify-snapshot.mjs` | 318 文件，`hashesMatch: true`，`manifestCompleteness: checked`，exit 0 |
| `node scripts/real-source-check.mjs`（工作树构建） | 35/35，exit 0 |
| `node scripts/real-source-check.mjs`（`GATEWAY_DIR` 指向包内构建） | 35/35，exit 0 |
| `npm test`（全量，隔离环境） | 921 tests / 908 pass / 1 fail / 12 skipped。唯一失败是 `run-worker.test.ts` 的「detached worker 在启动器退出后存活」计时用例（并行负载下 6615ms 超时，单独重跑 5/5 通过、用时 908ms），与本轮改动的文件无交集 |

新增测试 `gateway/test/resource-routing.test.ts` 覆盖：空库不出映射、已配置未采集、观察到的池与模型、
过期降级、采集错误降级、同池多连接去重、桌面 facade 与网关结果相同、HTTP 只读与参数校验、
缺表时 503 而任务接口仍 200、以及"永不把计划升级为已执行路由"。

## 8. 候选包

| 项目 | 值 |
| --- | --- |
| 包 | `outputs\resource-source-routing-20261104\package\codex-workbuddy-gateway-v0.7.1.zip` |
| SHA-256 | `532f2b868a207cabd108f68d7261aa3af730a34b622973f1b1fa6d21cf9e4677` |
| 包内校验 | `node scripts/verify-release.mjs` → `{"version":"0.7.1","verifiedFiles":557,"hashesMatch":true}` |
| 与旧候选（`60b79f56…`，552 文件）差异 | 新增 `dist/resource-routing.js`、`src/resource-routing.ts`、`test/resource-routing.test.ts`，以及随之变化的 `dist/*`、快照清单 |
| 版本号 | 仍为 0.7.1，**同版本号、不同哈希**；以哈希区分 |

运行文件确实变化，所以按流程重建了候选并核对包内容；浏览器与 WebView2 的既有合成验收结论（128/128、71/71）
针对旧包，本轮未机械重跑，因为它们不覆盖新增只读接口——新接口的验证以第 4、7 节的真实来源检查与 HTTP 测试为准。

## 9. 子项状态

| 子项 | 状态 | 依据 |
| --- | --- | --- |
| D3-01 采集器 ↔ 真实来源契约 | **真实来源代码上验证通过** | 第 4 节；真实 `wb_proxy.py` + 隔离实例 |
| D3-01 正式部署的真实只读联调 | **未完成（缺部署注入）** | 第 3 节；本机无统计连接配置 |
| D3-01 真实账号池的 rows / 余额 | **未验证** | 隔离实例账号池为空 |
| D3-02 连接 → 池 → 模型的证据结构 | **已实现并验证** | `routing-evidence-1`、10 项测试、真实来源 35 项检查 |
| D3-02 未知与失效回退 | **已实现并验证** | 过期/报错/缺表三类降级测试 |
| D3-02 任务 → 模型的真实路由 | **不可证，保持 `routing_unverified`** | 上游载荷无任务/会话维度 |
| D3-02 请求层实际路由证据 | **缺** | 本轮不发模型请求 |

D3-01 与 D3-02 因此都**不标整体完成**：D3-01 缺正式连接注入与真实账号池，D3-02 缺任务级与请求层证据。
D3-03 的任务方案关联、D3-04 的监督/停止隔离、D0/D1、生产部署与正式发行保持各自状态。

## 10. 复现

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
