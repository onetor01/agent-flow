# Changelog

## v0.0.46

### 新增

- **silent_task 自动回复上限**：无人值守模式自动回复（续轮 + 自动应答 + 自动接受）受 `SILENT_MAX_AUTO_REPLIES`（默认 30）per-run 次数上限约束，超过后触发 `agent-error` 终态，SDK 层 `maxTurns=60` 作双重兜底。
- **AgentNode 新增"需要确认"快捷设置**：在 AgentNode 上可直接切换 `require_confirm`（完成前确认），与 `no_input` / `no_output` / 隔离模式等快捷操作对齐。
- **Code 节点中断/终止支持**：Code 节点运行中可被中断（interrupt → disposed + error 终态）或终止（kill → disposed + stopped 终态）。

### 优化

- **对话按 run 分组折叠**：MessageList 按 run 分组折叠显示，最新 run 默认展开；收起态保留首条 user 消息 + 完成卡片 + "显示消息"按钮。
- **注入数据可视化**：AgentRun 创建时固化 `injectedShareValues`，按 `allowed_read_values_keys` 过滤后附加展示于首条 user 气泡内。
- **Fork 支持从工具调用消息分叉**：tooluse 块现在也可以作为 fork 起点；fork 按钮统一在最后一个消息块显示，确保图标与实际 fork 位置一致。
- **copy/fork 按钮样式优化**：消息气泡上复制和 fork 按钮的视觉样式调整。
- **节点模型选择器优化**：AgentNode 上模型选择器交互优化。
- **静默模式提醒扩展**：点击 Agent 节点也会弹出静默模式警告提醒（此前仅在编辑器面板显示）。
- **"无输出"快捷设置位置调整**：`no_output` 快捷设置移至与其他快捷设置统一的位置。
- **更准确的 AI 工具拒绝词**：完善内置提示词中 AI 拒绝工具调用的措辞。
- **打开文件默认使用 active 编辑器**：避免新开编辑器组造成的卡顿。
- **run 折叠算法优化**：不再计算气泡个数，减少渲染计算量。
- **优化默认工作流**：多次调整内置预设 flow 结构与节点配置。

## v0.0.45

- 优化交互和默认工作流

## v0.0.44

### 新增

- **快捷回复功能**：聊天输入框提供快捷回复选项，一键填入常用回复内容。
- **节点便捷设置**：在 AgentNode 上可直接切换 `no_input`、`no_output`、隔离模式及模型，无需进入编辑器。

### 优化

- **code 节点只提交自身修改的 values**：code 节点返回的 `values` 仅将代码显式修改的 key delta 合并到 shareValues，其余 key 不受影响。
- **更准确的 AI 工具拒绝词**：优化内置提示词中 AI 拒绝工具调用的措辞，描述更精准。
- **优化默认工作流**：多次调整内置预设 flow 结构与节点配置。
- **优化样式**：细节样式优化。

### 修复

- **修复 agent 编辑表单**：修复 Agent 编辑表单在特定情况下的异常行为。
