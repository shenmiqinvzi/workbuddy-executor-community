# 启动链路诊断（RC6 只读，2026-11-06 夜）

对象：RC6 候选包（sha256 `c9f724d4…`）解包根 + 本树自建的桌面壳 `WorkBuddy.Workbench.exe`（`gateway/desktop`，Release 构建）。
边界：不计费、隔离、未安装 RC6、未真实派工、未登录、未移动或覆盖原 WorkBuddy 安装、未改系统策略/ACL/生产注册/旧任务状态。RC6 包字节未变。

## 1. 先修正上一版的四处越界表述

| 上一版写法 | 事实 | 正确写法 |
| --- | --- | --- |
| 「本机只有 PowerShell 5.1」 | Codex 执行上下文是 PowerShell 7.6.9（`C:\Users\LENOVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`） | 先前 DSH 执行上下文为 5.1；本机另有 7.6.9 |
| 「页面渲染成功」 | 窗口里的「工作台暂时无法连接」「重新连接」是 `Program.cs` 的原生 Label/Button | 窗口出现 ≠ 网页加载成功；本轮 `ready` 始终为 false |
| 「壳没有把宿主留住 / 宿主先退出」 | `StartAsync` 的每个 catch 都调用 `StopHost()` | 失败后查不到宿主是 `StopHost` 的结果，不能证明宿主先退 |
| 「把安装移到纯 ASCII 路径是已确认修法」 | Node 只读打开 `app.asar` 成功；日志里的损坏路径是历史记录 | 编码线索是假设；移动安装属安装动作，未获授权、未执行 |

## 2. 环境事实

- 用户 `神秘奇女子\lenovo`（非管理员，Medium 完整性）；Defender 实时保护关闭。
- WebView2 Runtime `156.0.4314.58`（HKLM WOW6432Node EdgeUpdate Clients）。
- 壳源码关键行：`gateway/desktop/Program.cs:150` `Directory.CreateDirectory(options.ProfileDirectory)`；`:156` `CoreWebView2Environment.CreateAsync(null, profile, envOptions)`；`:160` 之后 `EnsureCoreWebView2Async`；`:165` `Navigate(...)`；`startupStage` 依次 `runtime → host → host_ready → webview → navigate`。
- `gateway/desktop/DesktopPolicy.cs:55` `InstanceKey = SHA256(gatewayDir + "\n" + db + "\n" + runs)` 大写后取前 24 位；`:57-64` `ProfileDirectory` = `WORKBUDDY_WORKBENCH_PROFILE_ROOT` 或 `%LOCALAPPDATA%\WorkBuddyWorkbench\<key>\WebView2`。
- 快照通道：命名管道 `WorkBuddy.Workbench.<InstanceKey>`，请求 `{"taskId":null,"status":true}`，回一行 `{status,pid,windowHandle,gatewayPid,ready,taskId,page,startupStage,failureCode}`（`Program.cs:367`）。

## 3. 时间序阶段表（attempt-06，`2026-11-06T23:49:13.5699653+08:00`）

| 时刻（相对启动） | startupStage | gatewayPid | page / HTTP | ready | failureCode | stderr |
| --- | --- | --- | --- | --- | --- | --- |
| 17 ms | `host_ready` | 3052（存活） | `null` | false | 无 | 空 |
| 5.1 s | `webview` | 3052（存活） | `http://127.0.0.1:62997/workbench/` / **200** | false | 无 | 空 |
| 12.8 s | `webview` | 3052（存活） | 同上 / 200 | false | 无 | 空 |
| 16.9 s | `webview` | 3052（存活） | 同上 / 200 | false | 无 | 空 |
| 21.0 s | `webview` | 3052（存活） | 同上 / 200 | false | 无 | 空 |
| 25.1 s | `webview` | 3052（存活） | 同上 / 200 | false | 无 | 空 |
| 29.2 s | `webview` | 3052（存活） | 同上 / 200 | false | 无 | 空 |
| 33.2 s | `webview` | 3052（存活） | 同上 / 200 | false | 无 | 空 |

- 宿主确实由壳启动并解析到 `desktop_host_ready`，端口 62997，`/workbench/` 在同一时刻可访问（200）。
- 33.2 秒内 `startupStage` 停在 `webview`，`failureCode` 为 null，`WORKBUDDY_WORKBENCH_DIAGNOSTICS=1` 下 stderr 仍为空 → **没有异常抛出，是等待 WebView 环境/控制器创建未返回**。
- attempt-07：启动 10 秒后系统有 40 个 `msedgewebview2` 进程，但本实例 profile 目录 `0` 个条目；部分进程无法从当前上下文停止（`Access is denied`）→ 进程数不能归因本实例，更不能当成功证据。
- attempt-08（profile 根改到 `%LOCALAPPDATA%\wb-diag-20261106`）：`Directory.CreateDirectory` 抛 `System.UnauthorizedAccessException: Access to the path '…\wl-diag…\<key>\WebView2' is denied.`，`failureCode=UnauthorizedAccessException`、`gatewayPid=null`（catch 之后 `StopHost`）。

