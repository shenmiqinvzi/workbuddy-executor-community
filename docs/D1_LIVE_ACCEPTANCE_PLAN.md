# D1 双执行器真实验收方案与样本

日期：2026-11-05；C 线从 `882acc8` 准备。**本文是可执行的后续方案，本轮仅准备，未派工。** 当前两端都未取得本任务的实际选模/费用确认；没有安装切换、登录、ensure_workspace、选模准备、send_task 或计划授权调用。现状和53项矩阵见 [D0交付账目](D0_D1_DELIVERY_READINESS.md)。

## 1. 目标、边界和当前阻塞

目标对应 D1-01/02：在最终可回退候选安装上，通过**已安装技能 + 当前聊天真实 MCP**，串行完成 WorkBuddy、DSH 各一个真实代码任务，取得独立命令/语义审查、认证报告、原生停止、不可变 reviewId、accept/closed。直接调 TaskApplicationService、候选临时 SDK、只写结果文件、worker 自报测试或空 requiredChecks 均不能替代。两个正常样本不代表 D1-03/04 或完整D1全部完成。

| 执行前条件 | 2026-11-05 当前事实 | 后续达成方式/负责人 |
|---|---|---|
| 可回退候选 | 当前代码基线882acc8与生产运行摘要不同 | A提供具体差异/备份/回退/活动任务保护；集成人补A/B/C后核对最终包，再按明确安装授权切换 |
| 安装技能/MCP/桌面一致 | 技能6文件一致，MCP仍旧网关；固定桌面查询0进程 | 获准安装后核对磁盘清单、health加载摘要、桌面目标/版本、服务注册与进程；重载不等于自动登录 |
| 真实会话 | health offline/ready=false；本线未准备或发现新会话 | 获准连接后只读目录发现精确宿主/项目会话；DSH不猜最新，不造替代，登录由用户完成 |
| 部署/任务政策 | 保存的allowlist仅WorkBuddy指定模型、requireFree=true，磁盘DSH_ENABLED=0；活环境/历史任务政策未完整核对 | 保持所有原限制；若要启用DSH或改变限制，先给具体差异由用户明确决定，不自动“修正政策” |
| 容量与原未知任务 | 配置任务库有slot1占用；原P0-1裁决不变 | 只读识别真实归属、原请求/会话及停止证据；未满足条件保持阻塞。不得清库/换库/TTL释放换取空闲 |
| 每个样本的实际选择 | 本轮只有开发授权，无真实模型任务选择 | 真实目录返回后逐任务展示执行器/来源/精确模型/推理/费用并取得实际选择；不能从旧样本复制授权 |
| 原T7D交付判定 | 独立新样本不自动替代原补验 | 即使用户另行授权独立实验，也须证明与原请求/会话无重叠；是否满足原交付条件另记明确决定，原未知记录不改 |

共享容量仍为1。第一端确认原生停止并完成accept/closed、核对容量安全交接后才能开始第二端。若原P0-1/其他原请求依然未知而阻止开工，就交付准备材料和阻塞事实，不启动“另一个库”的旁路。

## 2. 两个小型代码约定（D1-02）

下列600秒、最多1轮是**待用户确认的提案上限**；部署/历史限制可能更严。免费、付费、价格未知都不在本方案中预选，价格未知不作免费或硬上限保证。正式约定保存服务器算出的绝对deadline，不因轮询/重连/输入等待延长。maxAttempts=1意味着不能在本样本内追加返工轮次；返工另按§6预先约定。

| 项 | WorkBuddy代码样本 | DSH代码样本 |
|---|---|---|
| 专用目录 | `<RUN_ROOT>/workbuddy` | `<RUN_ROOT>/dsh` |
| 唯一可改文件 | `src/clamp.mjs` | `src/paid-summary.mjs` |
| 可复现缺陷 | 有限number的clamp错误组合上下界，区间内/低值/高值会出错 | summarizePaid错误计入pending；应只计算status严格等于paid的数量和整数分金额 |
| 必须保留 | 非有限值/错误类型TypeError；lower>upper RangeError；负数、小数、端点/零宽度正确，无副作用 | paid/pending/refunded状态与非负安全整数校验；空值/零金额；输入不可变；累计溢出拒绝 |
| 不可改 | `checks/acceptance.test.mjs`、README、外部contracts/owner/baseline、其他文件 | 同左 |
| 原始必需命令 | Node `--test --test-reporter=tap checks/acceptance.test.mjs`，生成时绑定绝对Node路径、准确cwd与inputs | 同左 |
| 必需语义 | 所有数值/校验语义；原检查/约定哈希未变、无越界/旧改动丢失 | 状态过滤/金额/不可变/校验语义；同样的保护检查 |
| 最大提案预算 | 600秒、1attempt，未选来源/模型/费用 | 同左 |

