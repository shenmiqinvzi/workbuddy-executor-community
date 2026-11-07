# D 线回执：自动政策、观测、共享准入与恢复

- 轮次：`forward-delivery-20261107`
- 工作树：`E:\javaproject\workbuddy-forward-20261107\D-automation`
- 分支：`feat/forward-automation-readiness`，起点 `134cdc7febbf858e89fb1010cf6b9d72da5edbe7`
- 本轮 HEAD：`899bed7`（6 个提交，未推送、未合入 main、未 reset/clean/stash/rebase）
- 未写 `E:\javaproject\workbuddy-finish\R-review-fixes`；未安装、未 arm 真实政策、未产生真实模型调用与费用

## 0. 一句话结论

自动派工现在有了**正式只读观测组合根**（`createReadOnlyProbe`），探测不到就阻塞而不是当免费；
`probe` 不再有「用已保存政策假装执行器可派工」的兜底；六层边界在 `describe()/snapshot()`/只读页/HTTP 投影上分开呈现；
决定 → 持久化 → 原 operation → 共享 `send` 的整链有组合回归（真实 CLI 组合根）；
撤回会把**尚未派工**的决定改成 `revoked` 并留审计，已开始的任务按原生命周期走。
**真实自动 arming 未做**：本线只把开关和判定做成可验证的代码路径，没有在真机上 arm 过任何真实政策。

## 1. 提交清单

| # | commit | 标题 | 改动 |
| --- | --- | --- | --- |
| 1 | `6267e05` | feat(automation): read-only observation probe and six-layer disclosure | 2 files, +542/−16 |
| 2 | `8e35607` | feat(automation): show the six layers, the observation and the waiting condition on the read-only page | 3 files, +215/−2 |
| 3 | `07f7b79` | test(automation): pin the read-only probe to real surfaces and honest refusals | 2 files, +275/−13 |
| 4 | `d50ae78` | test(automation): pin the probe to decide to dispatch chain through the CLI root | 1 file, +300 |
| 5 | `70b1803` | test(automation): read the layers and the observation through the HTTP projection | 1 file, +31/−2 |
| 6 | `899bed7` | feat(automation): let the page observe the original operation, read-only | 5 files, +158/−1 |
| 7 | HEAD | docs + fix: 本回执、集成请求，以及 HTTP 测试连接池偶发 `ECONNRESET` 的修复 | 4 files（含 2 份文档） |

合计 `8 files changed, +1507/−20`（相对起点）。改动文件：
`gateway/src/automation.ts`、`gateway/src/automation-cli.ts`、`gateway/src/automation-http.ts`、
`gateway/workbench/automation.mjs`、`gateway/test/automation-probe.test.ts`（新）、
`gateway/test/automation-composition.test.ts`（新）、`gateway/test/automation-http.test.ts`、
`gateway/workbench/test/automation-view.test.mjs`。

顺带修掉的真实缺陷：`automation.ts` 的 id 生成器原用 `base64url`，会产出 `_`，而协作层的
`validId` 只接受 `[a-zA-Z0-9._:-]`，导致新建的政策/决定 id 有约 31% 概率被自己的守卫拒绝
（`PLAN_CONFIRMATION_REQUIRED`）。现改为 `randomBytes(18).toString("hex")`（`automation.ts:279`）。

## 2. D01 六层边界：每一层的**判定来源**

`AutomationService.layers()`（`gateway/src/automation.ts:462`）逐层给出判定来源，`describe()`、`snapshot()`、
HTTP 根投影、只读页都读它（对象键：`installation/process/authorization/taskSelection/decision/dispatch`）。

