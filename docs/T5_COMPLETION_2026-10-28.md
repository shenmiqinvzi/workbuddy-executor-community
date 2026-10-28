# T5 交付记录（2026-10-28）

T5 已实现派工前持久文件基线、原有改动保护、累计增量检查及 WorkBuddy/DSH 共用验收关口，两端本机真实补验均已 accepted 并关闭。本次仓库集成入口为 [PR #16](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/16)；最终合并提交、状态及对应 CI 可由该记录核对。源码验收、仓库合并和安装发布分别登记。

## 交付内容

- 模型准备前固定原工作流基线，每轮另存输入库存；返工不扩大范围，不覆盖原始基线或消除累计越界。
- 核对新增、修改、删除、重命名两端、二进制、最小 metadata，以及原 Git dirty/暂存/未跟踪内容和暂存索引。
- 范围检查、报告认证、原生停止与最终存储验收相互独立；缺失、错轮次、库存变化、越界或 checker_error 均拒绝，不自动回滚用户文件。
- Windows 路径别名按真实归属核对，链接/硬链接与歧义名称拒绝；stage-2 workspaceScope 只读已存事实，GET 不扫描工作区、不执行 Git 或调用模型。
- 修复真实补验发现的执行器政策路由不一致；离线计划仍为元数据操作，单轮任务预算与历史模型限制保持。

实现细节见 [T5 文件保护](T5_WORKSPACE_PROTECTION.md)，真实样本及限制见 [10月27日本机补验](T5_LIVE_ACCEPTANCE_2026-10-27.md)。

## 验证归属

WorkBuddy 真实样本属于 `9da96c2`；DSH 真实样本属于 `951f20d`。后续 `9891cb5` 完成离线计划兼容，`34f305a` 只修正测试夹具长轮询窗口；交付文档同步不改变运行代码。这些样本不冒充每个后续文档提交均重新运行过模型。最终运行代码摘要为 `be7d7fe75bf1c115602d0a335ad306691c3a166aab700c7557c492d7d8fa8e37`。

本地构建、类型检查、400项契约/报告/范围回归、94项受影响回归均通过，计数有重叠，不相加；监听器夹具修正后，持久服务51项回归通过。独立干净检出无需构建、没有开发依赖或本机 .env，438文件快照和25步已编译 MCP/HTTP 冒烟通过。生产依赖复用相同 lockfile 的既有独立安装，未冒称再次安装。

`9891cb5` 的[首次 CI](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/40630250902)保留一项监听器夹具失败：500ms 轮询被繁忙 runner 的准备 I/O 耗尽，正常返回 retry。改用队列已有的默认长轮询，仍只调用一次 claim，全部原断言保留，没有延长生产任务期限。最终提交的完整 Windows CI 通过情况须核对 PR 对应 SHA；[合并后 main 运行](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/workflows/windows-gateway.yml?query=branch%3Amain)单独验证，不用旧候选或 PR head 的结果代替。

原提交使用 noreply 身份，通过一次性的本机 SOCKS 代理参数上传，未更改持久 Git/代理配置或关闭 TLS 校验。原始业务/会话日志、数据库、配置和凭据保留在仓库外。

## 完成边界与下一步

本阶段交付限于约定的文件保护、两端本机关键验收及仓库集成。库存具有明确排除项，不能全面观察任意 shell 对外部路径的写入，不是 OS 沙箱；并发改动不能可靠归因时保持冲突。全部真实故障注入、第二台 Windows、正式发布安装包和升级用户已安装网关/技能不由本次替代。

下一阶段是 T6：不可变 reviewId、独立检查记录与当前约定/attempt/源码/执行来源的绑定，以及拒绝旧证据的最终验收。T6/T7 和新增 HTTP 写入口没有借本次交付开放。