不使用项目根目录或真实业务代码；无网络/依赖安装、没有“把测试删掉便通过”的验收路径。测试位于允许读取的工作区内，避免历史T7B项目外检查器的 `SCOPE_PATH_OUTSIDE` 问题；写范围仍只有唯一src文件。

### 2.1 重复生成与完整性验证

在包含本线脚本的 `gateway` 下，可执行以下**仅准备样本**的命令；`<C_OUTPUT>` 应替换为本线自有绝对目录：

```text
node scripts/live-acceptance-fixture.mjs create --parent <C_OUTPUT>/samples
node scripts/live-acceptance-fixture.mjs verify --root <NEW_RUN_ROOT> --baseline-sha256 <SAVED_SHA256>
```

create每次在指定parent创建唯一`live-acceptance-*`子目录，无reset/覆盖/清理入口；拒绝绝对路径缺失及已有符号链接/junction祖先，包括尚不存在的子目录。不会扫描或写生产目录。`create`退出0只表示准备完成。

输出 `preparedOnly=true, authorized=false`、root、`baselineSha256`和两端路径；生成的contracts是**包装草稿，不是可直接提交的TaskContract**：`execution=null, collaboration=null`，所有操作均未授权。taskId/workspaceId/operationId是提案身份；正式采用后固定，不反复换键重试。

基线清单在worker工作区之外，仅两src文件标记mutable；contracts/README/checks/owner均记录摘要。审查者必须把create返回的 `baselineSha256` 保存于worker不可写的独立证据记录。verify必须传外部保存值，不能每次从可改baseline重新求值来“刷新基线”。它核对受保护文件、增加的文件/空目录和链接；仅返回准备完整性，不证明语义正确或真实执行成功。检查脚本保护是约定+外部哈希检测，并不宣称OS沙箱。

正式选模后**复制草稿中的contractTemplate到独立agreements目录**再完善；不修改受保护的原草稿/基线。新授权条款的摘要另存。若改检查、范围或预算，应生成/评审新的准备约定，不能覆盖已派任务的原约定。对已有效果不明的操作，只观察原身份。

### 2.2 必需检查必须是精确 CommandSpec

生成器的 `requiredChecks` 包括 `independent-command`（command）、`behavior`和`protected-checks`（semantic）。command的definition是以下结构的**JSON字符串**，不是普通命令文字：

```json
{
  "executable": "<NODE_ABSOLUTE_PATH>",
  "args": ["--test", "--test-reporter=tap", "checks/acceptance.test.mjs"],
  "cwd": "<EXACT_SAMPLE_WORKSPACE>",
  "timeoutSeconds": 30,
  "inputs": ["<src/clamp.mjs或src/paid-summary.mjs>", "checks/acceptance.test.mjs"]
}
```

采用生成的实际值，不原样提交占位符。服务器 `task-reviews.ts` 按原约定JSON摘要匹配，随意拼字符串或现场换executable/args/cwd/inputs不会成为匹配证据。审查时同时核对退出码、实际测试数7、零失败/零跳过、输入哈希/清理确认和语义；空测试退出0也不能通过。

## 3. 正式开工前的最少用户选择

准备材料先交付；下面表格等真实目录可用后填写，**本轮不请求也不伪造用户答复**：

| 必填 | WorkBuddy样本 | DSH样本 |
|---|---|---|
| 实际executorId | 待用户选择确认 | 待用户选择确认 |
| connectionId / providerId | 由当前真实目录给出，待选择 | 精确host/来源，待选择 |
| modelId / reasoningEffort | 真实可用ID；档位未提供时明确null，不代填 | 目录可用ID/档位，不能取Codex审查模型配置 |
| 报价/单位/时间/来源；实际费用可观测性 | 未知；读回后如实展示，不能复制历史x0.00 | 未知；credits:null不是零，代理可见层和限额能力明确 |
| 范围/检查/期限/轮次/费用要求 | §2提案，待实际确认 | 同左 |
| 精确workspace/session/host | 空闲/归属/无重叠核对后记录 | 同左，禁止自动替代会话 |
| 真实确认记录 | 确认时间、可信入口、约定摘要 | 每任务各自记录 |

