# 2026-10-16 队列链路修复与验证

本轮同时修复网关实现与执行官技能，并经过真实 WorkBuddy 桌面任务验证。原始任务数据库、租约、会话记录、账号、日志与部署备份均不进入仓库。本文只保留可复现的技术结论及脱敏结果。

## 修复内容

1. **模型就绪与立即领取的竞态。** 旧实现等唤醒回执后才写模型就绪标记，但原生 helper 可能已经开始领取，于是错误返回空队列。新实现先验证原生模型配置、授权本轮领取，再发送唤醒；模型确认失败不发送任务。回归覆盖“唤醒回执尚未返回时立即领取”。
2. **查询写锁与报告丢失。** 未到期的消息查询不再抢写锁；真实写入发生跨进程短暂冲突时，有界等待2秒，保留重复报告幂等性，不重复派任务。
3. **Windows 权限副作用。** 已有 SQLite 数据库沿用 NTFS 权限，不再 chmod。新增 `scripts/workbuddy-inspect.mjs`，只读数据库及保存状态，不初始化/迁移、不连接原生服务、不改变权限；结果文件的认证状态按报告摘要匹配，不能由文件存在推断完成。
4. **截止检查与迟到报告。** 回报端自行检查截止时间；尚未确认停止的本轮真实迟到报告可保留为 blocked 供审查，不转换成完成。确认停止后的旧报告仍被拒绝。取消请求、报告回执、原生停止和验收保持不同状态。
5. **启动与报告契约。** 默认180秒领取窗口与业务总期限分开。领取后的任务 prompt 自身包含本轮结果文件和提交命令，降低长对话丢失外层报告指令的影响。
6. **原生网络错误识别。** 某些版本把502写入 incomplete 消息却正常结束 RPC。监督器在原生空闲时，只读检查精确匹配当前 wake 的有界历史，显示实际错误，不把旧错误归给新轮，也不自动换模型或重发。

技能同步要求按可独立验收的阶段推进大型计划。queued、working、needs_review 与 accepted 不混用；基线测试不能当作改动后验证。

## 复现检查

要求 Node.js 满足 package.json（本次为24.19.0）。在 gateway 目录执行：

```sh
npm ci
npm run build
node verify-snapshot.mjs
node --import ./test/support/typescript-loader.mjs --test --test-concurrency=1 test/queue-reliability.test.ts test/inspect-task.test.ts test/desktop-queue.test.ts test/coordinator.test.ts test/task-store.test.ts test/persistent-service.test.ts test/workspace-workers.test.ts test/brief-result.test.ts test/native-desktop-trigger.test.ts test/native-process.test.ts test/native-turn-failure.test.ts
```

受影响模块共131项：125通过、6项平台限定测试跳过、零失败。测试 driver 使用本地 TypeScript 编译器，避免 Windows 沙箱下 tsx 的 os.userInfo 限制；生产入口始终使用构建后的 dist。该结果不代表历史跨平台全量测试均通过。

## 实机验收

模型为原生目录中已确认 `x0.00` 的 `deepseek-v4.1-flash`；没有切换其他模型。保留失败历史：早期试行揭示领取竞态，另一次因 WorkBuddy502未开始业务执行；均在确认原生停止后按原任务有界继续，没有换键绕过次数限制。

修复后的连续三个原生轮次完成真实回报和停止确认，两个独立任务正式 accepted：

| 轮次 | 实际工作 | 独立验收 |
| --- | --- | --- |
| 功能开发 | 实现标签规范化，补充边界测试 | Codex 重跑10项测试全部通过，并检查 Unicode、冻结输入、稀疏数组和类型拒绝；约54秒完成并确认停止 |
| 独立文档首版 | 新增精确四行 README | 101字节，UTF-8无BOM、纯LF、末尾换行；约36秒完成并确认停止 |
| 同任务返工 | 仅修改 README 第三行 | 113字节，其余行以及原功能、测试的哈希保持不变；约39秒完成并确认停止 |

返工前后 taskId、sessionId 保持一致，attemptId 区分轮次；回报均来自 desktop_queue，且 needs_review 后取得原生停止证据才验收。结果由 WorkBuddy 自行提交，Codex 没有代领或代交成功报告。

## 发布及限制

技能根目录与网关内同名副本同步。快照校验覆盖当前源码、测试、编译产物和说明；历史运行基线仍保留原日期，当前结果另存于 `RELIABILITY_VERIFICATION.json`。

不包含本机凭据、实际 .env、SQLite、任务/会话记录、租约、日志、业务工作区、依赖安装目录或机器专用部署脚本。单元测试里的 UUID 是通用虚构夹具。

平台502仍受 WorkBuddy 服务状态影响；小任务闭环不代表复杂长期任务、新机器恢复、系统重启或重新登录均已验证。当前聊天的旧 MCP 可能缓存旧代码，可通过官方新进程入口加载新版；Codex 重启后常驻 MCP 才加载更新。
