# 任务约定（TaskContract）持久化

不可变的初始任务约定：保存、幂等创建与只读读取。依据
[INTERFACE_CONTRACT.md](INTERFACE_CONTRACT.md) 第 2 节与
[DEVELOPMENT_DESIGN.md](DEVELOPMENT_DESIGN.md) 第 5、7 节。

## “已保存约定”不等于“已执行检查”

这是本模块最容易误读的地方，先写清楚：

| 事实 | 是否由约定记录证明 |
|---|---|
| 这些条款被提交、校验并持久化 | **是** |
| 范围检查（真实文件归属与增量）已执行 | **否** |
| 模型目录费率/免费政策已核验 | **否** |
| `requiredChecks` 中任何检查已执行并给出结果 | **否** |
| 独立审查/验收已通过 | **否** |

`requiredChecks` 保存的是**检查定义**，不是检查结果。客户端不能提交 `actor`、`passed`、
`status`、`verified` 等结论字段（会被 `check_conclusion_not_allowed` 拒绝），本模块也不执行任何命令。
模型字段表示“请求使用哪个模型”，不等于模型政策已经核验。

## 记录字段

`task_contracts` 表（新增表，不影响既有表与历史）：

| 列 | 含义 |
|---|---|
| `task_id` | 主键，与 `tasks.task_id` 外键关联（约定不能脱离任务存在） |
| `agreement_version` | 服务端生成的约定版本 `av1-<32hex>`，与会话/时钟/计数器无关，重启可复算 |
| `contract_hash` | 规范化约定的 SHA-256 |
| `schema_version` | 目前只接受 `workbuddy-executor/vnext-1` |
| `contract_json` | 规范化后的完整约定 |
| `requested_max_attempts` | 客户端请求的轮次上限 |
| `policy_max_attempts` | 服务端政策上限（`TASK_CONTRACT_POLICY`），**不是**客户端字段 |
| `effective_max_attempts` | 两者较小值，任何预算判断只能用这个 |
| `created_at` | 首次保存时间 |

约定内容字段：`schemaVersion`、`taskId`、`workspaceId`、`title`、`objective`、`model`、
`timeoutSeconds`、`maxAttempts`、`scope{allowedChanges,permittedMetadata}`、`requiredChecks[{id,kind,definition}]`。

## 规范化规则（决定摘要）

- **对象键顺序不影响摘要**：规范化 JSON 在每一层按键名排序后序列化。
- **数组顺序**：`scope.allowedChanges`、`scope.permittedMetadata` 去重后按字典序排序；
  `requiredChecks` 按 `id` 排序（`id` 唯一，故为全序）。数组是集合语义，顺序不参与摘要，
  但**不会丢字段**。
- **自然语言原样保留**：`title`、`objective`、检查 `definition` 不改写、不裁剪、不做空白折叠；
  只在校验时看 trim 后是否为空。
