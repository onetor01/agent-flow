# CLAUDE.md

中文回复。Agent schema 字段保持 snake_case 与 prompt 对齐。优先用 `ts-pattern` 的 `match` + `.exhaustive()` 替代嵌套三元 / `if-else` / `switch`。

**功能变动后必须同步本文件**：改动事件契约、reducer 行为、运行时层级、work_mode 行为、ShareValues 链路、易踩坑硬约束 → 改完代码后回查相关章节并更新；新增硬约束追加到「易踩坑」节。文档与代码不一致即视为 bug。

## 项目性质

VSCode 插件 `agent-flow`：用 Agent 编排工作流。Flow 是 Agent 作为节点的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，按 `outputs[i].next_agent` 决定下一跳，通过 Flow 的 `shareValues`（按 key 授权读写）共享数据。

## 三层源码结构

跨层 import 只能经 [src/common/](src/common/)。三个独立 tsconfig：

- [src/common/](src/common/) — 共享层（Zod schema / 类型 / 事件契约 / prompt 构建），webview 应 import `@/common`（不含 SDK）
- [src/extension/](src/extension/) — Node / VSCode 扩展宿主，可 import `@/common/extension`（含 SDK）
- [src/webview/](src/webview/) — React 19 + AntD + `@xyflow/react` + `zustand`(immer)

领域定义与校验在 [src/common/index.ts](src/common/index.ts)（Flow/Agent/Output、validateFlow、matchTool、buildAgentSystemPrompt）。[PersistedDataController](src/extension/PersistedDataController/index.ts) 加载失败整体回退 `defaultStore`。

## Extension ↔ Webview 事件契约（[src/common/event.ts](src/common/event.ts)）

