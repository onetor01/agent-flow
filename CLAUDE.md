# CLAUDE.md

本文件指导在此仓库工作的 AI 助手。用户与代码注释主要使用中文，回复也请用中文。

## 项目性质

VSCode 插件 `agent-flow`：**用 Agent 编排工作流**。工作流（Flow）是 Agent 作为节点的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，拥有自己的上下文；Agent 之间通过 Flow 的 `shareValues` 共享数据（按 key 授权的只读注入 + `AgentComplete.values` 写入），通过 `outputs[i].next_agent` 决定下一跳。

## 代码风格

Agent schema 字段用 snake_case 与 prompt 对齐，**不要**改成 camelCase。

**优先用 `ts-pattern` 的 `match` / `P` 代替嵌套三元、冗长 `if/else` / `switch`**：对判别联合、枚举字面量、多值共享分支（`P.union(...)`），用 `.with(...)` + `.exhaustive()`，让新增分支时编译器强制补全。

## 三层源码结构

项目用三个独立的 tsconfig 分别编译 —— 跨层导入只能通过 [src/common/](src/common/)。

| 目录                             | 运行环境                 | tsconfig                                           | 说明                                                                     |
| -------------------------------- | ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------ |
| [src/common/](src/common/)       | 共享                     | [tsconfig.common.json](tsconfig.common.json)       | Zod schemas、类型、事件契约、prompt 构建。**唯一可被双方 import 的层**。 |
| [src/extension/](src/extension/) | Node（VSCode 扩展宿主）  | [tsconfig.extension.json](tsconfig.extension.json) | `FlowRunnerManager`、`ClaudeExecutor`、`PersistedDataController`。       |
| [src/webview/](src/webview/)     | 浏览器（VSCode Webview） | [tsconfig.webview.json](tsconfig.webview.json)     | React 19 + Ant Design + `@xyflow/react` + `zustand` + `immer`。          |

只有 extension 可以 import `@/common/extension`（MCP server 构建，依赖 SDK）。webview 应 import `@/common`（不含 SDK 依赖）。

## 核心领域模型

`Flow` / `Agent` / `Output` 的字段定义与 [validateFlow](src/common/index.ts) 校验语义见 [src/common/index.ts](src/common/index.ts)。[PersistedDataController](src/extension/PersistedDataController/index.ts) 加载时若解析/校验失败，会整体回退到 `defaultStore`（不保留部分）。

## Extension ↔ Webview 事件契约（[src/common/event.ts](src/common/event.ts)）

