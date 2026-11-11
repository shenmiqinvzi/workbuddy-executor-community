# WB26–WB31 自动政策、通知与导出：源码级验收

日期：2026-11-11。工作树 `E:/javaproject/workbuddy-forward-20261107/R-executor-plan-20261111`。

## 状态

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| WB26 可信自动政策授权入口 | `blocked_external` | 第二层 `preauthorized_policy` 的启用需用户明确规则调整（ADR-01 §7 三条问题未答）；现役 `per_task_confirmed` 已由 `automation-modes.test.ts` 4 例守住 |
| WB27 决定→派工原子闭环 | 源码完成 | 69 例通过，含撤回竞态、重启、重复决定、窗口额度、硬限不支持 |
| WB28 自动模式界面与审计 | 源码完成 | HTTP 只读 + 15 例视图测试；写路由一律 405 |
| WB29 真实自动执行与撤回 | `blocked_external` | 需真实政策授权、精确模型与费用条件 |
| WB30 通知接到真实事件 | 源码完成 | 通知中心 + 持久化 + 注意力聚合 |
| WB31 诊断与交付导出 | 源码完成 | 白名单导出、预览/保存一致、秘密种子检测 |

## WB27 事务边界与不变量

入口复用同一条受保护链路，不新开执行通道：

```
decide(policy, snapshot) → decision(revision, TTL, scope, cost, window, capacity 全部重验)
        → automation dispatch intent（持久化 decision ↔ plan ↔ operation）
        → TaskApplicationService.send（同一 guarded service 与同一容量槽）
        → 原生派工（最多一次）
```

已被测试钉住的事实：

- **一次决定最多一个副作用**：「one decision yields at most one effect, even when it is retried」；重试只读原 operation。
- **两进程争用**：「two processes racing one decision produce a single dispatch」。
- **撤回竞态**：撤回发生在准入提交之前 → 零派工（`automation-composition`「revoking the policy retires its pending decisions without dispatching」、`automation-cli-dispatch`「a revoked policy blocks the next decision before any dispatch」）；撤回发生在派工意图之后 → 记审计但不伪造取消（`automation-dispatch`「revocation after the dispatch intent is audited without cancelling the effect」）。
- **崩溃/重启**：「a restart turns an unowned dispatch intent into an unknown outcome, never a retry」；「a live dispatch is never reclaimed by the restart receipt」；「an unknown effect keeps the original task and refuses a replacement」。
- **窗口与容量**：「the window budget survives a restart and a new operation key does not buy another task」；「capacity stays one, so a second automatic task waits」。
- **硬限**：「P1 known_cost refuses an estimate explicitly instead of only excluding unavailable」——不支持硬上限的来源被明确拒绝，不用余额代替限制。
- **未武装/未启用/未接线**：「the dispatcher refuses while it is unarmed, disabled or unwired」。

## WB28 只读界面与审计

`automation-http.test.ts`（8 例）与 `workbench/test/automation-view.test.mjs`（15 例）共同固定：

- 投影只读：`every automation route refuses a write with 405, not 404`；`without the option the automation routes do not exist`。
- 未知标识不编造：`unknown policy and decision identifiers are not fabricated`。
- 已记录决定与审计可见且不触发派工：`recorded decisions and their audit trail are visible without dispatching`。
- 原 operation 可读，无 operation 的决定如实说明。
- 撤回以状态呈现而非错误：`revoking a policy is visible as a status, not an error`。
- 页面只拿到六层事实、观察时间与请求身份，没有额外字段。

停止接纳新任务的正确操作是撤回政策（终态）；在途任务不因撤回被标记为已停止——与 WB04/WB09 的停止围栏一致。

## WB30 / WB31

**WB30**：通知按 task/attempt/event episode 去重，静默与频率可配置；点击定位原数据根原任务，跨库编号冲突明确拒绝；通知失败可见但不影响任务生命周期；不发送邮件或外部即时消息。证据：`notification-center.test.ts`、`notification-persistent.test.ts`、`workbench/test/attention.test.mjs`。

**WB31**：导出按白名单输出（约定摘要、运行身份、审查与统计引用、缺项、覆盖层级），不打包凭据/账号/原生历史；预览摘要与保存字节一致；支持大小上限、取消、路径拒绝与失败说明；Unicode/URL/JWT/PEM/嵌套文本秘密检测；保存失败不改任务成功状态。证据：`delivery-export.test.ts`、`delivery-export-e2e.test.ts`。

## 运行证据

```
node --import tsx --test <automation 9 文件>            tests 69 / pass 69 / fail 0 / 55826ms
node --test workbench/test/automation-view.test.mjs     tests 15 / pass 15 / fail 0 / 375ms
node --import tsx --test <模板/通知/导出 12 文件>        tests 92 / pass 92 / fail 0 / 4250ms
```
日志：`wb27-wb28.log`、`wb25-wb31.log`。

## 未覆盖

- WB26/WB29 需真实政策授权与真实模型/费用条件；未获批准前自动模式保持 `per_task_confirmed`，`src/**` 中不存在 `preauthorized_policy` 实现。
