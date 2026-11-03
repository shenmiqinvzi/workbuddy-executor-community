# P0-5 真实验证记录：隔离账本 run5（2026-11-02）

本文件记录一次**真实**的端到端派工验证，与源码层测试分开。它只记录发生了什么、
哪些步骤有证据、哪些没有。结论句由 `gateway/src/verification-plan.ts` 的
`allowedClaims()` 机械推导，不写「通过」。

> 本文件经独立审查后修订过两次事实错误（见 §7）。修订后的数字以
> `_wb-p05-state/evidence-run5.json` 为准。

## 1. 现场

| 项 | 值 |
| --- | --- |
| 账本 | `<workroot>\_wb-p05-state\run5\workbuddy.db`（独立目录，与源仓库不共享文件） |
| 运行目录 | `<workroot>\_wb-p05-state\run5\runs` |
| 派工状态 | `<workroot>\_wb-p05-state\run5\dispatch` |
| 工作区 | `<workroot>\_wb-p05-scratch\run-05`（空目录起步） |
| 原生 | WorkBuddy 5.9.4，CDP 18491，会话档位 `deepseek-v4.1-flash-sg`（客户端观察费率 x0.03，非账单） |
| 执行者 | 我（DSH 会话） |
| 授权人 | YG（2026-11-02，1 次、10 分钟） |
| 独立审查者 | Codex CLI 0.166（不同模型，只读沙箱），结论见 `_wb-p05-state/review-verdict.md` |

任务身份（全部来自账本，不手写）：

- task `desktop-9486b19f-0ba3-4d03-95cc-7ab90108ab61`
- 主操作 `desktop-send-647901b2-f26b-4f92-bc7d-c17a27a64758` → `succeeded`，`dispatchEnteredAt 07:34:01.271Z`
- attempt `run-057c815f-9467-4d12-8670-40de616051aa`
- session `d78d2c19-ba07-4d59-a10c-7be97be39910`
- 预留键 `preparationBinding.workerKey = desktop-9486b19f-…ab61`（等于 taskId）

## 2. 实际发生的链路（时间均为 UTC）

1. 隔离预检：派工开关开启、目录独立；起始那一刻的容量快照没有留存成独立文件
   （`evidence-run5.json` 里的 preflight 是**事后**快照，`ready=false`，因为容量此刻被本任务占着）。
2. 壳内核对约定 → 人在原生确认窗口勾选同意 → 派工（来源 `desktop-native-confirmation`）。
3. 原生建会话成功；桌面历史库登记该 session。
4. 派工请求 `outcome_unknown → submitted`，租约与心跳正常。
5. 模型领取任务（`claim.json claimedAt 07:34:15.873Z`），随后**实际写文件**：
   `run-05\hello.txt`，6 字节，内容 `hello`，文件 `mtime 07:34:24Z`。
6. 模型尝试用网关受管执行器自查：`commands\f83eb50a-….json`，`exitCode=125`，
   `cleanupConfirmed=false`（PowerShell 执行策略拒绝 `gateway/scripts/bounded-job.ps1`，
   `UnauthorizedAccess`）。**因此没有产生独立验证记录**（`validationRecords: []`）。
7. 模型写回报：`worker-result.json status=completed`，报告认证
   `authenticatedAt 07:34:58.087Z`，`state.json status=needs_review`（07:34:58.093Z 事件）。
8. 之后无人推进；07:49:31 队列截止检查把状态改写为 `blocked` 并写 `cancel.json(reason=deadline)`。

## 3. 八步证据（由 `verificationSummary()` 计算）

| 步骤 | 状态 | 缺什么 |
| --- | --- | --- |
| 预检 | recorded | —（但只是事后快照，见 §2.1） |
| 预留身份 | recorded | — |
| 原生创建 | missing | `elapsed_ms`（createWorker 未单独计时） |
| 桌面历史登记 | recorded | — |
| 派工 | recorded | — |
| 收到报告 | recorded | — |
| 原生停止 | **missing** | `stop_evidence`（`stopControl.state=stop_unconfirmed`） |
| 独立审查 | recorded | —（审查者 Codex，只读，非执行者） |

机械推导出的允许句式（原文来自 `allowedClaims()`）：

- 本次验证在独立状态目录中开始，旧账本未被打开写入。
- 网关记录到一次派工请求及其回执。
- **已收到报告，但原生停止尚未确认。**
- 存在一份由非执行者给出的审查结论。

其中第一句的算法口径偏宽：它只检查「预检四类证据齐全」，并不证明「旧账本绝未被写入」
（见 §7-A）。这句话在用的时候要带上这个限制。

## 4. 这一轮暴露的真实缺陷

### D-1 截止检查把「已认证报告」改写为「没有可靠结果」——成立

`gateway/src/desktop-queue.ts:661-680`：`checkDeadline()` 对
`status==="needs_review"` 且缺原生停止证据的尝试，只要过了 `deadline` 就调用
`expire()`；`expire()` 把状态写成 `blocked`、错误文案
`The desktop queue task deadline passed without a verified result`，并写
`cancel.json(reason:"deadline")`。

