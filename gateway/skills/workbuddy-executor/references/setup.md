# Windows desktop-queue 连接与恢复

仅接通或异常时读取。本部署使用 desktop-queue，不使用 Agent Hub。

## 本机部署与模型政策

本机网关 `F:/WorkBuddy/codex-workbuddy-gateway`，Node `F:/node.exe`。迁移时只更新本节及已有服务注册中的真实安装位置，不把示例路径当成配置。网关由自身安装目录加载 `.env`，显式进程环境优先；保留 `.env`、任务库、会话映射及原任务身份。

本部署 `.env` 设置 `WORKBUDDY_REQUIRED_FREE_MODEL=deepseek-v4.1-flash`。该开关启用原生配置与唤醒时的模型 ID/免费状态硬校验；不设置时通用网关允许原生模型选择，技能文字本身不提供费用保障。不能为绕过阻塞取消此配置。list_models 的免费信息是本次观察，不代表额度或后续平台一定可用。

网关在原生模型配置确认后授权本轮领取，再发唤醒；立即领取的 helper 不必等唤醒回执。默认未接单窗口180秒、总期限1800秒、最多三轮；以已有配置和返回的 claimDeadline/deadline 为准。技能文字不能修复正在运行的旧网关。

## 查询与备用入口

优先现有 MCP 的 get_task/wait。安装文件更新后，当前聊天可能仍连接旧内存版本；可用新进程官方启动器加载新构建，不必创建新任务：

```powershell
& 'F:/node.exe' 'F:/WorkBuddy/codex-workbuddy-gateway/scripts/workbuddy-call.mjs' workbuddy_get_task '@C:/absolute/task-arguments.json'
```

参数文件为真实 JSON，例如 `{"taskId":"已有编号","detail":"brief"}`。不拼接多行文本、命令替换或凭据。启动器从本机加载环境，不打印凭据。它会同步本地任务记录，因此不属于完全无写入的离线查询。

MCP 查询不可用或权限不足时，可先使用专用离线快照入口：

```powershell
& 'F:/node.exe' 'F:/WorkBuddy/codex-workbuddy-gateway/scripts/workbuddy-inspect.mjs' '@C:/absolute/task-arguments.json'
```

离线入口只读 SQLite 和执行目录，不初始化/迁移数据库、不 chmod、不发任务、不提交结果、不连接原生接口。`snapshotOnly=true` 表示保存状态，`observedAt` 是原证据时间；不能把它当成刚刚确认的原生停止。`workerResult.present=true` 但 `authenticated=false` 表示存在尚未被队列认证的结果文件，应检查现有文件，不能据此报成功。Windows 数据库沿用 NTFS 权限，不通过放宽权限解决查询失败。

查询报锁繁忙时最多原样重试一次，然后读上述快照并核对现有轮次；不循环读同样的日志、不重派任务。若现有 MCP 恢复且任务仍 working，可继续有界监督。登录或原生权限须在 WorkBuddy 界面处理，不改安装包、账号、原生数据库或安全设置绕过。

原生模型接口可能把 502 等错误写为 incomplete 消息，同时正常结束 sendMessage。新版监督器会只读检查当前会话、精确匹配本轮 wake 标记的原生历史，在原生空闲时暴露该错误；不自动切模型或重发。平台网络错误仍需恢复服务后再按原任务预算返工，不能将“网关已修复”说成平台一定可用。

回报格式与失败处理统一见 [执行规范](execution.md#进度与回报)。

新版 send_task 对初始请求保存指纹；同一 taskId、同一请求复用原任务，目标、范围、会话、模型或预算不一致会明确报冲突，不投递新提示。恢复查询用 get_task/wait，修正用停止确认后的 continue_task。旧记录没有初始指纹时只能检查仍可确定的冲突，不能声称完整比对过旧请求。

## 停止与恢复

先核对原 attempt 的原生状态和已有文件。queued/working 继续有界监督；needs_review 也要等 remoteStopped=true 才能返工或验收。cancelRequested 与 remoteStopped 是两回事。原生停止而缺报告仍属阻塞；不补造成功。

主机休眠不会自动延长绝对期限。启动期限到而未领取，说明启动阻塞，不等完整业务预算。时间到期或连续确定拒绝唤醒时保留成果、确认停止；已投递但不明确接收时尤其不能重发。

默认最多三轮（首次加两轮返工）。正常返工保留 taskId/sessionId，只有原生确认停止后才继续。更换模型、新任务或新会话不能绕过旧执行未停止及次数限制。

## 版本与停止证据

health/get_task 返回 runtime.release、pid、startedAt、codeHash，均在进程启动时捕获。核对 MCP 与常驻服务 state.runtime 是否为同一部署；磁盘文件更新不代表旧 MCP 内存已更新。当前工具若缺 runtime，应使用上面的官方启动器加载新进程，保留原任务身份；不要用旧进程派工来验新版行为。

正式取消和超时已集成原生 session:cancel。停止前核对当前任务三重身份、最近原生用户消息唤醒标记和工作目录；仅持久发出一次停止，再有界确认 idle。API 失败、失联或执行归属不清返回 stop_unconfirmed，不重发任务、不换会话，不误报停止。仅剩本轮命令清理证据不全时也不确认停止；保留日志并人工核查归属，禁止按进程名批量清理。

失联恢复后继续查原 attempt；重复取消只重新观察，不抹去首次截止失败。原生用户在同一会话发起了其他工作时归属检查会拒绝停止，需要人工在界面核对。恢复服务、原生登录/权限或这种归属冲突可能仍需人工；不修改账号、安全设置、安装包或原生数据库。

## Windows 验证环境

开发或验收 `bounded-job.ps1` 时，先在实际使用的 Windows PowerShell 中查 `Get-ExecutionPolicy`。Codex 沙箱与正常用户可能看到不同策略；本机已观察到沙箱为 Restricted、正常用户为 RemoteSigned。同一文件在沙箱中被拒绝，不足以判断原生 WorkBuddy 也失败。

通过已有授权在正常本机上下文运行隔离副本的 `test/bounded-command.test.ts` 和 `test/command-cleanup.test.ts`，并保留日志；当前沙箱的 tsx 若因 os.userInfo 失败，可使用仓库已有的 `--import ./test/support/typescript-loader.mjs` 测试入口。需要区分测试框架启动失败、helper 被拒绝、命令超时与清理失败，不修改执行策略、不加 Bypass、不换执行方式绕过限制。

真实链路检查由原生 WorkBuddy 在专用样本目录通过领取契约的 exec 运行，核对正常退出、预期超时的124、cleanupConfirmed、Job归属及本轮样本PID确已结束。预期超时是清理样本，不可作为退出码0的通过验证引用；原生停止证据和独立验收仍按主流程要求。
