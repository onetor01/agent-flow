# Changelog

## v0.0.39

### 新增

- **deny_tools**：为每个 Agent 配置禁止使用的工具清单，被禁止的工具不会出现在 Agent 的工具列表中。
- **no_output 节点**：Agent 可标记为无输出节点（`no_output`），无输出节点的后继节点首条消息统一使用"执行任务"（与 `no_input` 节点行为对称）。
- **输出分支确认标注**：需要完成前确认的输出分支在 Agent 编辑器中特别标注，一目了然。

### 优化

- **统一 tool permission 链路**（PR #25）：AskUserQuestion / CompleteTask 完成前确认 / ExitPlanMode / must_confirm 四类"挂起等待确认"统一为单一 pendingToolPermissions 队列与 ToolPermissionCard 卡片 UI；silent_task 下 ExitPlanMode 自动接受；工具权限默认全部允许（移除"自动确认工具"概念）。
- **连线静默替换**：在已有连线的输出端口再连线时，静默替换旧连线而不是阻止操作。
- **无输入/无输出节点展示**优化：视觉布局更直观。
- **Plan 模式**：支持在主面板打开文件；描述更准确。
- **silent_task 自动回复**：回复文本更明确强调任务要求，新增 maxTurns 限制。
- 预设工作流内容与位置调整；提供 JSON 格式的预设 flow 文件（`preset-flows.json`）。
- 编辑节点时不再额外写入无关字段。

### 修复

- GetFlowJSONSchema 返回的 Flow Schema 有误，修复并优化描述，AI 设计 Flow 时更准确。