## 4. 权限对照（同一会话、同一用户）

| 动作 | 结果 |
| --- | --- |
| PowerShell 创建 `%LOCALAPPDATA%\wb-diag-20261106\<key>\WebView2` | 成功 |
| PowerShell 写 `%LOCALAPPDATA%` 文件 | 成功 |
| `cmd` 子进程写 `%LOCALAPPDATA%` 文件 | 成功 |
| 桌面壳（`.NET`，无签名）在同一位置 `CreateDirectory` | `UnauthorizedAccessException` |

父目录 ACL 含 `神秘奇女子\CodexSandboxUsers Allow ReadAndExecute`、`神秘奇女子\LENOVO Allow FullControl`，owner `LENOVO`。

判定：**目录创建被拒与执行上下文相关，尚不能归因于产品缺陷**。需要一次「从普通桌面会话（Explorer 双击或普通终端）启动同一 exe」的对照，才能把这一项定死；本轮不做，因为需要用户手动操作或授权。

## 5. 三分结论

**已观察（有原始证据）**
1. 壳能启动宿主、解析 ready 帧、拿到 origin；同一时刻 `/workbench/` 返回 200。
2. `startupStage` 停在 `webview` 33 秒，无异常、无 stderr、`ready=false`。
3. 在 `%LOCALAPPDATA%` 下 `CreateDirectory(profile)` 抛 `UnauthorizedAccessException`，而同会话 PowerShell/cmd 可写。
4. 在 `E:\javaproject` 工作区内 profile 目录可建，但 `CreateAsync`/`EnsureCoreWebView2Async` 未在 33 秒内返回。
5. WorkBuddy 客户端以「仅设 `WORKBUDDY_REMOTE_DEBUGGING_PORT`」方式启动：`exit code 0`、无子进程、18491 无监听、`debug.log` 未追加、`AppData\Roaming\WorkBuddy AI` 与 `AppData\Local\workbuddy-ai` 为空。
6. `app.asar` 在本上下文可读（181,847,875 字节）；`debug.log` 中的 asar 警告时间戳（13:03–18:11）全部早于本轮 23:xx 启动。

**可复现**
- `startupStage=webview` 卡住（连续两次不同 profile 根：E: 工作区一次、C: AppData 一次被权限提前打断）。
- 客户端立即 `exit 0` 且不写日志（多次）。

**尚待验证的假设**
- H1：WebView2 用户数据目录落在 `E:`（非系统盘）导致 `CreateAsync` 挂起；C: 一次被权限干扰，未取得干净对照。
- H2：无签名 exe + 沙箱继承的受限令牌导致 `CreateDirectory`/WebView 子进程写入被拒。
- H3：`msedgewebview2` 残留进程（40 个，属其他会话）争用运行时资源。
- H4：客户端 `exit 0` 与 asar 路径编码有关（只有历史日志支持，未取得本轮日志）。
- H5：客户端因单实例锁或 userData 初始化失败而静默退出（userData 为空、无 Singleton 文件，证据不足）。

## 6. 下一轮最小对照（需要授权或用户手动一次）

1. 在**普通桌面会话**（非沙箱上下文）双击 `WorkBuddy.Workbench.exe`，参数同上；只取一次 `--status` 快照与窗口截图，用于判定 H2。
2. 若 H2 排除，把 profile 根显式指向 `C:\Users\LENOVO\AppData\Local\WorkBuddyWorkbench-rc6probe`（预建目录）再跑一次，判定 H1。
3. 客户端：在普通桌面会话直接双击 `WorkBuddyAI.exe`，观察是否有窗口；只读比对 `debug.log` 是否新增行（判定 H4/H5）。不移动安装目录。

## 7. 纯 ASCII 复制对照方案（仅方案，未执行，需明确授权）

- 目标：验证「路径编码是否影响客户端启动」，不改变原安装。
- 新目录：`E:\javaproject\outputs\wb-ascii-probe\WorkBuddy\`（唯一新目录，纯 ASCII）。
- 复制内容：`WorkBuddyAI.exe`、`resources\app.asar`、同目录必要运行库（先列清单并逐项记录大小与 sha256，不复制账号/配置/缓存）。
- 不复制：`%APPDATA%`/`%LOCALAPPDATA%` 下任何用户数据；不创建新账号；仍指向原 `WORKBUDDY_CONFIG_DIR`。
- 预期影响：可能触发单实例互斥或与已运行实例冲突；只读观测 `debug.log` 与进程/端口，不做登录。
- 清理：结束后删除该目录并核对原安装目录 sha256 未变。
- 授权点：复制哪些文件、是否允许在原 profile 下启动、失败后的清理口径。

## 8. 本轮未做

- 未重跑 1301 项测试、未重新打包 RC6、未改 RC6 任何字节。
- 未安装 RC6、未派工、未登录、未改系统策略/ACL、未移动安装目录、未清理旧未知占用。
- 四尺寸/键盘/200%/读屏测试未开始：`ready` 未达 true，按验收口径不得进入。
