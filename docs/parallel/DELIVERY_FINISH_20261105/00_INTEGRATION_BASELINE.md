# 00：建立统一开发基线G0

你是唯一集成人。完整读COMMON/MASTER、原docs/parallel/20261105共同约定及AGENTS。任务是审查本轮A/B/C并在新本地分支统一，不能只根据交付报告合并。

## 输入与工作目录

正式源E:\javaproject\workbuddy-resource-integration，目前6c9787a；原树README/ROADMAP未提交需保护。
A工作树E:\javaproject\workbuddy-next-round\A-installation，803dc56。
B工作树E:\javaproject\workbuddy-next-round\B-task-preparation，f8015c9、972cca5。
C工作树E:\javaproject\workbuddy-next-round\C-delivery-readiness，a98dfe2。
核对实际状态；新提交存在则读差异并记录，不reset回这些历史点。

## 必须完成

1. 先保存原README/ROADMAP的只读SHA与status摘要到自有outputs；不复制私有正文到公开报告。建立I-integration新工作树/分支，沿用COMMON路径。
2. 逐线读diff和验收报告。A重点：不可信zip/manifest、绝对/越界/链接路径、生产只读preview、缺失与不可读停止证据、活动服务、安装重复/失败回滚/配置保留、完整桌面与依赖缺口。B重点：单源失败保留另一源、坏结构不当空目录、多会话/忙未知、选择刷新/迟到请求、费率/政策重验、真实路径和信任边界。C重点：源库不以TaskStore打开、DB/WAL稳定复制及SHM不变、临时副本清理、快照来源/非原子局限、样本原始失败与受保护检查。
3. 在新集成分支依次合A、B、C。审查问题先做最小修复并加对应回归；不以“后续交给Codex”跳过当前明显缺陷。合并方式可用merge保留原提交，禁止改写别人的分支。
4. 补package脚本白名单candidate-installation.mjs、delivery-baseline.mjs、live-acceptance-fixture.mjs，检查是否已加入避免重复。新增前端入口需要时补workbench-assets；更新快照/技能副本一致性，明确构建输出的仓库惯例。
5. 依09跑G0必要构建/专项/全量/包并从解包执行工具。保留A quota-entry历史并发失败及C测试夹具失败，不把A因果推测当已定位结论；若当前复现，实际定位到可解释原因。
6. 更新新集成树的D0矩阵/进度：仅如实登记本轮开发与合成，不改真实部署。原README/ROADMAP的独立在途修改没有批准内容时，只在新的docs/delivery/STATUS_INDEX.md作现状入口，不用旧HEAD覆盖用户文字。
7. 生成gates/G0.json：完整commit、tree、branch、检查/包摘要、各后续工作树、模块归属、外部条件。创建01–04独立树，不预建05–08旧基线树。
8. 复制/纳入本规划包到新集成树可追溯位置（只新增本包文件，不带原树其他未提交内容）；保留本包初版，后续变更记录日期/原因。

## 验收和交接

实际运行各线新增专项及受影响既有回归，再统一全量；不是把A1022、B56、C19相加。输出E:\javaproject\outputs\finish-integration-20261105\G0\，在新集成树提交源码/文档/生成清单，不将outputs或真实状态入Git。
交付G0回执与01–04每条完整“任务文件+工作树+分支+HEAD”开工清单。原集成树用户文件摘要前后相同，不推送/合main/部署。完成G0后继续担任09角色，不自行启动真实验收。