本轮即如此：报告 07:34:58 已认证、文件 07:34:24 已生成，07:49:31 仍被判成
「没有可靠结果」。报告与认证对象本身保留在磁盘上（`state.json.reportAuthentication`），
但**账本上的状态被改成了失败**。`:389` 的分支只在状态已经是 `blocked` 时才保留迟到报告，
救不了 `needs_review`。

性质：这正好落在项目铁律「不得从本地异常、空闲或超时推导终态」的边界上。

### D-2 证据摘要包含随观测变化的字段，读取路径长期 `evidence_stale`——成立

`gateway/src/run-evidence.ts:40-42` 把整个 `stopControl` 对象（含每次观测都刷新的
`checkedAt`）算进摘要；`gateway/src/task-view-reader.ts:476-479` 要求
`当前文件重算摘要 === 账本里持久化的摘要`。

只要队列进程还在观测（每轮刷新 `stopControl.checkedAt`），面板就读到
`evidence_stale`。实测：显式 `sync()` 之后立刻读面板 `ok=true`；十几秒后再读又变回 stale
（这一条属于我的现场观察，材料里没有留时间序列，独立审查判定为「核对不了」）。

### D-3 服务状态文件按项目目录共享，会被别的账本的服务覆写——部分成立

`gateway/src/service-cli.ts:290,299`：状态文件路径按 `projectDir` 计算，不区分账本。
同一个仓库目录下跑多个账本时，先起的服务会持续用**自己的**账本信息覆写状态，
另一个账本的面板/预检读到的是别人的状态。

实测中我先看到状态一直显示 `run-04 / no_task`，清理旧服务后才恢复（这段清理过程没有
留时间序列，独立审查判定为「核对不了」）。

### D-4 原生停止卡在「受管命令清理未确认」——成立，但理由要改

原始说法「没有受管命令所以永远无法确认」是错的：`desktop-queue.ts:460,498` 在没有任何
受管命令时循环会跳过，缺省仍可据 `idle` 确认停止。

真实机制是：本轮**有一条**受管命令 `f83eb50a-…`，它因为 PowerShell 执行策略挡住了
`bounded-job.ps1` 而 `exitCode=125`、`cleanupConfirmed=false`；`desktop-queue.ts:463`
要求每条自有命令 `endedAt` 与 `cleanupConfirmed===true` 才放行，于是即使原生侧
`nativeHealth=idle`、`stopReason=end_turn`，`stopControl.state` 仍是 `stop_unconfirmed`。

即：**受管执行器在本机不可用，会连带把「原生已结束」也判成未确认。**

## 5. 边界（不主张的事）

- 本轮**不构成** P0-3 或 P0-5 的验收通过：原生停止未确认。
- 本轮**不主张**产物已被独立验收：`hello.txt` 内容由模型自查输出支撑，网关的独立验证
  记录为空（`validationRecords: []`）。
- 本轮**不主张**任何性能/成本结论；`x0.03` 是客户端观察值。
- 本轮**不追溯**修改历史任务；前三轮（run1–run4）账本原样保留。

## 6. 下一步

1. 修 D-1（截止不得覆盖已认证报告）与 D-2（摘要只绑定不可变事实），各补替身测试。
2. D-4 需要一条不以受管命令为前提的停止证据路径，属 P0-3 协议问题，另立项。
3. 若要拿到「产物被独立验收」的证据，需要一个不依赖 PowerShell 受限脚本的验证通道。

## 7. 独立审查结论（Codex CLI 0.166，只读）

原文：`<workroot>\_wb-p05-state\review-verdict.md`（3040 字节）。要点：

- **A 核对结果**：task/attempt/session/operation 与全部时间戳（07:34:01.271Z 派工、
  07:34:15.873Z 领取、07:34:58.087Z 认证、07:49:31.327Z 截止）均可对上；
  指出我三处不实——① 声称「壳内派工不产生 workerKey」（实际存在，等于 taskId）；
  ② 声称文件生成于 07:34:37（实际 07:34:24）；③ 声称起始预检 `ready=true`（材料里只有事后快照）。
- **B 结论边界**：第一句只能支持「独立路径」，不支持「旧账本绝未被写入」；
  原文「真正完成」「永远像失败」属越界表述，已删除。
- **C 缺陷判定**：D-1 成立、D-2 成立、D-3 部分成立、D-4 不成立（理由见 §4-D-4，已按实际机制改写）。
- **D 不能支撑**：旧账本绝未写入；产物已独立验收；超时证明原生终止；无命令必然无法确认停止。
- **E 一句话**：目前只能作过程记录，不能证明 P0-5 验收通过；最缺原生停止证据与产物的独立验收证据。

据此修订的动作：补 `workerKey` 与 `hello.txt` 的 `mtime`/`sha256` 进证据、改正文件时间、
把 preflight 标注为事后快照、重写 D-4、删除越界措辞、把独立审查登记为第 8 步证据。
修订后八步：6 步有证据、2 步缺失（原生创建耗时、原生停止）。

## 8. 修订记录