此外需明确候选安装授权及回退边界、若必要的DSH部署/政策变更，以及原未知任务不重叠/交付判定。无需把密钥发到聊天。没有回复就保持等待；不得默认挑最便宜、免费模型或换一个模型。历史P0-5补验文档存在“缺模型时选最便宜”的旧操作描述，**本方案不沿用该描述**，以当前AGENTS逐任务明确选择规则为准，历史记录保持原样。

## 4. 获准后的执行顺序与参数

本节仅是后续操作手册，本轮未执行这些写入步骤。先核对A/B/C最终候选及所有§1条件，再由已安装技能引导：

1. **只读就绪核对**：读取当前MCP health、`workbuddy_list_executors`、相应模型目录与精确项目会话。WorkBuddy使用真实session的目录；DSH通过`workbuddy_list_dsh_sessions`定位精确host/session/workspace，目录来源/选择/观察模型分开。无候选、多候选、忙碌、错路径或能力未知时停在明确原因，不准备模型。B的诊断可作参考，不代替当前原生事实。
2. **可信入口建立方案**：用户实际选择后，复制contractTemplate，填真实`execution={executorId,connectionId,providerId,modelId,reasoningEffort}`。在尚未获服务器planId时，可使用当前 `plan-cli.test.ts` 同样的占位`collaboration={planId:'pending-d1-plan',expectedPlanRevision:'pending-d1-plan'}`创建提案；它不能派工。通过受信本地操作者执行下面的register/create/authorize（或等效可信桌面入口），再把返回的planId/revision填入正式合同，保留termsHash/政策版本/确认来源。agent不能自称用户确认。

   ```text
   node scripts/plan.mjs register <workspaceId> <EXACT_WORKSPACE> <displayName>
   node scripts/plan.mjs create --contract <AGREED_CONTRACT_FILE> --reason <ACTUAL_REASON> --mode manual --ttl 900 --operationId <CREATE_OPERATION_ID>
   node scripts/plan.mjs authorize <RETURNED_PLAN_ID> <RETURNED_REVISION> --source <ACTUAL_TRUSTED_CONFIRMATION_SOURCE> --operationId <AUTHORIZE_OPERATION_ID>
   ```

   这些命令会写库；只能在获准的最终安装、明确指向与当前MCP一致的数据环境中由可信操作者执行。不要直接在源码树用默认loadConfig意外创建另一个账本，不把上面的命令当本轮只读采集。plan工具故意不暴露到MCP/HTTP，不能自行补一个确认API。方案过期或条款变更必须重新向用户展示并确认，不能把旧确认转移过去。
3. **唯一派工**：通过当前聊天 `workbuddy_send_task` 提交正式vnext-2合同（由`execution.executorId`路由WorkBuddy/DSH），传`taskId=contract.taskId`、精确`workspace/sessionId`、`objective`和固定send `operationId`。`contract`只传正式合同，不传带authorized:false的草稿包装；不要另传冲突的legacy scope/model。DSH的host须与execution.connectionId一致。保存完整返回，服务器生成的attemptId/实际revision不能预造。
4. **监督**：`workbuddy_wait`等现有观察入口持续监督原task/attempt；采用full详情作为证据。记录claim、请求/会话、模型准备读回、报告认证、等待输入、deadline、原生terminal。brief只作进度摘要。若send超时/重连，先恢复原operation回执与原task，不能再用新键、换执行器/会话或新库试一次。
5. **独立验收前提**：完整报告来自原身份且认证通过，原生停止可证，文件范围/旧修改/检查基线正确。worker自报完成后不立刻accept；按§5核对停止。`not_dispatched`只证明未派出，不能拿来通过“真实代码任务正常完成”。
6. **后端独立检查**：按最新task返回刷新expectedAttemptId/expectedRevision；调用`workbuddy_run_review_command`，checkId=`independent-command`，用固定独立操作ID。它运行原CommandSpec，不允许任意命令覆盖或再调模型。保存服务端machineCheckId、输入摘要、完整日志、exit/cleanup；随后以新revision调用`workbuddy_check_task`生成当前程序批次。缺命令时unknown记录保留，checker_error不当内容失败，更不能语义豁免必需项。
7. **语义与不可变review**：审查者独立看源码/差异、7项实际检查及外部完整性验证。调用`workbuddy_review_task`传最新身份/revision、当前批次machineCheckIds、`behavior`与`protected-checks`的passed/failed/unknown/checker_error及真实evidenceRefs、固定operationId和说明。失败/未知/检查器故障均不能accepted；更正用新review并supersedesReviewId保留旧历史。证据引用使用服务端可识别且保存的来源，不凭空造checkId或文件引用。
8. **最终接受与关闭**：仅全必需项通过时，以当前reviewId和最新committedRevision/attempt调用`workbuddy_accept_task`；不要误用review的basisRevision，也不用旧note/evidence验收参数。服务器重核认证/原生停止/当前文件。只读重开验证accepted、绑定同review的task_closed、原deadline不变；若容量没有可证安全释放，第二端仍不能开始。
9. **第二端**：再次核对实时目录/政策/容量，取得它自身的实际选择，再重复以上流程。不共用task/attempt/plan/review/operation，两个结果分开报告；一端失败不被另一端成功抵消。

