# 10 证据修复记录（集成人，2026-11-06）

真实验收（10）的证据目录 `E:\javaproject\outputs\finish-live-20261106\evidence` 有 34 个 JSON，其中 3 个不可解析。本文件记录这三份文件的实际情况与修复方式，修复产物在 `E:\javaproject\outputs\finish-integration-20261105\G3-fix\evidence-repair\`。

判断口径：**原文件能解析但内容不是它声称的东西，不等于证据成立**。所以这里区分「重采」「转码」「只能给投影」三种结论，不用格式合法掩盖内容缺失。

## 1. 三份文件的实际状态

| 文件 | 原状 | 实际内容 | 结论 |
| --- | --- | --- | --- |
| `evidence/cards/r6/recovery-view.json`（952B） | 非 JSON，BOM + PowerShell 转录 | 一次失败的 `workbuddy-call.mjs` 调用：参数 `{operationId:card-r6-…}` 未加引号，服务端没收到请求就 `SyntaxError` | 报告里「R6 恢复视图」这条证据原本不成立；已重采 |
| `evidence/workbuddy-models.json`（5042B） | UTF-16LE | 内容是合法 JSON（23 个模型 + runtime 指纹） | 只是编码问题；已转码，未重查 |
| `evidence/get-task-1.json`（1898B） | UTF-16LE，且非 JSON | 同样是失败调用的转录：`workbuddy_get_task {"taskId":…}` 未加引号 | 无法按原路重采；已给投影并说明原因 |

三份文件全部是 PowerShell 重定向 + 参数未加引号的产物。这不是 10 判断错，而是编码与引号两个坑叠在一起：重定向把 UTF-8 变 UTF-16，未加引号又把 JSON 参数变成脚本片段。

## 2. R6 恢复视图：重采成功

用 RC2 解包候选自带的 `dist/recovery-cli.js`，对**库副本**执行 `show` 与 `observe`，两次都 exit 0，输出是合法 JSON：

- `r6-recovery-show.json`、`r6-recovery-observe.json`，各 4667 字节，SHA-256 均为 `5a4feca14c6aad3552fde37da4767b17ad59713486f813a1027a75949c6c607d`；
- 关键字段：`schemaVersion operation-recovery-1`、`operation.operationId card-r6-foreign-session-1793948211334`、`operation.kind send`、`attemptId null`、`available []`、`proof` 与 `capacity` 段俱在。
- `available: []` 与 10 报告里的描述一致——**这次有可解析的文件支撑它了**。

副本在 `evidence-repair/db/tasks.sqlite`（复制自安装根 `data\tasks.sqlite`），全程只读，没有打开真实库，没有派工。

## 3. 模型目录：转码即可

`workbuddy-models.json` 按 UTF-16LE 解码后再以 UTF-8 写出，**内容一字未改**：

- `transcoded/workbuddy-models.json`，2520 字节，SHA-256 `2ebda8f827dfbcbe5b351332015d9104197a6f79ff3633a6908cbfa1ec8a8f18`；
- 解析确认：`models` 23 条，`runtime` 含 `release/packageVersion/pid/startedAt/codeHash`，首条 `{"id":"default-model","name":"Auto","credits":"x0.15"}`。

没有重新查询模型目录：重查会再次接触真实客户端，而这里只需要把已有字节换个编码。

## 4. `get-task-1.json`：只能给投影

这份原文件想覆盖的是 DSH 那一单（`d1-dsh-5f82573e-…`），但即使把引号补对，也拿不到 `get` 结果：

| 尝试 | 结果 |
| --- | --- |
| `workbuddy_get_task`（原路径） | `{"ok":false,"error":"The original DSH adapter is unavailable; WorkBuddy cannot take over its task"}` —— 设计如此，DSH 任务不走 WorkBuddy 读路径 |
| `deepseek_get_task`（正确读路径） | `{"ok":false,"error":"Unknown DeepSeek task: d1-dsh-…"}` —— 该工具读 Harness 自己的存储，本沙箱没有它的运行库 |

两次拒绝都留在 `get-task-1.workbuddy-refusal.json` 与 `get-task-1.deepseek-refusal.json`，作为「不是没试，是这条路在本机不通」的记录。

替代品是**库副本上的投影**，不是工具输出：`get-task-1.projection.json`（8290 字节，SHA-256 `92b4e999c178f8ae4c6aa579201a03e9866b0366ece0338e88ec3a5e5e2c8cc2`），schema `workbuddy-executor/task-projection-1`，取自 `tasks.sqlite`，含任务行（state `accepted`、attempt 1、revision、review 时间）、51 条事件、10 条操作、attempt 列表与容量行（0 条）。

**因此要修正 10 报告的一处说法**：那一单的「任务详情证据」没有 `get` 捕获，只有库内投影。派工与验收结论不受影响（`workbuddy_get_task` 对 WorkBuddy 单可用，DSH 单的接受证据走 `deepseek_get_task`，10 的证据目录里 DSH 侧另有 10 个文件）。

## 5. 边界

- 只读副本，未打开真实库，未派工，未安装，未改任何真实配置。
- 修复产物全部在 `outputs` 下，不入 Git；本文件只记录结论与哈希。
- 若要拿到真正的 `get` 捕获，只能在有 DSH 运行库的机器上重做一次读操作——那属于 10 的范围，需要单独授权。