| 层 | 字段 | 当前判定来源 | 等级 |
| --- | --- | --- | --- |
| ① 安装级启用 | `installation_enabled` | `automation_meta.enabled`（真实 sqlite 列，持久化，跨进程/重启一致） | **真实** |
| ② 进程内 armed | `process_armed` | 本进程 `--enable-dispatch` 开关 + 派工器是否接线 + `probeKind`；不持久化 | **真实（进程级）** |
| ③ 政策授权 | `policy_authorization` | `automation_policies` 当前版本行（真实），`authorizationSource` 只接受 `user:` / `local-operator:` / `desktop:` 前缀 | **真实** |
| ④ 逐任务选择 | `per_task_selection` | **常量声明** `mode:"per_task_confirmed"`：这是规则说明，不是被观测出来的事实 | **未知/声明** |
| ⑤ 已记录决定 | `recorded_decision` | `SELECT status,COUNT(*) FROM automation_decisions GROUP BY status`（真实计数） | **真实** |
| ⑥ 实际派工 | `actual_dispatch` | `guardedService:"TaskApplicationService.send"` 与 `capacity:"single_shared_slot"` 是**常量声明**；容量真实值来自 `store.operations.occupant()`，只在 `assessment` 里作为阻塞依据使用 | 声明 + 真实（容量判定处真实） |

写入面：`writeEntry:"local_cli_only"`、`httpWrites:false`、`mcpWrites:false`。页面、HTTP、MCP 都没有写入口；
CLI 参数里的 `--actor` 字符串本身不构成授权（`source` 必填且必须匹配 `SOURCE` 正则，层说明里明写这一点）。
第 ④ 层的措辞是「受控政策执行，仍需每任务确认」——政策不替未来未知任务选模型。

## 3. D02 只读观测 probe：哪些字段来自真实表面，哪些还是占位

实现：`createReadOnlyProbe(options)`（`gateway/src/automation.ts`，`AutomationReadOnlyProbe` 接口 + `readOnly:true` + `kind:"read_only_local"`），
报告类型 `AutomationProbeReport {probeVersion:"workbuddy-executor/automation-probe-1", readOnly, observedAt, policy, executors, models, sources, coverage, limitations}`。

真实读面（本机、免登录、不发模型请求）：

- `readResourceConnections(process.env)`（`WORKBUDDY_RESOURCE_CONNECTIONS_FILE`）→ `connections` 源
- `readQuotaResources(db)` → `quota` 源（token 估算）
- `readCreditBalances(db)` → `credit` 源（region 池 credit 缓存）
- `desktopModelCatalog(config, env)`（B 线已有可见目录）→ `catalog` 源：执行器在线/可派工、模型清单、`credits`、`pricingVerified`
- 可选 `liveness()` 注入 → `liveness` 源

| 报告字段 | 来源 | 等级 |
| --- | --- | --- |
| `executors[].online/dispatchable` | 可见目录里的执行器行（来自 `desktopModelCatalog`） | 真实（需真实宿主；宿主不在则 `unavailable` 并阻塞） |
| `executors[].capabilities` | 常量：workbuddy → `["desktop_queue_send","native_session"]`，dsh → `["dsh_bridge_prompt","per_host_session"]` | **占位（常量）** |
| `models[].modelId/reasoningEfforts` | 可见目录行 | 真实 |
| `models[].credits` | 目录行的 `credits`（`pricingVerified` 为真才算 `valueKind:"reported"`） | 真实（宿主不在则 `null`） |
| `models[].remaining/unit` | 仅当存在同 `modelId` 且连接快照新鲜的 quota 观测：`unit:"tokens"`, `valueKind:"estimated"` | 真实（估算，非硬上限） |
| `models[].hardCap` | 恒为 `"unsupported"` | **占位（常量）**：本机没有能证明硬封顶的证据源 |
| `models[].observedAt/expiresAt` | 取自**源快照时间**，不是 probe 的 `observedAt` | 真实 |
| `models[].freshness` | 由源状态推导（`ok`→fresh，过期→stale，无表/无声明→unavailable） | 真实 |
| `coverage.executors/catalog/costEvidence/tokenEstimates/creditCache/taskAttribution` | 由各源状态计算；`taskAttribution` 恒 `unavailable` | 真实计算 / `taskAttribution` 为**已知缺口** |
| `sources[].status/detail/entries` | 每个读面单独记录：`ok/not_declared/missing/unreadable/stale/unavailable/unwired` | 真实 |
| 价格证据 | 目录 `pricingVerified`；quota 只有 token 估算；`credit_balance` 是 **region 池**，永不下放到单模型 | 真实但**不能**支撑 `free_only` |

