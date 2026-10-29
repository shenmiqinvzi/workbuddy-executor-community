# T6：独立检查、不可变审查与最终验收

基线为 T5 main `d058234`。本阶段交付 WorkBuddy desktop-queue 与 DSH 的共用后端、受控 SDK/MCP 及隔离验证；HTTP 保持 stage-2 只读，不开放完整 vNext POST、T7 面板、自动调度或计量。不安装、升级已部署网关或技能，不默认调用新的付费模型。

## 事实、身份与持久性

TaskStore.reviews 使用 SQLite 的追加记录保存程序批次、独立命令记录、人工文件检查与 review；服务端生成 ID，正文摘要核验，UPDATE/DELETE 触发器拒绝覆盖与删除。更正新增 review，引用 supersedesReviewId 并标记 reviewer_error。旧结论、原生返工和轮次预算保留。不会给历史任务补造认证、约定或 review。

程序来源为 program，语义审查来源为 independent_reviewer，通道固定为 trusted_local_coordinator；worker 报告继续作为已认证执行报告单列，不能充当独立检查。所有来源由实际服务入口赋值；请求中的 actor 或未知行为字段拒绝。此处是受信本地协调者边界，不是面向任意远端用户的身份系统或 OS 沙箱；拥有本机数据库/进程控制权的主体不属于不可信网络调用方。

每份 review 绑定 task、attempt、原约定摘要/版本、session、实际执行来源与原生模型准入/轮次绑定、原报告认证与停止、T5 原基线和库存、请求/事件文件及被检查的源文件/证据哈希。非契约新调用沿用真实初始提交摘要，约定版本为 null，不虚构结构化契约；acceptanceCommands 只能按命令检查处理。历史缺少原提交、基线、认证或受支持的停止来源时，无法通过 T6；旧 accepted 查询事实不变。

## 实际流程

1. 显式 sync 接收原生报告与停止证据，使原 task 处于 needs_review。审查服务自身不同步、不派模型、不新建 attempt。
2. reviewChecks / workbuddy_check_task 复用报告认证、原生停止、T5 范围与原有改动保护、引用命令的输入哈希和清理证明，保存完整程序批次。单个 machineCheckIds 批次包含全部必需程序项，不允许客户端选择部分 passing 项掩盖失败。
3. 原语义项由协调者实际阅读文件并显式 recordInspection，保存明确检查说明、文件摘要与当前执行绑定。review 只接受原约定中 kind=semantic 的检查项与已保存 inspection 引用；不能以语义复核豁免来源、停止、归属或哈希。
4. review 保存不可变 reviewId。每项状态为 passed / failed / unknown / not_applicable / checker_error；当前契约只有 requiredChecks，没有可预声明为非必需的检查项，因此任一必需项 not_applicable 都不能通过。失败或不完整 review 可以保存供审计，accept 必须逐项 passed。
5. acceptReview / workbuddy_accept_task 重新核对当前 needs_review、revision/attempt、约定/执行/报告/停止、所有必需项与当前文件/证据，再在同一 BEGIN IMMEDIATE 内由存储边界重复保护检查、提交 accepted、review 引用、task_closed 和操作回执。closed 事件时间与 reviewedAt 一致。needs_review 保留共享工作流名额，不凭 TTL 或界面结束释放。

## 命令证据

已认证 WorkBuddy validationRecords 无论是否有命名 command 项，都保持已有验证：真实命令目录、记录摘要、exitCode=0、cleanupConfirmed、前后输入摘要与当前文件必须一致。有输出路径时同时绑定输出字节。这些引用保留为 worker 报告证据，不自动提升为独立 program 检查：即使 JSON 字段和哈希正确，也不能证明后端实际执行了命令。只有本服务实际运行并持久登记的命令记录，才可满足原 command 项。自报 TEST_RESULT 或任意路径/“passed”字符串不算机器证据。

两执行器也可显式 runReviewCommand / workbuddy_run_review_command，在原 agreement 内查找 checkId 并执行精确 JSON CommandSpec。示例定义（须换成实际路径和参数）：

```json
{"executable":"C:/Program Files/nodejs/node.exe","args":["--test","test/example.test.js"],"cwd":"E:/example/project","timeoutSeconds":60,"inputs":["src/example.js","test/example.test.js"]}
```

此操作复用现有 runBounded、Windows Job 与 validation 验证；要求明确非空输入，服务端不接受命令覆盖或执行自由文字。已有后端独立记录只按完全相同的 JSON spec 匹配；自由文字定义无法证明可执行文件与参数边界，保持 unknown，不能事后修改原约定补成通过。退出非零且清理确认是独立检查 failed；helper/清理问题为 checker_error，均不修改 worker 内容失败或返工预算。命令本身是显式外部副作用，其运行与未知结果沿原持久 operation 观察，不自动重跑。

## Revision、并发与限制

程序检查与人工检查写入均推进 revision；提交下一步时使用实际返回值。review 保存审查依据 basisRevision 和落库后 committedRevision；因此审查不会因自身写入立即失效。accept 要求当前 revision 精确等于 committedRevision；其他事实变化、新审查、轮次变化或并发接受使旧操作拒绝。相同 operationId/参数重放原结果，不同参数冲突；失败的受控写入保留拒绝回执；不会重复接受或重派模型。

SQLite 保证审查写入、接受决定、关闭事件与对应同步操作回执的数据库事务一致性，不能锁住数据库之外的文件系统。验收在持锁窗口再次读取外部文件与 T5 库存，可检测读取时可见的变动；不能宣称阻止最后一次读取后发生的任意外部写入。原 T5 库存排除、资源上限、链接/别名检查及任意 shell 外写可见性限制继续生效。

listReviews / workbuddy_get_reviews 只读已存检查与 review，GET 不执行 Git、不扫描文件、不提交审查或调用模型。stage-2 DTO 保持原范围；受控 SDK/MCP 子集不是完整 vNext TaskView。旧 note/evidence/artifactPaths 的最终 accept 调用拒绝绕过，新任务不会因兼容获得免审。

## 验证归属

源码自动测试使用真实临时 Git、文件、SQLite、多连接及独立进程，原生领取/事件适配为合成替身。PR #17 的最终 head CI 与实际 main `0e9d96b` CI 分别通过。随后在该 main 的字节相同隔离运行副本上执行了新的真实模型任务：WorkBuddy 与 DSH 官方来源均 accepted 并关闭，原 DSH 代理来源因渠道校验失败而 failed/关闭。具体归属见[交付记录](T6_COMPLETION_2026-10-29.md)和[补验摘要](T6_LIVE_ACCEPTANCE_2026-10-28.md)。第二台 Windows 和正式部署未执行；没有把 T5 真实样本重新标记为 T6。

本机源码验证及 E 盘预检曾被既有 PowerShell 区域信任检查阻止，原失败记录保留。后续在正常识别为本机区域的 C 盘使用字节相同的隔离运行副本，正常退出、超时和取消的 Windows Job 清理预检通过，两端后端独立命令亦通过；没有修改执行策略、签名、区域流、Job 清理要求或成功断言。补验脚本另有 LF/CRLF 预览哈希及新建父目录检查错误，依据派工前已持久保存的原始基线纠正，保留初次失败，没有追加模型轮次或补造基线。具体结果与限制在补验摘要单列，不将局部预检冒称整套本机历史失败均已重跑通过。
