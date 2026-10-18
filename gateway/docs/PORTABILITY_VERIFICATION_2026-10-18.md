# Windows 部署改造验证（2026-10-18）

代码版本 0.7.1，运行标识 portability-20261018.1。本报告验证配置探测、只读诊断、安装/升级/卸载和验收工具；第二台物理机器的原生业务验收仍为 pending。

- TypeScript 构建通过；相关回归 145 项：139 通过、6 项 macOS 生命周期用例跳过、零失败。覆盖 deployment、package、persistent-service、native-desktop-trigger、workspace-workers、inspect-task、task-store、coordinator、queue-reliability、reliability-v2；不宣称全历史套件均通过。
- 新部署行为测试 12 项通过，包含冲突/本地改动保护、回滚、活动任务/停止不明拦截、复用 PID 归属拒绝、只读桥接观察和证据身份校验。
- 根技能和网关副本的 skill-creator 基础验证通过，参考文件保持同步；文档链接和 JSON 示例检查通过。
- 用最终 ZIP 在中文与空格目录解压，从不同工作目录执行 plan、install、重复 install、doctor、upgrade、uninstall；原配置与历史保留。实际 stdio MCP 握手、工具列表和 health 查询成功，MCP 版本为 0.7.1，任务表仍为零条。
- 发布包共 279 个清单文件，使用独立 Python zipfile 核对 CRC，解压后核对全部发布哈希。没有外部 zip/unzip 依赖。网关 ZIP 的 SHA-256 为 1d67fc35a09f408d23a83dc491506a43e8e0bd4de785ae7bd17b0978910e400a。

隔离演练使用假的 WorkBuddy 可执行文件、合成数据库与独立 CODEX_HOME；未启动真实 WorkBuddy、未调用业务模型、未更改现有用户 MCP 配置。不能用这次握手证明原生任务执行、登录额度或第二台机器通过。既有生产网关和聊天连接未部署此改动。

使用步骤见 [Windows 安装](INSTALL_WINDOWS.md)，异机操作者按 [部署验收](DEPLOYMENT_ACCEPTANCE.md)执行并记录真实卡点。完整机器日志、安装路径与应用记忆留在私有位置；[结构化摘要](portability-verification.json)仅含脱敏结果。