关键否定结论（都已写成测试断言）：

- 没有目录读面 → `catalog:unwired`，**不会**有任何执行器被判为可派工，`assessment` 追加阻塞 `OBSERVATION_UNAVAILABLE`（字段 `probe.catalog`）。
- 目录行没有可核验价格 → `valueKind:"unavailable"`，`free_only` 政策被 `QUOTA_UNAVAILABLE` 阻塞，而不是「当免费」。
- 旧快照 → `stale`，`remaining` 不下发、`known_cost` 被阻塞；probe 的 `observedAt` 不会把旧快照洗成实时。
- 资源连接文件只是**声明**（`declaration_only`），永远不会产生执行器行。
- region credit 缓存即使被声明，也不下放到单模型：`credit_balance_is_a_region_pool_not_a_model_balance`。

`runProbe()`（`gateway/src/automation.ts:1050`）已删除旧的「政策镜像」兜底；无 probe 时返回空观测 +
`catalog:unwired` + 限制 `["no_catalog_reader","saved_policy_is_not_an_observation"]`。

CLI 组合根接线（本线自有）：`gateway/src/automation-cli.ts:164-169`，
`probe = --probe FILE ? 录制快照 : createReadOnlyProbe({db: store.database, env, catalog: runtime.catalog ?? (() => desktopModelCatalog(config, process.env))})`，
`probeKind` 同步为 `snapshot_file` / `read_only_local` 并进入 `describe()/snapshot()`。

## 4. D03 政策生命周期与预算：是否真的持久化

**是，真持久化在同一个 sqlite**（`automation_meta` / `automation_policies` / `automation_decisions` / `automation_audit`），
不是进程内状态：

- 政策版本：`automation_policies` 每次修订新增一行（`is_current` 翻转），旧版本保留可查；`revisePolicy` 拒绝延长到期、拒绝换工作区。
- 预算轮次：`roundsUsed` 直接数 `automation_decisions` 里落在窗口内的 `executing|dispatched|outcome_unknown` 行 →
  重启不清零；新 operation key 也不会多买一次（同一决定只有一个 effect，见 D04）。
- 撤回：`revokePolicy` 终止政策，并把该政策下 **pending** 决定改成 `revoked` + `blockedCode=POLICY_REVOKED` + 审计 `decision_revoked`；
  已 `executing` 的决定只留 `revoke_after_dispatch_intent` 审计，不取消已开始的 effect。
- 到期：`assessment` 先判 `expiresAt`，过期即 `POLICY_EXPIRED`，不产生新派工。
- 价格未知：`unknown_allowed` 只加限制 `cost_unknown_not_a_hard_cap`，`requiresHardCap` 时直接 `COST_CONTROL_UNAVAILABLE`；
  绝不给出「免费」或「硬封顶」结论。

## 5. D04 幂等、共享准入与撤回竞态

自动化与手工走**同一个** `TaskApplicationService.send`：`automation.ts:861` 的 `this.options.send({...})`
就是 `automation-cli.ts:192` 赋值的 `sharedDispatch = input => service.send(input)`（同一 `TaskApplicationService` 实例，
同一 operation 表、同一容量位）。派工前的围栏在同一事务里：`createPlan`（`automation.ts:834`）→
`authorizePlan(..., \`automation:${policyId}\`)`（`automation.ts:840`）→ 决定置 `executing` + `operationId` → 审计
`decision_dispatch_intent` → 之后才 `send`。跳过 scope/计划/revision/模型准备围栏的路径不存在。

已覆盖的竞态（`gateway/test/automation-dispatch.test.ts` 10 条 + `automation-composition.test.ts` 5 条）：