`flow.command.*` = webview → extension，`flow.signal.*` = extension → webview。`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

标识符：`flowId` / `runId`（一次 Agent 运行的主键，所有载荷以此寻址）/ `sessionId`（Claude SDK session id，挂在 `AgentRun.sessionId`，每切 Agent 换一次；不出现在载荷上，由 `aiMessage` 内 SDK 原生 `session_id` 回填）。`runId` 来源：`flowStart` 由 webview 生成，`next_agent` / `fork` 由 extension 生成。

## 单一 reducer

[updateFlowRunState](src/common/flowRunState.ts) 是 Flow 运行态的唯一 reducer：signal 路径上 extension 发出前 / webview 收到后各 reduce 一次，command 路径同理。两端走同一份保证同步。webview store [useFlowStore](src/webview/store/flow.ts) 与 extension [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 各自镜像。

`FlowPhase` / `AgentPhase` 同构：`idle | starting | running | result | interrupted | awaiting-question | awaiting-tool-permission | completed | stopped | error`，共用 `aggregatePhase(runs)` 聚合。selector：[getAgentPhase](src/common/flowRunState.ts) / [getRunPhase](src/common/flowRunState.ts) / `getFlowPhase` / `getPendingQuestionsFor` / `getPendingToolPermissionsFor`。

`FlowRunState`：`phase` / `runs: AgentRun[]`（按切换顺序追加，每项 `runId`(主键)/`agentId`/`sessionId?`/`messages`/`completed`/`outputName?`/`phase`）/ `answeredQuestions` / `pendingQuestions[]`（Flow 级，按 runId 区分归属）/ `answered/pendingToolPermissions[]`（同）/ `shareValues`。

守卫：所有 run 终态时除 `flowStart` / `killFlow` 外消息忽略；非 `flowStart` 按 `msg.data.runId` 在 `runs` 寻址，找不到忽略。

`MessageEffect` 的 5 个 `reason`：`result` / `awaiting-question` / `awaiting-tool-permission` / `flow-completed` / `agent-error`。除 `agent-error` 外 4 个 reason 在 webview 端会自动打开 ChatDrawer / 跟随切到下一 agent；不可见 / 不在当前 Flow 时弹 VSCode 或 antd 通知。silent_task 模式只放行 `agent-error` / `flow-completed`。

## 运行时层级

extension 端：[FlowRunnerManager](src/extension/FlowRunnerManager/index.ts)（全局唯一，`Map<flowId, FlowRunner>`）→ [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts)（一个 Flow，`Map<runId, ClaudeExecutor>`，本期约束 `size <= 1`）→ [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts)（封装 SDK `query`）。**路由职责由 FlowRunner 承担**：所有 command 在 `executors: Map<runId, ClaudeExecutor>` 中按 runId 寻址；ClaudeExecutor 自身不持有 runId/agentId，仅暴露 `sessionId` getter 用于 SDK resume。per-Agent MCP server 在 [src/common/extension.ts](src/common/extension.ts)：`AgentComplete`(chat 模式不挂) / `validateFlow` / `getFlowJSONSchema`，silent_task 额外加 `terminateTask`。

webview 端：[App](src/webview/App.tsx) → `<AgentFlow>`（xyflow）+ `<ChatDrawer>`，状态收敛到 [useFlowStore](src/webview/store/flow.ts)。

**用户当前要看的 agent = `runs.at(-1)?.agentId`**：reducer 处理 `agentComplete` 切 next_agent 时立刻追加新 run 到末位。AgentNode 高亮 / ChatDrawer 自动切换 / `activeRunId` 同会话追问判定都按这条规则在调用点内联，不要重新引入跨场景 `getActiveAgentId` 工具。

## ShareValues 授权读写

Flow 级共享存储，对 Agent 暴露为按 key 授权的 `values` 契约：

- `Flow.shareValuesKeys`（`{key, desc?}[]`）声明全集。`desc` 仅设计期标注，不进 prompt / MCP schema。删 key 自动从所有 Agent 的 `allowed_read/write_values_keys` 清理。
- 读：[buildAgentSystemPrompt](src/common/index.ts) 把可读 key + 当前值（缺失为 `null`）以 JSON 注入「# 可用数据」节，**prompt 时点快照、不重读**，运行中改值需切下一 agent 生效。
- 写：仅 [AgentComplete](src/common/extension.ts) 的 `values` 参数，schema 由 `allowed_write_values_keys` 动态生成；未授权 key 静默丢弃。`chat` 模式无 AgentComplete 故无法写。
- 事件：`flow.signal.agentComplete.values`（reducer 合并到 `state.shareValues`）；`flow.command.setShareValues`（full replace，无 runId，未运行也能编辑）。无 `shareValuesChanged` signal、无 `get/setShareValues` MCP 工具。
- 运行时取值经 `getLatestShareValues(flowId)` → `FlowRunStateManager.getFlowRunStates()[flowId]?.shareValues`，`FlowRunner` 不持有副本。
- 命名：Flow 视角 = `shareValues`（`FlowRunState.shareValues` / `Flow.shareValuesKeys` / `setShareValues` / `getLatestShareValues`），Agent 视角 = `values`（`allowed_read/write_values_keys` / `AgentComplete.values` / `agentComplete.values` / `currentValues`）。

## work_mode 三态行为差异

- **task**：常规推进。系统提示词注入「任务描述 / 完成任务 / 输出分支」骨架，AskUserQuestion 允许、AgentComplete 必须；否则系统持续以「继续」让模型循环。
- **chat**：长期对话。AgentComplete 不挂载、可写 values 节不注入。`agent_prompt` 视作长期规则。
- **silent_task**：无人值守。
  - AskUserQuestion 自动以 `SILENT_ASK_AUTO_ANSWER`（`'自行处理'`）应答 + `behavior: 'allow'`，同步 `events.onAnswerQuestion` 走 `flow.signal.answerQuestion`，与人工回答展示路径一致。
  - 每轮 `result/success` 收到后（未 `pendingCompleteResult` 且未 disposed）push 一条 user 消息（content = `SILENT_CONTINUE_TEXT` = `'自行处理'`）：先 `events.onMessage` 手动 echo（SDK 不 mirror input stream user message），再 `userInputStream.push`。
  - `canUseTool` 兜底返回 `behavior: 'deny'`，提示加入 `auto_allowed_tools`，不走 `requestToolPermission`。
  - 仅对 AI 侧的 AskUserQuestion / 工具权限兜底 / result 续轮自动应答；用户侧 `sendUserMessage` / `interruptAgent` 与 task 一致，ChatDrawer 中断按钮直接走 `interruptAgent`。
  - reducer `pushEffect` 只放行 `agent-error` / `flow-completed`。
  - `terminateTask` MCP：模型确定无法完成时调用，`onTerminate(reason)` 包成 `Error` 走 `events.onError` → reducer 推到 `error`，同步 dispose + 清 pendingPermissions + interrupt SDK。
  - AgentEditor `silentWarnedRef` 首次切到 silent_task 弹 `modal.warning`。

## 易踩坑（硬约束，不要回退）

- **handleCommand 必须 `keyof` + `.exhaustive()`**：[FlowRunnerManager.handleCommand](src/extension/FlowRunnerManager/index.ts) `type` 形参类型 = `keyof ExtensionFlowCommandEvents`，分支写完整 `flow.command.*`，`.exhaustive()` 收尾（不要 `.otherwise`）。曾因短名 `'killFlow'` 错配被静默吞掉，造成 ClaudeExecutor 残留烧 token、interrupt 失效、新旧 runner 信号污染。
- **killFlow vs flowStart 语义对照**（reducer 见 [flowRunState.ts](src/common/flowRunState.ts) 的 `killFlow` / `flowStart` 分支）：
  - `killFlow`：phase→`stopped`、`runId` 清空，保留 `sessions` / `messages` / `shareValues`。
  - `flowStart`：`sessions` 重置为 `[]`（messages 清空）、`shareValues` 透传保留（未运行时编辑带入）、`currentAgentId` = 目标、phase→`starting`。
  - messages 仅在下次 `flowStart` 清空；`shareValues` 仅在 phase 转 `completed` 时由 reducer 清空。
- **next_agent 是 id 不是 name**：[useFlowStore.copyAgents](src/webview/store/flow.ts) 复制 Agent 必须重新生成 id 并通过 `idMap` 重映射 `next_agent`。
- **破坏性编辑锁**：`phase === 'starting' | 'running'` 禁止删节点 / 删边 / 改连接（[flowIsDestructiveReadOnly](src/common/flowState.ts)）。
- **ExtensionMessage 按 sessionId 分桶**：没有 `sessionId` 的 signal（如 `flow.signal.error`）不入桶（[ExtensionMessage.ts](src/webview/utils/ExtensionMessage.ts)）。
- **状态分层**：Flow 定义 → `.agent-flows.json`（`os.homedir()`）；`FlowRunState` 仅内存，extension 端 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像；UI 状态仅 webview。
- **ChatPanel 开始运行**：`phase === 'idle'` 直接启动；非 idle 非 awaiting 要 modal 确认（清空运行数据）。见 [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx)。
- **webview 粘贴双路径**：`<AgentFlow>` 内 = 粘贴 Agent（保留内部连接、ID 重映射）；画布空白 / App 层 = 作为 Flow JSON 导入。
- **CodeRef.line**：`line?: [number, number]`，整文件为 `undefined`。Tag 仅 line 存在时显示行号；点击 `openFile`，`undefined` 时只打开不选中。`Ctrl+Shift+L`（Mac `Cmd+Shift+L`）选中文字注入带行片段，无选中注入整文件（`line` 省略）。
- **assistant 跨 ID 重复**：某些模型（glm-5.1）发 `stop_reason: null` 完整重述消息且 `message.id` ≠ streaming ID。[buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts) 已处理：移除 trailing streaming items + 按 `stop_reason` 标记 streaming 状态。修改时务必保留。
- **shareValues 是 prompt 快照**：[FlowRunner.doOnAgentComplete](src/extension/FlowRunnerManager/FlowRunner/index.ts) 切下一 agent 时 reducer 还没收到 signal，必须手动 `{ ...getLatestShareValues(), ...result.values }` 给 nextAgent systemPrompt，否则看到旧快照。
- **ClaudeExecutor 路由由 FlowRunner 承担**：FlowRunner 用 `executors: Map<runId, ClaudeExecutor>.get(runId)` 寻址，不维护 `currentRunId/SessionId/AgentId`；Executor 不暴露 runId 也无 `matches()`。`onComplete` 等回调闭包内通过 `this.executors.get(runId) !== getExecutor()` 判定是否过期，避免切换时旧 executor 的回调污染新 run。
- **ClaudeExecutor 启动模式 `eager` / `lazy`**：`eager` 构造时立即 `createQuery` + push initMessage；`lazy` 用于 fork，构造时不 createQuery 不 push，等用户首次 `sendUserMessage` 触发。SDK 不支持 askUserQuestion 作 fork 终点，故 fork target 仅 `kind: 'message'`。修改启动 / interrupt / answerQuestion 路径时区分两种 mode。
- **AgentComplete 后 SDK result 不走 onMessage**：AgentComplete 已暂存（`pendingCompleteResult`）时跳过该 result 的 onMessage，通过 `onComplete` 一并上抛；FlowRunner 写入 `flow.signal.agentComplete.result` 字段；reducer 把 result 包成独立 aiMessage 写当前 `session.messages`（放在 agentComplete signal 之前），避免 phase 误切到 `result` 触发"生成完毕"通知。
- **fork 切片 uuid 用 SDK transcript 实际值**：handleFork 末尾 `getSessionMessages` 拿新 session 真实 transcript，把切片末端 user/assistant uuid 替换为 SDK remap 后新值；否则二次 fork、turn_end fork 因源 uuid 不在新 transcript 报 forkSession failed。
- **findPrevUuid 必须排除 stream_event uuid**：`includePartialMessages=true` 时 `SDKPartialAssistantMessage`（type='stream_event'）也带 uuid 但不在 transcript。`findPrevUuid` 仅允许 `SDKUserMessage` / `SDKUserMessageReplay` / `SDKAssistantMessage`，否则 forkSession 报 `Message <uuid> not found`。`turn_end.messageUuid` 同理：取本回合最后带 uuid 的 SDK 消息（result.uuid 不在 transcript）。user item 的 messageUuid 取「上一条 SDK 消息」uuid（user 自己 uuid 常缺、user fork 语义 = 截到上一条含）。
- **fork 走 handleFork 路径**：[handleFork](src/extension/index.ts) `setRunState(newRunState)` + `spawnForFork` 起 FlowRunner + lazy executor → 发 `flow.signal.fork`；webview push 新 Flow / 写入 newRunState / 切 active / 打开 ChatDrawer。用户首次发消息 [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx) 命中 `activeRunId && phase=result/interrupted` 走 `sendUserMessage`，不经 `flowStart`。
- **fork target 带 runId 不带 agentId**：`flow.command.fork.target = { kind: 'message', runId, messageUuid }`。webview RenderItem 一定知道自己属于哪个 run（MessageList 按 run 维度遍历），extension `locateFork` 单 loop `state.runs.find(r => r.runId === target.runId)`。`flow.signal.fork` 也只带 runId，webview 从 `newRunState.runs.at(-1).agentId` 反推。
- **store 命令派发必须传 runId**：`sendUserMessage` / `interruptAgent` / `answerQuestion` / `answerToolPermission` 均要求调用方明确传 `runId`，store 不做"末位非终态 run 回退"（多 run 后会乱派发）。`sendUserMessage` / `interruptAgent` 由 ChatDrawer 用 `activeRunId` 派发；`answerQuestion` 用 `pendingQuestion.runId`；`answerToolPermission` 在 `pendingToolPermissions` 按 `toolUseId` 反查。没 runId 直接放弃，不要猜。
- **ChatPanel 跨 Flow / 跨 run 切换必须 unmount**：[ChatDrawer](src/webview/components/ChatDrawer/index.tsx) 给 ChatPanel 加 `key={`${flowId}-${agentId}-${runId ?? ''}`}`，避免 AskUserQuestionCard selections / motion.div ask-card key 在新旧 Flow / 新旧 run 间被复用（fork 出的新 Flow 与源 Flow toolUseId 实际相同，SDK forkSession 不 remap）。
- **zustand selector 禁止返回新数组 / 新对象**：`s.x.filter(...)` / `... ?? []` / `... ?? {}` 每次新引用 → `useSyncExternalStore` 用 `Object.is` 判定快照变化 → 死循环 `Maximum update depth exceeded`。取原始引用稳定字段（`s.flowRunStates[fid]?.pendingQuestions`），过滤在 `useMemo` 里；空结果用模块级常量（如 `EMPTY_PENDING_QUESTIONS`）；多个派生值拆多 selector，不要在 selector 内造对象。
- **AgentComplete.content 作为 next agent 首条消息回显**：reducer 处理 `agentComplete` 创建新 `AgentRun` 时 `messages` 预置一条 user `aiMessage`（content = `nextAgent.no_input ? '开始' : data.content`），与 `FlowRunner.doOnAgentComplete` 喂给 SDK 的 `nextInitMessage` 同源。改链路时两端同改。
- **`flow.signal.answerQuestion` 与 `flow.command.answerQuestion` 同语义**：silent_task 自动应答走 signal，人工回答走 command，reducer 两条分支处理一致。不要合并 —— 入口区分对未来场景过滤有用。
