# `automation_*` 四张表的归属决定（IR-D3 裁定）

> 决定方：I 集成线。D 线在 `docs/forward/INTEGRATION_REQUEST_D.md` 的 IR-D3 把「统一迁移 vs 模块自建」交给我裁定，本文给出结论、理由与三种语义的可验证行为。

## 决定

选 **(b) 模块自建，但把版本与所有权显式声明出来**：

- `ensureAutomationSchema(db)` 继续由 `gateway/src/automation.ts` 拥有 `automation_meta`、`automation_policies`、`automation_decisions`、`automation_audit` 四张表与两个索引。
- `AUTOMATION_SCHEMA_VERSION = 1`（`gateway/src/automation.ts:33`）是该模块的**独立**版本号，不并入任务库的建表块。
- `TaskStore.database` 的注释（`gateway/src/task-store.ts:182-187`）已经写明：共享连接只用于让模块的写入落在同一个 WAL 事务边界内，**共享表的结构变更留在 `task-store.ts`**，模块自己的表由模块负责。

## 为什么不是 (a) 并入统一迁移

1. **升级路径**：并入统一迁移意味着每次打开任务库都会对四张表做版本判定与 DDL。任务库当前没有版本表（建表块只有 `CREATE TABLE IF NOT EXISTS`），要支持版本化就要新增一张迁移记录表——这会改变既有安装根在首次打开时的写入集合，属于对已安装环境的结构性改动，风险大于收益。
2. **谁在读**：`automation_*` 只在自动化模块被装配时读写；任务库的只读路径（`readTaskStatus`、工作台只读面）根本不碰它们。把不属于核心生命周期的表塞进核心建表块，会让「任务库能不能打开」与「自动化表版本对不对」互相牵连。
3. **RC6 的既有修复**：`8afd839 fix: read the automation schema version before creating any table` 的前提就是「先读版本再决定建不建」。并入统一迁移会绕开这个顺序保证。

## 三种语义（都可验证，不靠口头承诺）

| 语义 | 行为 | 证据 |
|---|---|---|
| 升级 | 读到 `automation_meta.schema_version > AUTOMATION_SCHEMA_VERSION` 时抛 `AUTOMATION_SCHEMA_UNSUPPORTED`（HTTP 侧 503），**在创建任何表之前**退出；旧版本网关绝不往新库里加表 | `gateway/test/automation-policy.test.ts:348` `a newer automation schema is refused before this build creates any table`（断言表清单仍只有 `automation_meta`）；`:296` `AUTOMATION_SCHEMA_UNSUPPORTED` 投影断言 |
| 幂等 | 同连接重复调用 `ensureAutomationSchema(db)` 不报错、不改版本、不重复插 `automation_meta` | `gateway/test/automation-policy.test.ts:365` `ensureAutomationSchema is idempotent on the same connection`（版本仍为 1） |
| 回滚 | 回滚到旧版本网关时，新库因 `schema_version` 更高而被拒（同上一条），旧版本既不改表也不删表；回滚只需换回旧包，不需要数据迁移 | 同上两条用例；`docs/forward/D_LINE_RECEIPT.md` 的 ARMED/`hardCap` 说明同样按「观测不到即阻塞」处理 |
| 旧库补表 | 老库没有这四张表时，第一次装配自动化模块会按需创建（`CREATE TABLE IF NOT EXISTS`），已有数据不动 | `gateway/test/automation-composition.test.ts`、`gateway/test/automation-policy.test.ts` 的夹具全部从空库起跑 |

## 边界（不许读成通过）

- 本决定只覆盖**表归属与版本语义**，不改变自动化默认值：生产库默认 `enabled=0`，任何 arming 仍需逐次人工授权。
- 没有真实 arming，也没有真实 dispatch；本文不提供任何关于自动执行「能跑通」的证据。
- 四张表的**内容**是否可信，取决于 `automation_decisions`/`automation_audit` 的真实写入，而本轮真实一档为 0（见 `docs/forward/TOTAL_RECEIPT.md` §2）。
