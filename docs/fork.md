# fork 链路

## 关键文件

- [`../src/extension/index.ts`](../src/extension/index.ts) — `handleFork`、locate、transcript 映射、signal 发送。
- [`../src/extension/FlowRunnerManager/index.ts`](../src/extension/FlowRunnerManager/index.ts) — `spawnForFork` / `spawnForRestore`。
- [`../src/extension/FlowRunnerManager/FlowRunner/index.ts`](../src/extension/FlowRunnerManager/FlowRunner/index.ts) — lazy executor。
- [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) — `flow.signal.fork` 后注入新 Flow 与切换 active。
- [`../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) — `ForkButton` / `buildForkIcon` 渲染 fork 按钮。
- [`../src/webview/components/ChatDrawer/ChatPanel/MessageList.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageList.tsx) — `tool_use` 消息传 `toolResultUuid` 作 `forkUuid`，其余消息传 `message.uuid`。
- [`../src/webview/components/ChatDrawer/index.tsx`](../src/webview/components/ChatDrawer/index.tsx) — ChatPanel key unmount。

## command / signal

- `flow.command.fork.target = { runId, messageUuid }`，target 带 `runId`，不带 `agentId`。
- `flow.signal.fork` 带 `{ newFlowId, newRunState, runId }`；webview 用 `runId` 校验 `newRunState.runs.at(-1)` 后反推当前 agent。

## extension 路径

fork 走 `handleFork`：

1. 根据 `runId` 与 `messageUuid` 定位源消息；同 uuid 多条消息取最后匹配项。
2. 锚点是 `tool_use` 时，向后扩展到所有 `parentToolUseId === toolUseId` 的子消息。
3. 调 `forkSession` 复制源 session 切片；失败则停止 fork。
4. 并发取源 session 与新 session transcript；失败只记录日志，不阻断 fork。
5. 按位置建立 `srcUuid → newUuid` 映射。
6. 替换 slicedMessages 中所有带 uuid 的 SDK 消息。
7. extension 端生成 `newRunId` / `newFlowId`，clone 源 Flow 写入 `currentFlows`。
8. `setRunState` 写入新 FlowRunState。
9. `spawnForFork` 启动 FlowRunner + lazy executor。
10. 发送 `flow.signal.fork`。

新 run 由 `structuredClone(targetRun)` 复制，继承源 run 的 `shareValuesSnapshot`（会话开始时点快照）与 `overwrite`，清除 `error`，置 `interrupted: true`，并重建 `acc.activeBlocks` / `acc.toolUseIndex` / `acc.seq`。`markInterrupted(newRun)` 会标记切片末端未定稿消息。新 FlowRunState 继承源 state 的 `answeredToolPermissions`、`shareValues` 与 `cwd`，清空 `pendingToolPermissions`。

lazy executor 首次启动经 `getRunSnapshot(runId)` 从 state 读此快照作 `currentValues`，经 `getRunOverwrite(runId)` 读取源 run 的临时改写配置，复现 fork 起点的 system prompt、ReadShareValue、work_mode 与 `outputs[].require_confirm`，与历史自洽；旧持久化 run 无快照字段时兜底 `getLatestShareValues()`。`spawnForRestore` 直接复用 `runner.spawnForFork` 的 lazy executor 路径。

## webview 路径

webview 收到 `flow.signal.fork` 后：

- clone 源 Flow 改 id，push 到 flows。
- 写入 `flowRunStates[newFlowId] = newRunState`。
- 切 `activeFlowId` 到新 Flow。
- 用 `runId` 校验末位 run 后打开对应 Agent 的 ChatDrawer。
- 清空 `editingAgent`。
- 立即通过 `save` 通道持久化新 Flow 列表。
- 用户首次继续输入走 `sendUserMessage`，不经 `flowStart`。

## fork 锚点

fork 按钮由 `buildForkIcon` 决定是否渲染：

- `buildForkIcon` 只在 `ctx.onFork`、`runId`、`forkUuid` 都存在时才可能展示 fork 按钮。
- `parentToolUseId` 非空的 subAgent 消息不展示 fork 按钮。
- `thinking / text` 且 `status = done` 时展示 fork 按钮，`forkUuid` 来自 `ChatMessage.uuid`。
- `tool_use` 且 `status = done` 时展示 fork 按钮，`forkUuid` 来自 `ToolUseMessage.toolResultUuid`（tool_result 所在 SDK 消息的 uuid）；tool result 未到达时 `toolResultUuid` 不存在，`!forkUuid` 提前 return，不显示 fork 按钮。
- `user / turn_end / agent_complete / error` 与 `status = streaming / interrupted` 的消息不展示 fork 按钮。
- `locateFork` 同时匹配 `uuid` 和 `toolResultUuid`，确保 tool_use 消息的 fork 锚点能在 tool result 到达后的 SDK 消息处切片。

## 限制

- SDK 不支持把 AskUserQuestion 作 fork 终点。
- `parentToolUseId` 非空的 subAgent 消息不展示 fork 按钮。
- code 节点没有 SDK session，不支持作 fork 起点。
- ChatPanel key 为 `${flowId}-${effectiveAgentId}-${runId ?? ''}`，依赖跨 Flow / Agent / run 切换时 unmount 隔离内部状态；fork 后 toolUseId 不重映射。
