# Changelog

## v0.0.36

- 修复 Code 节点无法复制的问题
- 任务模式（`task`）现在也暴露 `TerminateTask` MCP，极端情况下可中止任务
- 优化工具名称显示
- 优化默认 flow
- 优化系统提示词

## v0.0.35

- 修复默认flow

## v0.0.34

- 修复lock文件

## v0.0.33

- **Code 节点**：新增 `node_type='code'`，不走 AI SDK，把 `code` 字段当作 `async function (input, values, runCommand) { ... }` 函数体执行。入参 `input` 为上游节点输出文本，`values` 为完整 shareValues 快照（全量读写不受授权约束），`runCommand` 为在 workspace 下执行 shell 命令的异步函数（基于 execa 9.x）。返回值映射为 `{ output_name?, content?, values? }` 驱动下一跳，`values` 与现有 shareValues 合并。
- Code 节点代码编辑器基于 CodeMirror，提供 `input` / `values.*` / `runCommand` 补全和 `Shift+Alt+F` 格式化
- Agent 字段 `model` / `effort` / `work_mode` 改为可选（code 节点不需要这些字段）
- `getFlowJSONSchema` 返回精简 schema，减少无关数据注入 AI 上下文
- 调整系统提示词，移除"否则系统会持续以「继续」让你循环"措辞
- 优化默认 flow：内置 flow 释放资源节点改为 code 节点，AI 对话 flow 新增 qwen / opus-max 模型选项
- 错误对象改为 string 传输（避免 Error 对象序列化丢失）

## v0.0.32

- 修复 Claude API Key 配置错误

## v0.0.31

- Flow/Agent 层级 `base_url` / `api_key` 分层配置：Agent 非空时覆盖 Flow 默认值，留空回落，两端不填沿用环境变量
- 优化 fork 交互
- 移除 Flow 简介
- 增加系统提示词自由度：`disable_claude_preset` / `raw_prompt` 选项
- 允许无后续 agent 的 complete 消息携带输出分支名称便于展示
- 细粒度的完成时确认：按 output 分支独立配置 `require_confirm`
- 优化默认 flow

## v0.0.30

- Dev/complete confirm：完成前确认机制 (#21)
- Plan 模式：Agent 可开启 `plan_mode` 以计划/只读模式运行
- 修复 fork 之后的会话无法再次 fork

## v0.0.29

- Dev/bash command perm：Bash 工具命令级权限控制 (#20) —— 支持 `Bash(git status)` 前缀匹配，复合命令拆分判断
- 调整 tool 请求相关的样式

## v0.0.28

- 调整 AI 会话渲染
- 调整日志打印

## v0.0.27

- 修改 Claude.md
- 修复流式渲染问题
- 优化 Agent 系统提示词，更有利于缓存
- 新增模型选项 sonnet[1m]

## v0.0.26

- 优化 CI

## v0.0.25

- Chat 模式对齐 task 模式的 token / 费用展示与上下文窗口进度条

## v0.0.24

- 日志增加模型用量
- 更新 SDK
- 调整模型选项
- silent_task 对齐普通模式的用户中断与发送能力

## v0.0.23

- 优化 AskUserQuestionCard 滚动逻辑

## v0.0.22

- 优化 Claude.md
- 修复部分模型无法展示上下文进度的问题
- 优化 Agent 系统提示词
- 修复工作流校验函数，静默模式也可以无 output
- 优化日志输出，减少大对象打印

## v0.0.21

- 大量功能迭代 (#19)：虚拟列表渲染、token 消耗可视化、上下文窗口占用展示、共享数据编辑、Ctrl+Shift+L 编辑器联动等

## v0.0.20

- ChatDrawer 改造：常驻 ChatInput，ChatPanel 新增 runId / tokenMode 模式

## v0.0.19

- token 统计、费用展示、对话 Fork 等

## v0.0.18 及更早

- 初始版本迭代：work_mode 三态、ShareValues 共享存储、silent_task 无人值守、MCP 工具权限控制、Flow 可视化编辑、内置示例工作流等基础能力