现有MCP验收工具的必需参数速查（实际revision每次读取，不能复制旧值）：

| 工具 | 参数 |
|---|---|
| workbuddy_run_review_command | taskId, expectedAttemptId, expectedRevision, operationId, checkId |
| workbuddy_check_task | taskId, expectedAttemptId, expectedRevision, operationId |
| workbuddy_review_task | taskId, expectedAttemptId, expectedRevision, operationId, machineCheckIds, semanticChecks[{checkId,status,evidenceRefs,note}], note；更正时supersedesReviewId |
| workbuddy_accept_task | taskId, expectedAttemptId, expectedRevision, operationId, reviewId；保存full结果 |

## 5. 必须留存的原生停止与身份链

按 `run-journal.ts:hasNativeStopEvidence()` 和对应coordinator，不用报告关键词或进程消失替代：

- WorkBuddy：原task/attempt/session/runtimeSource匹配；nativeStopSource为`native_idle`或`not_dispatched`且nativeStoppedAt有效，或历史`native_idle_verified`、`native_failure_verified`、`native_idle_without_report`监督标记。发生nativeFailure时，另须failure→stopControl issued/acknowledged→至少两次idle观测的时间链，观测跨度至少1000ms；失败后仅一次idle不够。`end_turn`是worker报告的stopReason，取消请求只表示已请求停止。
- DSH：requestId===attemptId，session和host与原binding/snapshot一致；terminal.seq有效，type为completed/failed/cancelled，rawType为`turn/end`，或cancelled配`agent/inbox/spliced`；nativeStopSource为`dsh_terminal_event`且nativeStoppedAt与terminal.at逐字相等。另有未派出拒绝路径，不算正常代码完成。
- 两端均记录executionStatus.remoteStopped=true及其原生来源，认证报告、停止、独立检查、审查、accept分别存证。结果文件、取消回执、进程不在、正文有“完成”、面板有数字均不足。原生许可/输入由用户处理，既不代批也不因等待延长期限。

## 6. 返工与异常场景的后续排程（D1-03/04）

历史记录可引用，但不能改成当前版本通过；不能以正常样本覆盖以下各项。仅在单独获准的可控样本中演练，不能杀真实共享宿主或改原P0-1。

