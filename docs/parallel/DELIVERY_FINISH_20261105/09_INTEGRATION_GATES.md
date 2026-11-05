# 09：集成人每批收口规程

同一个集成人连续执行，读COMMON/MASTER和各线HANDOFF。用户交付本文件后，授权本地集成分支上的合并、修复、验证与候选准备；不等于推送/合main/生产切换/发行。

## 每次gate操作

1. 验每线实际HEAD/干净状态、父基线、文件归属、diff/专项证据与未完成项。跨线同文件冲突先按契约解决，不整体取ours/theirs或丢用户改动。
2. 第一批01→02→03→04；第二批05→06；第三批07→08。合入后由集成人完成所有integration-request：schema/服务/注册/导航/静态资产/包/技能副本；逐项关闭请求并保存对应检查，不能只有未调用模块。
3. 不在其他线正跑检查时共用它的dist/数据库/profile。依lockfile准备本集成树依赖，显式隔离原生环境与回环NO_PROXY。
4. build、typecheck:task-view、受影响专项、npm test、test:workbench；改C#则desktop策略/构建，插件变更跑对应检查。完整检查命令以当时package脚本为准，记录实际exit/count/log，跳过有理由。已有失败定位归类，不宣称“重跑绿所以肯定无关”。
5. 运行技能副本一致性、包检查、manifest生成/verify及编译入口冒烟（依仓库现有命令，不猜参数）。只在集成树按标准重生成SNAPSHOT。已提交dist是否更新依仓库现行规则核对。
6. 从解包候选启动受控合成服务，验证新功能实际可达；执行候选安装check/preview/drill及C的准备/完整性CLI，确保脚本/资产/依赖都在包。archive与manifest都保存SHA，源码/打包/运行摘要分开。
7. 更新总进度/31任务与53项矩阵，仅改本轮可证状态。原README/ROADMAP未提交文字没有纳入授权时仍保留，不覆盖；在新STATUS_INDEX维护现状入口。
8. gate回执至少含baseCommit/commit/tree、已集成提交、契约版本、检查/失败/包摘要、未完成接线、外部条件、下一批工作树和完整HEAD。缺关键开发检查不能将gate写passed；不以缺真实账号阻断所有可独立源码工作，但明确sourcePassed与liveReady分开。

## G3最终收口

对07自动政策与06模板/03统计、05推荐/02资源、01目录/可信确认进行端到端合成联调；所有实际执行路径共享准入/容量1/身份围栏。08问题逐项复现、修复、独立复验。冻结RC后生成影响表，任何再改运行代码/包都重新计算摘要并补对应检查。

输出docs/delivery/STATUS_INDEX.md、接口冻结记录、gates/G0–G3.json和各批候选档案，原始logs留outputs/finish-integration-20261105/Gn。
G3源检查完成后交10和11。真实验收中发现缺陷返回相应负责线修复并生成新RC，再按影响范围复验，禁止直接热修生产掩盖。
