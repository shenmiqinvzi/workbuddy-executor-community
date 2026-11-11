# WB38 安装演练 + WB35 窗口实测（installed / window 两维证据）

状态：WB38 = `done_source`（本机完成安装、依赖安装、医生检查、部署检查、技能落位与同步）；
WB35 = `blocked_external`（真实窗口已出现并按阶段给出状态文案，但任务面板本体在本机会话渲染不出来）。

口径：本文件只登记**实际跑过**的步骤与输出。窗口出现过不等于面板通过，安装成功不等于派工成功。

## 1. 安装演练（从 release 包到可首跑）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 解包 | `tar -xf release-wb37c\codex-workbuddy-gateway-v0.7.1.zip -C <install>`（演练时最新构建；最终产物已重建为 `release-wb38`） | exit 0 |
| 依赖 | `node scripts/bootstrap.mjs --install-root . --apply` | `ok npm_ci: npm.cmd ci --omit=dev (4235ms)`，exit 0 |
| 初始化任务库 | `node scripts/init-state.mjs` | `{"ok":true,"event":"task_database_initialized","bytes":249856,"tables":25}` |
| 医生检查 | `node scripts/doctor.mjs` | exit 0：`localSetupReady:true`、`packageVersion 0.7.1`、`release portability-20261018.1`、`codeHash 96f8cfe6…565b52`、`discovery.application=detected` |
| 部署检查 | `node scripts/deployment-check.mjs` | exit 0：`schemaVersion workbuddy-deployment/v1`、`local.ok true` |
| 就绪报告 | `node scripts/readiness.mjs --json` | exit 1（存在未就绪层）：`toolResponsive ready`、`nativeOnline blocked`、`projectSessionDispatchable unknown`、`candidateDeployed unknown`、`desktopPageReady absent` |

安装根：`E:\javaproject\workbuddy-install\gateway-v0.7.1-plan20261111\codex-workbuddy-gateway-v0.7.1`。
注意包结构：wrapper 目录**本身就是 gateway 根**，没有嵌套 `gateway/` 子目录。

隔离措施：`doctor` 需要原生应用的会话库，因此复制两份库到
`E:\javaproject\outputs\executor-plan-20261111\installed-config`（`gateway/data/tasks.sqlite` 与
`C:\Users\LENOVO\.workbuddy-ai\workbuddy.db`）。运行中的应用库没有被写入。

医生检查的 `native_config_schema` 判据（`src/doctor.ts` 的 `checkNativeSchema`）：`<config>/workbuddy.db`
必须存在且 `sessions` 表含 `id`、`cwd`、`is_playground`、`deleted_at` 四列。缺库或缺列即失败——
第一次演练正是缺这个文件，补入真实库副本后通过。

证据：`wb38-doctor3.log`、`wb38-deployment-check.log`、`wb38-readiness.json`、`wb35-init-state.log`。

## 2. 技能落位与同步（FIX05 关闭）

| 动作 | 命令 | 结果 |
| --- | --- | --- |
| 安装 Codex 技能 | `node scripts/install-skill.mjs` | `installed:true`，目标 `C:\Users\LENOVO\.codex\skills\workbuddy-executor`，备份 `skill-backups\workbuddy-executor-4ElzMh` |
| 安装 DSH 技能 | `node scripts/install-deepseek-skill.mjs` | `installed:true`、`unchanged:true` |
| 漂移检查 | `node scripts/sync-skill.mjs --check --json` | exit 0：`inSync true`、`drifted []`（bundled/codex/dsh 三者同步） |

安装后暴露并修掉一个真实缺陷：`skill:check` 曾把 DSH 安装位与**仓库根六文件**比对，于是永远报漂移。
DSH 技能是派生变体（两个文件：`SKILL.md`、`references/setup.md`），自身源是
`gateway/skills/deepseek-executor`。修复后 `inspectSkillCopies` 允许每个安装位带 `source`，
比较用它自己的源，并在报告里写出 `copy.source`；`updatePlan` 的文案也改成「安装位与其源不一致」。
回归：`node --import tsx --test test/skill-sync.test.ts test/skill-copies.test.ts` → 9/9 通过。
证据：`wb38-skill-check2.json`。

## 3. 桌面壳窗口实测（window 维度）

桌面预览包解到同一安装根，`desktop/app/WorkBuddy.Workbench.exe` 能启动，窗口标题
`WorkBuddy · 任务工作台`，窗口尺寸 853x573，中文文案为真实渲染（不是截图或合成）。

启动流水线共八段，`--status` 会逐段给出 `stageElapsedMs`/`boundMs`：

`runtime` → `dependencies` → `host` → `host_ready` → `webview` → `profile` → `webview_environment` → `controller` → 导航。

三轮实测，每轮都停在不同的真实阶段：

1. `host_ready` / `InvalidOperationException`（188ms）：宿主进程报告任务库不存在。
   跑 `node scripts/init-state.mjs` 建库后通过。
2. `profile` / `UnauthorizedAccessException`（"the profile or data directory was refused"）：
   本 shell 会话不允许进程创建新的 WebView2 配置子目录。预建
   `<PROFILE_ROOT>\<InstanceKey>\WebView2` 后通过（`webview_environment` 用 500ms 完成）。
