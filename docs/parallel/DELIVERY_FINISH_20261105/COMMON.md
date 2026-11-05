# 全线共同约定

本包日期2026-11-05，落实docs/FUTURE_DEVELOPMENT_PLAN.md，保留ACCEPTANCE.md、接口契约、T7D和原P0-1裁决。每条任务必须先读自己工作树AGENTS.md。用户转交一个任务文件意味着开展该文件定义的源码/文档/隔离验证工作，不等于真实模型选择、生产部署或发行授权。

## 基线、工作树与归属

- 唯一正式集成源仍为E:\javaproject\workbuddy-resource-integration。当前已观察HEAD为6c9787a，README.md/ROADMAP.md有既存未提交内容；不reset、不stash、不暂存或覆盖这些改动。
- 集成人在E:\javaproject\workbuddy-finish\I-integration建立integration/delivery-finish本地分支；未存在时从已核对的集成HEAD创建，已存在则核对归属并继续，不强制重建。原A/B/C分支保留。
- 各线工作树在E:\javaproject\workbuddy-finish\Lxx-名称，分支feat/finish-lxx-名称。由集成人从对应gate完整HEAD创建，写入gates/Gn.json；开发线只用回执真实路径/HEAD，不猜未来SHA。
- 本包默认最多4条源码工作线；每条独立worktree、dist、数据库、TEMP、端口和profile。源码并行不授权实际执行器并发，生产共享容量仍为1。
- 开工先记录status、分支、HEAD、AGENTS及文件归属。遇到别人改动先识别，不覆盖。按需要读已有设计/实现/测试，复用已具备能力，不重写整个执行引擎、安装器或资源中心。
- 本包01–08仅拥有各自列出的模块和本线新文件。同批其他线文件不修改。共享入口、数据库统一schema/migration、核心准入/服务、MCP/HTTP注册、全局CSS/HTML导航、包白名单、workbench-assets、根技能六文件和总进度由本批指定所有者/集成人控制。
- 如果功能需共享入口接线，提供可审查的精确补丁建议、参数/返回契约和集成测试入口，写integration-request；集成人必须实际接线并验证，不能以“模块完成但从产品不可达”作整项完成。不要提交大段虚拟stub或调用未存在方法。
- 根技能六文件在第一批归01、第二批归05、第三批归07；他们不能跨批同时编辑。改技能需同步gateway发布副本，验证六文件；安装副本由10按授权办理。
- PROGRESS、FUTURE_DEVELOPMENT_PLAN、D0矩阵、总README/ROADMAP、SNAPSHOT、package及总验收由集成人更新。04可改自己安装模块/桌面打包实现，包总白名单仍由集成人维护。

## 实施和验证

- 默认完成源码和隔离验收，不反复请求普通实现确认。schema/接口内部实现沿用现有信任边界，禁止为方便前端开放公共HTTP写入口或让agent伪造用户确认。
- 使用合成DB、假原生适配器、测试账号值。依lockfile准备依赖，不能修改版本来遮环境失败。依赖dist的检查先build；.NET/WebView2检查按实际支持环境运行。
- loadConfig相关测试显式使用自建WORKBUDDY_CLI_ELECTRON、WORKBUDDY_CONFIG_DIR、DB/runs，回环NO_PROXY；不继承生产账号配置。测试子进程注意NODE_TEST_CONTEXT与真实测试数，不能把空测试exit0当通过。
- 每线先类型/构建/必要专项，UI线加浏览器与真实桌面壳合成数据验证，说明测试宿主还是正式宿主。界面不能仅靠配置/截图存在宣称键盘、读屏或缩放全部通过。
- 各线不重复跑不相关全量；修改公共执行逻辑时做相关回归。统一全量/打包由集成人串行执行，保留每次失败、环境与修正。计数可变，不以旧1013等数字作通过判据。
- Windows清理仅限已核对绝对路径的本线自建资源；不按进程名批量杀、不删除别人的profile或状态。不导出配置全文、账号、原生历史、DB/runs、凭据、令牌。
- 原P0-1未知不关闭、不重派、不释放；不以TTL、换库、taskId、operationId、执行器或替代会话绕过。只读生产政策采集复用C的源文件稳定读取+临时副本方案，不能用TaskStore构造迁移源库。
- 新增schema要验证升级/旧数据/回退限制；若旧程序无法读新schema，明确恢复路线，不编造无损降级。

## 真实环境与交付

- 代码开发不默认授权生产安装/配置/政策变更、登录、真实模型派工、推送、合main或发行。先完成可审查差异、备份回退、样本与检查，10集中办理必要选择；已有明确授权不得重复索要。
- 依AGENTS，每个真实任务展示实际执行器/来源/精确模型/推理/已知费用并取得选择确认；不默认免费/最便宜、不自动替代、不把未知费用当零或硬上限。原部署限制/历史任务政策仍须满足。
- 自动协作功能只在合成授权对象中验证；本包不启用实际预授权。当前逐任务规则仍生效，未来政策信任边界变更须有明确用户授权，不能自行修改AGENTS放宽。
- 源码完成、合成通过、窗口通过、真实模型通过、异机通过、已合入/部署/发布分开记录。外部条件缺失时“待外部条件”，不能整项改绿或停掉其他独立开发。
- 各线提交自己的文件并保持树干净，不推送/合入集成。集成人只在本地新分支集成，最终交Codex检查，发布另办。

## 每线固定交付

在本线docs/delivery/Lxx_ACCEPTANCE.md写范围、实际基线/提交、变更文件、验证命令/退出码/统计、失败历史、局限、运行/部署状态；本线outputs证据在E:\javaproject\outputs\finish-lxx-20261105下。
同时在该outputs下交HANDOFF.json，字段：
line、baseCommit、commits、branch、worktree、ownedFiles、taskIds、checks[{command,exitCode,counts,log}]、evidence、integrationRequests[{file,reason,patchOrContract,verification}]、openIssues、externalConditions、implemented、syntheticVerified、liveVerified、deployed、releaseReady。
未知字段用null/原因，不预填通过。最终提交SHA写外部HANDOFF，避免提交哈希自引用。必须交可执行复验方式，不把真实密钥写在命令。
