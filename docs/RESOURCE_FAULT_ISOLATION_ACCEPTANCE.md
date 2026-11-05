# D3-04 资源故障隔离：B 线验收

日期：2026-11-05。结论：既有实现在下列新增隔离验证中通过；本线没有发现或修改生产代码中的隔离缺陷。专项结果不等于最终集成候选全量验收，也不证明真实模型、真实账号池或生产进程。

## 版本与文件归属

- 核实的起始基线：`b89a587963d295fcf00858c7fbb4e5b47425841c`；独立分支 `feat/resource-fault-isolation`，工作树 `E:\javaproject\workbuddy-resource-fault-isolation`。
- 测试提交：`3ad105fd898fbce3535b51e946d5e85e46bbf4cd`；本验收记录是其后的独立文档提交，最终 HEAD 可用 `git log -1 --format=%H` 读取，避免提交哈希自引用。
- 本线文件：`gateway/test/resource-fault-isolation.test.ts`、`docs/RESOURCE_FAULT_ISOLATION_ACCEPTANCE.md`。没有修改公共运行模块，也没有修改 A 线的 plan-resource-reference、plan-reference、关联/loader 测试；没有改 README、ROADMAP、PROGRESS、开发总表、版本号或清单。集成时需重新生成快照清单，并在 A/B/C 合入后执行最终完整回归。

## 场景矩阵

| 场景 | 结果与证据边界 |
|---|---|
| A：运行中任务与资源故障 | 通过合成交叉测试：使用正式 TaskStore、TaskApplicationService、WorkbenchHttpServer；WorkBuddy 假原生会话经正式 DesktopQueue claim 后处于 working。quota 采集的 401、403、无效结构、超时及 quota 快照损坏时，任务 HTTP 仍 200；比较任务、原操作、容量记录和 attempt 数，未改成失败或自动重派。旧值和 snapshotId 保留，错误显式标记 stale；损坏 quota 与 routing GET 返回 503，credit 和任务查询仍可用。 |
| B：采集挂起时监督与停止 | 通过合成交叉测试：本地上游通过收到 HTTP 请求的 Promise 握手证明采集已在途，再调用正式 service.sync 和 service.cancel；每项上限 10 秒。WorkBuddy 与 DSH 两条原任务均不等待采集。WorkBuddy 在取消未确认期间主动中止资源采集，再由原队列完成报告和原生观察；资源中止没有终止原任务通信或释放容量。 |
| C1：停止尚无证据 | WorkBuddy 正式队列收到取消、worker 报告 cancelled 之后仍断言 remoteStopped=false、原容量持有；第二个合成任务的准入以 CAPACITY_OCCUPIED 拒绝且没有创建任务。DSH 的假传输即使返回 stopped=true，仍断言 remoteStopped=false，原容量与 requestId 保留，取消只调用一次。 |
| C2：满足原生停止规则 | WorkBuddy 使用正式 DesktopQueue.observeNative(idle) 后同步持久事实；DSH 使用绑定原 requestId/session/host 的 `turn/end` cancelled 事件后同步；两者 remoteStopped=true，取消任务 isClosed=true，未成为 accepted，attempt 仍为一条。已保存容量行保留到下一次准入检查已关闭事实时交接；本线没有提交第二次任务来制造释放。 |
| D：只读与乱序 | 挂起采集期间从正式 HTTP 读取 quota、credit、routing，断言上游计数不增加，比较任务、原操作及容量持久事实不变；资源损坏时再次确认 GET 不采集。既有 quota 回归覆盖旧配置/旧代次迟到、来源时间缺失/倒退与失败保留；credit 回归覆盖部分覆盖、null/零和失联；只读桌面回归覆盖资源缺表/损坏和容量未知。合并批次具体结果见下。 |
| 其他边界 | 超大响应由既有 credit 测试覆盖；新交叉测试未在同时运行的 DSH 任务中注入每一种 401/403/坏载荷，DSH 交叉部分覆盖采集挂起、监督、停止和原始终态。旧资源数据的跨重启及重新配置由既有单模块测试覆盖，不冒充本轮真实来源验证。 |

## 夹具与持久化

WorkBuddy 夹具使用隔离 SQLite、正式 DesktopQueue/TaskCoordinator、真实 TaskApplicationService/HTTP 和 `SelectedModelClient` 的合成选择；它只在自建假原生库中 claim/report，不启动 WorkBuddy 或模型。DSH 使用正式 DshTaskCoordinator 与只在内存中返回合成事件的 `DshTransport`，计划授权、任务、容量和原始绑定仍通过正式存储。无真实模型、账号、原生任务或生产连接。

GET 不触发采集由上游调用数及任务/operation/capacity 语义记录比较验证；任务 HTTP 是正式接口，未以 SQLite 主文件哈希代替事实读取（因此不依赖 WAL 是否合并）。每个夹具仅删除自身 `mkdtemp` 创建的目录；HTTP 服务和采集器在 finally 关闭，新增 WorkBuddy 与 DSH 用例对自建服务端口关闭后再次连接失败作断言。没有启动需要按进程名清理的外部进程。

## 命令、结果与证据

以下在隔离 worktree 的 `gateway` 执行，单独进程清除继承的 `WORKBUDDY_*`，并显式设置合成 `WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR`，loopback `NO_PROXY`；没有设置生产数据路径。

- `node --import ./test/support/typescript-loader.mjs --test --test-concurrency=1 test/resource-fault-isolation.test.ts`：退出码 0，最终测试源码 3/3 通过，见 `E:\javaproject\outputs\resource-fault-isolation-20261105\cross-tests-final.log`。
- `node node_modules/typescript/bin/tsc --noEmit --target es2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess test/resource-fault-isolation.test.ts`：退出码 0；`npm run build` 和 `npm run typecheck:task-view` 均退出码 0。
- 相关批次（同一 loader，`--test-concurrency=1`，含新增、quota、credit、desktop-readonly-resources、desktop-queue、dsh-adapter、workbench-http）：首次退出码 1，96 通过、2 未通过，见 `related-tests.log`。只读资源文件在并发构建完成前找不到 dist/task-store.js；入口子进程收到 HTTP 400 且当时批次继承了不应设置的 runs 变量，无法将该次失败归因于产品。构建完成、清除 WORKBUDDY_RUNS_DIR 并限定 loopback NO_PROXY 后，受影响的只读资源文件单独 14/14 通过（`readonly-retry.log`），入口场景单独 1/1 通过（`entry-retry.log`）。首次失败保留，不将多次运行合并成一次全绿批次。新增测试后续曾修改并单独重跑，以最终 `cross-tests-final.log` 为准。
- `git diff --check` 对本线最终变更运行；完整仓库全量检查留给集成阶段。本线没有构建发行包或修改快照清单。

## 集成建议

可以将 D3-04 更新为：**WorkBuddy/DSH 合成运行中资源挂起、监督、停止证据及容量隔离专项已验证；真实来源、真实执行器、最终候选全量及其他未覆盖组合仍待验收**。不要把资源 GET 的成功解释为可派工、余额充足或 D3 全部完成。A 线规则未触碰；与其他线的冲突风险主要在集成人后续统一生成 `gateway/SNAPSHOT_MANIFEST.json` 与共享进度文件，而非本线生产模块。本线不代替集成人合并、推送、部署或发布。