| 场景/矩阵 | 已有证据及边界 | 当前候选补验方案/通过条件 |
|---|---|---|
| 原身份返工 V08/C06/C17 | T6的旧attempt/旧review合成拒绝，历史实际返工记录按其原版本；本次一轮样本没有返工 | 另行提前约定最多2轮、同task/session/模型/绝对期限；计划两阶段演练与真实质量缺陷返工分开命名。第一轮停止并保存失败审查后才能continue，attempt按程序新建，不重send新task；旧review不可accept |
| 领取后取消 V04/C07 | T5/T6历史停止/取消、本地run7保留不确定；资源故障线为替身 | 在测试任务真实claim后有界取消，只针对原请求；保留cancel_requested直到原生停止，stop不明不释容量、不重派。需要原生中断授权，不能从准备授权推断 |
| 执行中重连/重开 V06/V11/F08 | T7B working时关/开桌面，T7C当前MCP/重开历史版本 | 当前候选仅重连测试客户端/工作台，保存原operation/task/attempt/deadline，无第二派发；关闭/重开具体测试窗口须明确授权 |
| 已知/未知输入等待 V02/F06 | run6及前端源/合成证据，不构成当前双端真实输入等待覆盖 | 准备非破坏且可控的原生输入请求，由用户在原生处理；显示详情或未知、期限不变、不代批；无法自然触发则标未覆盖 |
| 报告先到仍忙 V03 | run6 §6.8历史停止窗口；停止围栏合成回归 | 先用假执行器故障注入确认三入口拒绝，再在获准原生样本观察；若没触发不能写实机通过，不改报告/停止记录造窗口 |
| 不确定准备/投递 V06/C07 | t4a/t4b/容量合成、run7历史未知 | 隔离合成先做准备边界中断/超时/重启；只能恢复原意图/回执，未知保持占用。真实故障注入另授权，不换库制造成功 |
| 到期与迟到 V05/F07 | 当前源码/合成及历史片段 | 单独短期契约，原deadline后才接迟到报告；原终态保留、不可验收、不增加期限/轮次；真实长耗时不在本轮默认执行 |
| 旧源码/证据 V08/C17 | T6合成不可变审查/失效，C完整性专项 | 假执行器先验证检查后改源码/旧attempt拒绝；再对专用副本有界复核。保存失败，重新检查不是覆盖旧review |
| 跨入口/双进程 C07/V06 | t4a/t4b/mcp-entry合成，资源线双端替身 | 隔离DB/假原生同时请求，同操作至多一次效果、不同任务容量1；生产共享容量不能用于压力注入 |
| 模型缺失/三轮/硬限 V10/C05/C13 | 准入合成；本次只读旧allowlist | 合成分别触发缺失/漂移/预算耗尽/硬限不支持，程序拒绝不换模型；不靠多次真实扣费测试预算 |

这些演练的隔离数据库是**假执行器故障测试**，不能用于绕过真实任务库占用而派真实模型。每项补验单独标合成/真实/窗口/未覆盖，沿用原T7D审查门槛；无法触发的原生场景保持未验证。

## 7. 一次真实运行的交付证据格式

原始证据仅本机受控保存；公开摘要使用别名和摘要，不发布账号、token、命令行全文、原生聊天正文、数据库或runs。至少按端分别保存：

| 文件/记录 | 必填内容 |
|---|---|
| run-identity.json | 实际candidate提交/包SHA/运行codeHash、已安装技能6文件对应、Node/Windows/宿主版本、执行路径为installed-skill+current-MCP、取样时间 |
| agreement.json + selection-confirmation | 正式合同/termsHash/planId及revision、政策版本/历史限制、本次选择/报价/费用未知披露、期限/最大轮次、可信确认入口 |
| identity-timeline.json | taskId、send/review/accept各自operationId、每个revision、attemptId、sessionId/hostId、requestId、runtimeSource、来源/请求模型/观察模型/推理档位、claim/report/stop/closed时间 |
| baseline + scope evidence | 外部保存baselineSha256、原失败日志、原/后源码摘要、受保护文件/旧用户修改摘要、verify结果和实际diff；原稿不改 |
| native/report evidence | 原报告authentication，绑定身份，原生事件/stopControl/idle或DSHterminal，remoteStopped及证据来源；不从正文推断认证 |
| independent-checks / review | 后端CommandSpec摘要、machineCheckIds、7项统计、exit/cleanupConfirmed、输入hash、语义evidenceRefs、reviewId/basisRevision/committedRevision、旧失败记录 |
| final-state / reconnect | accept回执、同review的task_closed、重开后原身份/状态/deadline、可证容量安全交接；未取得则null并说明 |
| coverage-and-gaps | §6每项实际覆盖、版本/类型/未覆盖，真实费用/调用数无法归因时null；不能以报价/余额差填实扣 |

判定：一端正常样本通过必须全链有证据，任何必需项failed/unknown/checker_error/not_applicable都不能accept。两端均通过只证明D1-02对应样本；D1-03/04、原交付决定、安装/异机/最终CI仍按矩阵单独收尾。

## 8. 本轮准备实测与交接

