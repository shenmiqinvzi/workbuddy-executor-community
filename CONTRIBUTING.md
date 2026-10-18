# 参与共创

欢迎贡献代码、测试、文档、使用体验、问题复现和功能灵感。尚未想好怎么实现的需求也欢迎提出；参与讨论不需要认领开发任务。

项目正在整理社区协作入口；统一开源许可证的状态与上游授权说明见 [AUTHORIZATION.md](AUTHORIZATION.md)。提交前请了解适用范围，不上传无权分享的代码、资料或私下聊天。

## 从哪里开始

- 报告故障：使用 Bug 模板，说明版本、平台、复现步骤、预期与实际行为。
- 分享灵感：使用灵感/场景模板，描述你要完成的事情和目前的困难；不要求先提交技术方案。
- 提出功能：使用功能建议模板，说明目标与验收方式。
- 贡献实现：查看 [路线图](ROADMAP.md)、[设计](docs/DEVELOPMENT_DESIGN.md)和 [接口](docs/INTERFACE_CONTRACT.md)。在相关 Issue 留下计划，维护者核对重复工作和依赖后确认认领。
- 修正文档和小问题：可以直接提 PR。涉及状态机、停止、费用政策、文件范围或存储迁移时，先讨论设计。

尚未确认认领的路线图条目都可以讨论；没有 Issue 时可以新建。不能开发也可以帮助复现、审查和补充案例。

## 本地准备

当前主要验证环境为 Windows desktop-queue。安装 Git、满足 `gateway/package.json` 要求的 Node.js（目前 >=22.13.0）和 npm。文档/UI mock/离线单元测试通常不需要登录 WorkBuddy；真实派工需要使用者自己的本机环境。

```powershell
git clone https://github.com/shenmiqinvzi/workbuddy-executor-community.git
cd workbuddy-executor-community
git switch -c docs/describe-your-change
cd gateway
node verify-snapshot.mjs
npm ci
npm run build
```

本仓库公开，欢迎直接 fork；新参与者无需先获得仓库写权限。外部贡献者从自己的 fork 开分支，协作者从仓库分支开 PR。配置参考 `gateway/WINDOWS_ENV.example`；真实 `.env`、运行数据和业务工作区放在本机，不能提交。

快照核验在修改/构建前运行；开发后源码和 dist 变化可能让旧清单不再匹配，这是需要集成更新的事实，不通过伪造哈希处理。实际部署使用 [Windows 安装指南](gateway/docs/INSTALL_WINDOWS.md)与 [独立验收](gateway/docs/DEPLOYMENT_ACCEPTANCE.md)；跨机器真实结果仍待取得，不能把 build 通过当作原生链路可用。

## 验证改动

纯文档修改核对链接、命令和示例即可。程序修改运行构建及相关测试；例如只检查 task-store：

```powershell
# 在 gateway 目录运行
npm run build
node --import ./test/support/typescript-loader.mjs --test test/task-store.test.ts
```

默认测试命令是 `npm test`，历史套件包含平台和环境限定用例，不把所有机器全量通过作为既有事实。停止、幂等、费用、范围和验收变更参照 [行为验收](docs/ACCEPTANCE.md)，区分自动、模拟和真实桌面证据。Windows 进程测试需在允许运行原有 helper 的环境执行，不降低系统策略。

独立 clone/worktree、配置与数据目录用于避免并发改写业务文件。不要让多个进程同时控制同一原生任务，不为刷新版本重派已有任务。

## 提交与审查

1. 每个 PR 聚焦一个可审查结果，说明问题、变化、实际验证和已知限制。
2. 不提交个人分工、工时、内部排期、私下授权聊天、凭据、任务库、原始会话或真实业务日志；新案例使用合成或脱敏数据，按 [公开内容检查](docs/PUBLICATION_GUIDE.md)复核。
3. 保留来源和版权声明。只提交有权分享的内容；使用 AI 辅助的提交也由提交者核对行为、来源与隐私。
4. feature 分支不手改 `gateway/dist/`、冻结 benchmark 或清单。发布维护者在集成时统一构建、核验及更新；确需修改这些内容时在 PR 单独说明原因。
5. 修改技能时维护根目录与网关内副本一致；涉及接口时同步契约、客户端和 mock。
6. 维护者按风险安排审查，执行约束相关改动由另一位维护者复核。合并以验证结果为准，GitHub 自动保护是否启用以仓库设置为准。

建议提交前在 GitHub 开启邮箱隐私，并在当前仓库使用自己的 GitHub noreply 邮箱。不要照抄其他人的 Git 身份；历史提交中的邮箱不会因修改当前配置而消失。

讨论应尊重参与者，围绕需求与证据提出意见。贡献会保留 Git/PR 署名；公开展示额外个人资料或列入团队介绍前征得本人同意。
