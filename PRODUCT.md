# WorkBuddy Executor 产品上下文

<!-- impeccable:product-schema 1 -->

## Platform

web

本文件中的 web 指规划中的本地任务面板。执行环境为 Windows 桌面 WorkBuddy 与本地 Node 网关。

## Stack

现有网关使用 TypeScript、Node、SQLite。面板技术栈尚未约定；当前交付为设计文档，框架选择留给前端实现任务确认，不视为已经建立前端工程。

## Users

使用 Codex 与 WorkBuddy 完成本地开发任务的人。他们需要看懂任务进度、阻塞原因、报告与独立验收的区别，并知道需要在哪个原生界面处理输入。

## Product Purpose

Codex 定义范围、监督和独立验收，WorkBuddy 负责执行，网关维护任务身份、轮次、绝对期限、执行证据与停止状态。本地面板提供这些事实的可理解展示。

## Operating Context

当前已确认的前端任务是只读模拟面板：任务列表、任务详情、全部状态与异常场景。它可以独立于真实 WorkBuddy 和后端 HTTP 接口开发。

## Capabilities and Constraints

- 现有 MCP 的基础 statusView 已实现；完整 vNext TaskView 与 `/workbench/v1` 为目标契约，尚未完成接入。
- 面板不建立第二套执行引擎，不将上游 HubRun 状态直接作为本执行器状态。
- 首版不派工、返工、取消、验收或批准权限；模拟数据持续明确标记。
- 原生停止与最终验收是不同事实；报告到达不代表执行已停止。
- 未知信息保持未知，原生权限在 WorkBuddy 界面处理。
- 任务、轮次、会话及绝对期限由服务端维护，前端不得重置。

## Evidence on Hand

- `docs/INTERFACE_CONTRACT.md`：目标契约；尚未实现的部分明确标注。
- `gateway/src/task-application-service.ts`：当前基础状态投影。
- `gateway/docs/native-history-deployment-verification.json`：本机真实执行证据，不代表面板已经接入，也不代表第二台 Windows 验收。
- `docs/FRONTEND_TASK_PANEL_DESIGN.md`：本次只读模拟面板的具体交付范围与验收标准。

## Product Principles

1. 显示可核对的事实，不将未知包装为成功。
2. 先说明当前状态、阻塞原因和用户下一步，再展示技术身份。
3. 客户端展示共享网关的事实，不自行决定执行与验收结果。
4. 独立配置和合成样本用于协作，真实凭据、会话与任务库不通过 Git 共享。
