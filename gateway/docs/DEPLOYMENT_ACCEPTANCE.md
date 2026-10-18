# 独立部署验收

验收目标：另一位使用者在自己的 Windows 电脑、自己的目录和账号下，仅按 [安装说明](INSTALL_WINDOWS.md)完成安装与真实任务闭环。维护者电脑上的多个临时目录、mock、单元测试和发布包解压验证分别记录，不作为第二台物理机器成功。

## 环境与安装

1. 从社区仓库全新 clone，记录提交和 Node/WorkBuddy 版本；不复制维护者 .env、数据库、会话、登录信息或全局配置。
2. 选择不同的安装位置，建议包含空格或中文。按说明执行 plan、install、重复 install、doctor；确认重复安装无额外修改。
3. 审核并合并本机 MCP 片段，连接 workbuddy。每次需要维护者口头补充的步骤都记为文档或程序缺陷，不能省略为“已经装好”。
4. 登录、原生权限和首次连接初始化由本机使用者处理；不降低系统策略、不自动批准权限、不换收费模型。

## 真实行为

在新的专用演练目录，使用 Codex 和已安装技能进行下列任务。真实 UUID、路径、日志和截图留在本机。

| 场景 | 操作 | 必需观察 |
|---|---|---|
| normal | 提交一个范围明确的小型代码修复及测试 | WorkBuddy 实际领取和修改；独立重跑测试、核对范围与停止，再 accept |
| rework | 事先声明两阶段交付：首轮完成第一部分，停止后以同 taskId/sessionId 补完原约定的第二部分 | continue 保留原身份与失败/轮次记录；不是增加新需求，最终独立验收 |
| cancel | 专用目录中提交一个持续等待的无破坏性演练任务，领取后正式 cancel | 不把取消请求当停止，等待原生停止证据；取消后不能继续 |
| reconnect | 在另一个正常任务进行时断开并重新连接 MCP，查询原 taskId | 原身份、轮次和绝对期限保持；只查询和监督，不重复提交 |
| upgrade/uninstall | 演练完成且停止后按文档更新与卸载 | 活动任务会阻止变更；配置/历史保留，原有技能可恢复 |

计划内两阶段演练用于检查 continuation 链路，不能算作真实质量缺陷返工。发现原生输入等待时记录在原生界面的处理情况，不以取消作为暂停。失败保留原结果，不能替换样本或补造 worker 回报。

## 程序生成本地报告

在 gateway 目录执行：

```powershell
node scripts/deployment-check.mjs --machine-label second-machine --output "./data/deployment-check-initial.json"
```

先得到本地环境检查和 pending 的场景。完成演练后，用自己的真实任务 ID 替换占位值并选用新的报告文件名：

```powershell
node scripts/deployment-check.mjs --machine-label second-machine --normal-task "NORMAL_TASK_ID" --rework-task "REWORK_TASK_ID" --cancel-task "CANCEL_TASK_ID" --output "./data/deployment-check-final.json"
```

工具只读本地状态，不派工、不恢复、不取消任务；不输出真实任务 ID、账号、路径、对话或报告正文。它核对已保存的原生停止、任务/轮次/会话身份、认证回报与独立验收记录。保存证据不是刚刚观察的原生状态。reconnect 永远保留 pending，由独立操作者另写事实与结果；工具不能自动证明物理机器身份。

命令退出码 0 表示本地环境检查通过，不表示整份部署验收完成。检查报告中每个场景以及手工 reconnect/升级/卸载记录，才能给出最终结论。

## 提交反馈

用匿名标签（如 tester-02）记录实际操作系统、应用版本、提交、各步骤结果及卡点。模板字段不能用“预计通过”替代实测。公开前检查报告、截图和 Git 元数据；完整原始材料留在私有位置，报告中手写补充也须去除账号和真实业务信息。

当前状态：程序和流程已提供，第二台物理机器真实结果尚未取得。只有拿到独立部署证据并修复阻塞后，才将跨机器支持写成已验证。
