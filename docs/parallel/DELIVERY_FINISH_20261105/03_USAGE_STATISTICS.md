# 03：请求归因与可复算统计（第一批）

从G0的L03-statistics / feat/finish-l03-statistics开发。读COMMON/MASTER、INTERFACE_CONTRACT、事件与review/operation存储、local-statistics-client现状。任务D6-01/02/05，V12/C12/C18统计子项；不重造执行引擎。

## 负责范围

拥有新增usage-attribution/statistics模块、只读统计视图、定向测试及docs/delivery/L03_ACCEPTANCE.md。统一schema/migration、TaskStore、TaskApplicationService、coordinator、MCP/HTTP/桌面导航接线由集成人持有；给出精确请求与集成检查。不得改01派工选择、02采集、04安装。

## 实施

1. 定义版本化归因记录：task/attempt→原生request→代理request/retry，执行器/来源/模型观察层级、worker/reviewer/检查器role、幂等来源键、发生/观察时间、单位/金额/币种/coverage。仅使用可见真实标识，不能把正文/路径/账号放作计费标签。
2. 设计最小持久化及去重/补录/冲正/来源冲突语义，读取旧任务无字段时unknown，不给历史任务造token、调用数或费用。不用余额差、报价、单次HTTP请求数推算模型账单。
3. 计算可复算总耗时/执行/等待/人工episode、attempt/返工/恢复/调用量/用量与费用；按角色分开、窗口/样本数/缺失覆盖明确，重复事件不重复累计，延迟观察不改事件发生时间。
4. 质量统计失败/检查器故障/未知/取消/blocked分开，分母和时间窗可查；样本不足不宣称节省或“更优秀”。不为统计再调模型。
5. 提供可达只读统计页面和可审计明细，null与零、部分覆盖与完整覆盖分开，不把统计API当外部任意文件读取入口。
6. 给05提供统计参考且附样本量/局限，05不得从缺失统计生成排名。与02用合成上游请求字段做一次契约联调；缺真实字段只输出未知原因。

## 验收

含重复/乱序/重放、并发写同来源、同池多客户端、重试、worker/reviewer区分、迟到费用、单位/币种分组、缺字段/部分覆盖、legacy/坏schema、人工episode、返工与重连不同计数。
逐条原始事件可复算聚合结果，窗口边界/非法时间可解释；只读API/界面无模型请求、泄漏或任务状态写入。schema升级/回退限制有合成证据。
提交实现、可执行合成数据复算示例、专项、接线请求及HANDOFF；真实请求归因覆盖由10另验证。