- **路径归一化**：`\` 统一为 `/`，其余不做改写。

## 校验

拒绝：未知字段（任意层级）、不支持的 `schemaVersion`、重复 `checkId`、类型错误、
越界数值、超限长度/数量、非法 scope 路径、检查结论字段。

限制（来自接口契约第 2 节）：`title` 1–120 字符，`objective` 1–100000 字符，
`scope`/`requiredChecks` 各 ≤100 项，规范化后 ≤1 MiB；`timeoutSeconds` 1–86400。

**scope 只接受工作区相对路径**：精确文件，或 `directory/**`。拒绝绝对路径、盘符、UNC、
`..`、空段/`.` 段，以及除尾部 `/**` 之外的任何 glob（`*` `?` `[]` `{}`）。
**本轮只做词法校验**，不检查文件是否真实存在、归属何处、解析到哪；真实归属要等派工基线。

## 幂等与不可变

**摘要由存储层自己算，不是调用方给的。** 创建入口接收**未校验的原始约定**，先校验、规范化，
再按实际内容计算 `contractHash`，然后用这个计算结果判断幂等与冲突。因此不存在"改内容复用旧摘要"
的路径，也没有可被伪造成全零的摘要参数。非法对象（`null`、字符串、数组、缺字段、错版本、
别的 taskId）在开事务**之前**就被拒绝，不会留下任务行、attempt 或约定。

以 `taskId` 为键，用主键冲突而非“先查后写”判定：

| 情形 | 结果 |
|---|---|
| 首次保存 | `created`，任务行与约定在同一事务内一起提交 |
| 同 `taskId` 且规范化约定相同 | `existing_same`，返回原记录，不写任何东西 |
| 同 `taskId` 但内容不同 | `conflict`，**不覆盖**原记录 |
| 旧任务已存在但无约定 | `task_without_contract`，**不补建** |
| 已存约定读取时完整性失败 | `rejected`（不按摘要比较，也不当作冲突） |
| 旧任务已存在且已有约定，新请求更大预算 | `conflict`（预算属于约定内容，因此**不能**通过重复请求提高） |

首次保存后 `agreementVersion` 与 `contractHash` 不再变化。

### 任务行与约定的一致性

`objective` 是同一个事实的两处记录。`createTaskWithContract` 的 `objective` 可以**省略**
（此时从约定派生），但不能与约定不同 —— 不同直接 `objective_mismatch` 拒绝，
不会分别保存两个互相矛盾的任务目标。

`workspaceId` 与任务行的 `workspace` 路径**属于不同概念**：前者是约定里的项目标识，
后者是本机目录。本轮不做字符串比较，也不做默认映射，**不假装**已经完成工作区登记验证。

**旧数据兼容**：`submissionHash`、`objective`、`acceptanceCommands` 都**不是**约定，不会被拼装成
约定。旧任务读到的 `contract` 为 `null`。

## 服务端政策

`maxAttempts` 的政策值来自服务配置 `maxTaskAttempts`（`policyFromConfig`），
由服务内部上下文**传入**创建入口；存储层不读环境变量，客户端也不能提供政策字段。
创建时把政策**快照**写进记录（`policy_max_attempts`），有效上限为
`min(请求, 政策快照)`。**后续重试不会重算政策**，因此调高配置不会提高已有任务的预算。

## 并发与原子性

`createTaskWithContract` 在单个 `BEGIN IMMEDIATE` 事务内完成：任务行、attempt 快照、约定行。
任务行用 `INSERT ... ON CONFLICT(task_id) DO NOTHING` 插入，`changes` 决定是否写约定，
因此两个独立连接竞争同一 `taskId` 时只有一个 `created`，另一个读到 `existing_same`，
不需要嵌套事务，也不依赖先查后写。任一步失败则整体回滚，不会留下半个任务或半份约定。

并发由**独立进程**验证：两个 worker 各自打开自己的 SQLite 连接，在共享起跑点后同时争用同一
`taskId`。结果：相同内容恰好一次 `created`、一次 `existing_same`；不同内容一个 `created`、
一个 `conflict`，最终任务与约定成对存在且内容是提交的完整一份，没有混合。

## 只读读取（含完整性校验）

`TaskStore.getContract(taskId)` 是纯 SELECT：不初始化、不迁移、不修复、不补写。
读到的一行**不是**解析后就信任，而是重新核验：

1. 内容结构仍然合法（重新走一遍校验与规范化）；
2. `taskId`、`schemaVersion` 与行内其他列一致；
3. 重算摘要等于 `contract_hash`；
4. `agreementVersion` 等于由 (taskId, 摘要) 的派生值；
5. `requested_max_attempts` 等于约定自身的 `maxAttempts`；
6. `policy/effective_max_attempts` 为正整数，且 `effective === min(requested, policy)`。

结果三态：`found`（返回记录）、`absent`（旧任务，无约定）、`integrity_failure`（有记录但不可信，
带具体问题 `shape` / `identity` / `schema` / `digest` / `agreement_version` / `attempt_budget`）。
**损坏记录不会以"没有约定"返回**：查询工具返回结构化 `contract_integrity` 错误并指明是哪个不变量
被破坏，也不自动修复或补写。

`workbuddy_get_task_projection` 的返回值新增 `contract`：

- 有真实约定 → 返回其 `agreementVersion`、`contractHash`、`schemaVersion` 与完整内容；
- 旧任务无约定 → `contract: null`；
- 记录损坏 → `contract_integrity` 结构化错误；
- 读取抛错 → `store_unavailable`（`field: "store.getContract"`）。

查询不调用 `sync`、不派工、不修改任务或运行文件。这仍不是完整 vNext TaskView：
`actionFacts` 保持 `null`，`allowedActions` 保持只有 `export`。

## 尚未完成

- 未接入真实派工；本轮不新增公开写工具。`createTaskWithContract` 只在服务内部可用，
  政策由调用方（将来的写入口）用 `policyFromConfig(config)` 提供，本轮无生产调用点。
- 未实现范围检查、模型政策核验、检查执行与独立验收——这些依赖后续阶段。
- `effectiveMaxAttempts` 目前只被记录，尚未用于实际的轮次准入。
- `workspaceId` 尚未与任何真实工作区登记关联。
