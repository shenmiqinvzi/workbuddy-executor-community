# UI、桌面壳与第二台机（RC6 准备，分阶段诊断）

上一版写「五次尝试都证明本机无法运行桌面壳」，这个结论不成立：那些失败点各不相同，其中两次是参数/配置，两次是目录权限，最后一次真正跑起来了。下面按阶段记录，失败与成功分别归属。

## 1. WebView2 分阶段结果（本机实测）

环境：身份 `神秘奇女子\lenovo`（非管理员）、WebView2 Runtime `156.0.4314.58`、Defender 实时保护关闭、可用 PowerShell 5.1.26100.7019。

| # | 条件 | 结果 | 归属 |
| --- | --- | --- | --- |
| 1 | 只给 exe | `Missing desktop option: --node` | 参数缺失，非环境问题 |
| 2 | 补 `--gateway-dir/--node/--database/--runs-dir` | 窗口起，网关 `dist/config.js:26` 抛「Multiple WorkBuddy installations…」 | 配置歧义（缺 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`） |
| 3 | 父进程补两个 WORKBUDDY 变量 | 网关 `ENOENT … stat '…\tasks.sqlite'` | 数据库未初始化 |
| 4 | 补一个空库文件 | `UnauthorizedAccessException` 于 `Directory.CreateDirectory(profile)` | 目录创建权限 |
| 5 | 换到 `%TEMP%` 新 profile | 同样拒绝 | 同上 |
| 6 | 预先建好 `<root>\<InstanceKey>\WebView2` | 过 CreateDirectory，`COMException 0x8000FFFF (E_UNEXPECTED)` 于 `CreateCoreWebView2ControllerAsync` | 首次控制器初始化 |
| 7 | 第 6 步 + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu --disable-software-rasterizer` | **渲染成功**：34 个 `msedgewebview2` 进程，窗口出画面 | 成功 |

壳的 profile 规则来自源码：`gateway/desktop/DesktopPolicy.cs:55` 用 `SHA256(gatewayDir + "\n" + db + "\n" + runs)` 大写后取前 24 位作 `InstanceKey`，`:57-64` 拼 `ProfileDirectory`（可用 `WORKBUDDY_WORKBENCH_PROFILE_ROOT` 覆盖）；`gateway/desktop/Program.cs:150` 直接 `Directory.CreateDirectory(profile)`、`:156` 才创建 WebView2 环境。

**结论**：WebView2 可用，渲染链路通；卡点在「profile 目录需预建 + 无 GPU 参数」与「壳自起的网关宿主没连上」。

## 2. 窗口已经出画面，但页面报连接失败

用 `PrintWindow`（`PW_RENDERFULLCONTENT`）只抓目标窗口本身，得到三张证据（`outputs\rc6-live-readiness-20261106\ui-shots\`）：

| 文件 | 画面内容 |
| --- | --- |
| `wb-1280x720.png` | 标题「WorkBuddy · 任务工作台」；正文「工作台暂时无法连接。请检查 Node.js、数据目录、网关依赖及 WebView2 Runt…」；「重新连接」按钮 |
| `wb-connected-1280x720.png` | 「正在连接本地任务记录…」 |
| `wb-connected2-1280x720.png` | 又落回同一错误页 |

同一时刻检查进程：`workbench-desktop-host` 的 node 进程不存在，即壳没有把宿主留住。宿主 stderr 为空（开启 `WORKBUDDY_WORKBENCH_DIAGNOSTICS=1` 后仍无输出）。因此这是**壳与宿主之间的启动衔接问题**，不是页面/WebView2 的问题，也不是「本机不能跑 UI」。

已按 PID 停止该壳进程；未改任何全局 ACL、未写系统策略。

## 3. 还差什么才能宣称「UI 已验收」

1. 让壳自起的宿主存活并连上（观察 `workbench-desktop-host` 是否被 spawn、端口/管道是否建立、宿主 stderr 为何为空）。
2. 连接成功后依次取：1280×720、1600×900、1920×1080、2560×1440 四尺寸截图。
3. 键盘路径：Tab 顺序、Esc、回车提交，逐项记录焦点落点。
4. 200% 缩放下同样四尺寸复测。
5. 读屏：本机无可脚本驱动的读屏宿主，只能登记为「需人工在桌面会话执行」并给出实际命令。
6. 与正式壳（用户日常使用的宿主）差异单独一节，不把合成壳的结论外推。

在完成 1 之前，所有 UI 结论只能写「页面可渲染、连接未通过」，不能写「UI 不可用」。

## 4. WorkBuddy 客户端（派工前置）诊断

- 启动脚本 `E:\javaproject\workbuddy-install\start-workbuddy-debug.ps1`（3031 B）`#requires -Version 7.0`；本机只有 PowerShell 5.1 且执行策略 Restricted，脚本不能直接跑（先报未签名、再报 requires 7.0）。
- 脚本做的事：在**当前进程**设 `WORKBUDDY_REMOTE_DEBUGGING_PORT` 再 `Start-Process` 客户端，轮询 18491；发现已有 `WorkBuddyAI` 进程会提示单实例锁。
- 客户端：`F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe`，204,590,360 B，sha256 `15880ca7859f417bf8a6a639bacd1da6b63ced83fbead710317dad38b8f6fcc8`，5.9.4（Tencent）。
- 用环境变量方式（等价脚本核心、不追加 Chromium 参数）启动：进程立即 `exit 0`，无窗口、无子进程、18491 无监听。
- 同目录 `open-debug-18491.cmd` 把 `--remote-debugging-port=18491` 当**应用参数**追加，实测 `bad option: --remote-debugging-port=18491` / `exit 9`——这只证明「该参数不被接受」，不等于客户端不能用参数调试。
- `debug.log` 的关键行：`WARNING:electron\shell\common\asar\archive.cc:196] Opening \\?\F:\鏂板缓鏂囦欢锟?(2)\WorkBuddy\resources\app.asar: FILE_ERROR_FAILED`。asar 路径被按错误编码解析（`新建文件夹 (2)` 变 mojibake），Electron 打不开 `app.asar` 就退出。**这是宿主退出的直接线索，与调试端口无关。**
- 可能的恢复路径：把安装目录移到纯 ASCII 路径后启动（属安装/迁移动作，需你决定，不在本轮自行执行）。
- 影响：`workbuddy_list_models` 经包内入口调用 120s 超时（`McpError -32001`），因此本轮拿不到实时的来源/模型/推理档/报价，只有 RC1 时代的 23 条快照（`G3-fix\evidence-repair\transcoded\workbuddy-models.json`）。快照只能当参考，不能当本轮报价。

## 5. 第二台机

- 仍缺第二台 Windows 机器与可用客户端；不能把「另一台机器」当成解除旧占用的手段（见 `CAPACITY_AND_IDENTITY.md` §5）。
- 若你提供机器，最小动作序列已写在 `INSTALL_AND_ROLLBACK_PLAN.md`，其中安装、样本、证据目录都按独立路径设计，不与本机共享库与 runs。
