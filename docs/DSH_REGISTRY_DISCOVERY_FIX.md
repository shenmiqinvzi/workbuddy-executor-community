# DSH 注册发现一致性修复（2026-11-05）

起点：`integration/resource-center` 的 `bd4cdf8`。范围：`DeepSeekClient` 的单次 RPC 宿主选择、发现失败的脱敏诊断及回归。不修改桥接 ACL、注册文件、原任务、容量或部署配置。

## 问题与修复

前一版正式全量 1000 项中只有 `test/dsh-transport.test.ts` 失败，异常是访问 `undefined.socketPath`，见 [前版集成记录](RESOURCE_PARALLEL_INTEGRATION_20261105.md)。`rpc()` 先调用 `resolveHostId()` 枚举私有注册表，再调用 `hosts().find(...)!` 枚举一次，第二次结果可能消失或被替换，非空断言无法保证该对象存在。使用第一次返回合成宿主、第二次返回空数组的夹具可以无网络复现。历史那次第二次枚举为什么被过滤，不能仅由这个复现判断为 ACL 超时或机器负载。

现在 `resolveHostId()` 与 `rpc()` 共用一次选择逻辑；每个 RPC 从同一份经过原有私有路径检查的发现结果中选定宿主身份、端点和令牌。中途不会重新枚举、换端点或换凭据；下一次独立 RPC 仍重新发现，不缓存旧宿主来绕过校验。指定宿主缺失不回退，多个候选或同一 hostId 的重复登记不按第一条选择。

| 发现结果 | 错误码 | 处理 |
|---|---|---|
| 无可用宿主，或指定宿主缺失/已死 | `HOST_NOT_FOUND` | 不发送本次 RPC，不回退其他宿主 |
| 候选不唯一 | `HOST_AMBIGUOUS` | 要求核对精确宿主/重复登记，不取第一条 |
| 注册目录不可读或私有路径无法核验 | `HOST_DISCOVERY_UNAVAILABLE` | 仅返回 `registry_unreadable` / `acl_query_timeout` / `private_path_unverified` 的固定诊断，不暴露路径、令牌或 PowerShell 原始输出 |

ACL 检查及其原 10 秒超时保持原样；未核验的登记仍被排除。远端认证失败、连接失败或响应丢失都不会触发本次 RPC 的重试。发现错误的 `admissionRejected` 保持 false：缺宿主不能证明原任务先前没有副作用，也不能作为停止或释放容量的证据。原有远端明确准入拒绝的规则不变。

## 验证范围

本机证据：`outputs/dsh-discovery-fix-20261105/`。全部使用合成登记、隔离数据库及本轮自建 named pipe/socket，没有真实模型调用。

- 新增发现回归的前 11 项先在旧实现上运行：0 pass / 11 fail，`before-fix.log`。
- 修复后这 11 项通过，`after-fix.log`；随后补 Windows ACL 查询失败注入，共 12 项，涵盖单次快照、登记旋转、显式宿主/多宿主/重复宿主、死亡进程、跨 RPC 重新发现、脱敏、认证失败不换凭据、响应丢失不重发。
- 协调器增加 1 项真实存储回归，分别注入三个本地错误码，证明原绑定仍不确定、没有停止证据、容量仍持有且不创建第二轮。
- 正式 ACL/认证 named pipe 由已有 `dsh-transport.test.ts` 验证；新 ACL 失败测试只模拟 helper 失败，不冒充真实 ACL 成功。

| 检查 | 结果 |
|---|---|
| 相关隔离批次：discovery/client/adapter/coordinator/resource-fault | 75 项 / 71 pass / 0 fail / 4 平台跳过，exit 0，`related-tests-isolated.log` |
| `npm run build` | exit 0，`build.log` |
| `npm run typecheck:task-view` | exit 0，`typecheck.log` |
| 新增/修改测试 strict 类型检查 | 从 gateway 运行 exit 0，`test-types.log` |
| 最终正式 `npm test`（正常本机上下文、默认并发） | 1013 项 / 1000 pass / 0 fail / 0 cancelled / 13 平台跳过，exit 0，332.4 秒，`full-suite.log`；此前失败的 DSH 私有传输用例在完整并发中通过 |
| 快照 | 328 个跟踪文件，保留历史 provenance，完整性与哈希校验通过 |

首次相关批次未显式隔离安装路径，1 项因多 WorkBuddy 安装歧义失败，保留 `related-tests.log`；限定自有假可执行程序/配置后完成上述 75 项。一次额外测试类型检查从仓库根执行未找到 gateway 的 Node 类型，已改从 gateway 执行通过，没有放宽 strict 或改类型依赖。全量使用正常本机上下文，避免已确认的受限 CIM / tsx 用户资料读取问题；测试数据和 TEMP 仍限定在自有目录。

## 交付边界

候选包：`outputs/dsh-discovery-fix-20261105/package/codex-workbuddy-gateway-v0.7.1.zip`，570 个业务文件，SHA-256 `003417bce7b41e4b9bdc3400d3a5d779f80d8dc9fed53437db52f63e964546b8`。解包后官方 `verify-release.mjs` 返回 570 文件、hashesMatch=true；逐项与源码/构建目录比较无差异。相对上一候选新增发现测试，修改 client 源码、三个 dist 文件和 adapter 回归，共 1 增 5 改，没有修改插件 ACL 文件。包内 dist 另经自建 named pipe 夹具验证：首次发现唯一宿主时一次 RPC 成功，随后宿主缺失返回 HOST_NOT_FOUND，累计只收到一个请求；见 `package-comparison.json`、`package-rpc.json`。

本轮不推送、不合 main、不安装、不部署、不重启生产进程。README.md、ROADMAP.md 的原有修改不纳入提交。真实账号池、已安装网关对齐、D1 真实 MCP 双端闭环与异机验收继续单列，不能由本修复的合成验证替代。
