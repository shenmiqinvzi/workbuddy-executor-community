# 下一轮三线并行：共同约定

用户已于 2026-11-05 确认并行方向。本轮代码基线为 `882acc8`（正式全量 1013 项 / 1000 通过 / 0 失败 / 13 跳过）。后续分工文档提交不改变这个运行代码基线。

正式集成目录仍为 `E:\javaproject\workbuddy-resource-integration`，分支 `integration/resource-center`。下面三个目录是开发工作树，不是另立正式源码或部署目录。

| 线 | 负责人 | 工作树 | 分支 |
|---|---|---|---|
| A | DSH | `E:\javaproject\workbuddy-next-round\A-installation` | `feat/candidate-installation-readiness` |
| B | 另一个 Codex 对话 | `E:\javaproject\workbuddy-next-round\B-task-preparation` | `feat/task-preparation-diagnostics` |
| C | 本对话，或第三个 Codex 对话接手 | `E:\javaproject\workbuddy-next-round\C-delivery-readiness` | `docs/d0-d1-delivery-readiness` |

## 开工与归属

1. 在自己的工作树核对 HEAD、分支、工作树和 AGENTS.md。起点应为 `882acc8`，有后续授权修改则记录实际差异；不 reset、不覆盖在途改动。
2. 只编辑本线分工文件。普通实现问题自主解决，不逐步索要确认。跨线问题先记录最小需求，并继续完成不冲突部分；不要直接改另一线文件。
3. 不修改集成目录 README.md、ROADMAP.md 的既有未提交内容。
4. PROGRESS.md、FUTURE_DEVELOPMENT_PLAN.md、SNAPSHOT_MANIFEST.json、scripts/package.mjs、workbench-assets.ts 归集成人统一处理。若本线新增入口需要白名单，提交具体文件列表和建议变更，由集成时补入。
5. A、B 各写自己的验收记录，C 整理交付矩阵。不得三线同时维护同一进度文件。

## 验证与交付

- 先读既有能力和测试，避免重做资源中心、安装器或协作引擎。已有工具可复用；增加机制须对应明确缺口。
- 使用隔离目录、合成数据库、假执行器及测试凭据。清理只针对本轮自建资源，不复用生产任务库，不按进程名批量杀进程。
- 依 lockfile 准备本工作树依赖，不全局安装、不修改依赖版本来消除环境问题。`gateway/dist` 是构建输出，先构建再做依赖 dist 的验证。
- 涉及 loadConfig 的测试显式指定自建 WORKBUDDY_CLI_ELECTRON / WORKBUDDY_CONFIG_DIR；使用回环 NO_PROXY。临时目录可指定到本线自建目录。不得把真实凭据或配置正文打印出来。
- 各线先完成有意义的专项、类型检查和必要构建；修改公共执行逻辑时追加相关回归或全量。记录真实失败，不将多次结果拼成一次全绿。受限环境的框架启动失败与用例断言失败分开。
- 最终合并后由集成人统一运行完整检查、生成快照和候选包。不要求三条线对不相关的同一基线反复跑全套。
- 本轮没有授权生产部署、修改真实 MCP/账号/政策、真实模型派工、登录面板、安装技能、推送或合 main。原 P0-1 不关闭、不重派、不释放容量。
- 若真实验收需要授权，先完成可审查的方案与准备材料，再集中说明最少选择；不要求把密钥发到聊天。开发任务本身不替代真实模型任务的逐任务选模确认。
- 每线提交自己的源码/测试/文档，保持工作树干净；不要自行合入集成分支。最终交付提交列表、负责文件、命令/退出码/统计、证据位置、缺项与共享文件需求。

集成顺序：先审查三线 → A → B → C 证据对齐 → 补公共清单 → 最终检查与候选包。后合入线只处理与最新集成提交有关的差异，不重新实现其他线。
