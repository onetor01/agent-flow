# Changelog

## v0.0.41

### 新增

- **节点快速切换 plan 模式**：在 AgentNode 上可一键切换 `plan_mode`，无需进入编辑器。
- **节点快捷设置入口节点**：在 AgentNode 上可直接将节点标记为入口节点（`is_entry`）。

### 优化

- **规范 icon 使用**：统一各组件（AgentNode、MessageBubble、text-components）图标使用方式。
- **优化类型问题**：修正多处 TypeScript 类型错误，涉及 flowUtils、AgentEditor、AgentFlow 等。
- **移除已废弃代码**：清理历史废弃逻辑。
- **优化算法**：改进内部布局/处理算法。
- **优化默认工作流**：调整内置预设 flow 结构与配置。

### 修复

- **修复默认 flow 加载问题**：解决默认工作流在特定情况下初始化异常的问题。
