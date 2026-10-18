# 修复版网关快照与恢复

本目录保存更新至2026-10-18的网关快照，包含 Windows 适配、模型就绪/领取竞态、回报、只读查询、原生停止证据、请求冲突检查和验收验证复核。`package.json` 沿用上游版本0.7.0；准确版本以本仓库提交和 `SNAPSHOT_MANIFEST.json` 文件哈希为准。历史基线标签保持不变。

## 保存内容

- `src/`、`test/`、`bin/`、`scripts/`、`docs/`、`skills/`、`deepseek-plugin/`。
- `package.json`、锁文件、TypeScript 配置、上游 README、配置样例和已安装 `dist/`。
- `SNAPSHOT_MANIFEST.json`：当前快照文件的 SHA-256、上游提交和排除范围。
- `RELIABILITY_VERIFICATION.json`：2026-10-16的脱敏验证摘要；`RUNTIME_BASELINE.json` 保留2026-10-15的历史核对结果。

未保存实际 .env、凭据、任务数据库、租约、会话注册、自启注册、日志、node_modules、业务工作区或旧发布压缩包。它是程序源码及产物备份，不是登录状态或任务历史备份。上游 README 中其他平台和接入路线不代表本机已验证支持。

## 恢复程序

1. 恢复前确认旧执行已停止，选择新的空目录；不要覆盖仍在工作的网关，不重放旧任务。
2. 将本目录复制到网关安装位置，在该目录运行 `node verify-snapshot.mjs` 核对清单中的文件；不需要先安装依赖。保留实际配置与数据在仓库之外。清单不包含自身和历史运行基线；根目录技能另由仓库提交版本管理。
3. 使用符合 package.json 要求的 Node.js，在恢复目录运行 `npm ci` 和 `npm run build`。本次验证环境为 Node 24.19.0、TypeScript 5.9.2。受影响模块的复验命令见 `docs/RELIABILITY_REPAIR_2026-10-16.md`；131项中125通过、6项跳过，不宣称历史全量测试均通过。
4. 根据 `WINDOWS_ENV.example` 和实际目录创建本机 .env。登录由使用者在 WorkBuddy 内完成。复核批准模型确实可用且免费；不自动改用其他模型。
5. **恢复最新 skill 时使用仓库根目录**：`SKILL.md`、`agents/openai.yaml` 和 `references/`。网关内同名技能的入口与恢复说明已同步至本轮版本；不再沿用原历史副本。按实际机器修改说明中的安装路径。
6. MCP 入口指向实际 Node 和恢复目录的 `dist/server.js`，重新核对注册与进程。先做只读查询，再使用新的稳定 taskId/workerKey 准备业务会话。自启和服务注册应按恢复后的实际路径重新核对，不复制历史会话注册文件。

当前聊天若仍连接旧 MCP 进程，可用 `scripts/workbuddy-call.mjs` 启动新构建完成同一任务的监督；重启 Codex 后常驻 MCP 加载新模块。不要为刷新程序而重建或重放旧任务。故障时可用完全只读的 `scripts/workbuddy-inspect.mjs @参数文件` 检查保存状态；`snapshotOnly=true` 不能替代刚刚取得的原生停止证明。

2026-10-16已实测功能开发、回报、停止确认、独立验收和正常同任务返工；未执行新机器完整恢复安装、系统重启或重新登录测试。平台502仍属于外部服务故障，不能通过切换收费模型或无限重派掩盖。

当前可靠性版本为 `reliability-20261018.1`，最新保障清单见 `docs/workbuddy-executor-audit.md`，原生Windows复验见 `docs/windows-job-verification.json`；2026-10-17验收文件保留为历史记录。恢复必须带上 `scripts/bounded-job.ps1`、command-cleanup/bounded-command模块与全部技能参考文件，包括新的 `references/dispatch.md`；使用health的runtime比对实际启动进程，不能只比较磁盘。Windows复验使用 `node --import ./test/support/typescript-loader.mjs --test --test-concurrency=2` 并选择适用测试；Unix socket Harness与POSIX启动器不在本机通过范围。沙箱因策略拒绝PowerShell脚本时，在批准的正常本机上下文运行Job相关测试，不降低系统策略。