- 2026-11-02 初版。
- 2026-11-02 依独立审查修订：workerKey 误判为缺失、文件时间写错、preflight 时点含混、
  D-4 机制说错、两处越界措辞。修订后 `evidence-run5.json` 重新生成（6 recorded / 2 missing）。

## 9. D-2 修复与 D-1 的撤回（2026-11-02 17:05）

- **D-2 保留并已落地**：`gateway/src/run-evidence.ts` 的 `runEvidenceDigestOf()` 不再把整个
  `stopControl` 计入摘要，改为稳定投影 `{state, requestedAt, issuedAt, acknowledgedAt, error}`。
  `checkedAt` 是队列每轮观测刷新的轮询时间戳，绑定它会让读侧永远落后一拍（本轮实测：
  sync 后十几秒又变回 `evidence_stale`）。替身测试：`gateway/test/evidence-consistency.test.ts`
  的「evidence identity ignores poll timestamps but tracks stop transitions」。
- **D-1 撤回**。原改法是「已认证报告不被截止改写」：新增 `hasVerifiedReport()`，
  `checkDeadline()` 两处判定都加守卫。实现后在 `reliability-v2` 上撞到既有契约——
  「报告在原生仍忙时不能豁免绝对截止」（pump 要 `stop_confirmed`、账本要 `blocked`）。
  撤回的理由不是测试挡路，而是两件事本来就不同：
  - run5 被写成 `blocked` 的根因是 D-4：受管命令清理未确认 → 原生停止永远确认不了 →
    `needs_review` 被判成「没有停止证据」→ 过截止即改写。截止逻辑本身没有错。
  - D-4 修好之后，`needs_review` + 停止证据一旦成立，原有 `!hasNativeStopEvidence` 判定
    就不会再触发 `expire()`；D-1 想要的效果由根因修复自然获得。
  - 因此 `hasVerifiedReport()`、两处守卫、以及为它写的测试断言全部撤回，`expire()` 恢复
    原始语义（save blocked → cancel → append result）。撤回后 5 个相关测试文件 51/51 通过。
- 结论：D-1 的**现象**由 §10 从根上解决，待 run6 证明；D-1 的**改法**（修改截止语义）不采纳。
- 边界：撤回意味着「报告已收到、但原生停止仍未确认、且已过截止」依旧会被写成 `blocked`。
  这是既有契约（先证明停止，再谈结果），不是新缺陷。
## 10. D-4 修复：受管命令的证据链（2026-11-02 16:50）

问题分两层，之前混在一起，所以看起来像「原生停了却确认不了」：

1. **这台机器的执行策略挡住了有界执行器。** `CurrentUser = RemoteSigned`，
   `powershell -File scripts/bounded-job.ps1` 直接报
   `UnauthorizedAccess`（`running scripts is disabled on this system`）。于是每一次有界 `exec`
   都返回 125 / `cleanupConfirmed:false`——**模型根本没有执行过任何检查命令**。
   run5 的 `validationRecords: []` 由此而来，不是模型偷懒。
2. **从未存在过的进程树被当成「可能还在跑」。** `desktop-queue` 的停止判定把
   「没有清理证据」一律当成「受管命令可能仍在运行」，哪怕 supervisor 连目标进程都没创建过，
   原生 `idle` 也只能停在 `stop_unconfirmed`。

修法（三处，各修一层）：

- `gateway/src/bounded-command.ts`：调用随仓库分发的自家 helper 时加
  `-ExecutionPolicy Bypass`。只作用于这个子进程，不改机器策略。
- `gateway/scripts/bounded-job.ps1`：新增 `-StartedFile`；在 `CreateProcess` 成功之后立刻落
  `<id>.started.json`（含 pid）。这是「这条命令真的创建过进程」的唯一硬证据。
- `gateway/src/bounded-command.ts` 记录 `processStarted` 与 `startedMarker`；
  `gateway/src/desktop-queue.ts` 新增 `ownedCommandStopReason()`，停止判定与报表对账都改用它：
  `cleanupConfirmed===true` 放行；`processStarted===false`（从未创建目标进程，无进程可清）也放行；
  其余仍然拦截。没有 `processStarted` 字段的旧记录保持原严格语义。

验证：本机 exec 一条 3 秒挂起命令 →
`exitCode 124 / reason timeout / cleanupConfirmed true / processStarted true`；
`bounded-command` + `command-cleanup` + `desktop-queue` + `evidence-consistency` 36/36；
`npm run build`、`npm run typecheck:task-view` exit 0。

替身覆盖：`bounded-command.test.ts` 断言正常执行留下启动标记、无法启动的程序
（`processStarted===false`）不产生标记；`desktop-queue.test.ts` 用纯函数覆盖
「未启动 → 不拦」「已启动但清理未确认 → 拦」「旧记录无字段 → 保持严格」。

边界：
- `-ExecutionPolicy Bypass` 只让**网关自己的 helper** 能运行，不改变系统策略，
  也不是给任意脚本放行。
- 这只修好「命令证据链」。§6 第 3 条（需要一个不依赖 PowerShell 受限脚本的验证通道）在
  执行器层面已不再被策略挡住，但**仍需要新一轮真实运行**才能拿到 `validationRecords` 非空。