消息类型由 `TypeWithPrefix<Payload, 'flow.signal.' | 'flow.command.'>` 生成；`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

- **方向**：`flow.command.*` 是 webview → extension，`flow.signal.*` 是 extension → webview
- **标识符**：`flowId`(哪个 Flow) / `runId`(一次 Agent 运行的唯一主键,所有 signal/command 载荷以此寻址) / `sessionId`(Claude SDK session id,作为运行时属性挂在 `AgentRun.sessionId` 上,**每切一次 Agent 就换一次**;不出现在 signal/command 载荷上,SDK 原生消息体内的 `session_id` 仍随 `aiMessage` 透传,reducer 据此回填到对应 AgentRun)
- `runId` 来源:`flowStart` 路径由 webview 生成随 command 下发;`next_agent` / `fork` 路径由 extension 生成

**启动握手**：

1. webview 生成 `runId`,发 `flow.command.flowStart{flowId, runId, agentId, initMessage}`,reducer 据此覆盖式重置 `runs` 并以该 runId 创建首个 `AgentRun`
2. extension 收到后 dispose 旧 runner → 新建 `FlowRunner` → 起 `ClaudeExecutor`,首条 SDK 消息携带 `session_id`,reducer 把它回填到 `runs[runId].sessionId`
3. extension 发 `flow.signal.flowStart{flowId, runId, agentId}`,reducer 把对应 run.phase 推到 `running`

**Agent 切换**（[FlowRunner.doOnAgentComplete](src/extension/FlowRunnerManager/FlowRunner/index.ts)）：本期 runtime 单 executor 约束 —— 切换时 `killExecutor(oldRunId)`(`Map.delete`) → extension 生成 `newRunId` → `runAgent(newRunId, ...)`(`Map.set`) → 发 `flow.signal.agentComplete{runId: oldRunId, output: { name, newRunId }}`,reducer 据此把当前 run 标记 completed 并追加新 `AgentRun{runId: newRunId}`。

## 运行时层级

**extension 端**：

- [FlowRunnerManager](src/extension/FlowRunnerManager/index.ts) —— 全局唯一,持有 `runners: Map<flowId, FlowRunner>`,每个 Flow 一个 FlowRunner
- [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts) —— 一个 Flow 的运行时容器,持有 `executors: Map<runId, ClaudeExecutor>`(本期 runtime 单 executor 约束 `executors.size <= 1`,Map 容器为后期并发触发能力预留),按 `outputs[i].next_agent` 编排 Agent 切换,所有 command 按 runId 在 Map 中寻址
- [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) —— 纯 AI 调度工具,封装 `@anthropic-ai/claude-agent-sdk` 的 `query`,负责单个 Agent 的 prompt 流、消息收发、interrupt/resume、canUseTool 判定;不持有 run 路由信息(`runId` 由 FlowRunner 在 Map 寻址时使用,Executor 自身不知道也不需要知道绑定的 runId)
- [AgentControllerMcp](src/common/extension.ts) —— per-Agent 的 MCP server，作为 SDK `mcpServers` 配置注入；提供 `AgentComplete`（含可选 `values` 参数，由 reducer 合并到 Flow.shareValues）/ `validateFlow` / `getFlowJSONSchema` 工具

**webview 端**：组件树由 [App](src/webview/App.tsx) 起，`<AgentFlow>`（xyflow 画布）+ `<ChatDrawer>`（右侧对话抽屉）为两块主区域。所有状态收敛到单一 zustand store [useFlowStore](src/webview/store/flow.ts)（用 `immer` 写 reducer），同时持有持久化的 Flow 定义和运行时 `RunState`；从 extension 来的 signal 也由 store 收敛处理（含上述通知/自动打开 ChatPanel 的副作用）。

Flow 的 `shareValues` 是 reducer（webview store / extension `FlowRunStateManager`）维护的运行时数据，**不以引用贯穿**所有 Agent。Agent 只感知自己的 `values`：
- **读（Agent 视角 `values`）**：构造 `ClaudeExecutor` 时，从 reducer 取 Flow 最新 shareValues，按 `allowed_read_values_keys` 过滤后注入到系统提示词「# 可用数据」节，**写死在 prompt 里**，Agent 在本次会话内看到的就是这个快照（中途换值也不会重读）
- **写（Agent 视角 `values` → Flow `shareValues`）**：Agent 调用 `AgentComplete` 时通过 `values` 参数一次性提交，未列在 `allowed_write_values_keys` 的 key 会被静默丢弃；写入随 `flow.signal.agentComplete.values` 一并广播，由 reducer 合并到 `state.shareValues`
- **手动叠加**：`FlowRunner.doOnAgentComplete` 切到下一个 agent 时，reducer 此刻还没收到 signal，因此手动 `{ ...getLatestShareValues(), ...result.values }` 给 nextAgent 的 systemPrompt（这是临时计算，FlowRunner 自身不持有 shareValues 字段）

## 状态机（[src/common/flowState.ts](src/common/flowState.ts)）

[updateFlowRunState](src/common/flowState.ts) 是统管 Flow 运行态的**单一 reducer**：signal 路径上 extension 发出前 / webview 收到后各 reduce 一次，command 路径上 webview 发出前 / extension 收到后各 reduce 一次，两端走同一份 reducer 保证状态推进同步。

- **`FlowPhase` / `AgentPhase`**：`idle | starting | running | result | interrupted | awaiting-question | awaiting-tool-permission | completed | stopped | error`。`AgentPhase` 与 `FlowPhase` 同构,Flow / Agent phase 共用同一个 `aggregatePhase(runs)`:Flow 跨全部 run、Agent 跨该 agent 的全部 run 聚合,优先级 `error` > `awaiting-tool-permission` > `awaiting-question` > `result` > `running` > `starting` > `interrupted` > `stopped` > `completed`(任一 run 出错即整体 `error`,跨越终态边界)
- **`FlowRunState`** 字段:`phase` / `runs: AgentRun[]`(按 Agent 切换顺序追加,每项含 `runId`(主键) / `agentId` / `sessionId?` / `messages` / `completed` / `outputName?` / `phase`) / `answeredQuestions` / `pendingQuestions[]`(本期 Flow 级,按 `runId` 区分归属) / `answeredToolPermissions` / `pendingToolPermissions[]`(本期 Flow 级,按 `runId` 区分归属) / `shareValues`(跨 Agent 共享数据)
- **守卫**：所有 run 都终态(`stopped` / `completed` / `error`)时,除 `flowStart` / `killFlow` 外的消息直接忽略;非 `flowStart` 的消息按 `msg.data.runId` 在 `runs` 中寻址,找不到则忽略
- **特殊入口**：`flow.command.flowStart` 覆盖式初始化（state 可为 `undefined`）；`flow.command.killFlow` 任意状态下幂等强制置 `stopped`
- **`MessageEffect`** 的 5 个 `reason`：`result` / `awaiting-question` / `awaiting-tool-permission` / `flow-completed` / `agent-error`,由 reducer 与新 state 一并产出,调用方负责消费(见下节);`MessageEffect.agentId` 直接来自当前消息所属 `run.agentId`,消费方按场景自行投影
- **UI helper**：[agentChatInputState](src/common/flowState.ts) 把 `AgentPhase` 投影为 ChatInput 的四态（`ready` / `disabled` / `loading` / `confirm-required`）；[flowIsDestructiveReadOnly](src/common/flowState.ts)（`starting` / `running` 锁定破坏性编辑）；[flowCanBeKilled](src/common/flowState.ts)（哪些 phase 允许中断）
- **selector**：[getAgentPhase](src/common/flowRunState.ts) 把该 agent 的全部 run 走 `aggregatePhase` 得到 phase；[getRunPhase](src/common/flowRunState.ts) 按单个 run 自身数据推断。**用户当前要看的 agent = `runs.at(-1)?.agentId`**：reducer 在 `agentComplete` 处理 next_agent 切换时立刻追加新 run 到末位,所以 "completed 且已流转走的中间 agent" 自然不在末位、无需单独排除;"completed 且 flow 末端(无 next_agent)" 仍在末位,用户要看最终结果。AgentNode 高亮(`isAgentActive`)、ChatDrawer 监听 `activeFlowId` 变化时按本规则自动 `openChatDrawer` / `closeChatDrawer`(`targetAgentId`)都直接用这条规则在调用点本地内联;ChatDrawer 同会话追问判定(`activeRunId`)进一步要求 `getRunPhase` 非终态/非 idle,并把命中的 runId 暴露给 `sendUserMessage` / `interruptAgent` 直接派发。**不要为这类语义重新引入跨场景 `getActiveAgentId` 类工具** —— 每个 agent 可能同时有多个 run,"唯一活跃 agent" 不是稳定概念,语义按场景内联。配套的 `getFlowPhase` / `getPendingQuestionsFor` / `getPendingToolPermissionsFor` / `getAnsweredToolPermissions` 也定义在同一文件,签名 `(state: FlowRunState | undefined, ...)`。

## 与用户的特殊交互

[updateFlowRunState](src/common/flowState.ts) 推进状态时一并产出的 `MessageEffect[]` 会触发**用户交互层面的副作用**：

- **通知**：上述 5 个 `reason` 都会触发通知。extension 端在 webPanel 不可见时弹 VSCode 通知；webview 端在页面隐藏 / 不在当前 Flow / ChatPanel 已开但 `agentId` 与 effect 不一致时弹 antd notification（[fireNotifications](src/webview/store/flow.ts)）。
- **自动打开 ChatPanel**：除 `agent-error` 外的 4 个 `reason`，若收消息时 `activeFlowId` 与之相同且 ChatDrawer 未开则自动打开；`agentComplete` 时 ChatDrawer 若停在已完成的 agent 上则自动跟随切到下一个 agent。

## 易踩坑

- **FlowRunnerManager.handleCommand 必须用 `keyof` + `.exhaustive()`**：[FlowRunnerManager.handleCommand](src/extension/FlowRunnerManager/index.ts) 的 `type` 形参类型必须是 `keyof ExtensionFlowCommandEvents`，分支字符串写完整 `flow.command.*` 形式，末尾以 `.exhaustive()` 结尾（不要用 `.otherwise`）。否则任何字符串错配（例如曾经写成短名 `'killFlow'`）会落到兜底分支被静默吞掉，而 reducer 已把 phase 推到 `stopped`，造成 ClaudeExecutor 残留烧 token、interrupt 静默失效、新旧 runner 信号污染等连锁症状。
- **killFlow 与 flowStart 语义对照**：两者是独立动作，不可串联。
  - `flow.command.killFlow`：phase→`stopped`、`runId` 清空，但保留 `sessions` / `messages` / `shareValues`；不会清空 messages，留作历史回看。
  - `flow.command.flowStart`：`sessions` 覆盖式重置为 `[]`（messages 因此清空）、`shareValues` 透传保留（用于未运行时编辑后带入新 run）、`currentAgentId` 设为目标 agent、phase→`starting`。
  - 即：messages 仅在下次 `flowStart` 时清空；`shareValues` 在 `flowStart` 不动，仅在 phase 转 `completed` 时由 reducer 清空。reducer 实现见 [flowRunState.ts](src/common/flowRunState.ts) 的 `killFlow` / `flowStart` 分支，修改时务必保持上述语义。
- **next_agent 是 id 不是 name**：复制 Agent 节点时（[useFlowStore.copyAgents](src/webview/store/flow.ts)）必须重新生成 id 并通过 `idMap` 重映射 `next_agent` 引用
- **破坏性编辑锁**：`phase === 'starting' | 'running'` 时禁止删节点 / 删边 / 改连接（[flowIsDestructiveReadOnly](src/webview/store/flow.ts)）
- **ExtensionMessage 的 sessionId 索引**：[ExtensionMessage.ts](src/webview/utils/ExtensionMessage.ts) 按 `sessionId` 分桶保存消息；没有 `sessionId` 的 signal（如 `flow.signal.error`）不会进桶
- **状态分层**：Flow 定义持久化到 `.agent-flows.json`（`os.homedir()`）；`FlowRunState` 仅在内存，extension 端由 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像（webview 关闭重开后能继续接 AI 消息）；UI 状态（`activeFlowId`、`chatDrawer` 等）仅存在于 webview
- **ChatPanel 的"开始运行"**：`phase === 'idle'` 直接启动，非 idle 非 awaiting 要 modal 确认（会清空运行数据），见 [ChatDrawer.onSend](src/webview/components/ChatDrawer.tsx)
- **webview 粘贴双路径**：`<AgentFlow>` 内粘贴 = 粘贴 Agent（保留内部连接、ID 重映射）；画布空白 / App 层粘贴 = 作为 Flow JSON 导入
- **代码片段（CodeRef）的 `line`**：`line?: [number, number]`，整个文件时为 `undefined`。Tag 仅在 `line` 存在时展示行范围；点击 Tag 触发 `openFile`，`line` 为 `undefined` 时只打开文件不选中行。快捷键 `Ctrl+Shift+L`（Mac: `Cmd+Shift+L`）：有选中文字时注入带行范围的片段，**无选中时注入整个文件**(`line` 省略)。
- **assistant 消息跨 ID 重复**：某些模型（如 glm-5.1）会发 `stop_reason: null` 的完整重述消息，其 `message.id` 与 streaming 事件的 ID 不同。[buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts) 已处理：移除 trailing streaming items + 按 `stop_reason` 标记 streaming 状态。修改该文件时务必保留此逻辑。
- **shareValues 是 prompt 快照不是实时变量**：值在构造 `ClaudeExecutor` 时注入到系统提示词后**不重读**。Agent 切换时 reducer 还没收到 `agentComplete` signal，[FlowRunner.doOnAgentComplete](src/extension/FlowRunnerManager/FlowRunner/index.ts) 必须手动 `{ ...getLatestShareValues(), ...result.values }` 给下一个 Agent 的 systemPrompt，否则 nextAgent 看到的是合并前的旧快照。
- **ClaudeExecutor 自带 (runId, sessionId) 校验**：[ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) 暴露 `runId` / `sessionId` getter 与 `matches(runId, sessionId)` 方法。`FlowRunner` 不维护 `currentRunId/currentSessionId/currentAgentId` 字段，`checkSession` 直接转发到 `currentExecutor?.matches(...)`，避免过渡期切换时 webview 的旧 sessionId 把 interrupt/userMessage 误派发到新 executor。
- **ClaudeExecutor 启动模式**：`mode: 'eager' | 'lazy' | 'resume-pending'`。`eager` 是常规启动；`lazy` 用于普通 fork（user/text/thinking/turn_end），构造时不 `createQuery` 不 push initMessage，等用户发消息或答题时再启动，lazy 期内的 `answerQuestion` 暂存到 `pendingAnswers`，SDK resume 后由 `canUseTool` 取出直接 resolve；`resume-pending` 用于 askUserQuestion fork，构造时立即 `createQuery` 并 push 一条 `isSynthetic: true` 的 dummy SDKUserMessage 启动 SDK iteration，让 SDK 走到 transcript 末端的悬空 AskUserQuestion tool_use 触发 canUseTool。修改 [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) 的启动 / interrupt / answerQuestion 路径时务必区分这三种 mode。
- **AgentComplete 后的 SDK result 不走 onMessage 透传**：AgentComplete 调用后 SDK 仍会发一条用于计费的 result 消息。`ClaudeExecutor` 在 AgentComplete 已暂存（`pendingCompleteResult`）时跳过该 result 的 onMessage 透传，通过 `onComplete` 一并上抛；[FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts) 把 result 写入 `flow.signal.agentComplete` 的 `result` 字段；reducer 处理 agentComplete 时把 result 包装成独立 aiMessage 写入当前 `session.messages`（放在 agentComplete signal 之前），避免 phase 误切到 `result` 触发"生成完毕"通知。修改这条链路时不要把 result 重新走回 onMessage。
- **fork 切片 uuid 必须用 SDK transcript 实际值**：handleFork 末尾用 `getSessionMessages` 拿新 session 的真实 transcript，把 webview 切片末端 session 的 user/assistant message uuid 替换为 SDK remap 后的新值；否则在 fork 出的 Flow 中再次 fork、turn_end fork 都会因源 uuid 不在新 session transcript 里而 forkSession failed。`tool_use.id` 不参与 remap：SDK forkSession 仅重映射 message uuid，askUserQuestion fork 时切片末端 tool_use block 的 id 与 pendingQuestions 项保留源 toolUseId，与 SDK transcript 中 `tool_use.id` 对齐，用户答题时 ClaudeExecutor 的 pendingAnswers / canUseTool 用同一 id 命中。
- **findPrevUuid 必须排除 stream_event uuid**：`includePartialMessages=true` 时 SDK 流出的 `SDKPartialAssistantMessage`（type='stream_event'）也带 uuid，但这是流式事件内部标识，不在 transcript 里。[buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts) 的 `findPrevUuid` 必须只允许 `SDKUserMessage` / `SDKUserMessageReplay` / `SDKAssistantMessage` 进入，否则误命中会让 forkSession 报 `Message <uuid> not found`。`turn_end.messageUuid` 同理：取本回合最后一条带 uuid 的 SDK 消息（result.uuid 不在 transcript 里）。user item 的 messageUuid 取「上一条 SDK 消息」的 uuid（user 自己的 uuid 经常缺失，且 user fork 语义 = 让用户重新说一次 = 截到上一条消息含）。
- **fork 出的新 Flow 走 handleFork 路径**：fork 在 [handleFork](src/extension/index.ts) 阶段 `flowRunStateManager.setRunState(newRunState)`（含 runId / 切片 sessions / pendingQuestions / shareValues）并 `spawnForFork` 起好 `FlowRunner` + lazy/resume-pending 模式的 `ClaudeExecutor`，再发 `flow.signal.fork` 给 webview。webview 收到 signal 后直接 push 新 Flow / 整体写入 newRunState（runId 已就绪）/ 切 active / 打开 ChatDrawer。用户首次发消息时 [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx) 命中 `activeRunId && phase=result/interrupted` 分支走 `sendUserMessage`（同会话追问），不经过 `flow.command.flowStart`。
- **fork target 必须带 runId,不再带 agentId**：`flow.command.fork.target` 是 `{kind, runId, messageUuid|toolUseId}`。**Why**：webview 端 RenderItem 一定知道自己属于哪个 run（MessageList 按 run 维度遍历,toBubbleItems 调用时已传 run.runId）,所以 target 直接挂 runId 是水到渠成的;extension 端 [locateFork](src/extension/index.ts) 据此 `state.runs.find(r => r.runId === target.runId)` 单 loop 寻址,不再扫所有 runs 的所有 messages。`flow.signal.fork` 也只带 runId,webview 端从 `newRunState.runs.at(-1).agentId` 反推 agent。**How to apply**：MessageBubble 的 `buildForkIcon` 闭包里通过 `renderItemToBubble` 的 runId 参数(toBubbleItems 转手把 sessionId 当 runId 传)拼 target;ChatPanel 顶部 askUserQuestion fork 按钮取 `pendingQuestions[0].runId`。
- **store 命令派发必须传 runId**：`sendUserMessage` / `interruptAgent` / `answerQuestion` / `answerToolPermission` 均要求调用方明确传入 `runId`，store 不再做"末位非终态 run 回退"。**Why**：多 run 后回退会乱派发到不属于当前 UI 视图的 run。**How to apply**：
  - `sendUserMessage` / `interruptAgent` 由 ChatDrawer 用 `activeRunId`(末位非活跃 run 且 agentId 命中 chatDrawer.agentId)派发
  - `answerQuestion` 用 `pendingQuestion.runId`,`answerToolPermission` 在 `pendingToolPermissions` 中按 `toolUseId` 反查 runId
  - 没有 runId 时直接放弃派发,不要回退到任何"猜测"。
- **ChatPanel 跨 Flow 切换必须 unmount**：[ChatDrawer](src/webview/components/ChatDrawer.tsx) 给 ChatPanel 加 `key={flowId-agentId}` 强制跨 Flow 切换重新挂载，避免 AskUserQuestionCard 内部 selections / motion.div 的 ask-card key 在新旧 Flow 间被 React 复用。

## ShareValues 授权读写

shareValues 是 Flow 级共享存储，对 Agent 暴露为按 key 授权的 `values` 契约——不是「Agent 自由读写的全局变量」：

- **Flow 级声明**：`Flow.shareValuesKeys: ShareValueKey[]`（每项含 `key` 与可选 `desc`）列出本 Flow 全部可用 key（FlowEditor UI 维护）。`desc` 仅作设计期标注语义，不进入 prompt / MCP schema。删除 key 时自动从所有 Agent 的 `allowed_read/write_values_keys` 中清理引用
- **Agent 级授权**：`allowed_read_values_keys` 和 `allowed_write_values_keys` 分别声明本 Agent 可读 / 可写的 key 子集。无授权时 Agent **完全感知不到** Flow shareValues 的存在
- **读路径**：[buildAgentSystemPrompt](src/common/index.ts) 把可读 key 与当前值（缺失为 `null`）以 JSON 形式注入到「# 可用数据」节。**这是 prompt 时点的快照**，Agent 在本会话内不会重新读，运行中改值需要切到下一个 Agent 才生效
- **写路径**：仅通过 [AgentComplete](src/common/extension.ts) 工具的 `values` 参数提交，schema 由 `allowed_write_values_keys` 动态生成；MCP 端按白名单过滤，未授权 key 静默丢弃。`never_complete` 模式无 AgentComplete，因此也无法写入
- **事件契约**：`flow.signal.agentComplete` 携带 `values` 字段（reducer 合并到 `state.shareValues`）；`flow.command.setShareValues`（webview→extension，full replace，**无 runId 字段**，未运行时也能编辑）。无 `flow.signal.shareValuesChanged` 与 `getShareValues` / `setShareValues` / `getAllShareValues` MCP 工具
- **运行时取值**：[FlowRunnerManager](src/extension/FlowRunnerManager/index.ts) 构造时接收 `getLatestShareValues(flowId)` 回调，最终指向 `FlowRunStateManager.getFlowRunStates()[flowId]?.shareValues`。`FlowRunner` 不持有 shareValues 副本
- **UI**：[FlowEditor](src/webview/components/FlowEditor/index.tsx) 抽屉编辑 Flow 名称、`flow_desc`、`shareValuesKeys`（拖拽列表，每项支持 `key` / `desc` 编辑、重复校验、清空按钮）以及运行中各 key 当前值；[AgentEditor](src/webview/components/AgentEditor/index.tsx) 用 multi-select 维护两个授权列表，选项标签为 `key(desc)`，提交时只用 key
- **Flow 完成清空**：reducer 在 phase 转 `completed` 时把 `state.shareValues = {}`，避免污染下一次启动；`flowStart` 保留 `state?.shareValues ?? {}` 以便 webview 在未运行时编辑的值能带入新 run
- **命名约定**：Flow 视角的全局存储称作 `shareValues`（`FlowRunState.shareValues` / `Flow.shareValuesKeys` / `flow.command.setShareValues` / `getLatestShareValues`）；Agent 视角统一称作 `values`（`Agent.allowed_read/write_values_keys` / `AgentComplete.values` 参数 / `flow.signal.agentComplete.values` / `ClaudeExecutor` 的 `currentValues`）。两端在 reducer 合并处衔接

## Token 追踪

- **flowRunState.ts**：`TokenUsage` 类型及 `extractTokenUsage`/`addTokenUsage` 工具函数
- **buildRenderItems.ts**：从 assistant 消息提取 usage 生成 message_usage 项；从 result 消息计算回合增量 usage 附加到 turn_end；以 sessionId 为 key 的 Map 缓存机制（`sessionContextWindow` sticky 缓存模型上下文窗口大小，`lastObservedUsed` 跟踪最近一条 assistant.message.usage 的 input + cache_read + cache_creation 总量），turn_end / agent_complete 时直接用此对计算上下文占用展示
- **MessageBubble.tsx**：`TokenUsageBadge` 组件展示 input/output/cache+/cache→ 标签；turn_end / agent_complete 内嵌 `ContextUsageBar`（按占用率红 / 黄 / 灰渐变上色）；普通气泡（user / text / thinking / tool_use / ask_user_question）不再追加独立 ctx 行
- **ChatPanel**：从 sessions 计算 Flow 级累计 usage，header 中以 Tag 展示总量；优先使用 SDK 实际 `total_cost_usd`

## 重点代码速查

- 状态 reducer：**[updateFlowRunState](src/common/flowRunState.ts)**、**[useFlowStore](src/webview/store/flow.ts)**、**[FlowRunStateManager](src/extension/FlowRunStateManager.ts)**
- 消息渲染：**[buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts)**、**[ExtensionMessage.ts](src/webview/utils/ExtensionMessage.ts)**、**[MessageBubble.tsx](src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx)**、**[buildRenderItems 文档](docs/assistant-message-cross-id-dedup.md)**
- 领域模型与校验：**[src/common/index.ts](src/common/index.ts)**（Flow/Agent/Output 定义、validateFlow、matchTool、buildAgentSystemPrompt）
- Flow 布局：**[flowUtils.ts](src/webview/components/AgentFlow/flowUtils.ts)**（DAG → ReactFlow 层次布局）
- Token 追踪：**[src/common/flowRunState.ts](src/common/flowRunState.ts)**（TokenUsage 类型、费用计算）、**[buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts)**（增量 usage 累计）
