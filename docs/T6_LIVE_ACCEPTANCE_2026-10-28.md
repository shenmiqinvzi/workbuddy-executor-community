# T6 本机真实补验（2026-10-28）

本记录公开独立合成工作区的脱敏结论。WorkBuddy 与 DSH 官方来源各一个真实小样本均已 accepted 并关闭；最初 DSH 代理来源的失败另行保留。原始任务库、会话标识、凭据、个人路径、配置和工具日志留在本机。本次未发布安装包或升级已安装网关、技能和应用插件，源码与 CI 归属见[交付记录](T6_COMPLETION_2026-10-29.md)。

## 候选和实际执行

两个成功样本均运行已合并 main `0e9d96b6e88e0bdfacfd007762c089e6e0f2101c` 的隔离副本。运行代码摘要为 `1aec15871cc64127cd970ee14bfc8819962818732b312098b4f7b17e5d4ffd5b`。结束时重新核对 448 个受版本管理的网关文件，字节与源码候选一致；该数量包括清单及基线文件，不等同于清单核验的 446 个条目。

| 样本 | 实际来源 / 模型 / 推理 | 执行轮次 | 结果 |
|---|---|---|---|
| WorkBuddy | workbuddy-native / deepseek-v4.1-flash / 未提供 | 1 | 原生领取、认证报告、停止、后端独立检查、review、accepted/关闭 |
| DSH 原代理 | wb-proxy / deepseek-v4.1-flash / low | 1 | 上游 HTTP 400、错误码 11128：渠道校验失败；failed、停止、关闭，无成功报告 |
| DSH 官方来源 | deepseek-account / deepseek-flash / low | 1 | 原请求配置匹配、认证报告、停止、后端独立检查、review、accepted/关闭 |

初次模型目录选择完成后才准备模型和派工；官方 DSH 是获得额外具体授权的新样本，原代理失败没有被替换、重置或续轮。官方原请求的 request/header 证明来源、模型和推理档位一致。没有绕过渠道校验、修改账号权限、自动换模型或自动重发。

各样本最多一轮、600 秒，审查没有增加 worker 轮次或延长期限。WorkBuddy 派工前实际观测为 x0.00，原免费限制保持；该观测不适用于 DSH。两次 DSH 费率及实际账单未知，期限不代表费用上限，不宣称费用为零。

## 独立验收与保护

两个成功样本分别修复 clamp：三个参数须为有限 number，min 不大于 max，否则抛 TypeError，合法输入保留原行为。实际交付文件仅为 src/clamp.mjs 和 artifacts/DELIVERY.md；官方 DSH 还创建了其允许的 artifacts 父目录。README、固定测试、三类既有 dirty/staged/untracked 文件的字节及 Git 语义暂存索引均保持各自派工前状态。

协调者实际阅读源码、固定测试与说明，保存独立文件检查。后端分别按原约定的精确 CommandSpec 实际执行 Node 测试，各 2 项通过、0 失败，退出码 0，Windows Job 清理确认。worker 报告中的测试结果与命令 JSON 保持 worker 来源，没有冒充独立 program passed。检查和最终 review 绑定本轮约定、执行来源、真实报告/停止、原始范围基线、当前源码及证据。

原生停止后，两个自有样本分别进行了以下协议检查：

- 必需语义项 unknown 的 review 可留档，但 accept 被 CHECKS_REQUIRED 拒绝。
- review 的 SQL UPDATE/DELETE 被不可变约束拒绝；更正新增记录并保留旧结论，未伪造 worker 内容失败或返还预算。
- 受控改变本轮交付说明后，读取已存 review 不改变 task revision，旧 review 的 accept 被 SCOPE_EVIDENCE_STALE 拒绝。随后精确恢复原字节、重新检查并新增当前 review；不覆盖原基线或失败操作。
- 旧 review revision 被 REVIEW_STALE 拒绝。同 operationId 同参数重放原验收结果；同键不同 review 被 OPERATION_CONFLICT 拒绝。
- 当前 review 的 basisRevision 与 committedRevision 明确区分，正常 accept 不因自身审查写入失效。最终各产生一次绑定最终 review 的 task_closed，时间与验收一致。
- 数据库关闭后重新打开，accepted、不可变 review 和相同验收操作重放仍一致。原期限、轮次和受保护文件/索引未变化。

WorkBuddy 在 needs_review 时还实际验证：为另一执行器准备新会话的共享准入被 CAPACITY_OCCUPIED 拒绝，没有执行原生创建。完成验收后，原关闭事实允许后续官方样本准入。结束时容量记录的原持有者已关闭，没有未关闭工作流；不把残留的已关闭持有者记录描述成仍在执行。

## 失败与检查器更正

E 盘 helper 的既有区域信任检查使最初预检 5 项通过、5 项失败，原始结果保留。在正常识别为本机区域的 C 盘运行字节相同的 helper 后，实际正常退出为 0，超时为 124，取消为 130，并均确认所有权范围内的进程清理。未改变 ExecutionPolicy、签名或区域流，未使用 Bypass，也没有自动停止用户应用。C 盘局部预检不冒称整套历史失败用例全部重跑。

官方 DSH 验收脚本首次错误沿用了原夹具的 LF 哈希，新克隆实际使用 CRLF，且脚本漏算合法新建的 artifacts 目录。初次检查错误完整保留。纠正依据为本任务派工前已经持久保存的后端库存：受保护文件的当前精确字节与原始基线一致，LF 归一化后也与预览文本一致，Git 暂存索引摘要未变。没有在执行后新造基线、修改 worker 成果、修改候选运行代码或追加模型轮次。

## 覆盖边界

本次是同一台 Windows 的两个成功小样本及一个保留失败，不能代替第二台机器、所有真实故障注入或生产环境验收。原生停止证明覆盖原请求，不代表全部系统进程。库存有明确排除项，Git 语义索引另检；任意 shell 对外写入的归属并非全面可见，SQLite 事务不能原子锁定外部文件。

已安装 MCP/网关是独立版本，本次使用候选的隔离运行副本及独立状态目录，没有覆盖用户部署、全局 MCP、profile、凭据或安全设置。T5 历史记录未修改或重放。后续文档提交不代表再次调用模型；HTTP 继续 stage-2 只读，T7 面板、策略、计量和发布验证另行交付。
