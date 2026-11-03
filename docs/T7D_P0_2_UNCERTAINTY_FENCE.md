# T7D P0-2 不确定状态围栏：实现与证据

本文件记录 P0-2 已落地的改动、验证方式与仍未完成的部分。它不替代 `docs/ACCEPTANCE.md`，只回答“这一阶段到底改了什么、凭什么说它是对的”。

## 解决的问题

派工请求发出后，如果回执长期不回来，界面过去会一直显示“正在处理原派工请求”，并在轮询 45 次（约 90 秒）后**静默停止**。用户看到的是“仍在进行”，据此可能重复派工。按项目铁律，等待时间长、没有回执、没有轮次记录，都不构成“没有副作用”的证据。

同一处文案还让用户“使用原操作编号查看恢复证据”，但桌面私有通道此前没有任何查询恢复证据的动作——文案指了一条走不通的路。

## 改动

1. `gateway/workbench/dispatch.mjs`
   - `receiptStatusText(state)`：回执文案集中为纯函数。`dispatching` 由“正在处理原派工请求”改为“派工请求已发出，等待回执”——我们只知道请求发出去了。
   - `receiptStillPending(state)`：人工刷新耗尽后显式提示“已停止自动刷新，结果仍未知……不要重复派工”，替换原来的静默停止。
   - `operationStateLabel` / `recoveryConclusionText`：把后端状态与结论翻译成固定文案，未知输入一律回落到“证据不足”，不外推。
   - 结果不明分区新增“查看恢复证据”按钮（仅当回执带有操作编号）。
2. `gateway/scripts/workbench-read-store.mjs`
   - 新增 `store.operationEvidence(identity)`：只读证据查询。接受操作编号或派工请求编号，返回原操作状态、准备/派工阶段标记、attempt、错误、派工请求状态、执行容量是否仍由该操作占用，以及 `integrity`（body 与列是否一致）与派生结论 `conclusion`。
   - 全程只读：连接以 `readOnly: true` 打开，函数内没有任何写语句；未知编号返回 `unknown_identity`，不做猜测。
3. `gateway/scripts/workbench-desktop-commands.mjs` / `gateway/scripts/workbench-desktop-host.mjs`
   - 私有父子通道新增 `recovery_show`，参数严格为 `{ identity }`，长度 1–200。该通道不注册到 HTTP。
4. `gateway/desktop/DesktopControlPolicy.cs`
   - 白名单加入 `recovery_show`，并校验参数只含 `identity`、长度合规、无控制字符。`Program.cs` 的默认分支直接转发，无需新增分支。
5. 测试
   - `gateway/workbench/test/receipt.test.mjs`（3 例）：回执文案不把未知说成进行中。
   - `gateway/workbench/test/recovery.test.mjs`（6 例）：证据形状、按请求编号解析、未知编号、body/列不一致、真实 host 进程端到端查询、通道拒绝多余参数。
   - `gateway/desktop/test/Program.cs`（+4 例）：策略层拒绝缺参、多余字段、控制字符，并接受合法身份。

## 验证记录（2026-11-02，隔离副本 workbuddy-t7d-p02-20261102）

- `npm run test:workbench`：31 tests, 31 pass, 0 fail。
- `npm run desktop:test`：`{"passed":42,"failed":0}`。
- `node verify-snapshot.mjs`：`{"snapshotFilesVerified":528,"hashesMatch":true}`。
- 端到端用例在真实 `workbench-desktop-host.mjs` 子进程上完成一次 `recovery_show`，并在前后比对数据库文件哈希，确认只读。
- 原件目录 `workbuddy-t7d-desktop-controls-20261031` 的 HEAD 仍为 `34fcb1b`、未提交状态仍为 8 条，本轮未写入。

## D4：派工租约与心跳（2026-11-02）

### 解决的问题

派工请求被某个进程认领后，只把状态改成 `dispatching`，没有记录“谁在跑、还在不在跑”。如果该进程在认领之后崩溃，这一行会永久停在 `dispatching`，界面据此显示“派工请求已发出，等待回执”——而它可能早就死了。等待时间长同样不是“没有副作用”的证据，但也同样不是“还在进行”的证据。

### 改动

