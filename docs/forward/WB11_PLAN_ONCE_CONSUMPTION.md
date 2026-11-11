# WB11 方案预览、返回修改与一次消费

本轮范围：核对既有实现、把规则写成可核对的契约、补测试缺口。新增代码只在 WB03 的派工前校验处（预览阶段就给出结构化错误），方案状态机本身沿用 HEAD 0919201 的实现。

## 1. 方案身份与状态

一份方案（`CollaborationPlan`，`gateway/src/collaboration.ts:25-30`）由四个身份字段共同确定：

| 字段 | 含义 | 变化条件 |
| --- | --- | --- |
| `planId` | 逻辑身份，返回修改后仍是同一份方案 | 只有新建方案才变 |
| `revision` | 不可变修订号 | 条款变化即新 revision（旧行保留） |
| `termsHash` | `collaborationTermsHash(contract)` 的摘要 | 目标/范围/检查项/模型/预算任一变化 |
| `consumedBy` | 消费它的 taskId | 一次派工后写死，不再变 |

状态图：

```
            ┌──────────── 返回修改（同 planId，新 revision，authorizedAt=null） ────────────┐
            ▼                                                                              │
draft ──preview──> proposed ──authorize(用户在本机确认)──> authorized ──send──> consumed    │
            │           │                                     │                            │
            │           │                                     ├── 超过 TTL ──> expired      │
            │           │                                     ├── 条款变化 ──> PLAN_STALE   │
            │           └── 未确认直接派工 ──> PLAN_CONFIRMATION_REQUIRED                    │
            └── 重复确认同一 revision ──> PLAN_ALREADY_CONSUMED（不是「再试一次」）──────────┘
```

规则细节（都可核对）：

- TTL 取 `options.ttl` 秒，必须整数且 `1 ≤ ttl ≤ 86400`，否则 `INVALID_PLAN_TTL`（`collaboration.ts:148`）。
- 只有 `manual` / `recommend` / `automatic` 三种模式，其他值 `PLAN_CONFIRMATION_REQUIRED`（`:137`）。
- `automatic` 必须带 `policyId/policyRevision/policyVersion/decisionId` 绑定；非 `automatic` 不得携带策略绑定（`:141-144`）。
- 读回时会重新算 `termsHash` 并比对 revision，任一不符即 `PLAN_STALE`（`:159-163`）。
- 消费发生在准入事务内，任务创建失败会回滚：`admission and plan consumption roll back when task creation fails` 断言 `consumedBy` 回到 `null`。

## 2. 一次消费的证据

| 完成标准 | 证明测试 | 结果 |
| --- | --- | --- |
| 同方案两个 taskId 只有一次派工 | `t3-admission.test.ts` 「the same authorized plan cannot be consumed by another task identity」 | pass |
| 过期/旧 revision 拒绝 | 同上「unconfirmed and stale plans cannot create a task」（`PLAN_CONFIRMATION_REQUIRED` + `PLAN_STALE`） | pass |
| 参数漂移拒绝 | 同上「changed terms or legacy model/check overrides do not reuse plan authorization」（改标题即 `PLAN_STALE`） | pass |
| 点击两次不生成两轮 | 同上「concurrent identical submissions create one task and prepare one native session」（`f.observations()===1`，revision 不变） | pass |
| 预览零原生请求 | 同上「unconfirmed and stale plans cannot create a task」；桌面侧 `workbench/test/confirm-failure.test.mjs`「a cancelled native confirmation sends nothing and keeps the agreement usable」 | pass |
| 换模型/档位不复用旧确认 | 同上「policy changes after plan authorization invalidate dispatch without native work」「actual selection mismatch and paid/unknown catalog rates cannot reserve an attempt」 | pass |
| 回执可查、不猜结果 | `workbench/test/receipt.test.mjs`「a pending receipt is reported as a request that was sent, never as work in progress」「unknown and settled receipts never claim the original effect ended」「an unrecognized receipt state falls back to a query hint instead of a status guess」 | pass |

本轮复跑（工作树 `feat/executor-plan-20261111`）：

```
node --test workbench/test/confirm-failure.test.mjs workbench/test/receipt.test.mjs workbench/test/dispatch-project.test.mjs
→ tests 14 / pass 14 / fail 0 / 1392ms
```

`t3-admission.test.ts` 的 53 例在 `E:\javaproject\outputs\executor-plan-20261111\wb09-admission.log` 里整组通过。

## 3. 桌面确认闭环的三种结局

`workbench/dispatch.mjs` 的 `confirmFailure(error, identity)` 把一次确认严格分成三类，页面不许把它们混成一句话：

| 结局 | 触发 | 页面文案取向 | 能否重试 |
| --- | --- | --- | --- |
| 已在本机取消 | `CONFIRMATION_CANCELLED` | 信息（不是错误） | 能，同一 planId/revision |
| 确定没派出去 | `DISPATCH_NOT_ENABLED` / `MODEL_UNVERIFIED` / `MODEL_POLICY_BLOCKED` / `MODEL_SELECTION_*` 等白名单 | 「尚未派工：<原因>」，身份不变 | 能，改完再确认 |
| 不确定是否已开始 | 断连、超时、未识别错误 | 「无法确认本次派工是否已经开始」+ 操作编号 + 查询入口 | 不能二次确认，只能查原 operation |

`PLAN_ALREADY_CONSUMED` 单独处理：它是「已经用掉了」，不是「拒绝」，所以既不显示成失败，也不给重试按钮。

## 4. 回执恢复入口

- 回执键 `workbuddy.desktop.lastRequest`，写在页面侧；刷新后据此查询原派工请求。
- `receiptStatusText(state)` 的词表把「请求已登记 / 请求已发出，等待回执 / 已受理 / 失败 / 结果不明」分开，`receiptStillPending(state)` 只对 `launch_requested` / `dispatching` 为真——「发出去了」不等于「在跑」。
- 未识别状态回落到「请查询原派工请求」，不做状态猜测。

## 5. 预览阶段就能看到 CommandSpec 错误（本轮新增）

WB03 的预检发生在原生准备与容量副作用之前，因此方案预览/返回修改阶段提交的非法检查项会立刻得到带位置、原因与示例的拒绝：

```
acceptanceCommands[0]: a free-text or shell command line is never executed; … [COMMAND_SPEC_REQUIRED] Expected e.g. {"executable":"C:/Program Files/nodejs/node.exe",…}
```

页面只需展示 `message`，不需要自己解析；`failureCause` 直接是错误码，可用来区分「该改输入」与「该换选择」。

## 6. 未覆盖

- 真实窗口里的双击、断连与手速竞争：属 WB35（需要真实桌面进程）；本轮的替身测试覆盖了逻辑分支，不替代实窗。
- 断连瞬间的原生侧真实排队状态：依赖上游事件，属 WB04 的最小桥接契约（`turn_end`），当前 `blocked_external`。
