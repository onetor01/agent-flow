# webview 状态与 UI 生命周期

## 关键文件

- [`../src/webview/App.tsx`](../src/webview/App.tsx) — 根组件挂载结构。
- [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) — zustand store、命令派发、signal 接收。
- [`../src/webview/components/ChatDrawer/index.tsx`](../src/webview/components/ChatDrawer/index.tsx) — 对话抽屉与 ChatPanel key。
- [`../src/webview/components/ChatDrawer/ChatInput.tsx`](../src/webview/components/ChatDrawer/ChatInput.tsx) — 输入框与编辑器联动。
- [`../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) — 消息气泡、tool_use、fork 按钮。
- [`../src/webview/components/text-components/index.tsx`](../src/webview/components/text-components/index.tsx) — Markdown / 行内 code 文件引用渲染。
- [`../src/webview/components/AgentFlow/AgentNode/index.tsx`](../src/webview/components/AgentFlow/AgentNode/index.tsx) — 节点状态展示。

## App 结构

[`../src/webview/App.tsx`](../src/webview/App.tsx) 挂载 `<AgentFlow>` 与 `<ChatDrawer>`。状态收敛到 [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts)。

## useFlowStore

store 负责：

- flows 与 activeFlowId。
- flowRunStates 镜像。
- ChatDrawer 打开状态、当前 run/agent。
- Flow 编辑状态。
- command 本地 reducer + postMessage。
- signal 接收后 reducer。
- `flow.signal.fork` 的新 Flow 注入与视图切换。

## 当前 agent / run

用户当前要看的 agent = `runs.at(-1)?.agentId`。reducer 处理 `agentComplete` 切 `next_agent` 时立刻追加新 run 到末位。

调用点内联使用这条规则：

- AgentNode 高亮。
- ChatDrawer 自动切换。
- `activeRunId` 同会话追问判定。

禁止引入跨场景 `getActiveAgentId` 工具。

## ChatDrawer / ChatPanel

- ChatDrawer 和 ChatInput 必须始终挂载，保证 insertSelection 事件在 webview 不可见时也能被接收。
- ChatPanel 内部按 `key={`${flowId}-${agentId}-${runId ?? ''}`}` 切换 unmount。
- 跨 Flow / 跨 run 切换必须 unmount，防止 AskUserQuestionCard selections 等局部状态复用。

## 消息渲染

[`../src/webview/components/text-components/index.tsx`](../src/webview/components/text-components/index.tsx) 负责 Markdown 组件映射。行内 code 命中 `parseFileRef` 文件引用判定时渲染为可点击跳转，发送 `openFile` 时携带当前 FlowRunState 的 `cwd`；判定必须避免把普通行内代码误判为文件路径。

## 通知

webview 根据 reducer 返回的 `MessageEffect` 触发通知：

- `result`
- `awaiting-tool-permission`
- `flow-completed`
- `agent-error`

silent_task 的通知过滤由 reducer `pushEffect` 约束，详见 [extension-runtime.md](extension-runtime.md)。

## 硬约束

- `sendUserMessage` / `interruptAgent` / `answerToolPermission` 调用方必须显式传 `runId`。
- store 不做末位非终态 run 回退。
- ChatDrawer / ChatInput 不可按条件销毁重建。
- ChatPanel key 必须包含 `flowId`、`agentId`、`runId`。
