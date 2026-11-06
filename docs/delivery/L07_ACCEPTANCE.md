# L07 验收记录：自动政策的保存、修订、撤回与持久派工

- 交付线：L07-automation（第三批，任务 D5-01 / D5-02 / D5-03 的 07 侧）
- 工作树：`E:\javaproject\workbuddy-finish\L07-automation`
- 分支：`feat/finish-l07-automation`
- 记录日期：2026-11-06
- 结论范围：源码、隔离验收、真实命令证据与交接。真实自动派工**未启用**，未安装、未发布、未部署、未推送、未合并主干。

## 1. 范围

### 1.1 本线交付的东西

1. **可信政策入口（D5-01）**：`gateway/src/automation.ts` 保存自动政策，绑定工作区、执行器、连接、provider、精确模型、推理档位、允许改动范围、允许元数据、每个窗口轮次、单任务超时、最大尝试、费用条件与到期时间。政策只能由 `user:` / `local-operator:` / `desktop:` 来源写入；`agent:`、`http:`、`model:`、`automation:` 与空来源一律 `PLAN_CONFIRMATION_REQUIRED`。政策可查看、修订、撤回：修订产生新版本并保留旧版本，撤回是终态，到期在读取时即阻断。每次写入与每次决定都进 `automation_audit`。
2. **持久自动决定（D5-02）**：一个决定同时绑定任务、方案（planId + revision）、政策版本与摘要、评估解释、操作意图（operationId）。执行前在同一个 `BEGIN IMMEDIATE` 事务里重读政策并重跑评估：授权、撤回、到期、工作区、范围、当前模型政策（含历史任务的原始政策）、费用证据、容量、轮次上限。方案由自动政策服务自身创建并被自己消费，重复触发至多一次效果。
3. **结果不明的处置**：派工只认「操作已成功」的回执；未确认的效果落 `outcome_unknown`，只观察原操作，不新建任务、不换会话、不换执行器、不按 TTL 释放占用。进程重启后仍处于 `executing` 的决定由 `recover()` 归入 `outcome_unknown` 并记账。
4. **只读界面与一致的技能文本（D5-03）**：`gateway/workbench/automation.mjs` + `automation.css` 展示授权状态、已存政策、决定、阻塞原因与审计，不发任何写请求；技能六文件（`SKILL.md`、`agents/openai.yaml`、`references/{setup,execution,dispatch,agent-hub}.md`）第三批归本线，已与 `gateway/skills/workbuddy-executor/` 发布副本逐字节一致。

### 1.2 明确不做的事

- 不默认启用真实自动派工：`armed` 默认 `false`，`enabled` 默认 `false`；`execute` 在没有 `--enable-dispatch` 时直接拒绝。
- 不给浏览器、MCP、HTTP 任何自动写入口。写入口只有 `gateway/scripts/automation.mjs`（本机命令行）。
- 不授权提交、推送、部署、合 main、批准原生权限。
- 不改 `AGENTS.md`：每个真实任务仍须展示执行器/来源/精确模型/推理档位/已知费用并取得用户当次确认。
- 不改既有表结构：新增 `automation_meta` / `automation_policies` / `automation_decisions` / `automation_audit` 四张自管表，其它 schema 不动。
- 不做真实安装、真实登录、真实模型派工与生产政策变更（归 10）。

## 2. 基线与提交

| 项 | 值 |
| --- | --- |
| 父基线提交 | `000e9da17c43ded7040c9e6822fb48eb51abcedc` |
| 父基线 tree | `7fc23ee6ea99da2e5b857a8ec4eeb8f66559941a` |
| 开工核对 | HEAD、`git status --porcelain` 空、分支名、tree 四项均与任务书一致 |
| 实现提交 | `98abb692e8df89231501d0954491fdbb9c22057c` |
| 文档提交 | 见外部 `HANDOFF.json`（避免自引用，不在本文内写自身提交哈希） |
| 依赖 | `gateway/` 下 `npm ci --no-audit --no-fund`（按本树 `package-lock.json`，未改版本） |