1. `gateway/src/dispatch-settlement.ts`（新增，纯函数）
   - `settleDispatch(lease, { now, alive, ttlMs })` 派生 `settlement`：`live` / `stuck` / `abandoned` / `lease_unavailable`。
   - 判定只用三类证据：租约列是否存在、所有者进程是否存活、心跳是否在 TTL 内（默认 180s，心跳间隔 15s）。
   - 所有者进程确认已退出 → `abandoned`；进程在但心跳过期 → `stuck`；心跳新鲜 → `live`；没有租约列（旧行） → `lease_unavailable`。pid 被复用不会让旧行“看起来健康”，因为复用者不会替它续心跳，过了 TTL 就降级为 `stuck`。
2. `gateway/src/desktop-dispatch-journal.ts`
   - 表新增四列 `owner_pid` / `owner_started_at` / `claimed_at` / `heartbeat_at`，用 `PRAGMA table_info` 检查后逐列 `ALTER TABLE ... ADD COLUMN`，旧库原地升级、行不重写。
   - `enqueue` 改为显式列名 INSERT（原来依赖列顺序，加列会错位）。
   - `claim(requestId, owner?)` 写入租约；新增 `heartbeat(requestId, owner)`，只有 `state='dispatching'` 且 `owner_pid`/`owner_started_at` 完全匹配才更新——迟到的、被取代的 worker 不能把行“续活”。
   - 新增只读 `lease(requestId)` 供读取与测试使用。
3. `gateway/src/desktop-dispatch-runtime.ts`
   - worker 认领时带 `{ pid, startedAt }`（`startedAt` 由本进程启动时间换算），工作期间每 15s 续心跳，`finally` 清理定时器。
4. `gateway/scripts/workbench-read-store.mjs`
   - 派工证据新增 `settlement` / `settlementReason` / `heartbeatAgeMs` / `ownerAlive`，由 `describeDispatch` 在读取时派生；连接仍为 `readOnly: true`。
   - 派生只读：不改 `task_operations.state`、不释放执行容量、不重派。
5. `gateway/workbench/dispatch.mjs`
   - 恢复证据面板新增“派工租约”一行，文案由 `leaseLabel` 决定，四种状态各有固定说法，未知值回落“无租约记录”。
6. 测试
   - `gateway/test/dispatch-settlement.test.ts`（6 例）：无租约、所有者已退出、心跳新鲜/过期/边界、旧库原地加列后可读可认领、非所有者续心跳被拒且读取不改行、真实退出的子进程 pid 判为 `abandoned`。
   - `gateway/workbench/test/receipt.test.mjs`（+1 例）：租约文案不把未知状态说成进行中。
   - CI 的 Desktop dispatch 步骤同时运行 `test/desktop-dispatch.test.ts` 与 `test/dispatch-settlement.test.ts`。

### 验证记录

- `npm run build` 与 `npm run typecheck:task-view`：exit 0。
- `test/desktop-dispatch.test.ts` + `test/dispatch-settlement.test.ts`：16 tests, 16 pass。
- `npm run test:workbench`：32 tests, 32 pass。
- `npm run desktop:test`：`{"passed":42,"failed":0}`。
- `node verify-snapshot.mjs`：`{"snapshotFilesVerified":533,"hashesMatch":true}`。

### 边界

- 跨进程无法校验 pid 是否被复用（没有可用的启动时间查询），所以“存活的 pid + 过期心跳”降级为 `stuck` 而不是 `abandoned`；这是保守方向，不会把可能还在跑的派工说成已死。
- `abandoned` 只是显示层的证据结论：任务库状态与执行容量都不动，恢复动作仍只经 `recovery show|observe|reconcile|close` 人工确认。

### 实测补充（2026-11-02 晚）

- **派工日志此前根本读不到**：日志在独立文件 `dispatch/<hash>/requests.sqlite`，读取层却在任务库找 `desktop_dispatch_requests`，同一身份修复前 `dispatch: null`、修复后读到真实行。现在 `openWorkbenchReadStore(file, { dispatchFile })` 只读打开日志，仅在任务库缺表时回退。
- **租约层崩溃**：真实子进程 `claim` 后被杀 → 行仍 `dispatching`、派生 `abandoned/owner_exited`、读取不改行、容量不释放（`workbench/test/dispatch-crash.test.mjs`，4 例）。
- **真实派工崩溃**：用生产宿主提交真实派工后杀持租约进程，同样得到 `abandoned`；但当时结论仍写“原操作仍在进行”，因为 `conclusion` 只看 `task_operations.state`。已改为先看租约：`abandoned`/`stuck` → `outcome_unsettled`，并补 2 条回归用例（死租约不许说 active、活租约仍算 active）。workbench 套件 43/43。
- 仍未覆盖：**已产生副作用后**才死亡的现场（两次都死在原生开始之前）。

