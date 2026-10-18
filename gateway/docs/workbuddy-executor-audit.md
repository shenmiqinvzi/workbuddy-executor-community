# WorkBuddy executor 技能与网关核查（2026-10-18）

范围：当前 Windows desktop-queue 技能及其共享底层执行约束。独立副本来自本机网关当前工作文件，未把原仓库已有未提交改动归入本次变更。没有派真实业务任务、调用付费模型或进行效率对照；本报告不证明真实环境业务成功率或节省成本。

## 技能结构

- 主文件按判断、派工、监督、验收排列，从6856字节降到4416字节（约36%）。
- `references/dispatch.md` 给出约定、准备、提交、等待、独立验收与返工的完整例子，已核对 `src/server.ts` 的工具名和字段。
- `references/execution.md` 保存 worker 执行约定、验证/进度/回报格式及证据局限。
- `references/setup.md` 保存唯一一处本机路径说明、已有免费模型配置、故障恢复与版本检查。
- Agent Hub 文档保留并明确标为另一工作流的历史参考。当前技能不使用其入口或模型规则。
- 安装和打包白名单包含新增示例，代理名称、依赖和自动调用政策保持原状。

## 规则、程序保证和人工判断

| 规则 | 实现入口 | 程序保证 | Codex 仍须判断/核对 |
|---|---|---|---|
| 指定免费模型 | `src/native-desktop-trigger.ts` 的 applyModel/wakeIdle；`src/workspace-manager.ts` | 设置 `WORKBUDDY_REQUIRED_FREE_MODEL` 后，配置及唤醒都核对精确ID与零积分字符串，未知或非零拒绝，不自动回退 | 本机配置存在且未被宿主环境覆盖；当前 list_models 信息。平台是否仍可用、账户额度不由此证明 |
| 先确认模型再领取 | `src/persistent-service.ts` 的 pumpLocked；`src/desktop-queue.ts` 的 claim | 原生配置回读确认后才写本轮 model-ready；带 model 的任务只由匹配会话和轮次领取；授权发生在唤醒前 | 派工显式传 model，不以模型名称代替ID |
| 同一任务不重复派发 | `src/coordinator.ts` 的 send；`src/task-store.ts` 的 createOrGet/beginAttempt | 原子保留任务；新增初始请求指纹，相同请求复用，冲突请求明确拒绝且不配置会话；指纹跨重连、返工保留 | 新任务使用稳定 taskId；遇到冲突查原任务，不换键绕过。旧任务无指纹，仅能检查仍可确定的冲突 |
| 停止未确认禁止重派/返工 | `src/desktop-queue.ts` 的 startLocked；`src/coordinator.ts` 的 continue；`src/persistent-service.ts` 的 stopAttempt | 未闭合队列执行阻止新派发；已领取或可能已唤醒的轮次没有原生停止证据不能返工；默认三轮上限 | 单次范围、人工已有改动及业务权限；不要用别的数据库绕过约束 |
| 取消只作用于本轮 | `src/persistent-service.ts` 的 stopAttempt；`src/native-desktop-trigger.ts` 的 cancelAttempt | task/attempt/session、目录及最近唤醒归属校验；持久记录已发取消，失联或不明确时保留 stop_unconfirmed | 人工在同会话发起其他工作时在原生界面核查；不按进程名清理 |
| 超时不可被迟到报告改成成功 | `src/desktop-queue.ts` 的 checkDeadline/report；`src/run-journal.ts` 的 cancel | 绝对启动与业务期限；认证迟到报告作为 blocked 成果保存，首次取消/截止原因保留 | 阅读真实部分成果；不要把 blocked 当作 needs_review |
| 引用验证对应当前源码 | `src/worker-result.ts`；`src/desktop-queue.ts` 的 report；`src/coordinator.ts` 的 accept | 新增保留验证引用与记录SHA256；finish、认证report和accept复核命令完成、退出码0、清理成功、输入前后哈希及当前文件；记录改写或删除也阻止验收 | 引用是可选的，inputs 可能不完整；覆盖范围、未列依赖及验证方法真实性仍要独立查证。旧报告没有保存引用，不追溯宣称此保证 |
| 验收绑定真实当前轮次 | `src/coordinator.ts` 的 accept；`src/task-store.ts` 的 updateAttempt | 队列身份、认证报告摘要、来源、停止证据和待验收状态；提交时原子检查轮次/状态；独立证据不能为空，附加产物必须存在且非空 | evidence 的业务含义和充分性；界面、权限、持久化等需求是否真的满足 |
| 有界验证和进程归属 | `src/bounded-command.ts`；`scripts/bounded-job.ps1`；`src/command-cleanup.ts` | 设计为独立Job/进程组、有界执行及清理证据；125或清理不明不算通过 | 当前机器是否允许执行PowerShell helper；本次真实进程样本受执行策略限制，见下文 |

