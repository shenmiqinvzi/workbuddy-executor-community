# ADR-01 自动模式的两层决策

- 状态：已决定（本轮只落地方案与守卫，不启用新授权层）
- 影响任务：WB02、WB26–WB29、WB41
- 关联文档：`AGENTS.md`（协作前置选择）、`docs/forward/ACCEPTANCE_MATRIX.md`（F19 automatic 行）、`gateway/src/automation.ts`

## 1. 背景：两处规格在这里撞车

原产品设计（`docs/FRONTEND_TASK_PANEL_DESIGN.md` §13 / `docs/ACCEPTANCE.md`）要求保留自动模式：策略授权后，任务可以在没有逐条人工点击的情况下被派工。仓库根 `AGENTS.md` 同时要求：**每个新的真实协作任务都要先展示可选的执行器/来源/模型/推理档位与已知价格，取得用户的实际选择确认之后，才允许准备模型或派工**。

两条要求放在一起只有一种自洽读法：

- 自动模式**不替未来的任务选模型**，它只在「已经由用户确认过的那一套选择 + 已经写下来的范围」之内，把重复的人工点击省掉；
- 「省掉点击」和「省掉选择」是两件事，前者可以自动化，后者不行。

`gateway/src/automation.ts` 的现状正好是这句话的代码版：`describe().limits` 里写着「A saved policy does not choose a model for a future task」，`layers().taskSelection.mode` 写着 `per_task_confirmed`。

## 2. 决定：两层，只有一层生效

| 层 | 名称 | 现状 | 谁能产生 | 作用 |
| --- | --- | --- | --- | --- |
| 第一层 | `per_task_confirmed` | **唯一生效模式** | 每次任务由用户当面选择 | 执行器 + 连接 + 供应商 + 模型 + 推理档位逐项确认后才准入 |
| 第二层 | `preauthorized_policy` | **提案，未启用** | 需要用户明确调整规则 | 在同一套已确认选择与已写范围之内，跳过重复点击 |

第二层要生效，必须同时满足三个条件，缺一不可：

1. 用户显式修改规则（不是推荐、不是默认值、不是某次对话里的语气）；
2. 写入一条可审计的授权记录（见 §3），且来源 ∈ `user:` / `local-operator:` / `desktop:`；
3. 策略仍然只做**收窄**：`automation.ts:31` 的注释「A policy only narrows dispatch. It never grants commit/push/deploy/native-approval rights.」不因第二层而放宽。

在三个条件同时成立之前，第二层的一切表述都只是设计文本。本轮交付里它只出现在这份文档中，`gateway/src/**` 里没有任何实现、开关或默认值（`gateway/test/automation-modes.test.ts` 有一条断言把这个事实钉住）。

### 2.1 六个层各自为证（现状实现，不是新设计）

`AutomationService.layers()` 把「装好了 / 武装了 / 有授权 / 选了模型 / 记了决策 / 真的派出去了」拆成六个独立事实，避免其中任何一个被读成另一个：

| 层 | 事实来源 | 读成什么 |
| --- | --- | --- |
| `installation_enabled` | `automation_meta.enabled`（本地 CLI 写） | 这个安装允许自动模式 |
| `process_armed` | 本进程构造参数 `armed`（**从不持久化**） | 这个进程愿意执行自动决策 |
| `policy_authorization` | 已保存的策略 + 可信来源 | 有一条收窄范围的授权 |
| `per_task_selection` | `mode: "per_task_confirmed"` | 选择仍由用户给 |
| `recorded_decision` | `automation_decisions` 按状态计数 | 有过一次决策记录 |
| `actual_dispatch` | `TaskApplicationService.send` 的守卫 + 单槽容量 | 真的形成了派工 |

## 3. 授权记录 schema（草案，未接线）

第二层启用时应该存下来的最小记录。字段名沿用现有 `AutomationPolicy` 的命名，避免出现第二套词汇：

```json
{
  "schemaVersion": 1,
  "authorizationId": "authz-<uuid>",
  "mode": "preauthorized_policy",
  "authorizationSource": "user:<name> | local-operator:<name> | desktop:<name>",
  "authorizedAt": "2026-11-11T00:00:00.000Z",
  "workspaceId": "project",
  "executor": {
    "executorId": "workbuddy",
    "connectionId": "<connection>",
    "providerId": "<provider>",
    "modelId": "<model chosen by the user>",
    "reasoningEffort": null
  },
  "scope": { "allowedChanges": ["src/**"], "permittedMetadata": [] },
  "limits": {
    "maxTasksPerWindow": 1,
    "windowSeconds": 3600,
    "maxTimeoutSeconds": 1800,
    "maxAttempts": 3,
    "cost": { "mode": "free_only", "unit": "credit", "ceiling": null, "requiresHardCap": false }
  },
  "expiresAt": "2026-11-12T00:00:00.000Z",
  "revocation": { "revokedAt": null, "reason": null, "revokedBy": null },
  "statement": "The user chose this executor/model/effort for this workspace and allowed repeated dispatch inside these limits."
}
```

