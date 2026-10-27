# T3c：WorkBuddy2API 积分缓存汇总

日期：2026-10-25。本阶段补齐真实来源的积分读取，和[已有 token 额度估算](T3C_QUOTA_OBSERVATION.md)使用不同接口、单位与响应 schema。后台和只读 API 已实现；前端资源页、实际 Key 的完整调度范围、单任务归因与费用控制仍未交付。本轮未部署到用户运行网关。

## 来源和读取边界

源服务须支持 GET `/v1/balance-summary`。本机当前 WorkBuddy2API 已验证该能力；它读取已启用账号的现有积分缓存，按请求区域汇总，不调用 fetch_credits 或模型。只使用既有 API Key，不需要面板令牌，不登录、不创建会话、不刷新上游积分。旧版本返回 404/501 时明确 source_unsupported，不回退到账号管理接口。

来源响应只有 balance、unit、realm、accounts_enabled、accounts_with_credit_data、updated_at。采集器逐字段校验并归一化；不透传额外字段、账号身份、凭据、URL 或原始错误响应。网络超时、重定向拒绝、1 MiB 上限与显式 loopback origin 的限制和 token 来源共用 LocalStatisticsClient，路径仅允许已登记的统计 GET（T3b 另登记模型目录 GET）。

## API 与数值含义

GET `/workbench/v1/resources/credit-balances?connectionId=...`，仅可按已登记连接 ID 过滤。GET/HEAD 只读本地缓存，POST 为 405；未知查询参数为 400，存储损坏为 503。沿用 Host/Origin 与 loopback 检查。

响应 schema 为 `workbuddy-executor/credit-balance-1`：

- connections：连接 ID、观察状态、固定错误码、快照 ID、collectedAt、cacheFreshness。
- balances：匿名 scopeId、realm、unit=credit、valueKind=reported_cache、balance、accountsEnabled/accountsWithData、coverage、latestMemberObservedAt、collectedAt、cacheExpiresAt、主连接引用及 connectionIds。
- shared=true、scopeKind=gateway_region_pool；相同网关端点与区域去重，不把国内或国际多个模型来源重复相加。不同端点不假设属于同池。
- actualTaskCredits=null、attribution=connection_only。积分不是货币，不和 token 相加；余额为零也不能推断所有免费模型额度耗尽。

coverage 的 complete 只表示启用账号都有数值，不证明它们全部实时更新；partial 表示仅部分账号有数值，balance 是已知部分之和；没有数据为 unavailable 和 null，不能补零。

上游 updated_at 是各账号时间的**最大值**。因此只称 latestMemberObservedAt，不能当作整个池的同步时间。cacheFreshness 表示本地缓存采集是否近期成功；balanceFreshness 仅可标 stale 或 unavailable：最大时间已旧时明确陈旧，即使最大时间近期也不伪造所有成员均新鲜。没有取得源服务最旧成员时间前，不标整个积分池 fresh。

这些是区域账号池的共享缓存，尚未核对模型限制、调度护栏或完整 Key 路由；不能称为 DSH 独占或某任务可支配余额。源服务缓存老旧时保留旧值和陈旧标记，用户可在源服务自己的界面决定是否刷新，本采集器不代刷新。

## 本地配置与恢复

仅显式配置后由 workbench-entry 启动，未配置时关闭。参数通过私有进程环境提供，见 [WINDOWS_ENV.example](../gateway/WINDOWS_ENV.example)：

| 变量 | 作用 |
|---|---|
| WORKBUDDY_CREDIT_SOURCE_ID | 本地连接 ID，默认 workbuddy2api-credit |
| WORKBUDDY_CREDIT_SOURCE_URL | loopback HTTP origin，不含 /v1 或 URL 凭据 |
| WORKBUDDY_CREDIT_API_KEY | 该来源既有 API Key，不在聊天、Git 或 URL 传递 |

与 WORKBUDDY_QUOTA_* 独立，不因为启用一种统计就悄悄开启另一种。默认 30 秒采集、90 秒本地缓存期限、5 秒网络超时。采集器单次请求合并、失败退避、代次拒绝旧配置/旧请求覆盖；源故障不清空末次值，也不影响任务查询或决定任务成功。新表 credit_balance_connections 仅保存脱敏缓存、固定错误码、私有配置指纹和代次；账户匿名盐复用资源模块，GET 不补写。

## 验证与当前限制

自动回归使用合成本地 HTTP 与临时 SQLite，覆盖完整/部分/未知/零值、单位/计数错误、鉴权/不支持、旧时间、共享去重、重启、乱序、GET 无采集和缓存损坏拒绝。编译入口分别验证 token/credit 的有效配置、非法配置和关闭状态；测试隔离真实来源环境，不继承用户运行连接。

本轮真实只读联调复用本机 DSH 已有的四个 WorkBuddy 来源，凭据只经内存/管道传递，没有修改 DSH 配置、导入账号或登录。四个来源去重为国内/国际两个区域池，成功经本项目新 HTTP 接口读取，任务事实与 GET 前后数据库字节核对通过。真实积分值未写入公开测试/文档，完整证据保存在本机验收目录。

该结果证明本机当前缓存读取链路，不代表源积分已刷新、模型可派工、单任务费用可计量或已完成前端展示。前端接入和发布仍按 T7；精确任务归因与硬费用准入需单独验收。