这些检查防止协议误用和错误验收，不构成对同一操作系统用户恶意篡改本地数据库/证据的安全隔离。报告引用只覆盖列出的输入文件及检查时刻；其他编辑器仍可能在检查之后修改源码。

## 本次修复

1. 原先同taskId、不同需求静默返回旧任务。现对初始请求保存不可随返工改变的指纹，检查目标、目录、会话、范围、验收、模型、会话模式和预算；并发冲突也不增加提示。旧库用可空列迁移，不改已有历史内容。
2. 原先 finish 检查验证记录后丢失引用，accept 无法识别回报后源码变化。现把引用及记录摘要纳入认证报告内容、写入轮次快照，验收再次复核；同时补齐队列报告的身份与待验收状态核对。

未引用验证的任务仍可由 Codex 实际查证后验收；没有把所有任务强制改成运行测试，也没有推断空 inputs 表示源码已验证。

## 验证结果

- TypeScript 编译通过。
- 最终发布目录相关回归合并运行139项：133通过、6项平台用例跳过、0失败。
- 核心回归：122项，116通过、6项macOS生命周期用例按平台跳过、0失败。覆盖 coordinator、reliability-v2、task-store、queue-reliability、persistent-service、workspace-workers、native-desktop-trigger。
- 打包：8项通过，包含独立技能包中的新示例和白名单隔离。
- 初次在沙箱运行的集成组：37项中32通过、5失败；失败均发生在Windows有界执行/进程清理样本，PowerShell在启动 `bounded-job.ps1` 时被沙箱所见执行策略拒绝，实际返回125而非预期退出码。后续本机与原生WorkBuddy复验已补齐，见下节。
- 测试使用仓库已有 `test/support/typescript-loader.mjs`；默认tsx在当前Windows沙箱中因os.userInfo失败，不能据其启动失败判断业务回归。
- skill-creator 的 quick_validate.py 通过；PyYAML仅装在隔离目录output中。
- 安装脚本在临时CODEX_HOME中检查首次安装及重复安装；Markdown本地链接与示例JSON另做结构检查。
- 新增回归包括请求冲突/并发/重连/旧记录兼容，以及回报后源码变化、验证记录改写/缺失、身份错配和未变化记录可正常验收。

各组原始日志仅保存在本机；本报告保存结果摘要，不将本机单元测试日志称为WorkBuddy原生执行证据。

## Windows 进程清理复验（2026-10-18）

结论：此前5项失败来自Codex沙箱的策略环境差异。本机正常用户和原生WorkBuddy都能执行原有helper，无需修改网关运行代码或系统策略。

- 同一绝对路径的Windows PowerShell：沙箱观察有效策略Restricted、CurrentUser=Undefined；经批准的正常本机上下文观察有效策略RemoteSigned、CurrentUser=RemoteSigned。helper文件仅有默认数据流，没有Zone.Identifier。
- 使用原有测试加载器在正常本机上下文运行 `test/bounded-command.test.ts` 和 `test/command-cleanup.test.ts`，9项全部通过。增强了正常退出和取消样本，使其实际创建detached子进程；超时、取消、正常退出都检查PID返回ESRCH，不能把EPERM误当成已退出。嵌套Job的真实清理与中断记录恢复也通过。
- 原生WorkBuddy通过desktop_queue完成一个专用样本任务；派工及配置均显式使用已确认x0.00的deepseek-v4.1-flash，没有自动换模型。真实任务、轮次与会话标识仅保存在本机。
- 原生正常样本exitCode=0、stdout标记正确；预期超时样本exitCode=124、reason=timeout。两者cleanupConfirmed=true、ownership=windows_job_object。2秒超时样本包含启动/清理的总耗时为4681ms，不把启动及清理开销当作命令本身的超时预算。
- Codex独立读取原始command记录、核对样本源码前后与当前SHA256；正常样本、超时父进程与detached子进程的三个PID均确认ESRCH。未调用任何进程停止接口。
- 使用新版官方MCP启动器确认原生会话remoteStopped=true后独立验收，任务已accepted。原生报告没有保存validationRecords引用，本次直接检查了原始记录及源码，不宣称自动引用复核已覆盖它。

脱敏结构化结果见 [windows-job-verification.json](windows-job-verification.json)。原始日志、会话标识、PID与本机执行目录不随仓库发布。沙箱中的限制仍然存在；今后应在批准的正常本机上下文做这组系统集成验证，不降低执行策略或绕过沙箱。

## 部署与生效

仅复制本次改动文件与对应构建产物，部署前核对源文件没有偏离隔离副本基线，并备份原文件。保留私有配置、任务库、会话映射和原仓库暂存区；本次提交保存在隔离仓库。

运行标识为 `reliability-20261018.1`。磁盘更新不升级已连接的MCP或已运行的常驻服务；新MCP进程/官方启动器会加载新代码。当前旧MCP连接须重连后才具备新的accept检查。未修改的常驻泵可继续监督旧任务，不因本次文档或验收修复重启WorkBuddy。

效率对照实验不在本次范围，没有开展第三项。
