# 小清单、返工与持久恢复验收

本步骤用简单文件任务验证真实桌面执行、同会话返工和 v0.4.1 持久服务，不需要制作视频。本轮 WorkBuddy 5.7.6 实测通过桌面自行安装及 LaunchAgent 激活、运行中自动派工、普通重开后领取、完全关闭后自动启动、裸启动无端口时自动正常重启一次，以及回复结束后的同会话返工。四项小文件创建与一项返工均已核对原生 Write/Read 或 Edit/Read、队列归属及真实内容，无 Computer Use；98 项自动化测试通过。本轮未做业务搜索或视频，登录恢复与系统重启未实测。

1. 按 [QUEUE_WORKER.md](QUEUE_WORKER.md) 核对专用 WorkBuddy 会话 ID 和工作目录，调用 `prepare_worker({sessionId, persistent:true})`，用户只粘贴一次完整安装指令。核对 service status 的安装状态与绑定。需要启动或启用端口时由服务自动启动应用或等会话空闲后正常重启一次，不要求用户手工反复重启；这两种场景本轮均已实测。
2. Codex 派一个任务：在全新目录写 `checklist.md`，包含唯一测试编号与三条清单。约束只改这份文件，不搜索、不安装、不制作视频。Codex 只建立空目录和做只读检查，不代写清单。
3. 确认 WorkBuddy 原生对话出现 helper 领取记录、文件创建命令或工具及真实结果；队列回报属于当前 attemptId。只有 queued 或健康通过不算成功。
4. Codex 独立读取真实文件，确认内容逐项符合要求，暂时保留 needs_review。
5. 等 WorkBuddy 回报后运行一次 `claim --wait-seconds 0`，空队列则结束回复。确认原生会话空闲后，Codex 用 continue 反馈“只改第三条，其他内容原样保留”。确认新 attemptId、同一 taskId/sessionId，服务自动唤醒 WorkBuddy 领取返工，不再次粘贴具体任务到界面。
6. 再读取文件并比较第三条，核对前两条和测试编号不变。检查通过后 accept，保存文件路径、内容检查与执行归属证据。
7. 等当前轮次结束、没有执行中任务，正常退出，再用普通 `open -a WorkBuddy` 重开，不显式设置调试环境。Codex 向相同 sessionId/workspace 排一个新的小文件任务；不再次粘贴 bootstrap。确认服务重连、同一会话出现 queuewake、helper 真实领取，新文件经独立检查后验收。本轮这项已通过。另验证原生应用完全关闭无主进程后直接排任务，服务自动启动并在同一会话完成；裸启动没有调试端口后排任务，服务正常重启一次并完成。这两项也已通过。
8. 空队列观察一个有界时段，确认没有新的 queuewake 或模型回复循环；服务的本机队列检查不算模型轮询。后续用户登录恢复需单独实测，正常应用重启通过不等于已验证系统重启、登出再登录。
9. 中断处理以自动化测试或经授权的独立测试验证：已领取的任务若应用崩溃，原轮次应阻塞并等待检查，不应静默重执行。不要通过关闭正在执行用户业务的应用来做验收。

若用户选择最后自己验收，就交回真实文件和 WorkBuddy 会话位置，仍保留 needs_review。权限或锁屏需要用户处理时明确阻塞原因；不自动重发，不伪造通过。

| 检查 | 当前状态 |
| --- | --- |
| v0.4.1 自动化检查 | 98 项通过 |
| 原生桌面 helper 领取、文件内容与临时返工 | 2026-10-08 小清单实测通过 |
| WorkBuddy 5.7.6 原生 MessageChannel RPC | 本轮已核实 |
| v0.4.1 桌面自行安装及 LaunchAgent 激活 | 本轮实机通过 |
| 无需再次粘贴的原生文件任务与实际内容 | 本轮 Write/Read 及队列归属核对通过 |
| 正常退出后普通方式重开，无需 bootstrap 自动领取 | 本轮实机通过，沿用同一会话 |
| 回复结束后自动唤醒同一会话返工 | 本轮 Edit/Read 与实际文件比较通过 |
| 持久唤醒指令回报后结束空闲回复 | 仅一次 claim 零等待，保留四次空等仅用于临时模式 |
| 应用完全关闭时按队列自动启动 | 本轮同一会话 Write/Read 与实际内容通过 |
| 裸启动无调试端口后自动正常重启一次 | 本轮端口前后状态及同会话实际文件任务通过 |
| 用户登出再登录或系统重启恢复 | 待单独实测 |
| 已领取中断及不确定唤醒不自动重执行 | 自动化已覆盖；实际执行中崩溃未单独实测 |