隔离环境（本线独占）：`WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR`、`WORKBUDDY_DB_FILE`、`WORKBUDDY_RUNS_DIR` 全部指向本线 `tmp/` 下的自建路径，`NO_PROXY=127.0.0.1,localhost`，并清除继承的 `WORKBUDDY_PYTHON` 与 `NODE_TEST_CONTEXT`。未改动生产安装、配置、政策、登录状态。

## 3. 变更文件

实现提交 `98abb69`：29 个文件，+2973 / −13。

新增：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `gateway/src/automation.ts` | 1029 | 政策/决定/审计存储、评估、持久执行、恢复 |
| `gateway/src/automation-http.ts` | 81 | 只读 HTTP 投影（六条 GET 路径） |
| `gateway/src/automation-cli.ts` | 199 | 本机命令行：政策写入与派工触发 |
| `gateway/scripts/automation.mjs` | 6 | `npm`/`node` 入口，转调 `dist/automation-cli.js` |
| `gateway/workbench/automation.mjs` | 290 | 「自动政策」只读视图 |
| `gateway/workbench/automation.css` | 25 | 视图样式 |
| `gateway/test/automation-policy.test.ts` | 353 | 政策生命周期与评估（21 例） |
| `gateway/test/automation-dispatch.test.ts` | 268 | 决定/执行/重放/竞态/重启（10 例） |
| `gateway/test/automation-http.test.ts` | 136 | 只读投影与写方法拒绝（6 例） |
| `gateway/test/support/automation-fixture.ts` | 181 | 合成政策环境（本线自建 fixture） |
| `gateway/workbench/test/automation-view.test.mjs` | 177 | 视图渲染与不写断言（8 例） |

修改（共享入口按 COMMON 要求同时写集成请求）：

| 文件 | 改动 |
| --- | --- |
| `gateway/src/collaboration.ts` | `CollaborationPlan.mode` 增加 `automatic`；新增 `AutomationPlanBinding`；`prepare()` 要求 automatic 方案必须带政策绑定且授权来源为 `automation:`；`createPlan` 拒绝普通路径铸造 automatic 方案 |
| `gateway/src/task-application-service.ts` | 暴露惰性 `automation` 服务；`createCollaborationPlan` 拒绝 `mode:"automatic"` |
| `gateway/src/task-store.ts` | 新增 `get database()` 句柄（自管表模块共享同一 WAL 写锁；schema 变更仍留在本文件） |
| `gateway/src/workbench-http.ts` | 注入只读 `automation` 选项；`isKnownPath` 与 GET 链挂接 `automation-http` |
| `gateway/src/workbench-entry.ts` | 组合根传入 `service.automation` |
| `gateway/src/workbench-assets.ts` | 白名单加入 `automation.mjs` / `automation.css` |
| `gateway/scripts/package.mjs`、`gateway/test/package.test.ts` | 发布清单加入两个前端文件（包白名单属集成人，见集成请求） |
| `gateway/workbench/app.mjs`、`index.html` | 侧边栏「自动政策」分组与挂载点、样式表 |
| `SKILL.md`、`references/{setup,execution,dispatch}.md` 及 `gateway/skills/workbuddy-executor/` 同名副本 | 自动政策章节（默认不启用、只读页面、命令行写入口、费用三档、撤回终态、结果不明只观察） |

`references/agent-hub.md` 与 `agents/openai.yaml` 未改，两侧仍一致。

## 4. 验证

### 4.1 命令与退出码（真实执行）

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `npm run build`（`tsc -p tsconfig.json`） | 0 | 无诊断 | `logs/build.log` |
| `npm run typecheck:task-view` | 0 | 无诊断 | `logs/typecheck-task-view.log` |
| `npm test`（`tsx --test test/**/*.test.ts`） | 0 | tests 1254 / pass 1242 / fail 0 / skipped 12 | `logs/npm-test-3.log`、`logs/npm-test-3.exit.txt` |
| `npm run test:workbench` | 0 | tests 131 / pass 131 / fail 0 | `logs/test-workbench.log` |
| `npx tsx --test test/automation-policy.test.ts` | 0 | 21 pass | `logs/automation-policy.log` |
| `npx tsx --test test/automation-dispatch.test.ts` | 0 | 10 pass | `logs/automation-dispatch.log` |
| `npx tsx --test test/automation-http.test.ts` | 0 | 6 pass | `logs/automation-http.log` |
| `node --test workbench/test/automation-view.test.mjs` | 0 | 8 pass | `logs/automation-view.log` |
| `npx tsx --test test/skill-copies.test.ts` | 0 | 1 pass（六文件逐字节一致） | `logs/skill-copies.log` |
| `npm run desktop:test` | 0 | `{"passed":92,"failed":0}` | `logs/desktop-test.log` |

