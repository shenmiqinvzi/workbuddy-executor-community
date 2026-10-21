# 下一开发任务：旧记录的只读事实适配

本任务由 dsh 实现，Codex 独立验收。执行模型沿用用户在 dsh 中选定的模型；不要因此修改网关的执行模型政策。

## 交付目标

实现一个离线可测的适配模块，把现有任务和执行记录转换为可供已验收状态推导函数使用的事实，同时明确报告无法取得的事实。交付包含字段映射、实现和测试，在同一轮完成。

这是旧记录的只读投影准备。现有存储没有完整的 vNext reviewId、结构化必需检查、约定版本、当前源码摘要和持久化 revision，因此本轮不得将输出称为已经实现完整 TaskView 或可执行的 vNext 服务。

## 文件范围

新增：

- `gateway/src/task-view-adapter.ts`
- `gateway/test/task-view-adapter.test.ts`
- `docs/TASK_VIEW_FACT_MAPPING.md`

按需修改：

- `gateway/tsconfig.task-view.json`：纳入新增文件。
- `.github/workflows/windows-gateway.yml`：在 TaskView 测试命令中加入新测试。

复用现有 `task-view-state.ts`、`task-view-actions.ts` 和契约类型，不改已验收推导规则。所有既有工作区改动属于前序任务，应完整保留。

## 输入与输出边界

适配函数只处理调用方传入的普通对象。输入采用现有 `StoredTask`、可选 `RunSnapshot`，及实现确实需要且在现有源码中有来源的附加记录/观测结果。附加输入必须说明由哪个现有生产入口采集、记录归属如何校验；不要把整套已经填好的 TaskDisplayFacts 当作输入，做无意义透传。

函数不实例化 TaskStore、RunJournal 或原生适配器，不访问文件、数据库、网络，不读进程环境和当前时钟，不发送控制命令。类型引用尽量使用 `import type`。可复用现有纯停止判定函数 `hasNativeStopEvidence`，但不得调用带初始化、同步、迁移或写入行为的入口。

输出至少表达：

- 已成功建立的显示事实，以及复用 `deriveTaskDisplayState` 得到的显示状态。
- 缺失、不支持或冲突的事实清单，带稳定原因和相关字段名。
- 无法建立事实对象时的显式结果，例如 `facts: null`；不伪造 attemptId、版本或源码摘要凑齐类型。
- 本轮写操作统一不开放：只返回 `export` 动作建议。说明这是适配覆盖范围的限制，不修改现有纯动作函数的行为。

不强制生成 `TaskActionFacts`。确实缺少其必要输入时保持不可构造，并记录缺口，不用空字符串、默认 true 或“猜测没有必需项”的空数组代替。

## 需要先固定的映射规则

开始编码前，在映射文档中为所有 `TaskDisplayFacts` 和 `TaskActionFacts` 字段列出来源、成立条件及缺失时的处理。引用具体源码类型、函数和字段；不依赖生产账号或真实历史数据调查。

已知源码入口包括 `task-store.ts` 的 StoredTask/StoredAttempt、`run-journal.ts` 的 RunSnapshot/RunRequest/RunEvent/hasNativeStopEvidence、`coordinator.ts` 的 sync/accept/executionStatus、`desktop-queue.ts` 的 report/observeNative/expire，以及 `worker-result.ts` 的验证记录核查。

规则如下：

1. 先校验 task、attempt、session、运行来源的关联。缺失与不一致分别记录；不得混用其他任务或轮次的证据。普通快照的关联不一致不能产生可用停止/报告事实。
2. 可信存储中已有的真实最终验收决定是持久事实，离线或旧快照冲突不能将其抹去；冲突另列。保留历史 accepted 不等于给旧记录补造 vNext reviewId。缺少 attempt 时采用显式缺失结果，不生成虚构编号。
3. 当前轮次停止判定复用现有程序规则。单独存在 nativeStoppedAt、stopReason=end_turn、worker 完成报告、取消请求或 idle 标签均不自动证明停止。现有判定认可的旧停止证据可以没有准确时间。
4. 报告收到、队列认证、独立验收是不同事实。StoredTask.state=needs_review、rawText 非空或 reportDigest 字符串存在，都不能在没有说明核验覆盖的情况下自动提升为已认证。阅读 report 的真实摘要算法及身份核验入口，明确本轮能完成哪部分；所需证据未输入时保持未知或仅收到。
5. terminalDecision 原因来自真实的结构化决定/取消记录或明确的已有程序语义，不能从时间相等、错误文案包含 timeout、普通 blocked 状态推断。首次决定优先，迟到报告不能覆盖。无法判定是否有决定时保留 unknown。
6. 运行快照不是当前在线证明。updatedAt 只是记录保存时间，PID 或 queued/working 字符串不能单独证明原生仍活跃。没有可靠的实时观测，就不生成可信的 queued/running/waiting_input。若需要实时观测输入，写清其采集来源和有效性条件；不自行给出未经约定的有效期，不在纯函数中读时钟。
7. 不把 submissionHash 当作 vNext 约定版本，不把 reviewNote/reviewedAt 当作 reviewId，不把 worker 的测试描述当独立 CheckResult，不把模型 ID 或免费目录标签当作刚刚完成的模型校验。
8. 本轮不新增约定/审查持久化、源码哈希扫描、范围基线、操作幂等或执行锁。它们缺失时记入能力缺口，不在适配器里临时实现第二套系统。

## 验收场景

使用合成的现有记录类型写独立输入/预期测试，至少覆盖：

- 任务不存在当前 attempt、执行快照缺失、记录归属不匹配，均不产生虚构身份或停止证明。
- 只有 worker 自报完成或 end_turn，不当作停止已确认或最终 accepted。
- 匹配当前轮次的真实程序停止证据能映射；旧证据无可靠停止时间时仍允许明确表达已确认停止。
- 只有过期的 working/waitingInput 快照而没有实时观测，不显示成可信的实时活跃状态。
- 明确的取消/截止决定不会被后到报告改写；决定原因不足时报告缺口。
- 已有真实 accepted 在断线或原生证据冲突时仍保留该决定，冲突显式返回。
- 缺少 vNext 审查、约定或源码摘要时不伪造；所有本轮输出的 allowedActions 均只有 export。
- 输入不被修改，同一输入结果确定；测试不是把已有 displayState 当作预期答案透传。

映射文档说明每个测试证明的覆盖边界。缺失事实导致部分记录显示 unknown 可以接受，但需要具体缺口，不能所有输入一律 unknown，也不能为覆盖全部十个显示状态而编造数据。

## 验证与回报

运行源码 `tsc --noEmit`、`npm run typecheck:task-view`，以及包含新增适配测试的全部 TaskView 相关测试。新增测试必须由严格类型检查和现有 CI 测试命令覆盖。无需重跑已知有环境性失败的全量套件。

不修改配置、数据库、已验收纯推导模块、dist、冻结 benchmark 或快照清单，不部署、不提交、不推送。不要访问真实任务库、凭据或原生私人会话；不添加本机敏感信息到文档/样本。

最终回报控制在 500 字左右：修改文件、已支持的映射、缺口、实际验证命令与退出码、git status。完整映射和实现细节放在文件里，避免重复长篇报告。