任务数据库、持久注册、会话编号、个人路径与原始执行日志保留本机，不包含在分享包中，不上传 GitHub。服务不能在电脑关机或用户登出时执行；后续恢复依赖有效登录、权限和匹配的 WorkBuddy 原生接口，升级后须核对兼容性。
# v0.6.0 多项目原生接入验收（2026-10-11）

macOS / WorkBuddy 5.7.6，本轮全程未使用 Computer Use：

- 通过 `workspace:initialize`、`session:create`、`session:rename` 原生接口为两个不同目录创建执行会话，并核对原生历史注册。原播客项目绑定保留。
- 通过 MCP 只传业务目录派工，一个已升级的 LaunchAgent 分别唤醒两条原生会话；两项任务都以 `runtimeSource: desktop_queue` 真实领取并回报。
- 独立读取两份实际文件，内容分别为 `PROJECT=A` / `PROJECT=B` 和 `REVISION=1`，均为21字节并保留末尾换行。
- 同一 taskId 对项目 A 排入返工，原 sessionId 自动领取新轮次并改为 `REVISION=2`；独立核对 A 内容与 B 原哈希未变，两项任务已验收。
- 从桥接器目录之外再次调用命令入口，`ensure_workspace` 返回 `created:false` 和相同会话，确认跨目录客户端复用。
- 142项自动化测试通过，包含创建去重、不确定结果不重建、选择变化保留旧执行器、多个目录路由及原会话返工。构建和已安装 Skill 更新完成。

原生会话编号、完整队列记录、真实路径和测试文件只保留本机 `data/verification/multi-workspace-v060` 及原任务库，不随公开包分发。本轮复用了已安装服务并完成升级重载，没有再次实测全新机器首次安装、系统重启或登录恢复，也未扩展到业务搜索或视频任务。

# v0.7.0 Agent Hub 验收（2026-10-11）

设计方案先于实现保存于 AGENT_HUB_DESIGN.md；使用说明见 AGENT_HUB.md。首期只接 WorkBuddy 桌面执行器，旧 Harness 桥接保持独立。

- 构建通过，157 项自动化测试通过。新增覆盖统一契约、第二个模拟适配器的扩展边界（不代表任何真实新执行器已接入）、跨执行器同目录串行、全局并发、幂等冲突、重启恢复、不确定派工不重放、取消占位、结果和文件边界、HTTP 鉴权、SSE 游标及 SDK 等待。
- 通过真实浏览器工作台提交 CSV 月度汇总任务。WorkBuddy 原生会话自动创建并领取，实际读 CSV、计算并写入 JSON 和 Markdown；平台收回 text、json 和真实文件入口，独立重算得到月份总额 170/230、总额400、4笔已支付订单。
- 在任务领取后重启平台服务，原任务沿用原 attemptId，底层只有一个轮次，没有重派业务目标。修复并实测 macOS 服务重新注册的短暂时序问题。
- 通过新的聚合 MCP 返工原任务，维持相同 sessionId，新增 revision=2 和 excludedCount=2，使用独立 round-2 结果文件；独立读取 CSV 重新计算并核对成果。原生记录含 Read、Bash、Write、present_files 等工具调用；最终恰好两个执行轮次。
- 从平台项目之外通过 CLI 提交省略 workspace 的文本任务。平台自动分配独立目录及另一原生会话，真实返回 `7+8=15`。
- 两项任务独立检查后，经平台 accept 保存验收。新 MCP 的9个工具已通过真实 stdio 客户端列出，并实际调用 providers 和 rework。工作台浏览器提交与结果显示已检查。
- 平台独立 LaunchAgent 已安装并运行，现有 WorkBuddy 唤醒服务与默认项目绑定保持原记录。公开打包文件清单包含平台源码、编译代码和 SDK 声明，排除私有 data。

