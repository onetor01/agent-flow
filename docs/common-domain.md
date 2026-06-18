# common 领域定义

## 关键文件

- [`../src/common/index.ts`](../src/common/index.ts) — Flow / Agent / Code / PersistedData schema、类型、校验、prompt 构建。
- [`../src/common/event.ts`](../src/common/event.ts) — extension ↔ webview 事件契约。
- [`../src/common/extension.ts`](../src/common/extension.ts) — extension 专用 MCP server 与 SDK 相关构造。
- [`../src/common/flowRunState.ts`](../src/common/flowRunState.ts) — 双端同构 reducer 与消息累加。
- [`../src/common/MessageType.md`](../src/common/MessageType.md) — SDK 消息类型说明。

## schema 与校验

[`../src/common/index.ts`](../src/common/index.ts) 是领域定义入口：

- `FlowSchema` / `AgentSchema` / `CodeSchema` 定义节点与工作流结构。
- `ShareValueKeySchema` 定义 Flow 级共享数据 key。
- `PersistedDataSchema` / `WorkspacePersistedDataSchema` 定义磁盘持久化结构。
- `validateFlow` 校验 Flow 定义。
- `buildAgentSystemPrompt` 基于 agent、flow、`values` 快照构建系统提示词。
- `AgentOverwriteSchema` 定义 code 节点返回值的 `overwrite` 对象结构：`work_mode` 可选枚举（`task` / `chat` / `silent_task`）、`outputs` 可选数组按 `output_name` 匹配覆盖 `require_confirm`。
- `applyAgentOverwrite(agent, overwrite?)` 深度合并 overwrite 到 agent 配置，返回新对象（不可变原 agent）。
- `formatAgentOverwriteText(overwrite?)` 格式化为人类可读文本，无有效内容时返回 `undefined`。
- `buildCodeJSDoc` 生成的 JSDoc 类型声明包含 `AskOption` / `AskItem` / `AskUserQuestion`、`vscode` 参数与 `overwrite` 可选字段，供 code 节点编辑器与只读展示共用。

## MCP server

[`../src/common/extension.ts`](../src/common/extension.ts) 构建 per-Agent MCP server：

- `CompleteTask`：task / silent_task 完成任务与写入 `values` 的入口；chat 不挂载。`buildCompleteTaskInputShape(agent)` 构建其 Zod input shape，供 `canUseTool` 校验复用。
- `TerminateTask`：task / silent_task 可用的中止工具。
- `validateFlow`：校验 Flow 定义。
- `getFlowJSONSchema`：暴露 Flow JSON Schema；`agents` 字段仅包含 `LiteAgent`（`node_type='agent'` 节点），Code 节点不包含在 AI 可见 schema 中。
- `ReadShareValue`：仅 `node_type='agent'`、存在大值（>500 字符）可读 key 时挂载；从 `init()` 时点快照只读；subagent 经 `preToolUseHook` 自动被拒。

运行时挂载与 `work_mode` 差异见 [extension-runtime.md](extension-runtime.md)；values 读写链路见 [share-values.md](share-values.md)。

## 硬约束

- Agent schema 字段保持 `snake_case`，与 prompt 中字段命名对齐。
- `LiteFlow` 不含 `project`，AI 无法设置 Flow 的持久化作用域；`project` 字段不入库详见 [persistence.md](persistence.md)。
- `CompleteTask.values` 的 schema 由 `allowed_write_values_keys` 动态生成，未授权 key 静默丢弃。
- `node_type='code'` 节点不读 `work_mode` / `agent_prompt` / `model` 等 agent-only 字段。