规则：

- `authorizationSource` 只接受三个前缀；`agent:` / `http:` / `model:` / `automation:` / 空串在保存时就被拒（错误码 `PLAN_CONFIRMATION_REQUIRED`，`automation.ts:729`）。
- `executor.modelId` 必须非空：没有模型就不能叫「已确认的选择」。
- `cost.mode: "free_only"` 只在探测到 x0.00 时成立；未知价格只能走 `unknown_allowed`，且不得被写成 `0` 或「免费」。
- 撤回是一条新记录（`revokedAt` + `reason`），不是删除；被撤回的授权不再能支撑新决策。
- 授权记录、策略、决策三者互不覆盖：策略 revision 变化不自动续授权。

## 4. 影响表

| 面 | 第一层（现生效） | 第二层（若启用） |
| --- | --- | --- |
| 派工入口 | 每个任务 `workbuddy_send_task` 带完整 `execution` | 仍走同一 `TaskApplicationService.send` 守卫，只是决策由策略触发 |
| 选择 | 每次当面选 | 复用授权记录里的选择；换模型必须新授权 |
| 容量 | 单槽共享，占满即阻塞 | 不变 |
| 停止 | 原生停止证据，不放宽 | 不变 |
| 面板 | 显示模式与下一步动作 | 需多显示「授权来自哪条记录、何时到期、如何撤回」 |
| 审计 | 每条决策一行 | 增加「决策 ↔ 授权记录」外键 |
| 资源/统计/推荐 | 可用 | 可用，但推荐不等于授权（`AGENTS.md`） |

## 5. 发行范围声明

发布说明里必须同时写清两件事，否则就变成缩范围或夸大：

1. 产品保留资源查看、用量统计、模型推荐、自动模式四块能力，不因为第二层未启用就降级成「手动预览版」；
2. 自动模式当前生效的是 `per_task_confirmed`：省点击但**不省选择**；`preauthorized_policy` 是已设计、未启用的一层，启用需要用户明确改规则。

`docs/forward/ACCEPTANCE_MATRIX.md` 的 F19 行与本文件口径一致：模式列 `automatic`，结果列只认当前进程与当前候选的证据。

## 6. 两模式失败用例设计（替身可测的部分已落测）

| 场景 | 期望 | 现状 |
| --- | --- | --- |
| 安装已启用、本进程未武装 | 拒绝，`AUTOMATION_NOT_ARMED`，不产生 plan/task | 已落测 |
| 来源是 `agent:` / `model:` / `http:` / 空 | `PLAN_CONFIRMATION_REQUIRED`，无策略、无审计 | 已落测 |
| 有策略但工作区不匹配 | 拒绝（`POLICY_MISSING`/`POLICY_AMBIGUOUS`），不派工 | 已落测（`automation-selection-gate`） |
| 策略的模型与用户当次选择不同 | 拒绝，不静默替换 | 已落测 |
| 策略过期 / 被撤回 | 拒绝，且不因超时放行 | 已落测 |
| 想用 `preauthorized_policy` 免掉逐任务选择 | 当前**无入口**：`src/**` 里不存在该模式 | 已落测（源码零出现断言） |
| 价格未知却按免费执行 | 拒绝（`free_only` 需要证明 x0.00） | 已落测 |

## 7. 要启用第二层，需要用户做的决定

用一句话回答即可，且需要能落到 §3 的记录里：

1. 授权范围：哪个工作区、哪一套执行器/连接/供应商/模型/推理档位；
2. 额度：每窗口最多几个任务、单任务超时与尝试次数上限、费用口径（`free_only` / `known_cost` 上限 / `unknown_allowed`）；
3. 期限与撤回方式：到期时间，以及谁来撤回。

在这三条被明确回答之前，本仓库继续以 `per_task_confirmed` 运行，`preauthorized_policy` 保持「已设计、未启用」。

## 8. 非目标

- 不引入「跑久了自动放行」：超时、报告、假 idle 都不构成停止或授权证据（D-6）。
- 不把推荐当授权：面板可以推荐模型，派工仍要用户选。
- 不因为第二层未启用而删除策略、决策、审计三张表或它们的测试。
