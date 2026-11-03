# T7D P0-3 原生准备可靠性：协议事实与观测日志

- 状态：**源码层已交付**；真实原生保证仍需在对应 WorkBuddy 版本上另验（见第 5 节）
- 对应计划：`docs/T7D_DEVELOPMENT_PLAN.md` 的 P0-3 行
- 不涉及：不追溯补造 2026-11-01 旧任务的回执（见 `docs/T7D_P0_1_ORIGINAL_TASK_DECISION.md`）

## 1. 结论（一句话）

原生端**没有**“请求终态”查询，也**没有**防迟到保证；因此本阶段只做两件事：

1. 把协议事实写成代码里的常量与类型（`gateway/src/preparation-protocol.ts`）；
2. 把每次失败时的**只读观测**追加成证据（`preparation_probes` 表），并明确“查不到 ≠ 未创建”。

**不从本地异常、空闲或超时推导终态**——这条现在是代码规则，不只是文档约定。

## 2. 协议与版本证据

| 项 | 事实 | 位置 |
|---|---|---|
| 创建渠道 | `session:create`（前置 `workspace:initialize`，后置 `session:rename`） | `gateway/src/native-desktop-trigger.ts`（渲染进程桥 `createWorker`） |
| 创建超时 | 45 s（外层 `evaluateConnected` 55 s） | 同上 |
| 幂等键 | **调用方生成的 session UUID**：同一个 UUID 重放不会新建第二条会话 | `gateway/src/workspace-workers.ts`（`reserve()` 用 `crypto.randomUUID()` 后先落库再调用原生） |
| 终态查询 | 只有 `session:get` / 桌面历史库的**存在性**，能回答“现在在不在”，不能回答“刚才那次执行没执行” | `gateway/src/desktop-runtime.ts`（`readDesktopSession`）、`native-desktop-trigger.ts`（`inspect`） |
| 迟到创建 | **未被排除**（`lateCreationExcluded: false`） | 同上；诊断中已观察过 Sidecar 启动超时后迟到 |
| 身份校验 | 创建返回必须与预留 sessionId 和 workspace 一致，否则拒绝重放 | `workspace-workers.ts` `ensure()` |

`NATIVE_PREPARATION_PROTOCOL` 把上表固化成 `revision: "native-preparation-1"` 的冻结对象，改动即需要新 revision。

## 3. 本次实现

### 3.1 纯函数分类器

`classifyPreparationProbe()` 只有四个出口，且**只能降级**：

| 观测 | kind | conclusion | reason |
|---|---|---|---|
| 探针本身失败/异常 | `unavailable` | `unconfirmed` | `probe_failed` |
| 没有可用探针 | `unavailable` | `unconfirmed` | `probe_not_supported` |
| 查不到（null） | `absent` | `not_observed` | `absence_is_not_proof` |
| 会话身份或工作区不符 | `identity_mismatch` | `unconfirmed` | `session_identity_mismatch` / `workspace_identity_mismatch` |
| 身份与工作区都相符 | `present` | `created` | `session_present` |

没有任何路径能产出“未创建（not_created）”这个结论——协议给不出它。

### 3.2 追加型观测日志

`gateway/src/preparation-journal.ts` 在 `workspace-workers.sqlite` 里建 `preparation_probes` 表：

- 只有 `record()`（INSERT），没有 UPDATE/DELETE；`probeId` 主键，重复写入被拒绝且不影响已有行；
- 迟到的“查到了”是**新增一行**，先前那行“没查到”原样保留；
- `forSession()` 按 `observedAt, probeId` 升序返回，`latest()` 取最新。

### 3.3 何时记录

`WorkspaceWorkers.ensure()` 只在**已经出现不确定**的两条路径上观测：

1. 原生调用抛错、返回错误身份、或返回后桌面历史未登记 → 先把 worker 标 `uncertain`，再记录一条探针；
2. 该工作区已有 `creating`/`uncertain` 的预留身份、再次调用被拒 → 记录一条探针再抛出。