原生编号、输入与成果、哈希、完整事件和核对证据只保存在本机 data/verification/agent-hub-v070、data/platform 和原任务库。本轮没有测量积分扣减、免费额度归属、长期业务吞吐、系统重启、登出恢复和 WorkBuddy 执行中崩溃；没有接入真实的新聚合执行器。版本下载入口见 README 的发布链接。

# v0.7.1 发行准备（安装、升级、回退与依赖）

本节记录发布产物的种类、已知限制与用户安装说明，来自安装与发行准备线的只读工具和合成演练。它不代表真实生产安装、真实升级或物理异机验收已经完成。

## 产物种类

| 产物 | 内容 | 不能做什么 |
|---|---|---|
| `codex-workbuddy-gateway-v0.7.1.zip` | 网关源码、已编译 dist、脚本、技能、文档、package.json 与锁文件、`RELEASE_MANIFEST.json` | 不含 Node.js、.NET 运行时、WebView2、WorkBuddy 本体、.env、任务库 |
| 同名 `.sha256` | 压缩包的 SHA-256 | 校验和本身不证明来源，需与公布值比对 |
| `RELEASE_MANIFEST.json` | 包内逐文件字节数与哈希 | 只覆盖包内文件，不覆盖安装后产生的 `data/` |
| `workbuddy-executor` 技能 ZIP | 技能指令与 references | 不含网关与连接，单独解压不能派工 |
| 桌面工作台预览 ZIP | `WorkBuddy.Workbench.exe` 及固定依赖、`WEBVIEW2-LICENSE.txt` | 未签名；不含系统运行时 |

## 用户安装说明（摘要）

完整步骤见 [Windows 安装指南](INSTALL_WINDOWS.md)。最短路径是：核对发布包 → 依赖自检 → 预览写入面 → `install --apply` → `doctor` → 合并 MCP 片段 → 首次真实连接。升级用 `upgrade --apply`；回退先用 `rollback-plan` 生成差异计划再执行；卸载用 `uninstall`（先看预览，再加 `--apply`）。每一步都先让任务结束并取得停止证明。

## 已知限制

- 未做代码签名（桌面预览包同样未签名），可能出现 SmartScreen 提示；不要求关闭系统保护，也不把关闭保护列为安装前提。
- 源码 ZIP 不是安装器：不含运行时与 WorkBuddy，也不会自动修改 Codex 配置。
- 安装器只写 `.env`（仅原本不存在时）、技能文件、`data/workbuddy-mcp.toml` 与 `data/deployment-installation.json`；不开始任务、不重启 WorkBuddy、不注册常驻服务。
- 本版安装、升级、回退与卸载的验证都在隔离目录和合成夹具上完成；真实生产切换、物理异机与真实模型派工不由本版声明。
- 任务库结构更新后旧版本可能读不了；回退前必须查看 `rollback-plan` 的 schema 判断，本项目不提供“删库恢复”。

## 第三方依赖与许可声明

项目自身许可由权利人决定；本版没有新增或修改 `LICENSE` 文件，以下清单只用于发行前复核。逐包台账来自 `package-lock.json` 与生产安装实测，保存在本线证据包的 `production-licenses.json`。

- 网关生产依赖 94 个包：MIT 84、ISC 7、BSD-3-Clause 2、BSD-2-Clause 1；直接依赖为 `@modelcontextprotocol/sdk` 与 `zod`。
- 桌面工作台：.NET 10（MIT）、`Microsoft.Web.WebView2` 1.0.4314.35（微软许可与再分发条款，包内附 `WEBVIEW2-LICENSE.txt`）。
- 运行时前置（不随包分发，由用户自行安装）：Node.js >= 22.13.0、.NET Desktop Runtime 10、WebView2 Runtime、WorkBuddy 本体。

若发行时需要随包附带许可全文，应先由权利人确认许可文本与归属，不在安装脚本里自动生成。

---
