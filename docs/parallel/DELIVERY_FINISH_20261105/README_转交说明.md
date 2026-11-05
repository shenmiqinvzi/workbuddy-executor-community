# 后续开发交接包：2026-11-05

本包是后续开发的执行策划，不是已完成记录。目标覆盖完整愿景 D0–D7 的31项任务，沿用原验收门槛。当前正式集成源：E:\javaproject\workbuddy-resource-integration；本包不实施合并、生产安装、真实模型调用或发布。

## 你现在怎么转交

1. 先开一个DSH对话作为长期“集成人”，把下方提示词整段发给它。它先执行00，审查/集成本轮A/B/C，产出G0基线和工作树。G0完成前，其他开发线不从旧882acc8开工。
2. G0完成后开4个独立DSH对话，分别交给01、02、03、04。可同时开发；不能共用同一工作树。每个对话使用下方通用转交模板，替换任务文件名即可。
3. 四线完成后把各线HANDOFF.json路径给集成人，让它按09做G1集成。之后同时开05、06两线；G2集成后同时开07、08两线。可以复用旧对话，但必须改用新工作树并重新读任务文件。
4. 集成人完成G3后，代码开发和隔离验收应形成可审查候选。10负责真实环境验收与异机准备；需要的账号、机器和实际模型选择集中列清单，由你按具体步骤提供。无这些条件时先完成全部独立工作，真实项保留待外部条件。
5. 11负责最终交付档案。把它产出的FINAL_REVIEW_INDEX.md路径发给Codex，叫我做最终检查。不要只发“都完成了”，索引应能直接找到提交、失败日志、产物和未完成项。

## 给集成人的开工提示词

你负责workbuddy-executor后续开发的集成与进度协调。请完整阅读：
E:\javaproject\workbuddy-resource-integration\docs\parallel\DELIVERY_FINISH_20261105\COMMON.md
E:\javaproject\workbuddy-resource-integration\docs\parallel\DELIVERY_FINISH_20261105\MASTER_PLAN.md
E:\javaproject\workbuddy-resource-integration\docs\parallel\DELIVERY_FINISH_20261105\00_INTEGRATION_BASELINE.md
然后执行00，后续按09协调各批交付。你可在新建的本地集成分支集成任务提交、修复集成问题、构建测试和生成候选。不要修改原集成树README/ROADMAP在途内容，不推送、不合main、不发布、不部署。普通实现与验证问题自主解决。先生成G0和四条开发线的实际基线/工作树清单，再报告这些路径供我转交，不虚构完成状态或提交哈希。

## 给每条开发线的通用提示词

你负责workbuddy-executor后续开发中的一条工作线。
先完整阅读：
E:\javaproject\workbuddy-resource-integration\docs\parallel\DELIVERY_FINISH_20261105\COMMON.md
E:\javaproject\workbuddy-resource-integration\docs\parallel\DELIVERY_FINISH_20261105\MASTER_PLAN.md
再完整阅读并执行本次任务文件：
E:\javaproject\workbuddy-resource-integration\docs\parallel\DELIVERY_FINISH_20261105\<替换为01至08其中一个任务文件的完整文件名>
使用集成人gate回执指定的工作树、分支和完整HEAD，不在其他线目录开发。
完成全部可独立实施的源码、专项测试、文档和证据；遇到跨线入口变更写integration-request交集成人，继续完成其余部分。真实凭据/模型/生产安装的缺项不编造、不绕过。
提交本线成果并保持工作树干净，交付本线HANDOFF.json及专项日志路径；不自行合入其他分支。不要停在建议或设计，按文件完成授权的开发工作。

## 文件顺序

| 文件 | 用途 | 启动条件 |
|---|---|---|
| [COMMON.md](COMMON.md) / [MASTER_PLAN.md](MASTER_PLAN.md) | 全线共同约定、31项覆盖及进度路线 | 所有对话必读 |
| [00_INTEGRATION_BASELINE.md](00_INTEGRATION_BASELINE.md) | 本轮A/B/C审查与统一G0 | 立即，单一集成人 |
| [01_PROJECT_WORKFLOW.md](01_PROJECT_WORKFLOW.md) | 项目/目录/方案/直接处理流程 | G0；第一批 |
| [02_RESOURCE_TRUST.md](02_RESOURCE_TRUST.md) | 资源真实来源接入能力与可信路由 | G0；第一批 |
| [03_USAGE_STATISTICS.md](03_USAGE_STATISTICS.md) | 请求归因与可复算统计 | G0；第一批 |
| [04_INSTALLATION_RELEASE_PREP.md](04_INSTALLATION_RELEASE_PREP.md) | 安装升级回退、依赖与发行材料 | G0；第一批 |
| [05_RECOMMENDATION.md](05_RECOMMENDATION.md) | 可解释推荐与用户覆盖 | G1；第二批 |
| [06_TEMPLATES_NOTIFICATIONS_EXPORT.md](06_TEMPLATES_NOTIFICATIONS_EXPORT.md) | 模板、通知、脱敏导出 | G1；第二批 |
| [07_AUTOMATION_POLICY.md](07_AUTOMATION_POLICY.md) | 有边界的预授权自动协作源码 | G2；第三批 |
| [08_ACCEPTANCE_HARDENING.md](08_ACCEPTANCE_HARDENING.md) | 异常矩阵/界面/兼容独立验收 | G2；第三批 |
| [09_INTEGRATION_GATES.md](09_INTEGRATION_GATES.md) | 每批统一集成和回归 | 集成人持续执行 |
| [10_LIVE_AND_SECOND_MACHINE.md](10_LIVE_AND_SECOND_MACHINE.md) | 当前候选真实双端/异常/异机 | G3；需对应外部条件 |
| [11_FINAL_REVIEW_HANDOFF.md](11_FINAL_REVIEW_HANDOFF.md) | 最终交付档案与Codex复核索引 | 各线完成或缺项如实登记 |

目前只需转交00。后续按gate批量转交，不再每做一个小功能回来拿提示词。推荐最多4条源码线同时开发；全量测试/打包由集成人串行跑。这里的并行是开发工作树并行，产品真实执行共享容量仍为1。
