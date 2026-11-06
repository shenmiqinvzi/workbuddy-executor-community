# UI、桌面壳与第二台机（RC6 准备，分阶段诊断）

详细阶段表与三分结论见 `STARTUP_DIAGNOSIS.md`。本文件只留结论与待办，避免把假设写成已验收。

## 1. 桌面壳：现在的真实状态

- 壳能自起宿主、解析 `desktop_host_ready`、拿到 origin；同一时刻 `GET /workbench/` 返回 **200**（attempt-06，端口 62997）。
- 之后 `startupStage` 停在 `webview` 33 秒以上，`ready=false`、`failureCode=null`、`WORKBUDDY_WORKBENCH_DIAGNOSTICS=1` 下 stderr 仍为空 → **卡在 WebView 环境/控制器创建，不是抛异常**。
- 在 `%LOCALAPPDATA%` 下建 profile 目录时抛 `UnauthorizedAccessException`；同会话 PowerShell/cmd 能写同一路径 → **更可能是执行上下文（沙箱令牌）而非产品缺陷**，需要普通桌面会话复跑一次才能定论。
- 窗口里的「工作台暂时无法连接」「重新连接」是 `Program.cs` 的原生 Label/Button，不是网页内容；窗口出现与 `msedgewebview2` 进程数都不是验收证据。

## 2. 验收口径（未达即不写通过）

进入四尺寸/键盘/200%/读屏测试的前置条件：`page` 是 `http://127.0.0.1:<port>/workbench/` 且 `NavigationCompleted.IsSuccess=true`、`ready=true`、能取到真实 DOM/控件与实际截图。当前 `ready=false`，因此：

| 项 | 状态 |
| --- | --- |
| 1280×720 / 1600×900 / 1920×1080 / 2560×1440 截图 | 未开始（前置未满足） |
| Tab 顺序、Esc、回车提交 | 未开始 |
| 200% 缩放复测 | 未开始 |
| 读屏（UIA/讲述人） | 未开始；本机无可脚本驱动的读屏宿主，只能登记为人工步骤 |
| 与正式壳（用户日常使用的宿主）差异 | 未登记（需在正式宿主上另测） |

## 3. 下一轮最小对照（不重跑 1301 项、不重打 RC6）

1. 普通桌面会话双击同一个 exe（同样四个参数），取一次 `--status` 快照 + 只截目标窗口，判定「权限拒绝是否只发生在沙箱上下文」。
2. 若权限项排除，profile 根显式指向 `C:\Users\LENOVO\AppData\Local\WorkBuddyWorkbench-rc6probe`（预建目录）再跑一次，判定「E: 盘 profile 是否导致 `CreateAsync` 挂起」。
3. 两项都排除后，才算进入 UI 验收。

## 4. WorkBuddy 客户端（派工前置）

- 以「仅设 `WORKBUDDY_REMOTE_DEBUGGING_PORT=18491`」方式启动：`exit code 0`、无子进程、18491 无监听、`debug.log` 未追加、userData 目录为空。
- `--remote-debugging-port=18491` 作为**应用参数**追加会被拒（`bad option` / `exit 9`），只能证明该参数不被接受。
- `app.asar` 在本上下文可读；`debug.log` 里的 asar 路径损坏告警时间戳为 13:03–18:11，**早于本轮启动**，不能归因当前运行。
- 结论：客户端不可用是**待验证假设的阻塞**（编码/单实例/userData 初始化），不是已确认的修法。纯 ASCII 复制对照方案见 `STARTUP_DIAGNOSIS.md` §7，未获授权不执行。
- 影响：`workbuddy_list_models` 经包内入口 120s 超时，本轮拿不到实时来源/模型/推理档与报价；只有 RC1 时代 23 条快照可作参考，不能当本轮报价。

## 5. 第二台机

- 仍缺第二台 Windows 机器与可用客户端；不能把「另一台机器」当作解除旧占用的手段（见 `CAPACITY_AND_IDENTITY.md` §5）。
- 若你提供机器：安装、样本、证据目录都按独立路径设计，不与本机共享库与 runs，步骤见 `INSTALL_AND_ROLLBACK_PLAN.md`。
