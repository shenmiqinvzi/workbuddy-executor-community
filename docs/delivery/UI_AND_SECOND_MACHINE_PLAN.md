# 桌面窗口证据与第二台机（RC6，实测记录）

## 1. 正式桌面壳能不能在本机构建

能。

```
cd gateway
dotnet build desktop\WorkBuddy.Workbench.csproj -c Release
→ 已成功生成。0 个警告 0 个错误，16.28 s
→ desktop\bin\Release\net10.0-windows\WorkBuddy.Workbench.exe
```

## 2. 能不能在本机跑出一个可用窗口

**不能。** 五次尝试都止步在 WebView2 用户数据目录。每一轮都按 PID 收尾，没有留下进程。

| # | 启动方式 | 结果 |
| --- | --- | --- |
| 1 | 只给 exe | `Missing desktop option: --node`，进程退出 |
| 2 | `--gateway-dir <RC6 解包根> --node F:\node.exe --database … --runs-dir …` | 窗口起来（标题「WorkBuddy · 任务工作台」），但内置网关 `dist/config.js:26` 抛 `Multiple WorkBuddy installations or data directories found; set WORKBUDDY_CLI_ELECTRON and WORKBUDDY_CONFIG_DIR explicitly.`，随后 `WorkbenchWindow.StartAsync` 抛 `System.InvalidOperationException: 本地记录服务启动失败…` |
| 3 | 第 2 步 + 父进程设 `WORKBUDDY_CLI_ELECTRON` / `WORKBUDDY_CONFIG_DIR` | 网关改报 `ENOENT: … stat '…\ui-profile\tasks.sqlite'`（host 要求库文件已存在） |
| 4 | 第 3 步 + 先建空库文件（profile 放在 `E:\javaproject\outputs\…`） | 网关进程启动成功（stderr 出现 `[host] PATH=…`），但下一步 `System.UnauthorizedAccessException: Access to the path '…\ui-profile\6EB75B8B7E836A3284532B10\WebView2' is denied` → `StartAsync` 失败 |
| 5 | 同上，profile 改到 `%TEMP%\wb-ui-c593fc97` | 同样 `UnauthorizedAccessException`（新哈希目录 `38B457BC9D2AD523F6B1F99F\WebView2`）；`http://127.0.0.1:19491/json/version` 始终不通；`tasks.sqlite` 保持 0 字节 |

历史对照：2026-11-04 的 L02 轮在同一台机器上也撞过同类错误（`UnauthorizedAccessException` / `COMException 0x8000FFFF`），当时改用「已打包壳 + 本树网关」绕过。这次连打包壳的内置网关都在同一处失败，说明卡点不是网关，而是**本会话创建 WebView2 用户数据目录被拒**。

结论：**窗口、UIA、四尺寸、键盘、200% 缩放、读屏，这六项在本机一条都拿不到真实证据。** 现有的 UI 证据只有两类，都必须在报告里如实分开写：

- 页面级：`npm run test:workbench` 139/139（含 `automation-view`、`statistics-page`、`productivity-page` 等），证明页面模块在 DOM 桩上的行为；
- HTTP 级：解包候选起 `workbench-entry`，`/workbench/` 200、`automation.mjs` 200、`POST /automation/policies` 405（`allow: GET, HEAD`）。

这两类**不等于**窗口可见、可点、可读屏。

## 3. 要补窗口证据，缺什么

1. 一个能创建 WebView2 用户数据目录的会话或机器（当前报 `UnauthorizedAccessException`，需要能确认是 ACL、受控文件夹访问还是 WebView2 Runtime 的安装状态）。
2. WebView2 Runtime 已安装（本机 `dependencies` 探针读到 `webview2_runtime 156.0.4314.58`，版本满足，故更可能是目录权限）。
3. 一个非 0 字节的库文件（host 会 stat 它；空文件只够过 stat，真正连接后需要 TaskStore 初始化 schema）。

补齐后的步骤（可直接照做）：

```powershell
$prof = "$env:LOCALAPPDATA\WorkBuddy\wb-ui"        # 换到用户可写、非受控的目录
New-Item -ItemType Directory -Force -Path $prof
# 用网关先建库，避免空库
$env:WORKBUDDY_DB_FILE = "$prof\tasks.sqlite"
F:\node.exe dist\workbench-entry.js                 # 起一次再停，让 schema 落盘
# 再起壳
WorkBuddy.Workbench.exe --gateway-dir <RC6 解包根> --node F:\node.exe --database "$prof\tasks.sqlite" --runs-dir "$prof\runs"
```

窗口起来后要采集的六项：

| 项 | 采什么 | 判定 |
| --- | --- | --- |
| 四尺寸 | 1280×720、1440×900、1920×1080、2560×1440 截图 | 侧栏不折行、任务表不横向溢出、按钮不被裁 |
| 键盘 | Tab 顺序、Esc 关对话框、Enter 提交 | 焦点可见、顺序符合视觉、无焦点陷阱 |
| 200% 缩放 | 系统缩放 200% 下重截四尺寸之一 | 无重叠、无截断 |
| 读屏 | 用 Narrator/Inspect 读主要控件 | 有可读名称与角色 |
| 主路径 | 新建任务 → 预览 → 确认 → 完成 → 复核 | 每步有可见反馈，失败有可读错误 |
| 控制台 | WebView2 控制台无未捕获错误 | 0 条 uncaught |

采不到就写「未执行 + 上述具体报错」，不写「界面正常」。

## 4. 第二台机

目的不是绕开 RC1 的旧占用（那是不允许的），而是验证「换机器后安装、技能、MCP、会话发现是否一致」。

前置：一台干净的 Windows（Node ≥ 22.13、WebView2 Runtime、无既有 WorkBuddy 安装），以及你对「在第二台机上装一次」的明确授权。

步骤草案：

1. 拷 `codex-workbuddy-gateway-v0.7.1.zip` 与 `.sha256`，先 `Get-FileHash` 对 `c9f724d4…`。
2. `Expand-Archive` → `npm ci --omit=dev --ignore-scripts` → `check` → `preview` → `drill --apply`。
3. `install --apply`，记录 `installedAt` / `snippetHash` / 六文件哈希（应与本机同包一致）。
4. `doctor`、`deployment:check`、`npm run desktop:test`。
5. 只读 `recovery show` 一个不存在 id，确认拒绝信息可读。
6. 若授权派工：跑一条 DSH 样本（不碰 WorkBuddy 原生目录），并在报告里写「异机样本，未解除任何旧占用」。

产出：异机差异表（版本、路径、权限、发现到的安装数、会话数），以及「哪些结论可以跨机、哪些只能本机」。