3. `controller` / `COMException`（"startup stopped at stage controller"，515ms）：
   换全新配置根、清掉 `msedgewebview2` 与残留壳进程后仍复现；runtime 检查已通过且错误不是
   `WebView2RuntimeNotFoundException`，因此判为**本机会话拿不到 WebView2 控制器**，不是源码缺陷。

为了排除「配置目录权限」与「父进程作业对象」两种解释，又做了三次对照，全部仍在 `controller` 失败：

| 对照 | 做法 | 结果 |
| --- | --- | --- |
| 配置目录位置 | 改用 `%LOCALAPPDATA%\WorkBuddyWorkbench\<InstanceKey>\WebView2`，并预建 `EBWebView\Default` | 同一阶段 `COMException`（1656ms） |
| 脱离父作业 | `cmd /c start "" explorer.exe <exe>` 让资源管理器拉起进程 | 同一阶段 `COMException`（`wb35-status10.log`） |
| 运行时是否存在 | 查 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application` 与 EdgeUpdate 客户端键 | 存在 **157.0.4341.42** |

即：WebView2 Runtime 装了、目录写得进、进程有窗口、环境对象也创建成功（`webview_environment` 1.5s 返回），
唯独 `EnsureCoreWebView2Async` 抛 `COMException`。这属于本机浏览器控制器不可用，代码侧能做的已经做完
（阶段、耗时、失败码都如实上报）。

窗口上真实出现过的三段文案（对应真实失败/等待阶段，均非占位文本）：

- 「工作台暂时无法连接。请检查 Node.js、数据目录、网关依赖及 WebView2 Runtime 后重试。」
- 「工作台无法创建本地应用数据。请检查当前 Windows 用户的文件夹访问权限」
- 「正在连接本地任务记录…」

抓图方法（可复用）：同一 exe 已在运行时 `Start-Process` 会被单实例转发拒绝
（`The operation was canceled by the user`），改用 `cmd /c start "" "<exe>"`；窗口被遮挡时
`CopyFromScreen` 只会拿到上层窗口，必须用 `user32!PrintWindow(hwnd, hdc, 2)` 把窗口自身表面画进
`Bitmap` 再保存。

本机环境事实：`discoverDesktopPaths({})` 命中应用 `F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe`
与配置 `C:\Users\LENOVO\.workbuddy-ai`；WorkBuddyAI 进程在跑，但 `workbuddy_health` 仍报
`online:false`——原生桥需要应用侧开会话，这属于本机外部条件。

## 4. 这证明了什么、不证明什么

证明：

- release 包能在干净目录解包、装依赖、建库、通过医生与部署检查，并就「工具已就绪」给出真实应答。
- 技能包能落位到两个安装位，且三者内容一致（漂移检查 exit 0）。
- 桌面壳能真实启动并渲染窗口；启动失败时分阶段文案与 `--status` 的 `failureStage` 一致，
  即失败是**可解释**的，而不是白屏或静默退出。

不证明：

- 任务面板（`/workbench/` 页面）能在窗口里渲染：`controller` 阶段在本机拿不到 WebView2 控制器。
- 点击流、原生等待态、真实任务详情/返工/审查在窗口中的行为（F06、F14、V/C 相关项）。
- 真实模型派工与费用：本会话没有选模型，也没有派任何真实任务。
- 第二台机、远端 CI 回执、发行签名。

因此 `ACCEPTANCE_MATRIX.md` 里 window 维度只登记为「部分」，WB35 保持 `blocked_external`。

## 5. 复现命令

```powershell
# 安装
tar -xf release-wb37c\codex-workbuddy-gateway-v0.7.1.zip -C <install>
cd <install>\codex-workbuddy-gateway-v0.7.1
node scripts/bootstrap.mjs --install-root . --apply
node scripts/init-state.mjs
node scripts/doctor.mjs
node scripts/deployment-check.mjs
node scripts/readiness.mjs --json

# 技能
node scripts/install-skill.mjs
node scripts/install-deepseek-skill.mjs
node scripts/sync-skill.mjs --check --json

# 窗口（先预建配置目录，绕开本会话的目录创建限制）
$key = node -e "…"   # SHA256(gatewayDir\n database\n runsDir 全大写) 前 24 位
New-Item -ItemType Directory -Force "<PROFILE_ROOT>\$key\WebView2"
cmd /c start "" "<install>\...\desktop\app\WorkBuddy.Workbench.exe"
<exe> --status --gateway-dir <install> --node <node> --database <db> --runs-dir <runs>
```

## 6. 仍未覆盖

- 面板渲染与交互：需一台能创建 WebView2 控制器的会话（本机 `controller` 阶段固定失败）。
- 原生桥在线：需在 WorkBuddyAI 侧开会话/连上 CDP，属应用侧操作。
- 升级与回退演练：会写入运行安装 `gateway-v0.7.1-final2`，本轮未动。
- 真实派工与费用计量：需先选执行器/来源/模型/推理档位。
