# T3b：DSH 原生适配与共享任务服务

日期：2026-10-26。实现状态与真实部署分开：本分支提供共享任务适配、只读发现、Windows 私有桥接与受控 SDK 接口；真实用户会话的派工、取消和返工仍须在安装新桥接后单独验收。没有升级已安装技能或改动原 dsh-codex-workflow 的自动审查记录。

## 服务边界

`DshTaskCoordinator` 与 WorkBuddy 使用同一 `TaskStore`，经 `TaskApplicationService` 按已保存的执行器路由。业务状态、契约、revision、事件和最终 accept 均由共享服务保存，不写入旧 `DeepSeekStore`，不把插件 review 当作最终验收。已绑定的 DSH 任务在适配器不可用时明确失败，不能交给 WorkBuddy 接管。

使用显式 vnext-2 契约、已登记真实工作区、经用户实际选择并确认的方案及精确 host/provider/model/effort。新默认为用户选择，没有固定模型或零费率门槛；可主动设置白名单和免费限定，历史任务限制保留。启用 DSH 环境配置不会确认方案或发起模型请求。方案和政策仍由可信本地应用入口维护；新增 HTTP 写接口不在本阶段。

`TaskStore.atomic` 组合准入、原任务和 DSH 绑定的 SQLite 写入，嵌套操作使用 savepoint。`dsh_attempt_bindings` 保存原 task/attempt/host/session/request、执行选择、代次游标、投递状态和占用；记录带摘要。每个已配置任务库最多一个未解决的 DSH 绑定；WorkBuddy beginAttempt 同时核对它，DSH 准备前核对其他任务的持久停止证据。模型准备或投递不明保留原绑定，重放 send 不再次准备或发送。

这是一条受控单任务路径。完整 operationId、跨入口恢复回执、占用迁移和模型准备结果不明的人工恢复仍属 T4；不把原 dsh-codex-workflow 或旧独立 DeepSeek 网关纳入同一容量保证，不能并行启用旧派工路径绕过共享服务。

## 会话和模型

- `discoverDshSessions` 用只读 SQLite 连接查询工作流插件的有效租约，不调用 BridgeStore.init、不更新租约或修复数据。目录取真实路径；无记录、读取失败、无匹配、多匹配和明确选择分别返回原因。
- 原生桥接只读 `sessions/session` 与 `models`；历史会话和当前 attached 会话分开。只能选择同一真实目录内 attached 的原会话，不选最新、不默认创建或恢复冷会话。
- 初始派工才可准备所选模型；已一致时不重复选择。原生 selectModel 后读回 provider/model/effort，发送前再次核对。返工沿用原会话且不重新切模型；漂移时拒绝。
- 宿主 selectModel 使用原生模型选择语义：改变会话选择时宿主也可能保存新建会话的默认模型。适配器不修改其他已存在会话或权限政策；真实验收前须明确授权所选模型。
- DSH 原生目录没有费率字段，不能据模型名或可见性认定免费。可选的 `workBuddyDshRateObserver` 只接受运营者明确绑定的实际连接/provider/网关 Key，通过 `/v1/models` 读取精确模型的费率元数据。付费值如实保存；未配置、不可得或过期的费率保持 unknown/null，默认政策允许用户了解后选择。该读取可能触发源服务的模型元数据缓存更新，不发模型推理或积分刷新请求。
- `workBuddyDshFreeRateVerifier` 保留为主动免费限定的严格封装，未知或非零仍拒绝。白名单与 Key 映射属于可信后端配置，浏览器不能提交“已免费”标记；错误来源映射仍拒绝。完整 Key 路由、代理物理模型与硬费用控制尚未验收，不由模型目录推导完成。

requested selection 在任务准入中保存，selected observation 在轮次准入中保存；`request/header` 的真实配置单独记录为 effectiveModel 和 nativeEventSeq。它只证明 DSH 请求层的模型，不证明代理背后的物理模型。一轮内任何已观察到的模型漂移都保留为失败，后来切回不能抹掉历史。

## 投递、停止与报告