## D1：任务面板的不可用原因（2026-11-02）

### 解决的问题

任务详情页的“任务操作”区有两个静默出口：没有 `attemptId` 的任务直接不渲染操作区（`gateway/workbench/app.mjs` 的挂载条件），有 `attemptId` 但没有候选按钮时 `controlCandidates` 返回空数组、界面一片空白。用户看到的都是“没有操作”，而实际原因可能是：记录缺轮次、缺版本号、只读面板、缓存快照、原生停止未确认、状态已终结。空白把六种不同情况压成同一种观感。

### 改动

1. `gateway/workbench/controls.mjs`
   - 新增纯函数 `unavailableReasons(record, { desktopAvailable, live })`：有候选按钮时返回空数组；否则按顺序给出 `desktop_unavailable` / `not_live` / `attempt_missing` / `revision_missing` / `native_stop_unconfirmed` / `already_stopped` / `review_incomplete` / `state_not_actionable`，每条都指向已记录的证据。
   - 新增 `renderControlUnavailable(record, options)`：没有原因时返回 `null`，避免空区块；每个原因带 `data-reason`，便于后续样式与测试定位。
   - 说明文字只陈述证据（“缺少 attemptId”“尚未确认原生停止”），不推测原任务是否在跑。
2. `gateway/workbench/app.mjs`
   - 详情页在实时数据下始终渲染操作区：有条件就渲染真正的按钮，没有条件就渲染原因分区；缓存快照与只读面板同样给出原因。演示数据（demo）不渲染，保持设计稿干净。
3. 测试
   - `gateway/workbench/test/controls.test.mjs`（+3 例）：无轮次/无版本/只读/缓存/组合原因的代码序列；原生停止未确认与已确认的区分；有候选按钮时不得声称不可用。

### 验证记录

- `npm run test:workbench`：35 tests, 35 pass。
- `node scripts/workbench-smoke.mjs`：25 步全过。
- `node verify-snapshot.mjs`：`{"snapshotFilesVerified":533,"hashesMatch":true}`。

### 边界

- 只覆盖桌面工作台的任务详情页。stage-2 的只读 HTTP 投影（`gateway/src/task-view-stage.ts`）仍无 `gaps` 与容量字段，公共面板上的同类解释见下文 D5。
- 原因文案不显示执行容量占用：任务视图里没有该字段，硬拼会变成猜测。容量证据在 `recovery_show` 的“执行容量”一行，公共面板另走 D5 的独立资源。

## D5：公共只读面板的容量与不可用原因（2026-11-02）

### 解决的问题

- 任务详情页此前只能看到任务事实，看不到“为什么现在不能开始新的执行”；容量占用只在桌面私有通道的 `recovery_show` 里可见。
- stage-2 的 `health.capacity.occupiedByTaskId` 恒为 `null`（契约要求本阶段不猜占用者），照抄它会把“没有记录”说成“容量空闲”。

### 改动

- 新增 `gateway/src/capacity-view.ts`：`CAPACITY_RESOURCE_SCHEMA = "workbuddy-executor/capacity-1"`，纯函数 `capacityResource(occupied, observedAt)` 只把 `workflow_capacity` 的唯一一行原样映射为 `{schemaVersion, readOnly:true, snapshotOnly:true, limit:1, occupied|null, observedAt}`。
- `gateway/src/task-application-service.ts` 增加 `readCapacity()`：一次 `operations.occupant()` 的 SELECT，不占用、不释放、不改任务状态；读失败抛出，由 HTTP 层答 503。
- `gateway/src/workbench-http.ts` 新增 `GET /workbench/v1/resources/capacity`（不接受查询参数，带参数 400 `INVALID_RESOURCE_QUERY`；读失败 503 `RESOURCE_STORE_UNAVAILABLE`），并把该路径加入 405 允许清单。stage-2 端点、`health.capacity` 与 GET 零写入规则均未改动。
- `gateway/workbench/http-source.mjs` 增加 `capacity(signal)` 校验（schema、`limit===1`、占用者三字段类型）；`gateway/workbench/demo-source.mjs` 返回合成空闲容量。
- `gateway/workbench/app.mjs`：切换任务时清掉旧容量读数，与详情在同一快照里读取容量；读取失败记为 `'unreadable'`，不当作空闲。
- `gateway/workbench/controls.mjs`：`unavailableReasons` 新增 `capacity_occupied_other`（点名占用任务，并说明“这不表示本条任务仍在运行”）与 `capacity_unknown`（读不到记录时说明“不等于容量空闲”）；容量由本任务自己持有时不报原因。

