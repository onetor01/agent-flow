# FlowRunState 双端同构 state 机制

## 关键文件

- [`../src/common/flowRunState.ts`](../src/common/flowRunState.ts) — 唯一 reducer、phase 推断、消息累加、恢复归一化。
- [`../src/extension/FlowRunStateManager.ts`](../src/extension/FlowRunStateManager.ts) — extension 端运行态镜像。
- [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) — webview 端运行态镜像与命令派发。

## 单一 reducer

`updateFlowRunState` 是 Flow 运行态唯一 reducer。signal / command 两条路径上 extension 与 webview 各 reduce 一次，共用同一份 reducer 保证两端同步。

## phase 推断

`FlowPhase` / `AgentPhase` 同构：

`idle | starting | running | result | interrupted | awaiting-tool-permission | completed | stopped | error`

phase 不存字段，由 [`../src/common/flowRunState.ts`](../src/common/flowRunState.ts) 中的 helper 推断：

- `getRunPhase`：推断单个 run 的 phase。
- `getFlowPhase(state)`：按 run 追加顺序取末位 run 的 phase。
- `getAgentPhase(state, agentId)`：取该 agent 最后一个 run 的 phase。

## 消息累加模型

`run.messages` 是累加态 `ChatMessage[]`：

- `TextMessage`
- `ThinkingMessage`
- `ToolUseMessage`
- `UserMessage`
- `TurnEndMessage`
- `AgentCompleteMessage`
- `ErrorMessage`

`appendSdkMessage()` 把 SDK 流式信号转换为累加消息，不保存原始 SDK signals。SDK 消息类型参考 [`../src/common/MessageType.md`](../src/common/MessageType.md)。

## shareValues 快照

`AgentRun.shareValuesSnapshot` 存该 run 会话开始（创建）时点的完整 shareValues map。reducer 在创建 run 时写入：`flowStart` 取 `state.shareValues`，`agentComplete → next_agent` 取合并 `data.values` 后的 `draft.shareValues`。fork / restore 的 lazy executor 经 `getRunSnapshot(runId)` 取源 run 此快照重建 system prompt 与 ReadShareValue，与历史自洽，不受运行中 shareValues 变更影响。随 `FlowRunState` 全量持久化到 workspaceStore。与首条 user 消息上的 `injectedShareValues`（agent 节点为全部可读 key 的全量值，code 节点为完整 shareValues，仅 UI 展示）区分：此处为完整原始 map，供 executor 消费。

## overwrite

`AgentRun.overwrite` 存上游 code 节点返回的 `AgentOverwrite` —— 临时改写本 agent 配置，仅本次运行生效。reducer 在 `agentComplete → next_agent` 创建新 run 时从 signal 的 `data.overwrite` 写入。随 `AgentRun` 持久化，恢复 / fork 路径经 `getRunOverwrite(runId)` 取源 run 此字段，由 `applyAgentOverwrite` 应用到 lazy executor 的 agent 配置，保证行为一致。webview 用 `formatAgentOverwriteText` 格式化为可读文本展示。

## MessageEffect

`MessageEffect` 只表示需要 UI 响应的副作用原因：

- `result`
- `awaiting-tool-permission`
- `flow-completed`
- `agent-error`

`pushEffect` 是 `updateFlowRunState` 内部生成 `MessageEffect` 的 reducer 行为。对 `node_type='code'` 或 `work_mode='silent_task'`，只放行 `agent-error`、`flow-completed`、`awaiting-tool-permission` 且 `toolName` 包含 `CompleteTask` 或 `ExitPlanMode`；`result`、AskUserQuestion 自动应答、普通工具授权不产生通知 effect。细节见 [extension-runtime.md](extension-runtime.md) 与 [tool-permission.md](tool-permission.md)。

## cwd

- `cwd` 只存 `FlowRunState`，禁止写入 Flow 定义。
- FlowEditor `onValuesChange` 调 `setCwd`，webview reducer 与 `flow.command.setCwd` 双路更新。
- extension 收到 `setCwd` 后设置项目运行态持久化标记并 flush，保证 `cwd` 写入 workspaceStore.runStates。
- `setCwd` 收到空字符串时等同清空；运行时 `null` / 空串 / `undefined` 按节点类型回退。
- `ClaudeExecutor` 触发的 `agentComplete` **不携带 `cwd`**，故 Claude agent 完成不改变当前 `cwd`；只有 CodeExecutor 返回 `cwd` 才写入。
- CodeExecutor 返回 `cwd` 时按 `agentComplete` 写入规则生效，详见 [extension-runtime.md](extension-runtime.md)。

## killFlow / clearFlow / flowStart

- `killFlow`：保留 messages / shareValues / cwd，投影为 `stopped`。
- `clearFlow`：返回 `undefined`，彻底清空 runState。
- `flowStart`：追加新 run，保留已有 messages / shareValues / cwd。
- phase 进入 `completed` 时清空 shareValues 与 cwd。
- `flow.signal.agentComplete` 携带 `cwd` 且值非 `undefined` 时原样写入，省略或 `undefined` 时沿用当前值。

## interrupted

`interrupted` phase 仅末位活跃 run 可恢复。被后续 `flowStart` 替代的非末位 interrupted run 投影为 `stopped`；自动 `agentComplete → next_agent` 场景中旧 run 优先返回 `completed`。

## 运行态恢复

恢复来源是 workspaceStore 的 `runStates` 字段。加载快照后立即调用 `normalizeRestoredFlowRunState`：

- 保留 `killed` 原值。
- 清理 pending tool permissions。
- 未完成 run 置为 interrupted。
- 清理 `acc.activeBlocks`。
- 调用 `markInterrupted`。

最后一个 interrupted 且有 `sessionId` 的 agent run 交给 `runnerManager.spawnForRestore`；code 节点或无 `sessionId` 时只保留中断态。
