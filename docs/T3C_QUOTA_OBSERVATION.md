# T3c：WorkBuddy2API 只读额度观测

日期：2026-10-25。状态：后台采集、持久资源缓存与只读 HTTP 已实现；没有配置真实凭据或改运行网关，真实 WorkBuddy2API 联调仍未验收。DSH 原生接入和任务级费用归因是其他交付。

## 数据流与含义

`WorkBuddyQuotaCollector` → 已登记的 loopback WorkBuddy2API `/usage/remaining` → 脱敏、限量及格式校验 → `QuotaStore` → `TaskApplicationService.readQuotaResources` → GET `/workbench/v1/resources/quotas`。

采集器只调用统计 GET，不访问模型推理、签到、主动额度探测或登录接口。WorkBuddy2API 自身构建统计时可能归档/刷新本地缓存，本项目不宣称整个外部服务零写入。资源缓存、采集代次与任务生命周期分开；采集不改变任务状态、revision、事件或验收。

当前来源提供的是“账号 × 模型”的 token 用量与历史预算估算。即使上游行的 estimated=false，预算也不能升级为官方精确余额。接口全部标记 valueKind=estimated/unavailable，冷却和未来恢复时间有来源记录时另标 availability=exhausted；没有触顶证据的零剩余不是已证实耗尽。

本阶段不解析真实 Key 的区域/模型/账号路由，因此范围恒为 gateway_pool、shared=true、routing_unverified。不得把显示值当成 DSH 独占余额或本次任务可支配额度。未观测到的成本保持 null，不做硬费用封顶、不自动切模型或账号。

## 只读资源接口

GET `/workbench/v1/resources/quotas?connectionId=...&modelId=...&limit=200`。查询字段均可省略；limit 为 1–200。只接受这些字段，任意 URL/路径/凭据参数被拒绝。沿用 loopback、Host/Origin、GET/HEAD 边界，POST 为 405。

响应 schema 为 `workbuddy-executor/quota-1`，独立于原 stage-2 TaskView：

- connections：connectionId、status、固定 errorCode、snapshotId、collectedAt/sourceObservedAt/expiresAt、freshness。
- observations：匿名 scopeId、scopeKind、shared、modelId、realm、unit=tokens、valueKind、availability、used/budget/remaining、resetAt、method、limitations、采集/来源时间、主 connectionId/snapshotId 及 connectionIds。
- 相同网关端点/区域/账号/模型以持久本地盐生成 scopeId，跨连接去重；主记录取较新的来源快照，其他连接引用保留。不同单位不相加，本期没有自动汇总“总余额”。
- 截断时 truncated=true，不把部分行冒充完整账号池。attribution=connection_only，actualTaskCredits/actualTaskTokens 为 null。

账号 UID、昵称、来源 URL、API Key、面板令牌及连接指纹不返回前端。scopeId 只供本地稳定去重，不可反向当账号身份或 API Key。未知值保持 null；来源观察时间缺失时 freshness=unavailable，不用采集时间冒充。

普通 GET 仅查持久缓存，不触发外部请求、后台同步、模型或任务写入。默认无来源时返回空资源集合，不能把它解释为额度为零。缓存损坏/不可读返回 503 RESOURCE_STORE_UNAVAILABLE，不混成空资源。

## 配置与故障隔离

仅 `workbench-entry` 可按显式进程环境启动一个可选来源；未设置 URL 时关闭。参考 [WINDOWS_ENV.example](../gateway/WINDOWS_ENV.example)：

| 变量 | 含义 |
|---|---|
| WORKBUDDY_QUOTA_SOURCE_ID | 稳定本地连接 ID，默认 workbuddy2api-local |
| WORKBUDDY_QUOTA_SOURCE_URL | 仅 loopback HTTP origin，例如 http://127.0.0.1:8788，不含 /v1、查询或 URL 凭据 |
| WORKBUDDY_QUOTA_API_KEY | 来源 API Key，仅存在本机私有配置/进程环境中 |
| WORKBUDDY_QUOTA_PANEL_TOKEN | 来源部署需要时使用既有有效面板会话令牌；不自动取得或续期 |

这些环境变量须通过私有启动环境提供，本入口不承诺自动加载 .env。不要把真实凭据写入示例、Issue、聊天或 Git。连接配置非法时只记 source_configuration_invalid 并停用该来源；任务 HTTP 仍启动。权限不足显示 source_unauthorized，不导入账号、不登录、不调整源服务权限。

默认 30 秒采集、90 秒最大陈旧、5 秒网络超时；内部构造可在受限范围配置。失败指数退避最多 5 分钟，不清空末次快照，并标 stale。已过期的来源生成时间不会因成功 GET 被刷新为 fresh。资源不可用不取消现有任务、不放宽政策、不阻塞任务查询与停止观察。

只允许明确的 127.0.0.1/IPv6 loopback origin，禁止 DNS 名、重定向及任意 URL 代理；响应最多 1 MiB、2000 行，最多登记 16 个连接。每个采集器单次请求合并；SQLite 代次阻止同连接的旧请求/旧配置覆盖新快照。停止只中断自身请求，待采集结束后关闭数据库。

## 存储与验收边界

新增 quota_connections 与 quota_metadata。仅保存末次脱敏快照、固定错误码、私有配置指纹、代次及本地匿名盐，不保存原始响应或凭据。配置改变时丢弃旧配置的可展示数据；重启保留相同来源的末次快照与匿名范围。将来任务若采用额度准入，须另存不可变引用证据，不能引用随时被替换的缓存作为验收或费用保证。

回归入口为 `gateway/test/quota-observation.test.ts`，使用真实本地 HTTP 样本和临时 SQLite，覆盖鉴权、脱敏、估算/未知/冷却、GET 不采集、失联/过期、连接轮换、乱序、去重、重启、重定向、超时和显示上限。它不证明真实账号余额或 DSH 的单任务消耗。

后续需分别验收：真实来源鉴权和口径；实际 Key 路由的可信映射；完整请求关联后的任务/重试/审查计量；前端资源页与通知。模型目录、协作决策与费用控制均不能从本资源接口直接推导为已就绪。