- 同键重放 → `{replay:true}`，`sent` 仍为 1，任务 1 个；
- 换键冲突 → `OPERATION_CONFLICT`；
- 两进程抢同一决定 → 恰好 1 个成功，另 1 个落在 `OPERATION_CONFLICT|EXECUTOR_BUSY|OUTCOME_UNKNOWN`；
- 撤回 vs 派工 → 意图后撤回只审计不取消；意图前撤回把 pending 改 `revoked`（本线新增）；
- 重启中断（无主 `executing`）→ `recover()` 置 `outcome_unknown` + 审计 `decision_recovered_unknown`，再次 execute 拒绝重试；
- 投递结果不明（native send 抛错 / operation 非 `succeeded`）→ `outcome_unknown`，原任务保留，不新建替代任务；
- 准备失败 → 计入 `blocked`/`outcome_unknown`，不重试。

线性化边界写死在一处：**决定行 `pending → executing` 的那次事务提交**。提交前撤回 = 不派工（`revoked`）；
提交后撤回 = 派工照旧、只留审计；重启只能观察到 `executing`，只能推成 `outcome_unknown`，永不复派。

## 6. D05 只读页与审计：证据等级

- 页面：`gateway/workbench/automation.mjs` 新增六层列表、`观测方式`、`实际请求身份`、`等待条件`、
  `当时的观测`（含每个源的 status/entries/detail）、`查看原任务`（`#taskId=<encoded>`，与 shell 深链一致）、
  `查询原操作`（读 `/decisions/:id/operation`）。页面无 input/form（测试断言 `input`/`form` 计数为 0）。
- 新读面：`GET /workbench/v1/automation/decisions/:decisionId/operation`（`automation-http.ts`），
  由 `AutomationService.operationFor()`（`automation.ts:951`）返回派工器自己的 operation 记录
  （`state/kind/taskId/attemptId/effectStartedAt/error`），声明 `readOnly:true`；所有 automation 路由对写动词仍 405。
- 审计能回答：谁（`actor`）、通过哪个入口（`source`，如 `user:...` / `automation:<policyId>`）、当时条款
  （`policyRevision`/`policyVersion`/`costMode`/`expiresAt`）、用了什么观测（`detail.probe.probeVersion/observedAt/sources/coverage`）、
  为什么不派（`blocks[{code,field,message}]`）、实际请求身份（`detail.requestedBy`）、恢复后是否重复（`decision_recovered_unknown` 无后续派工）。
  审计只存上述元数据，不存任务正文、不存凭据（HTTP 测试断言投影里没有 objective 原文、没有 `"credentials":`）。

**证据等级：全部是本机合成/开发级证据**——真实 sqlite、真实 `WorkbenchHttpServer`、真实 CLI 组合根、
真实 git 工作区，但：使用合成工作区与合成执行器/模型 id（`synthetic-user-choice`），目录读面在测试里被替换为
固定 `DesktopCatalogSource`；**没有任何真实派工、没有真实模型调用、没有真实计费**。不得把本节读成「真实自动模式已验证」。

## 7. D06 真实样本方案（只备不执行）

见本节（方案即，未执行、未 arm、未产生费用）：

1. 范围：`workspaceId` = 一个专用真实工作区，`scope.allowedChanges` 只含 `docs/forward/sample/**`；`permittedMetadata: []`。
2. 模型/推理：执行器 `workbuddy`，连接 `local-workbuddy`，provider `workbuddy-native`，精确模型由**用户当次指定**
   （不预选），`reasoningEffort: null`（该执行器能力要求）；备选允许 DSH 宿主，但必须显式写 provider/host。
3. 费用：`mode:"known_cost"` 且 `requiresHardCap:false` 仅在目录 `pricingVerified=true` 且额度新鲜时可用；
   若价格未知，明确写「价格未知，不构成免费或封顶」，`mode:"unknown_allowed"`。
4. 授权与期限：`--expires` 只给几天、`--max-tasks 1`、`--window-seconds 86400`、`--max-attempts 1`、`--max-timeout 1800`；
   `--source user:<真人>`。
5. 观察方法：先 `status` 看六层与 `probeKind`；`evaluate` 看 `probe.coverage` 与阻塞；只有目录 `observed` 且额度新鲜才可能 `delegate`。
6. 停用/撤回/恢复：`disable --source user:<真人>` → `policy-revoke` → 页面确认 `revoked` 与 `decision_revoked` 审计 →
   不再产生新派工；若已有 `executing`，只用 `decisions/<id>/operation` 观察，不重试、不换执行器。