证据根目录同D0 `<C_EVIDENCE>`；本轮保留的正式待执行样本：`samples/live-acceptance-9ABtZo`，外部记录 `prepared-fixtures.json`，baseline SHA-256 `24b1d710a0537a2c34a36db57f5eea1ea465ea748b18007ff09ea2234f8db17d`。此目录两端源码**保留原始缺陷**，未选模、未派工；参考修复只在另一个`reference-probe/`生成目录和专项临时目录执行，不冒充worker产出。

| 实际命令/动作 | 退出码与统计 | 证据 |
|---|---|---|
| `node --test test/delivery-baseline.test.ts test/live-acceptance-fixture.test.ts`（gateway目录，Node24.19.0；TEMP/TMP指C自有test-temp） | 最终19/19通过，0失败/跳过，exit0 | c-tests-final-release.log；源DB/WAL/SHM不变/临时副本清理、源回滚journal拒绝、脱敏/未知状态、注册与运行分开、样本/篡改/链接边界 |
| `node <C_EVIDENCE>/capture-local-inputs.mjs`（早期方法） | exit0；候选570全等，安装487相同/53不同/30缺失；源库SQLite只读连接的SHM零变化未验证 | baseline.json、baseline-capture.log；保留初版限制，不作为最终源零写入证据 |
| `node <C_EVIDENCE>/capture-source-isolated.mjs`（最终方法） | exit0；仅文件读取源DB/WAL，在C自有临时副本查询；源DB/WAL/SHM前后摘要全部相同，副本已删除；政策/容量结论未变 | baseline-source-isolated.json、source-state-stability.json、baseline-source-isolated-fixed.log；无原子快照/有效政策已核实声明 |
| `delivery-baseline.mjs` 新服务注册投影 | exit0；磁盘注册v1，安装时间2026-10-31T06:43:39.233Z，gateway/db目标匹配，runtime=null、loadedCodeVerified=false | service-observation.json；没有重启服务 |
| `node <C_EVIDENCE>/prepare-and-check.mjs`（调用实际create/verify CLI） | exit0；原WorkBuddy 7项中2过5失败、命令exit1；原DSH 5过2失败、exit1 | prepared-fixtures.json、fixture-checks.json、fixture-original-*.log；预期红灯 |
| 同脚本单独reference-probe最小修复后检查 | 两端各7/7、exit0；原/参考两个目录完整性verify均ok | reference-fixtures.json、fixture-reference-*.log；纯本地参考修复，非真实模型 |

验证历史完整保留：`c-tests.log` 首跑15项14过1失败，子进程继承NODE_TEST_CONTEXT未独立运行预置检查；修正并断言实际7项后 `c-tests-fixed.log` 15/15，新增摘要/注册用例后 `c-tests-final.log` 17/17。随后补SHM断言的 `c-tests-final-shm.log`、`c-tests-copy.log` 各有1失败：夹具在取before摘要后自己查询schema，污染采集测量窗口，不能将该变化归因采集器。把夹具SQL移出窗口，并将实现收紧为不对源库建立SQLite连接，增加scratch拒绝测试后18/18，再补充拒绝源回滚journal的测试形成最终19/19。初版源SQLite只读连接仍可能参与SHM协调，因此不用其宣称源三文件零变化；最终本机文件摘要另已核实。

取样适配器首次 `baseline-source-isolated.log` 因Windows绝对路径ESM导入格式失败，尚未读取源库；改为file URL后成功，日志另存fixed。没有把环境/检查器失败当worker失败，也未拼成一次全绿。未重跑882acc8全量、前端/C#套件，未改其业务逻辑；最终A/B/C集成由集成人统一检查。

集成交接：本线负责两份文档、两个`scripts/*.mjs`和两份`test/*.test.ts`，不碰A/B业务文件。请集成人在 `gateway/scripts/package.mjs` 的脚本白名单加入 `scripts/delivery-baseline.mjs`、`scripts/live-acceptance-fixture.mjs`，统一快照/最终包并从解包实际复跑这两个CLI；无新依赖/前端资产需求。本机证据和生成样本不进发布包。最终包、安装/运行摘要和A/B新结果更新矩阵时另列版本，不覆盖本轮事实。

下一次可开展的工作顺序：审A/B/C → 集成/最终候选 → 审查具体安装差异并取得所需授权 → 核对原未知/容量及精确会话 → 每样本真实选择确认 → 串行执行§4 → 安排§6剩余项 → 更新矩阵/发行范围决定。本轮停在“准备完成，真实验收待条件”，没有将D0/D1标为全部交付。