12 项 skip 是既有的平台跳过（6 项 POSIX-only、6 项 macOS lifecycle），与本线改动无关，不是空测试。

### 4.2 用例覆盖（任务书验收场景 → 实测）

| 场景 | 覆盖 |
| --- | --- |
| 政策生效 / 未确认 / 过期 / 撤回 | `automation-policy`：`POLICY_EXPIRED`、`POLICY_REVOKED`、无政策 `POLICY_MISSING`、覆盖歧义 `POLICY_AMBIGUOUS`；撤回后详情仍可读且带原因 |
| 不同项目范围 | `SCOPE_VIOLATION`（工作区、允许改动、允许元数据三类分别断言） |
| 来源 / 模型漂移 | `MODEL_POLICY_BLOCKED`（执行器、连接、provider、精确模型、推理档位逐项）；历史任务原始政策与当前政策同时校验 |
| 政策变更 / 历史限制 | 修订产生新 revision、旧版本 `superseded`、审计记 `revised`；`requireFree` 历史政策在评估里单独标记 `history.blocked` |
| free-only | 只认新鲜的 `x0.00`：`credits:null` → `QUOTA_UNAVAILABLE`，`x1.50` → `MODEL_UNVERIFIED`，`freshness:"stale"` → `QUOTA_UNAVAILABLE` |
| 费用未知 / 硬上限不支持 | `unknown_allowed` 放行但写 `cost_unknown_not_a_hard_cap` 限制并说明不是硬上限；`known_cost + requiresHardCap` 且 `hardCap:"unsupported"` → `COST_CONTROL_UNAVAILABLE` |
| 预算耗尽 | `remaining 10 < ceiling 25` → `QUOTA_EXHAUSTED`；`remaining 500` → `delegate` |
| 双进程撤回竞态 | `automation-dispatch`：两个并发 `execute` 只有一个成功，另一个落在 `OPERATION_CONFLICT` / `EXECUTOR_BUSY` / `OUTCOME_UNKNOWN` 集合内；`send` 只发生一次、只产生一个任务 |
| 重启回执 | `recover()` 把遗留 `executing` 归入 `outcome_unknown`，审计 `decision_recovered_unknown`，不重派 |
| 未知准备投递 | `failNativeSend` fixture：原生发送抛错后决定落 `blockedCode:"OUTCOME_UNKNOWN"`，`listTasks().length === 1`，不补发 |
| 截止迟到 / 轮次 / 容量 1 | `DEADLINE_EXCEEDED`（超时与政策早于任务结束两种）、`ATTEMPT_LIMIT`、`EXECUTOR_BUSY(field=capacity)` 占用共享槽时阻断 |
| 政策修订 / 撤回审计 | `automation_audit` 序列含 `created`、`revised`（fromRevision）、`revoked`、`decision_pending`、`decision_blocked`、`decision_dispatch_intent`、`decision_dispatched`、`decision_recovered_unknown`，每条带 actor 与 source |
| 合成授权不能被伪造 | 服务层只接受 `user:`/`local-operator:`/`desktop:`；`createCollaborationPlan({mode:"automatic"})` 与 registry 层直接 `createPlan` 均 `PLAN_CONFIRMATION_REQUIRED`；`test/automation-policy.test.ts` 静态断言 `server.ts` / `deepseek-server.ts` 不含 `/automation/i`（MCP 无自动写工具）；`automation-http` 断言六条路径 POST/DELETE 均 405 且 `allow: GET, HEAD` |
| 升级旧记录无自动授权 | 旧库补建四张表后 `schema_version=1`、政策表为空、`enabled/armed=false`；`schema_version=99` → `AUTOMATION_SCHEMA_UNSUPPORTED`；`ensureAutomationSchema` 幂等 |
| 回退限制 | 无政策时全部拒绝并说明「没有已保存政策」；页面在读取失败时显示失败而非空政策；`describe()` 明确不扩张任何权限 |