Windows 使用随机 named pipe 和私有注册令牌，不监听 TCP。新建桥接目录设置当前用户私有 ACL，已有路径仅核对、不改权限；允许系统和管理员的管理权限，拒绝其他用户的允许规则及 reparse point。Unix 保留 UID/mode 检查。请求仍有大小、数量、超时和原生操作未结清时的占用限制。

桥接支持实际 session-controller `0.2.0-rc.2` 与 `0.2.1-rc.2`，并检查所需方法。新派工须带 expectedSelection；缺少模型绑定的旧独立网关 prompt 被拒绝。插件不会启动另一个宿主或调用工作流 Planner/Reviewer。

业务成功、报告认证、停止和独立验收分别保存：

1. 投递回执缺失保持 uncertain，不重发、不换会话。只有明确 native pre-admission rejection 可记为 not_dispatched；不会伪造 turn/end。
2. cancel 只记录请求，原生回执中的 stopped 布尔值不作为停止证明。只有匹配原 request/turn 的持久 turn/end 或精确的队列取消事件才确认原请求结束；idle 不证明结束。
3. 固定 deadline 来自持久轮次准入；观察时核对文件未改写期限。监督 sync 到期时发起原请求取消并保留占用，直到原生终止事件；迟到成功报告不能升级为成功。
4. 完成报告还需匹配的请求模型和真实文本。DSH 用独立认证格式 2 绑定 host/request/terminal seq，既有 WorkBuddy 格式 1 不变。文件或原生来源身份不符时拒绝。
5. native terminal 只证明原生请求的生命周期，不代替工具命令的退出/清理或子任务检查；委派约定须禁用后台任务与另行委派，独立验收仍需核查实际文件和检查证据。更完整的执行范围和子任务监督需后续能力支持。
6. accept 需要当前已认证报告、停止证明和协调者独立 evidence；复核 projection/revision 后原子保存 review 和 task_closed。插件 automaticReview 仍为 false；不自动重提历史失败审查。

stage-2 的只读详情/列表/事件可读取 DSH 记录；GET 不同步、不补写。HTTP 所有写入口继续关闭，TaskView 完整模型选择界面与 T7 面板尚未交付。

## 显式启用与核查

配置见 [WINDOWS_ENV.example](../gateway/WINDOWS_ENV.example)。`WORKBUDDY_DSH_ENABLED=1` 只开启适配器；host/provider 与可选的费率来源 URL/既有 Key 由私有启动环境提供。默认政策下缺少费率来源表示费用未知，用户了解并确认后可派工；只有主动免费限定才要求零费率证明。不可把其他来源 Key 的目录冒充该 DSH provider 的费率。参数错误停用 DSH，不妨碍原 WorkBuddy 服务启动。

```powershell
cd gateway
node dist/dsh-inspect.js --cwd <existing-absolute-project-directory>
# 多会话时显式追加 --session <selected-session-id>；多 Host 时追加 --host。
node scripts/dsh-host-check.mjs <installed-dsh-package-json>
```

发现命令不输出令牌，不选择模型或创建会话。host-check 在临时存储中加载/卸载插件，检查实际宿主 Cordis 与控制器方法，但使用空的控制器/Agent 替身，不运行真实模型或验证真实会话执行。

新桥接单独打包安装，安装需通过现有宿主的 bundled CLI，并保留私有配置备份。Windows 使用 `node scripts/install-deepseek-plugin.mjs --app <existing-install-directory> --profile desktop --package <reviewed-local-tgz>`。该命令会修改所选 DSH profile 的插件登记；代码开发或 push 不自动授权安装、重新加载或部署。不要为安装重写用户已有插件配置或按进程名终止桌面程序。

自动回归入口为 `test/dsh-adapter.test.ts`、`test/dsh-transport.test.ts` 和 `deepseek-plugin/test/*.test.mjs`，包括真实本地 named-pipe/HTTP、合成原生事件和临时 SQLite。实际宿主 API、隔离加载、合成执行、真实模型与真实文件验收分别记录，未覆盖项不计为通过。