### 验证记录

- `node --import ./test/support/typescript-loader.mjs --test test/capacity-resource.test.ts test/workbench-http.test.ts`：13 tests, 13 pass（覆盖 200 形状、400 查询参数、405 `Allow`、`health.capacity.occupiedByTaskId` 仍为 `null`）。
- `npm run test:workbench`：37 tests, 37 pass（新增 2 个容量原因用例）。
- `npm run build`、`npm run typecheck:task-view` exit 0。

### 边界

- 这是快照：`observedAt` 之后容量可能变化；面板不轮询容量，也不据容量推断任务是否仍在运行。
- 容量占用不等于“有副作用”；释放仍只由 `claim` 与关闭/恢复裁决路径负责，本资源只读。
- 桌面私有通道的 `recovery_show` 继续保留自己的容量行；两条读路径同源一张表，本资源不替换它。

## D5：待处理项的“原因 + 出口”（2026-11-02）

### 解决的问题

侧栏早就有「待处理」分组，但它只按状态筛选：`waiting_stop`、`inconsistent`、`needs_review` 在列表里长得一样，点进去也只有一句「任务操作」的空结论。三轮实测（run8/9/10 死亡、run12 停止窗口）都指向同一件事：**卡住了，但没人说为什么，也没有出口。**

### 改动

- 新增 `gateway/workbench/attention.mjs`：纯函数 `attentionReason(record)` 把已存事实翻成「标题 + 为什么 + 下一步」三句，`attentionItems(records)` 只保留有原因的记录；`renderAttention` 渲染一张卡，含「核对当前证据」按钮。措辞固定，不随状态发明新解释：
  - `waiting_stop` → 「报告已到，原生停止未确认」，并点名「停止证据缺失」与「不要重派」。
  - 状态显示待验收但没有停止证明（`inconsistent`）→ 「待验收记录缺少停止证明」：两个事实不能互相顶替。
  - `needs_review` 且停止已确认 → 「等待独立验收」；有审查但基线版本不一致时点名版本。
  - `blocked` / `waiting_input` / `failed` / `expired` / `unknown` 各有固定说法。
- `gateway/scripts/workbench-read-store.mjs` 新增 `store.taskEvidence(taskId)`：任务状态、报告是否存在、审查时间、原操作结论、派工结算、**停止证据**（从 `<runs>/<attemptId>/state.json` 读，只读）、容量归属。停止证据本来只在运行日志里，这是它第一次出现在面板通道上。
- 桌面临命令 `attention_verify`（`workbench-desktop-commands.mjs`、`DesktopControlPolicy.cs`）：只接受一个 `taskId`（1–200 字符、拒绝控制字符），只读、不改、不重派、不释放容量；多给字段直接拒绝。
- `gateway/workbench/app.mjs` 在详情页挂载该卡（仅实时数据源）；`controls.css` 增加卡片样式。

### 实测

对 run12 那条「报告已到、停止未确认」的任务，经由生产宿主私有通道调用 `attention_verify`，返回：

```text
task.state            needs_review
task.reportPresent    true
task.reviewedAt       null
stop.nativeStoppedAt  null          ← 停止证据仍然缺失
stop.reportDigest     96193967…
dispatch.settlement   lease_unavailable / not_pending
capacityHeld          true          ← 唯一容量槽仍被占
```

多带一个 `retry` 字段 → `INVALID_REQUEST`。这张卡说的每一句都能在这份返回里找到对应字段。

### 验证记录

- `npm run test:workbench`：51 tests, 51 pass（新增 `attention.test.mjs` 7 例 + `read-store.test.mjs` 1 例「报告在、停止不在」）。
- `npm run desktop:test`：46 passed / 0 failed（新增 4 例：缺 taskId、多字段、控制字符、正常读取）。
- `node verify-snapshot.mjs`：`{"snapshotFilesVerified":555,"hashesMatch":true}`。

### 边界