### 4.3 本机命令行冒烟（合成库 `tmp/smoke`，非真实派工）

真实调用 `node scripts/automation.mjs`，结果：

| 步骤 | 结果 |
| --- | --- |
| `status` | `enabled:false`、`armed:false`、`dispatcherWired:false`、`writeEntry:"local_cli_only"`、`httpWrites:false`，limits 含「never grants commit, push, deploy or native-approval rights」 |
| `policy-create --source user:smoke-operator` | exit 0，`authorizationSource:"user:smoke-operator"` |
| `policy-create --source http:remote` | exit 1，`PLAN_CONFIRMATION_REQUIRED`：「Only a saved user/local-operator/desktop source may authorize a policy; agent and HTTP sources cannot.」 |
| `evaluate`（政策无 scope） | `decision:"wait"`，`SCOPE_VIOLATION` |
| `evaluate`（探针过期） | `QUOTA_UNAVAILABLE` + `MODEL_UNVERIFIED` |
| `evaluate`（补 `--scope-allow 'src/**'`、探针新鲜） | `decision:"delegate"`，`candidates[0].status:"candidate"` |
| `decide` | exit 0，`decisionId:"decision-_nOwnDNEC2YFJIopWb59vUJ5"`、`status:"pending"`、`operationId:null` |
| `execute`（未武装） | exit 1，`AUTOMATION_NOT_ARMED`：「Automatic dispatch is not armed in this process; a manual dispatch is still available.」 |
| `audit --limit 12` | `decision_pending` / `decision_blocked`（source `automation`）、`revised` / `created`（source `user:smoke-operator`） |
| `policy-revoke --reason 'smoke finished'` | exit 0，`status:"revoked"`、`revocationReason:"smoke finished"` |
| 撤回后 `evaluate` | `decision:"wait"`，`POLICY_REVOKED`：「The saved policy was revoked.」 |

冒烟证明确实是「保存了政策但仍然不会自动派工」，且撤回是立刻生效的终态。

### 4.4 只读 HTTP 投影

`automation-http` 六个用例：根响应含 `httpWrites:false`、`writeEntry:"local_cli_only"`、`armed:false`、`enabled:false`、`snapshotOnly:true`；未知政策 404 `POLICY_MISSING`、未知决定 404 `DECISION_NOT_FOUND`；`decide` 之后详情 `status:"pending"`、`operationId:null`、审计含 `decision_pending`，并且 `store.listTasks().length === 0`（只记录决定、没有派工）；不注入服务时 GET 404、POST 405。

## 5. 失败历史

