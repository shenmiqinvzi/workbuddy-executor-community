# 执行、进度与证据

正常任务以 claim 返回的绝对路径和原样命令为准，不自行猜租约或会话。规范随每轮 prompt 重新给出，返工保留 taskId/sessionId 和原失败历史。

## Worker 执行约定

自行定位、实现和相关验证；范围内代码或测试失败，本轮最多两次针对性修正后复验，无进展或到期如实回报。业务执行遇服务或权限错误停止相关动作，不排障网关、改权限或换 shell。小修改用最小有效检查，不默认完整构建、清理 dist 或安装依赖。

## 有界验证

测试和浏览器样本使用领取契约的 `exec --claim-file ... --command-file ...`。command-file 为 UTF-8 JSON，executable 使用本次安装的真实 Node 路径，下面只是占位示例：

```json
{"executable":"C:/Program Files/nodejs/node.exe","args":["--test","sample.test.mjs"],"cwd":"E:/example","timeoutSeconds":60,"inputs":["sample.mjs"]}
```

按实际运行时间设上限，不统一把长任务裁成短任务。外层上限不能替代样本内部正确退出条件；浏览器样本自身也要设置页面等待/观察时限并关闭自建资源。exec 会限制到本轮 reportBy，报告预留期不再开命令。

Windows 执行器在进程仍挂起时把它加入独立 Job Object，再恢复执行；结束、超时或取消时清理该 Job 中的子进程，不根据进程名推断归属。其他系统使用独立进程组。124 表示超时、130 表示取消；125 或 cleanupConfirmed=false 表示执行监督/清理失败，不能报通过。记录在本轮 commands 目录：实际参数、开始/结束时间、退出码、归属方式、清理结果、stdout/stderr 路径及 inputs 源码前后哈希。

嵌套命令的外层结束可能使内层来不及写最终记录。Windows 下监督器会核对本轮唯一 spec 文件、直接创建的监督进程 PID/命令行与实际系统进程表；仅精确 Job 所有者已退出时记录句柄关闭所证明的清理。实际退出码仍未知，记125，不能当作通过的验证；无法证明归属或退出时仍为 stop_unconfirmed。此过程只补监督证据，不提交 worker 报告，也不清理其他进程。

## 进度与回报

阶段变化或约60秒有意义进展时写 progress-file，再执行契约里的 update 命令：

```json
{"stage":"验证","completed":"入口与异常分支已修正","running":"本地浏览器退出样本，外层上限90秒","blocker":""}
```

lastMeaningfulAt 只随内容变化前进；重复心跳不伪装进展。不修改文件的长测试、等待用户输入、工具超时和会话失联是不同状态，不靠无文件变更自动判死。

最迟 reportBy 开始整理回报（默认预留预算10%，最少5秒、最多120秒）。deadline 是绝对期限，休眠/失联不延长。来不及完成时报告实际部分结果、未验项与阻塞。源码检查、Mock、本地浏览器和真实环境分别标注；报告通常500字内，完整日志用 artifacts 引用。附本次实际命令、退出码、证据和遗留问题。

WorkBuddy 自己用 Write 在 reporting.resultFile 写 UTF-8 JSON，例如：

```json
{"status":"completed","text":"实际结果、修改文件、实际验证和遗留问题","artifacts":["真实成果绝对路径"],"validationRecords":["本轮 commands 目录内的实际通过记录绝对路径"]}
```

status 按实际选 completed、blocked 或 failed。validationRecords 可选，仅引用本轮真实通过的验证；记录中的 inputs 应覆盖被验证源码。未运行的检查不能报通过。网关检查引用的退出码、清理状态与源码哈希；没有引用、inputs 为空或遗漏依赖时，不代表已验证这些源码，覆盖是否足够仍由 Codex 判断。

新版在认证回报中保留引用与记录摘要，finish 和 accept 都复核；回报后修改源码、改写或删除引用记录会阻止验收。旧轮次没有保存引用时不能补称已获此保障，须由 Codex 查证当前源码及实际验证。

写完后原样执行 reporting.command，凭据由 helper 读取，不自行拼接。领取后的 prompt 也带同一回报契约。提交失败仅原命令原样重试一次；仍失败保留文件并结束。成功回报或空队列后结束，不循环 claim。已认证迟到报告保留为 blocked，不能覆盖截止结论或作为成功验收。

## 监督和统计

正常使用增量 brief 和45–55秒 wait；查证才请求 full/历史 attempt。重连复用 task/attempt/session，传 sinceEventSeq 延续游标。brief 不是验收证据，仍须真实认证报告、原生停止证明、Codex 独立检查。

受控验收记录每次监督工具名称、耗时、返回字节数，单列 worker 最终报告字节数、从派发到停止的耗时、人工纠错/终止次数。预定 cancel/返工与异常人工干预分开统计。网关内部泵轮询不是 Codex 监督调用；不要混算或据此估算 token 节省。