7. 规则约束（如实）：按当前 `AGENTS.md`，**每个新的真实协作任务仍需用户当次确认执行器/来源/精确模型/推理档/费用**。
   因此本方案只能作为「受控政策执行 + 每任务确认」下的样本，不能声明政策替用户选模。

## 8. 复验命令与实际计数

工作目录 `gateway/`：

| 命令 | 结果 |
| --- | --- |
| `npx tsx --test test/automation-policy.test.ts test/automation-dispatch.test.ts test/automation-cli.test.ts test/automation-http.test.ts test/automation-cli-dispatch.test.ts test/automation-probe.test.ts test/automation-composition.test.ts` | tests 56 / pass 56 / fail 0（duration ≈33.4s） |
| `npx tsc --noEmit -p tsconfig.json` | exit 0，无输出 |
| `node --test workbench/test/automation-view.test.mjs` | tests 15 / pass 15 / fail 0 |

分套计数：policy 22、dispatch 10、cli 2、http 8、cli-dispatch 2、probe 7、composition 5。
未跑 1301 全量（I 线负责）。日志见 `E:\javaproject\outputs\forward-delivery-20261107\D\`。

一次真实失败记录（不删除）：首轮证据运行时出现 `1 fail`（56 中），失败用例是
`the original operation is readable, and a decision without one says so`，错误 `read ECONNRESET`。
原因是测试助手 `request()` 复用了 Node ≥19 默认 keep-alive 连接池里的 socket，而服务端已关闭空闲连接；
加载较重时（该次全组耗时 52.8s）才暴露。修复：每次请求用独立连接（`agent: false` + `Connection: close`），
随后该套件连跑两次均 8/8，全组重跑 56/56（39.99s）。这是测试侧的偶发缺陷，不是产品行为改变。

## 9. 当前规则下实际支持的操作方式

只支持本机命令行（`node scripts/automation.mjs ...`，或 `npx tsx src/automation-cli.ts ...`）：

```
status                      # 六层 + probeKind（真实只读观测）
policy-create --workspace ... --model ... --scope "docs/**" --expires ... --source user:NAME
policy-revise --policy-id ... --expected-revision ...     # 到期不可延长
policy-revoke --policy-id ... --expected-revision ... --reason ... --source user:NAME
evaluate|decide --contract FILE --policy-id ...           # 记录决定，不派工
execute DECISION_ID --operation-id UUID --enable-dispatch # 唯一派工入口，需 enabled
enable|disable --source user:NAME                         # 安装级开关
decisions|audit|recover|policy-show|policy-list
```

页面与 HTTP 只读；MCP 不出现 automation 工具（既有测试断言）。

## 10. 未做项与不成立项（不得读成已完成）

1. **未做真机自动 arming**：没有在真实安装上 `enable` + `--enable-dispatch` 派过任何真实任务；仓库默认仍是 `armed:false`。
2. `server.ts` / workbench 导航 / 共享 schema 的正式接线属 I 独占，本线只提交了集成请求
   （`docs/forward/INTEGRATION_REQUEST_D.md`）：工作台进程内的 `AutomationService` 目前仍由 I 侧构造，未自动带上真实 probe。
3. `desktopModelCatalog` 需要真实宿主（WorkBuddy/DSH）在线才能给出非空目录；否则 `catalog:unavailable` 并阻塞——这是设计，不是缺陷，但也意味着「本机能观测到什么」取决于宿主是否在跑。
4. `models[].hardCap` 恒 `unsupported`、`coverage.taskAttribution` 恒 `unavailable`：本机没有能证明硬封顶与逐任务归因的证据源。
5. `credit_balance` 只有 region 池粒度，永不下放到单模型；`free_only` 政策在当前证据下基本只会被阻塞。
6. `automation_*` 四张表仍是模块自建，未纳入统一迁移（归属待 I 裁定，已在集成请求里列出）。
7. 没有跑全量 1301；没有推送、没有合并 main、没有安装、没有改 MCP/常驻服务、没有释放任何历史未知占用。