1. **PowerShell 文本管道把源码写成非 UTF-8**：用 `(Get-Content -Raw) -replace ... | Set-Content` 改 `gateway/src/workbench-http.ts` 后构建报 `invalid UTF-8 text`。处置：`git checkout -- src/workbench-http.ts` 复原（25875 字节），改用编辑工具做定点改动。教训：含中文的源码不要走 PowerShell 文本管道。
2. **只读组合根没有可写句柄**：`npm run test:workbench` 报 `TypeError: Cannot read properties of undefined (reading 'exec')`（`dist/automation.js:94`），来源是 `scripts/workbench-desktop-host.mjs:29` 的 `openWorkbenchReadStore` 门面没有 `database`。处置：`AutomationService` 构造函数改为空体、schema 首次使用时才初始化，句柄缺失时给出明确 `INVALID_AUTOMATION`（「opened a read-only view」）；`TaskApplicationService.automation` 改惰性 getter。
3. **HTTP 用例 1/6 失败**：`decide` 返回 `blocked`，因为该用例用了未注入 probe 的服务，回退快照 `credits:null` 让 free-only 政策判 `QUOTA_UNAVAILABLE`。处置：显式注入 `probe`，用例通过；顺带确认「回退快照必然阻塞」是正确行为，不是缺陷。
4. **全量首跑 174 fail**：全部是 `loadConfig` 报「Multiple WorkBuddy installations or data directories found; set WORKBUDDY_CLI_ELECTRON and WORKBUDDY_CONFIG_DIR explicitly.」（`config.ts:55`）。处置：按 COMMON 用本线自建 `WORKBUDDY_CLI_ELECTRON=F:\node.exe`、`WORKBUDDY_CONFIG_DIR=tmp\wb-config`、清除继承的 `WORKBUDDY_PYTHON`、`NO_PROXY=127.0.0.1,localhost`；随后 `coordinator.test.ts` 16/16 通过。
5. **第二跑 3 fail**：①`schema_version=99` 用例仍按旧写法在构造期断言（构造函数已惰性化），改为在 `describe()` 上断言；②`desktop-queue` 一个监听时序用例在全量并行下偶发失败，单跑 17/17 通过（既有 flaky，非本线引入）；③`package` 清单缺 `automation.mjs` / `automation.css`，补 `scripts/package.mjs` 与 `test/package.test.ts` 夹具清单。
6. **第三跑全绿**：1254 测试 / 0 fail / exit 0。

其它工具层教训（不影响产物）：PowerShell here-string 传 JS 会破坏引号；`Set-Content -Encoding utf8` 在 Windows PowerShell 5.1 会写 BOM，导致命令行读 JSON 报 `Unexpected token '\ufeff'`，改用 node 写无 BOM；修订政策不能用 `--ttl-hours`（会延长自身到期而被拒），须用 `--expires` 传原到期值。

## 6. 局限

- **真实自动派工没有启用过**：`armed` 只能是命令行进程内的临时状态，仓库默认 `false`；因此没有一次真实的模型调用、没有一次真实费用产生。
- **额度与目录证据靠注入**：`probe` 是只读快照，真实数值要靠 02/03 线的观测适配器喂进来；没有 probe 时回退到「只有已存政策」的快照，free-only 政策会据此阻塞——这是有意的保守行为。
- **决策 actor 默认 `agent`**：`decide` 记录的是「谁触发了决定」，不是授权；授权只认政策保存时的 `user:`/`local-operator:`/`desktop:` 来源。
- **面板只读**：浏览器无法保存、修订、撤回政策，也无法触发派工；这是 COMMON 与任务书的硬要求，不是待补的缺口。
- **未做真实安装 / 登录 / 生产政策变更**：按任务归属留给 10。
- **`desktop:test`（92 项）与本线无关**：本线没有改 C# 原生代码，跑它只为确认没有连带破坏。
- **`automation_*` 四张表由本模块自建**：未并入统一 migration；需要集成人在 schema 上确认归属（见集成请求）。

## 7. 运行与部署状态

| 项 | 状态 |
| --- | --- |
| 已安装到本机 | 否 |
| 已登录 / 已连真实模型 | 否 |
| 真实自动派工 | 未启用（`armed:false`、`enabled:false`） |
| 已推送远端 | 否 |
| 已合并主干 / 发布 / 部署 | 否 |
| 生产配置、政策、登录态 | 未改动 |
| 工作树 | 提交后干净（`tmp/` 为本线自建临时目录，未入库） |

## 8. 交接产物

- 外部交接：`E:\javaproject\outputs\finish-l07-20261105\HANDOFF.json`（提交哈希、检查项与日志、集成请求、未决项）。
- 集成请求（共享入口由集成人接线/复核）：`workbench-http.ts` 只读挂接、`workbench-entry.ts` 组合根、`workbench-assets.ts` 白名单、`task-application-service.ts` 惰性服务、`task-store.ts` 数据库句柄、`scripts/package.mjs` 发布清单、`gateway/workbench/app.mjs` 导航与 `index.html` 样式表。
- 后续线依赖：08 的独立负例应按本文件 §4.2 的阻断码与「至多一次效果」断言；10 在真实启用前必须具备真实额度证据与用户逐任务确认。
