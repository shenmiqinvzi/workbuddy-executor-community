# 后端集成进度

更新日期：2026-10-23（Asia/Shanghai）。本页记录集成分支的源码与验证边界；运行网关、前端和异机验收分别核对。

## 当前状态

PR [#8](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/8) 已合并 main（`4ccba60`）。本分支以此为基线，整合 PR [#4](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/4)（`a970cb5`）和 PR [#7](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/7)（`1e7115a`）。集成分支存在不等于已合并 main 或已部署。

| 能力 | 本次整合结果 | 仍需区分的边界 |
|---|---|---|
| Windows 部署兼容 | 保留中文/空格/短路径 renderer 匹配、UTF-8 进程查询、Unicode 自启动脚本和受限超时恢复修复 | 实机登录自启和完整异机验收仍待补充 |
| 共享任务服务 | MCP 执行入口及只读投影均经过 TaskApplicationService | statusView 是兼容摘要，不是完整 vNext TaskView |
| 只读任务投影 | 服务与 MCP 复用同一存储实例和明确的 runsDir；不调用 sync 或 executionStatus，不修改记录 | 只读取保存的快照；无实时观测，allowedActions 仅 export |
| 报告认证 | 按时通过队列身份、租约和验证引用检查的报告保存认证记录；读取重算摘要 | 历史无认证记录保持 unknown；认证不等于独立验收 |
| 初始 TaskContract | 不可变保存、规范化、摘要、幂等与完整性核验已整合 | 尚无真实派工调用点；effectiveMaxAttempts 未用于轮次准入，workspaceId 未绑定真实工作区 |
| 跨模块回归 | 新增真实队列代码路径到共享服务及 MCP 的合成集成测试 | 注入原生 actor 的测试不是真实桌面或异机证据 |

## 验证方式

- 从合并后的 TypeScript 源码统一构建 dist，重新生成版本控制文件快照；不手工合并编译代码。
- 类型检查覆盖 TaskView、共享任务服务及集成测试。
- Windows CI 同时运行任务视图/认证/约定测试，以及部署、共享服务、队列、停止、恢复、Job 清理等回归；具体提交、数量与结果以集成 PR 的实际运行记录为准。
- 集成测试检查：报告到达但未停止时等待停止；停止后可进入待审查；报告篡改不被提升为待审查；服务与 MCP 返回一致的快照；读取前后数据库和所有执行文件哈希不变。
- 本次没有重新部署、重启 WorkBuddy 或派发真实任务。已有历史实测不自动转移成集成版本的实测结果。

## 下一步

1. 补齐完整 TaskView 与本地只读 HTTP 的列表、详情和事件接口，保留 unknown 与陈旧快照语义。
2. 持久 revision、reviewId 与审查证据绑定。
3. 将约定接入真实派工、工作区身份和轮次预算准入。
4. 跨入口、跨不同任务的容量排他，以及真实文件范围/原有改动保护。
5. 对接前端只读原型（[Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6)），再做真实读取联调。
6. 在隔离部署中补当前集成版本的真实桌面验证；继续补完整异机验收（[Issue #3](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/3)）。

以上均为待办，不表示本次已经提供 HTTP 服务、完整执行约束或已完成面板。

## 历史验证与实机反馈

- 2026-10-20 共享服务历史分支的正常任务、重连、取消及修复后超时样本，见[原始阶段摘要](../gateway/docs/native-history-verification.json)和[当时部署复验](../gateway/docs/native-history-deployment-verification.json)。这些记录保留当时版本、失败和修复边界。
- 2026-10-21～22 的[提交者实机反馈](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/3#issuecomment-6343397605)记录修复后的正常任务与同任务返工；完整安装、取消、执行中重连、升级卸载、deployment-check 及设备关系仍需补充。
- 上述反馈中的 WorkBuddy 会话标题可见而对话内容不可见问题仍未解决；没有将其写成已通过。
- 旧离线诊断对含 validationRecords 报告的认证误报仍是独立待核查项；新的只读投影认证不自动证明旧离线入口已修复。