探针来源：`NativeWorkerCreator.probe` 存在时用原生只读查询（`native_session_get`），否则读桌面历史库（`desktop_history`）。观测自身失败不会顶替原来的错误——原错误仍是主错误，探针记 `unconfirmed`。

### 3.4 只读查看

```powershell
# 在拥有该工作区 runs 目录的机器上（只读）
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});console.table(db.prepare('SELECT observedAt,source,kind,conclusion,reason,error FROM preparation_probes WHERE sessionId=? ORDER BY observedAt').all(process.argv[3]))" "<runs>/workspace-workers.sqlite" "<sessionId>"
```

## 4. 替身覆盖矩阵

`gateway/test/preparation-protocol.test.ts`（11 例，全部替身，不碰真实原生）：

| 验收要求 | 覆盖用例 |
|---|---|
| 发出前崩溃 | `without a native probe the desktop history read is used…`（原生调用直接抛错，预留身份落库、无第二条会话） |
| 发出后崩溃 / 回执不明 | `a crash after the native call leaves one uncertain worker and one probe row` |
| 观测不可用 | `an unreadable probe records unconfirmed evidence without replacing the original error` |
| 身份不匹配 | `a wrong identity from the native side is recorded and never auto-resolved`；`identity mismatch is unconfirmed even when something exists` |
| 迟到创建 | `a late creation appends a row and leaves the earlier absence untouched` |
| 进程重启 | `probe history survives a restart and a duplicate probe id is refused` |
| 并发 / 双进程 | `two gateway instances record concurrently under the same reserved identity` |
| 事务回滚 | 同上一条中重复 `probeId` 被拒、已有行不变 |
| 超时不当证据 | `a failed probe stays unconfirmed and never borrows the timeout as evidence` |
| 协议事实 | `protocol facts record the limitations instead of promising a terminal state` |

## 5. 仍未验证的真实原生保证（需另验）

以下四条**只能在真实 WorkBuddy 版本上验**，替身证明不了：

1. 同一个 session UUID 重复 `session:create` 确实只产生一条会话（幂等）；
2. 进程在 `session:create` 返回前被杀，原生端是否仍会迟到创建；
3. 迟到创建后桌面历史库的登记延迟上界（决定“查不到”的观察窗口有多长）；
4. 断线重连后 `session:get` 能否看到刚创建的会话。

另验方式（需要用户授权与真机，见 P0-5）：创建 → 记录时间 → 在渲染进程侧强杀 → 重开 → 连续观测 5 分钟 → 把 `preparation_probes` 全部行与原生会话列表比对。**未完成前，P0-3 的结论只到“观测已如实记录”。**

## 6. 与其它文档的关系

- 计划与验收：[T7D_DEVELOPMENT_PLAN.md](T7D_DEVELOPMENT_PLAN.md)
- 旧任务裁决（不受本文件影响）：[T7D_P0_1_ORIGINAL_TASK_DECISION.md](T7D_P0_1_ORIGINAL_TASK_DECISION.md)
- 不确定状态围栏与恢复证据：[T7D_P0_2_UNCERTAINTY_FENCE.md](T7D_P0_2_UNCERTAINTY_FENCE.md)、[T7D_PREPARATION_RECOVERY_EVIDENCE.md](T7D_PREPARATION_RECOVERY_EVIDENCE.md)

## 7. 边界

- 本文件不主张任何旧操作已经终结，也不主张新任务已经验收。
- 探针日志**不改变** `workers.state`：`uncertain` 只能由人工核对后另行处理，`abandoned` 类判断不在本阶段。
- 探针日志不进公共 HTTP（stage-2/panel-1 均未改），只在本地只读查看。
- `probe` 目前只有测试替身实现；真实 `NativeDesktopTrigger` 尚未提供该方法，因此生产路径走 `desktop_history`。