- 卡片只覆述已存证据，不判断“到底停没停”；停止证明仍只能来自原生。
- 它给出的是**出口的入口**，不是出口本身：`recovery reconcile/close` 仍要人工确认。收口演练（执行记录 §6.9）证明：有停止证据时 `close` 会关闭原工作流、释放唯一容量槽并让卡片消失；没有停止证据时命令直接拒绝，容量继续被占。
- 新建的两个文件目前是未跟踪状态，不在 `SNAPSHOT_MANIFEST.json`（该清单只收 `git ls-files`）；**提交时必须 `git add` 后再跑一次 `generate-snapshot-manifest.mjs` 并一起提交**，否则 CI 的 `verify-snapshot` 会因为清单里缺这两个文件而失败。

## D6：人工补证入口（2026-11-02）

### 解决的问题

收口演练（§6.9）暴露的真实缺口：停止证据只能由原生写入。现场一旦丢了回执，用户亲眼确认「它确实停了」也进不了证据链，唯一结果是永久占位。这一节补的就是这个入口——**但只补“声明”，不补“证据”**。

### 设计取舍

- 声明写进自己的表 `native_stop_declarations`（每次 attempt 只能一条），字段里带 `basis`：声明当时的任务状态、`nativeStoppedAt: null`、运行状态、报告摘要。它**永远不满足 `hasNativeStopEvidence`**，也永远不写进运行日志。
- 收口判定多一种依据 `declared_stop`，与 `native_stopped` 并列但语义更弱。`operation_recoveries` 里保存的 `proof` 会一直写着 `declared_stop`，并附 `declarationId`。
- 声明本身不改任务状态、不动容量、不写任务库以外的任何东西；写库是惰性的（第一次声明时才打开可写连接），所以「打开窗口」依然不会迁移数据库。
- 声明命令要求逐字输入 `declare native stop <taskId> <attemptId> <revision>`；收口命令要求逐字输入 `close <原操作> <稳定id> declared <声明id>`——两处都比原来的句子更长，且都包含声明编号。

### 拒绝的四种情况

| 情况 | 错误码 | 说明 |
|---|---|---|
| 运行记录已经证明停止 | `NATIVE_EVIDENCE_PRESENT` | 有原生证据就不接受更弱的声明 |
| 运行记录仍在 `queued`/`working` | `STILL_RUNNING` | 别拿“我觉得停了”去顶替在跑的事实 |
| 说明少于 10 字 | `DECLARATION_INVALID` | 声明必须写清楚怎么核对的 |
| 同一 attempt 已有不同声明 | `DECLARATION_CONFLICT` | 声明不可覆盖，只能保留第一条 |

### 实测（drills/run12-drill，账本副本）

```text
wrong sentence           → CONFIRMATION_REQUIRED
declare_native_stop      → declarationId 85597ce3…，basis.nativeStoppedAt = null
attention_verify         → declaration.source = human_declaration
recovery close 预览      → proof: declared_stop，并回显该声明
确认句                   → close desktop-send-64a52891… f04d0e1e… declared 85597ce3…
结果                     → 任务 cancelled，容量 1 → 0
审计记录                 → proof: declared_stop，declarationId: 85597ce3…
```

### 验证记录

- `node --import ./test/support/typescript-loader.mjs --test test/t7d-native-stop-declaration.test.ts`：4 tests, 4 pass（无声明时不可收口 / 声明不动状态与容量 / 声明后收口释放槽位且保留弱证据 / 三种拒绝 + 覆盖冲突）。
- `npm run test:workbench`：54 tests, 54 pass（新增 `declaration.test.mjs` 3 例）。
- `npm run desktop:test`：50 passed / 0 failed（新增 4 例：确认句不符、正常声明、多余字段、说明过短）。
- `npm run build` exit 0；`node verify-snapshot.mjs`：555 文件哈希一致。

### 边界

- 这是**人工声明**，不是原生证据；任何下游都不得把它渲染成「已确认停止」。
- 它只让 `close` 多一个可用依据，不改变「关闭 ≠ 验收」。
- 目前只有单一入口：桌面私有命令 + 逐字确认句；HTTP、MCP 都没有这个动作。
- 新增文件仍是未跟踪状态，提交前必须 `git add` 后重打 `SNAPSHOT_MANIFEST.json`，否则 CI 的 `verify-snapshot` 会失败。

## 仍未完成

- 结论文案只在点按时出现，重开窗口后需要再查一次；把最近一次证据写进任务视图（`task-view-stage` 的不可用原因分区）尚未开工——现在的卡片在 UI 层，stage 投影里仍没有 `blocker`/`gaps`。
- `recovery show|observe|reconcile|close` 的 CLI 入口保持不变；本轮未改动任何恢复裁决路径，`abandoned` 也不释放容量。
