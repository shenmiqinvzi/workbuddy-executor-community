# F-CONTRACT-1：未声明范围的任务与「不得新建文件」的冲突

状态：已给出现行行为说明与兼容影响；**是否允许从自然语言或目标文本推导写权限，需要用户一次决定**。本文件中的代码改动只做了措辞与诊断改进，没有扩大任何写权限。

## 1. 现象（RC2 真实派工复现）

- 派工单正文要求执行器新建 `rc2-check.txt` 并写一行内容；调用方没有传结构化 `scope`。
- 执行器按要求创建了文件，随后 `$scope` 机器检查判为 `failed`，`workbuddy_review_task` 因此无法得到通过的 review，任务停在 `needs_review` 并继续占用共享容量。
- 上一轮的 note 只是通用文案「T5 inventory and original user changes」，看不出是哪条路径越界。本轮已改为指名路径（见 §4）。

## 2. 现行行为（源码事实）

- `gateway/src/coordinator.ts:148`：未声明 `scope` 时，提示词固定为
  `No structured file scope was declared: this submission is read-only. Do not create, modify or delete workspace files.`
- `gateway/src/workspace-protection.ts:64-66`：`category()` 只把命中 `allowedChanges`/`permittedMetadata` 的条目判为 `deliverable`/`metadata`，其余一律 `unauthorized`；未声明范围时两个模式都是空集，任何新增/修改/删除都落到 `unauthorized`。
- 同文件 `:222`：`mode === "legacy_read_only"` 且范围为空时，任何写入请求直接 `SCOPE_PATH_UNAUTHORIZED`（"Legacy submissions have no implicit write grant."）。
- 因此「正文允许新建」与「网关判越界」不是两个缺陷，而是同一设计的两面：**写权限只来自调用方声明的结构化范围，正文与目标文本不构成授权**。这是 T5 范围证据链的基础，收紧方向一致，不能靠改判放宽。

## 3. 兼容影响

| 方案 | 语义 | 兼容影响 | 风险 |
| --- | --- | --- | --- |
| A. 保持现状 + 提前说明（本轮已做） | 无范围=只读；提示词说明需要改文件时应先声明范围 | 无行为变化；只改文案与诊断 | 无 |
| B. 未声明范围时在准入阶段直接拒绝「需要写文件的任务」 | 需要调用方能表达「我要写」这个意图 | 现有只读任务不受影响；想改文件的调用必须补 `scope` | 无范围时无法区分意图，只能在正文里猜，等于引入启发式授权 |
| C. 从目标/正文推导 `allowedChanges` | 把自然语言当授权 | 破坏「范围来自调用方声明」的证据链；审计上无法区分谁授权了哪条路径 | 高：等于让执行器自己扩大权限 |

本轮只做 A。B/C 都需要改正式语义，按总任务要求留待用户一次决定。

## 4. 本轮已做的改动（不扩权）

1. `$scope` 失败时指明未授权路径：`gateway/src/task-reviews.ts:141-146` 取 `scope.changes` 里 `category === "unauthorized"` 的前 5 条，生成 `Unauthorized workspace changes: added <path>, modified <path>`，替换掉通用文案；`scope.error` 存在时仍优先显示原错误。
2. `workbuddy_review_task` 的 `INVALID_REVIEW` 文案补充「call workbuddy_check_task first to create that batch」，与 `$scope`/批次来源一起构成可发现的链路。
3. 提示词补充：未声明范围时明确写出「若目标需要改文件，先报告调用方必须声明结构化范围；正文不构成写授权」。措辞改动不影响任何判定分支。

## 5. 需要用户决定的事项

- 是否要 **B**：在准入阶段对「无范围 + 目标文本暗示需要写文件」直接拒绝并给出稳定错误码（不猜路径，只拒绝并提示补 `scope`）。若采纳，需定义错误码（建议 `SCOPE_NOT_DECLARED`）与调用方补范围的入口。
- 是否要 **C**：从目标文本推导写范围。若采纳，需同时给出审计口径：谁授权、授权到哪条路径、如何回滚。默认不建议。
- 在此之前，真实派工若需要新建文件，调用方必须显式传 `scope.allowedChanges`（例如 `["src/**"]` 或具体文件名），否则 `$scope` 必然失败——这是当前正确行为，不是缺陷。

## 6. 复现与验证入口

- 现状复现：任意未声明 `scope` 的派工，执行器新建文件 → `workbuddy_check_task` 的 `$scope` 为 `failed`，note 现在包含 `Unauthorized workspace changes: added <path>`。
- 正向对照：声明 `scope.allowedChanges` 覆盖该路径后，同一检查为 `passed`。
- 回归：`gateway/test/task-reviews.test.ts` 的「T5 machine checks name the unauthorized workspace change instead of a generic scope note」。
