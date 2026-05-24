# Change Log

## [0.0.23] - 2026-05-24

### 优化

- **AskUserQuestionCard 自动导航逻辑**：原导航优先滚到 `currentIdx + 1`，会跳过用户尚未交互过的多选题（多选空数组在校验里被视为已答，自动导航就把它当"答完"略过）。改为始终查找首个未显式回答的题（含当前题之前的题）：单选未选 / 多选空数组 / 选了 Other 但未填字均视为未答，逐题滚动定位；只有全部题都显式回答才执行提交。新增 `isQuestionExplicitlyAnswered` 辅助函数与 `isQuestionAnswered`（控制发送按钮可点状态）解耦——多选空数组允许"主动放弃"提交但不允许"自动跳过"。

## [0.0.22] - 2026-05-23

### 修复

- **GLM 等不下发 assistant.usage 的模型上下文进度条无法展示**：原 `buildRenderItems` 在计算 turn_end / agent_complete 卡片的 `lastObservedUsed` 时坚持只读 assistant.message.usage（result.usage 是回合累加值，工具往返多时会大幅膨胀）。但 GLM 系列模型不下发 assistant.usage，导致这类模型整条对话上下文条都拿不到值。新增 `turnAssistantUsageSeen` 标记：本回合见过 assistant.usage 时 turn_end 仍优先用更精确的 assistant 数据，没见过时再用 result.usage 的 input_total 兜底；turn_end 后重置为 false 逐回合判定。
- **`validateFlow` 不再把 silent_task 无 output 当作错误**：原校验项 `silentAgentMissingOutputs` 强制 silent_task 至少配置一个 output（基于"无 output 会无限自循环"的假设），但实际场景中 silent_task 可以靠 `terminateTask` 或 `AgentComplete` 不带 next_agent 自然终止，强校验过严。移除该校验项与 `FlowValidationResult.silentAgentMissingOutputs` 字段。

### 优化

- **Agent 系统提示词重写**：通用前缀压缩为 5 条核心规则——中文简洁输出 / 精确改动相关代码 / 禁止主动优化重构 / 禁止道歉表明身份 / **改动前必须先读所有调用方理解影响范围**；并补充各 work_mode 下"遇到冲突 / 歧义 / 无法满足的需求必须明确暴露"的硬约束：`task` 通过 AskUserQuestion 或 AgentComplete.content 上抛、`chat` 直接告知用户、`silent_task` 必须完整写入 AgentComplete.content，禁止静默忽略或绕开。
- **Extension 日志输出体积控制**：`logger.ts` 新增 `truncate` / `safeStringify` 工具，对 `flow.signal.aiMessage` 等大对象载荷做截断打印（默认 2KB），避免 SDK 流式回包让 OUTPUT 面板被海量 JSON 刷爆；`src/extension/index.ts` 内的高频 signal / command 日志统一切换到截断打印。
- **CLAUDE.md 整改**：精简冗余、删除已落后的描述，与当前 reducer / 运行时层级 / work_mode 行为对齐。

## [0.0.21] - 2026-05-23

### 破坏性变更

- **`work_mode` 三值枚举重命名**：`auto_complete` → `task`、`never_complete` → `chat`、新增 `silent_task`；`require_confirm` 模式被合并掉（"调用 AgentComplete 前必须先 AskUserQuestion 确认"的语义改由 `agent_prompt` 自行约束，不再单列模式）。`buildAgentMcpServer` 中 `AgentComplete` 工具仅在 `work_mode !== 'chat'` 时挂载（原条件 `work_mode !== 'never_complete'`）。`PersistedDataController/defaultStore.ts` 内置 PresetFlows 已迁移到新枚举值。
- **`Agent.work_mode` 默认值从 `auto_complete` 改为 `task`**：AgentEditor 在新建 / 兜底场景下使用新枚举值。

### 新增

- **`silent_task` 静默模式（无人值守循环执行）**：
  - **AskUserQuestion 自动应答**：`ClaudeExecutor.canUseTool` 在 silent_task 下不再挂起等待用户回答，直接以占位字符串 `"自行处理"` 填给每个 question 的 answer，并同步 fire `onAnswerQuestion` → `flow.signal.answerQuestion` 让 webview 看到自动答案，与人工回答的展示路径（`answeredQuestions` / 移出 `pendingQuestions`）保持一致。
  - **每轮自动续「继续」**：`createQuery` 的 for-await 循环中，silent_task 收到 `result/success` 且未 AgentComplete / 未 disposed 时，自动 push 一条 `{ type: 'user', content: '自行处理' }` 推动模型推进下一步。SDK 不会 mirror 通过 input stream push 的 user message，所以同步通过 `onMessage` 透传，让 webview 通过 `flow.signal.aiMessage` 看到自动「继续」消息。
  - **未授权工具直接 deny**：silent_task 永远没有用户在场，未授权工具不再挂起 `requestToolPermission`，直接返回 `behavior: 'deny'`，提示信息引导在 `auto_allowed_tools` 中显式加入。
  - **拒收用户消息**：`sendUserMessage` 在 silent_task 下直接 return，不接受外部 send；`ChatDrawer` 中断按钮在 silent_task 下也只弹 `message.info('静默模式无法中断')` 不再发 interrupt 命令。
  - **通知精简**：reducer 在 push effect 时检查 `agent.work_mode === 'silent_task'`，只放行 `agent-error` / `flow-completed` 两类 effect，避免无人值守模式下海量 result / awaiting-question 通知打扰用户。
  - **`terminateTask` MCP 工具**：silent_task 模式独有，模型确定无法完成「任务描述」时（缺失关键信息 / 工具不可用 / 环境异常等极端情况）调用此工具中止任务，`onTerminate` 回调把 reason 包成 Error 走 `onError` 路径让 reducer 把 run 推到 `error` 终态，同时 `interrupt()` SDK 让流尽快收尾。系统提示词「# **停止会话**」节同步注入。
  - **`validateFlow` 新校验项 `silentAgentMissingOutputs`**：silent_task 必须至少一个 output（否则 Agent 永远调不到 AgentComplete 出口，会无限自循环）。
  - **AgentEditor 首次切到 silent_task 弹一次警告 modal**：提示用户该模式下用户无法参与多轮对话、无法中断、AskUserQuestion 与普通消息会被自动应答，请谨慎选择模型 / effort / 提示词。Agent 本身已是静默模式时不再提示。
- **事件契约 `flow.signal.answerQuestion`**：载荷 `{ runId, toolUseId, output }`，与 `flow.command.answerQuestion` 同语义。reducer 处理写入 `answeredQuestions`、移出 `pendingQuestions`，仅入口换成 signal —— 让 webview 在无人值守模式下也能看到自动答案。

### 修复

- **AgentComplete 的 `content` 无法展示为下一个 Agent 的首条消息**：reducer 在 `agentComplete` 处理 `next_agent` 切换时，新创建的 `AgentRun.messages` 现在以一条 `flow.signal.aiMessage`（user 消息，content = `nextAgent.no_input ? '开始' : data.content`）作为首条消息，与 `FlowRunner.doOnAgentComplete` 喂给 SDK prompt 的 `nextInitMessage` 同源，避免 UI 与运行时输入错位。
- **selector 返回新引用导致的"Maximum update depth exceeded"死循环**：`MessageList` / `ChatPanel` 在 `pendingQuestions` / `pendingToolPermissions` / `answeredToolPermissions` / `runs` 等无内容场景下统一返回模块级常量（`EMPTY_PENDING_QUESTIONS` / `EMPTY_PENDING_TOOL_PERMS` / `EMPTY_RUNS`），并把过滤 / 转换搬到 `useMemo` 中，避免 zustand 的 `useSyncExternalStore` 因 `Object.is` 判定新引用持续触发重渲染。

### 优化

- **MessageList 虚拟化**：原 `Bubble.List` 改为 `@tanstack/react-virtual` 驱动的虚拟列表（`useVirtualizer` + `overscan` + `measureElement`），长对话场景渲染开销显著降低。`ctx` / `pendingToolPerms` / `answeredToolPermissions` 从 ChatPanel 下沉到 MessageList 内部 selector。`MessageListRef` 暴露 `scrollBoxNativeElement` / `scrollToBottom`，命令式贴底由 ChatPanel 在流式新消息时调用。
- **系统提示词通用约束重写**：所有 work_mode 共享前缀新增「简洁输出，直接给代码或结果，无需解释和推导 / 仅修改用户指定的代码或文件 / 禁止道歉、表明身份、免责声明 / 严格按需求执行，禁止主动优化代码」；并按 work_mode 分流：`task` / `chat` 仍允许 AskUserQuestion 询问用户，`silent_task` 强制「自行决策，避免使用 AskUserQuestion，不询问用户意见」。任务完成提示改为「一旦达成结束条件，**立即**调用 AgentComplete 提交结果并选择输出分支，否则系统会持续以「继续」让你循环」。
- **移除 SDK `options.maxTurns` 兜底**：原 `maxTurns: 1000` 移除（silent_task 的 `maxTurns: 10` 兜底也只保留为注释，未启用），完全由 AgentComplete / terminateTask / 用户中断决定 run 终止。

## [0.0.19] - 2026-05-22

### 破坏性变更

- **Agent 视角字段统一为 `values`，与 Flow 视角的 `shareValues` 解耦**：
  - Agent 配置 `allowed_read_share_values_keys` / `allowed_write_share_values_keys` 重命名为 `allowed_read_values_keys` / `allowed_write_values_keys`。
  - `AgentComplete` 工具参数 `shareValues` 重命名为 `values`；事件 `flow.signal.agentComplete.shareValues` 重命名为 `values`（reducer 仍合并到 `FlowRunState.shareValues`）。
  - 系统提示词中「# 可写数据」节的措辞同步切到 `values`。命名约定：Flow 全局存储称作 `shareValues`（`FlowRunState.shareValues` / `Flow.shareValuesKeys` / `flow.command.setShareValues` / `getLatestShareValues`），Agent 视角统一称作 `values`。
- **运行时改为按 `runId` 寻址会话（#18）**：原 `AgentSession[]` 调整为 `AgentRun[]`，`runId` 是一次 Agent 运行的唯一主键、所有 signal/command 载荷以此寻址；`sessionId` 仅作为运行时属性挂在 `AgentRun.sessionId` 上、每切一次 Agent 就换一次。`flow.command.flowStart` 由 webview 生成 `runId` 随命令下发；`next_agent` / `fork` 路径由 extension 生成。`ClaudeExecutor` 自带 `(runId, sessionId)` 校验，`FlowRunner` 持有 `executors: Map<runId, ClaudeExecutor>`（本期单 executor 约束 `executors.size <= 1`，Map 容器为后期并发触发能力预留）。
- **store 命令派发强制传 `runId`**：`sendUserMessage` / `interruptAgent` / `answerQuestion` / `answerToolPermission` 调用方必须明确传入 `runId`，store 不再做"末位非终态 run 回退"。`ChatDrawer` 用 `activeRunId`（末位 run 且 agentId 命中 chatDrawer.agentId）派发；`answerQuestion` 用 `pendingQuestion.runId`，`answerToolPermission` 在 `pendingToolPermissions` 中按 `toolUseId` 反查 runId。
- **`pendingToolPermission` 数组化**：单字段 `pendingToolPermission?` 变为 `pendingToolPermissions[]`，按 `runId` 区分归属，与 `pendingQuestions` 对称；`getPendingToolPermissionFor` 重命名为 `getPendingToolPermissionsFor`，`MessageBubble.pendingToolPermissionToolUseId` 调整为 `pendingToolPermissionToolUseIds: Set`。
- **fork 终点限定为消息，移除 askUserQuestion fork**：SDK 不支持把 askUserQuestion 作为 fork 终点（fork 切片末端只可能是 user / text / thinking / turn_end）。`flow.command.fork.target` 收敛为 `{ kind: 'message', runId, messageUuid }`，删除顶层 `agentId`；`flow.signal.fork` 同样删除 `agentId`，webview 从 `newRunState.runs.at(-1).agentId` 反推。`ExecutorMode` 收敛为 `eager | lazy`，删除 `resume-pending` 模式以及 `pendingAnswers` / `isSynthetic` dummy 启动等兜底路径与对应 UI。

### 修复

- **ChatPanel 顶部 tokens 重复累加且漏算 `cache` 字段**：`modelUsage` 是 session 累计快照，原本对所有 result 求和会重复累加；改为每个 session 取最后一条 result，并把 `cacheCreation` / `cacheRead` 也算上，与 turn_end / agent_complete 卡片口径对齐。
- **单轮直接 AgentComplete 的结束卡片缺失上下文 / 用量 / 成本**：reducer 把 SDK result 包装成独立 aiMessage push 进 session.messages 后，`buildRenderItems` 的 `agentCompleteSeen` 守卫会把这条 result 也吞掉，导致单轮场景 `cached.prevModelUsage` / `lastTotalCost` / `sessionContextWindow` 全部未更新。让 `message.type === 'result'` 的 aiMessage 穿透 `agentCompleteSeen` 守卫进入 result 处理分支正常更新 cached；但在 `agentCompleteSeen=true` 时跳过 push turn_end item，避免在 agent_complete 卡片之外多出一个回合结束卡片。
- **AgentRun 改造后第一条消息无法展示**：`flowStart` reducer 路径在覆盖式重置 `runs` 时未正确创建首个 `AgentRun`，导致首条 SDK 消息找不到归属 run 而被丢弃，已修复。

### 优化

- **去掉 `getActiveAgentId` 改按场景内联判断**：每个 agent 可能并行多个 run，"唯一活跃 agent" 不是稳定概念。AgentNode 高亮（`isAgentActive`）/ ChatDrawer 同会话追问（`activeRunId`）/ ChatDrawer 监听 `activeFlowId` 自动开关 ChatPanel 都改为本地按 `runs` 末位 agent 内联，AgentFlow 不再负责 ChatPanel 自动开关。

## [0.0.18] - 2026-05-19

### 优化

- **上下文窗口占用展示精简至回合结束**：原方案在每条 assistant 相关消息（user / text / thinking / tool_use / ask_user_question）后都追加一条独立 `ContextUsageBar` divider 行，信息冗余且容易让人误以为是单条 block 的开销。改为仅在 turn_end / agent_complete 卡片内部展示一份，其余气泡不再追加独立 ctx 行。`buildRenderItems` 缓存模型同步重构：以 sessionId 为 key 维护 `sessionContextWindow`（首次拿到上下文窗口后 sticky 缓存）+ `lastObservedUsed`（每条 assistant.message.usage 的 input + cache_read + cache_creation 总量），turn_end / agent_complete 时直接用此对计算 used / total，确保非空稳定展示；`agent_complete` 项不再因 result.usage 缺失而无法显示占用。
- **默认「修改代码」工作流需求确认提示词细化**：内置 PresetFlows 中「需求分析」Agent 的「需要确认需求」分支提示词补充"在业务上有什么要求"，并明确"将需要确认的内容放在题干里"，引导 AI 在 AskUserQuestion 题干里自带摘要而不是放到选项注释里。

## [0.0.17] - 2026-05-19

### 新增

- **上下文窗口占用展示**：在每条 assistant 相关消息以及 turn_end / agent_complete 卡片中追加 `ContextUsageBar`，展示「最后一次 API 调用真实喂给模型的 input + cache 总量 / 模型上下文窗口」，并按占用率以红 / 黄 / 灰渐变上色（≥80% 红、≥50% 黄、其余灰）。`buildRenderItems` 同步暴露 `getContextUsage(sessionId, itemKey)`，turn_end / agent_complete 内嵌一份，其它命中 cache 的 item（user / text / thinking / tool_use / ask_user_question）追加一条独立的 divider 行。

### 修复

- **killFlow 命令字符串错配致 runner 永不释放**：`FlowRunnerManager.handleCommand` 中 `.with('killFlow', ...)` 与实际事件名 `'flow.command.killFlow'` 不匹配，落到 `.otherwise` 静默吞掉——reducer 已 phase=stopped 但 ClaudeExecutor 仍存活继续烧 token、interrupt 静默失效，新 flowStart 抢跑前的旧 in-flight signal 还会污染 webview state。改为 `type` 形参类型限定 `keyof ExtensionFlowCommandEvents`、所有分支写完整 `flow.command.*` 形式，末尾以 `.exhaustive()` 替代 `.otherwise`，任何字符串错配或新增分支遗漏都在编译期失败。

### 优化

- **清理 fork 路线 A 下永不触发的 `resumeSessionId` 死代码**：fork 出的新 Flow 在 `handleFork` 阶段已写入 runId 并 spawn `FlowRunner`，首次发消息走 `sendUserMessage` 同会话追问，不再经 flowStart command；webview / reducer / `useStartFlow` / `FlowRunner.handleFlowStart` / `runAgent` 全链路的 `resumeSessionId` 兜底分支均不会命中。彻底删除 `flow.command.flowStart` 的 `resumeSessionId` 字段及其全链路引用，同步删除 reducer 中永不命中的 existing session 复用分支。
- **默认工作流措辞与样式**：`defaultStore` 预设 prompt 中的 url、链接关键词用星号包裹，提升 Agent 对飞书 url 字段的识别强度；继续微调内置 flow 的 prompt 措辞。
- **CLAUDE.md 写作风格整改**：移除"不再走"/"改为"/"原本"等变化叙事，改为只描述当前状态；修正 fork 切片 uuid 段（`tool_use.id` 不参与 SDK forkSession remap，askUserQuestion fork 保留源 toolUseId 与 SDK transcript 对齐）；「易踩坑」节追加 handleCommand 的 `keyof + exhaustive` 要求与 killFlow / flowStart 的语义对照（messages 何时清、shareValues 何时清）。

## [0.0.16] - 2026-05-18

### 新增

- **对话 Fork**：在 Agent 对话中可从任意一条消息（user / text / thinking / turn_end / askUserQuestion 卡片）分叉出新 Flow，原路径保留，便于对比不同提示或模型的效果。
  - **事件契约**：新增 `flow.command.fork` / `flow.signal.fork`，承载源 Flow id、目标 agent id、fork 切片（message uuid 或 askUserQuestion toolUseId）、新 Flow id 与 RunState；`flow.command.flowStart` 增加 `resumeSessionId` 字段，reducer 在 resume 模式下保留既有 sessions / answered\* / shareValues 不清空，flowStart signal 命中已有 sessionId 时复用而非追加。
  - **extension 侧**：通过 SDK `forkSession` 拿到新 sessionId，深拷贝源 Flow + 重置 id 入 `currentFlows`，复制并裁剪源 RunState 后通过 `FlowRunStateManager.setRunState` 注入；fork 完成后立即 spawn FlowRunner 拿到 runId 并写入 newRunState，`signal.fork` 携带 runId 让 webview 后续 `sendUserMessage` / `answerQuestion` / `interrupt` 不再因 runId 缺失 silent drop。
  - **ClaudeExecutor 启动模式重构**：把原 `lazy: boolean` 重构为 `mode: 'eager' | 'lazy' | 'resume-pending'`。普通 fork（user / text / thinking / turn_end）走 `lazy`：构造时不 createQuery，等用户在新 Flow 发消息或答题时再启动，并用 `pendingAnswers` 暂存 lazy 期内 `answerQuestion` 的输出；askUserQuestion fork 走 `resume-pending`：构造时立即 createQuery 并 push 一条 `isSynthetic: true` 的 dummy SDKUserMessage 启动 SDK iteration，让 SDK 自然走到 transcript 末端的悬空 AskUserQuestion tool_use 触发 canUseTool，把 resolver 挂起到 `pendingPermissions`。
  - **askUserQuestion fork toolUseId 替换**：handleFork 在 askUserQuestion fork 时重新生成 toolUseId 并替换切片末端 tool_use block 的 id 与 pendingQuestions 项，避免 SDK resume 后 canUseTool 触发的 toolUseID 与上层不匹配。
  - **webview UI**：`MessageBubble` 在 user / text / thinking / turn_end 项与 askUserQuestion 卡片右侧悬挂 fork icon（仅在 messageUuid 存在时）；`ChatPanel` 接管 onFork：sessionCompleted=true 时弹 modal 提示 shareValues 不保证后再发命令；`ChatDrawer` 给 ChatPanel 加 `key=flowId-agentId` 强制跨 Flow 切换重新挂载，避免 AskUserQuestionCard 内部状态在新旧 Flow 间被 React 复用；`ChatDrawer.onSend` 检测 runId 缺失（fork 后未启动 runner）时自动取该 agent 最近 session 的 sessionId 作为 resumeSessionId。
  - **store**：新增 `forkFlow` action（postMessage 不预提交 reducer）以及 `flow.signal.fork` 处理：深拷贝源 Flow + 改 id 入 flows、写入 newRunState、切 activeFlowId、打开 ChatDrawer 并发 save 持久化。

### 修复

- **AgentComplete 后跳过 SDK result 透传**：AgentComplete 调用后 SDK 仍会发一条用于计费的 result 消息，原本会被 `ClaudeExecutor` 当作普通 aiMessage 透传给 webview，触发 reducer 把 phase 切到 `result` 并误发 reason=`result` 的"生成完毕"通知，与紧随其后的 agentComplete signal 语义重叠。改为让 agentComplete signal 携带整条 SDK result 消息：`ClaudeExecutor` 在 AgentComplete 已暂存（`pendingCompleteResult`）时跳过该 result 的 onMessage 透传，通过 onComplete 一并上抛；`FlowRunner` 把 result 写入 agentComplete signal 的 `result` 字段；reducer 处理 agentComplete 时把 result 包装成独立 aiMessage 写入当前 `session.messages`（放在 agentComplete signal 之前），`buildRenderItems` 仍能取到 result 累计 token 并填充 `agent_complete` 项的 modelBreakdown / totalCost。
- **FlowEditor 跨 flow 切换 shareValues 残留**：`form.setFieldsValue` 对 nested 字段是合并语义，空对象不会清除旧子 key；form 实例又不随 `editingFlowId` 重建，导致打开新 flow 抽屉时仍能看到上一个 flow 的 shareValues。改为先 `resetFields` 再赋值。
- **fork 后 uuid 对齐**：extension 端 fork 后用 `getSessionMessages` 拿新 session 的真实 transcript，把 webview 切片末端 session 的 user / assistant message uuid 替换为 SDK remap 后的新值，修复在 fork 出的 Flow 中再次 fork 以及 turn_end fork 失败时 SDK 报 `Message <uuid> not found in session` 的问题。
- **findPrevUuid 排除 stream_event uuid**：`includePartialMessages=true` 时 SDK 流出的 `SDKPartialAssistantMessage`（type='stream_event'）也带 uuid 但不在 transcript 里，原 findPrevUuid 不区分类型会误命中导致 forkSession `Message <uuid> not found`。改为加白名单：只允许 `SDKUserMessage` / `SDKUserMessageReplay` / `SDKAssistantMessage` 进入。
- **user fork 锚点**：`buildRenderItems` 给 user item 的 messageUuid 取「上一条 SDK 消息」的 uuid（不是 user 自己的 uuid，因 `SDKUserMessage.uuid` 经常缺失）；user fork 语义 = 让用户重新说一次 = upToMessageId 截到上一条消息（含）。
- **fork icon 渲染重构**：去掉 `ForkWrap` 的 absolute 定位，改为 inline 元素 `ForkButton`；`Copyable` 加 extra 槽，fork icon 与 copy icon 同列垂直堆叠不再遮挡；turn_end 因 antd-x DividerBubble 用 antd Divider 包裹会让 absolute 子元素被遮挡 + group hover 失效，改为 inline 渲染在 content 内；text/thinking/turn_end 移除 turnClosed 守卫，只校验 messageUuid，避免切片末端项 turnClosed=false 时无 fork icon。
- **interruptAndAwaitResult 超时缩短**：增加 `timeoutMs` 参数，用户主动 interrupt 路径传 800ms（原 3000ms 兜底过长，fork lazy 启动后立即打断时 SDK result 不一定到达，体感卡）；AgentComplete 内部 interrupt 仍走默认 3000ms 兜底保本回合 token 统计。

## [0.0.15] - 2026-05-17

### 修复

- **画布同步丢失 Flow 非 agents 字段**：`reactFlowToFlow` 原签名只接收 `id / name / agents`，导致画布上任何编辑（节点增删、连线调整等）触发 `syncToFlow` 时，会把 `flow_desc`、`shareValuesKeys` 以及未来新增的 Flow 顶层字段全部抹掉。改为接收完整 `flow` 对象，输出时 `{ ...flow, agents }` 透传 agents 以外的所有字段；`AgentFlow/index.tsx` 中 `syncToFlow` 的依赖也由细粒度字段改为整 `flow` 引用。

### 优化

- **默认「修改代码」工作流精简**：移除原 `需求分析-glm` 节点（与 `需求分析-opus` 职责重合）；`修改代码` agent 的模型从 `glm-5.1` 切换到 `opus`，提升默认体验下的修改质量；统一 `更新summary` 段落措辞为「如果用户提出新需求」。

## [0.0.14] - 2026-05-17

### 破坏性变更

- **`Flow.shareValuesKeys` 数据形态变更**：从 `string[]` 调整为 `ShareValueKey[]`（每项含 `key` 与可选 `desc`），方便在设计期对每个共享 key 标注语义。`Flow` 同步新增可选字段 `flow_desc` 用于描述 Flow 整体职责。`AgentEditor` 的读 / 写授权多选下拉项展示形如 `key(desc)`，`buildAgentSystemPrompt` 注入 prompt 时仍只用 key。内置 PresetFlows 已迁移到新格式，旧 `string[]` 数据需经 `validateFlow` 重新清洗。

### 新增

- **AgentComplete 完成卡片展示 shareValues 写入**：`buildRenderItems` 把 `agentComplete` signal 携带的 `shareValues` 透传到完成卡片，气泡中以 `Tag + 值` 列表展示该回合 Agent 写入的共享数据，便于回看数据流转。
- **FlowEditor 共享 key 编辑重写**：原 `Select tags` 模式改为 `@dnd-kit` 拖拽列表，每行支持编辑 `key` / `desc`、按钮删除、拖拽手柄调整顺序，并对重复 key 给出表单级校验；新增 Flow 简介（`flow_desc`）输入与"清空 shareValues"按钮，抽屉宽度调整为 600。

### 优化

- **AgentComplete 后立即中断 SDK，token 统计不再丢失**：`ClaudeExecutor` 抽出 `interruptAndAwaitResult()`，让用户主动 interrupt 与 `AgentComplete` 触发的内部 interrupt 共用同一条「先 interrupt → await SDK result(modelUsage / total_cost_usd) → close」路径，3s 兜底防 hang；中断回合的费用 / token 现也能完整透传到 webview。同时模型在 AgentComplete 之后不再继续生成多余文字。
- **AgentComplete 工具卡片与多余消息丢弃**：`buildRenderItems` 引入 `agentCompleteSeen` 标志——AgentComplete 的 `tool_use` 一出现就视为本 session 收尾，既不再渲染该 tool 卡片（避免被中断后显示「失败」），也丢弃后续因中断时序产生的多余 text / 重试 tool_use / MCP AbortError tool_result，只保留下方完成卡片。
- **停止工作流不清空 shareValues**：ChatPanel 停止按钮 tooltip 更新为「停止工作流，不清空shareValues」，方便用户中断后基于已写入的共享数据重启或排查。
- **默认工作流提示词措辞**：内置 PresetFlows 中部分 Agent 的「任务完成」章节统一改为「完成任务」，并明确 `content` 取值与共享数据写入要求；工作流生成器对子 Agent 的 `agent_prompt` 模板也补充了「明确 AgentComplete 的 content 与写入 key」要求。

## [0.0.13] - 2026-05-16

### 破坏性变更

- **ShareValues 重构为按 key 授权读写**：废弃 Agent 级 `enable_share_values` 开关，改为：
  - **Flow 级声明**：`Flow.shareValuesKeys: string[]` 列出本 Flow 全部可用 key（在 FlowEditor 抽屉中维护）。
  - **Agent 级授权**：Agent 配置 `allowed_read_share_values_keys` / `allowed_write_share_values_keys` 分别声明可读 / 可写 key 子集。无授权时 Agent 完全感知不到 shareValues 的存在。
  - **读路径**：可读 key 与当前值以 JSON 形式注入到 Agent 系统提示词「# 可用数据」节（prompt 时点的快照，本会话内不再重读，运行中改值需切到下一个 Agent 才生效）。
  - **写路径**：仅能通过 `AgentComplete` 工具的 `shareValues` 参数一次性提交，未授权 key 静默丢弃；`never_complete` 模式无 AgentComplete 因此无法写入。
  - **删除的 MCP 工具**：`setShareValues` / `getShareValues` / `getAllShareValues` 三个工具不再注入到任何 Agent。
  - **删除的事件**：`flow.signal.shareValuesChanged` 移除；`flow.signal.agentComplete` 现携带 `shareValues` 字段统一同步。
  - **Flow 完成清空**：reducer 在 phase 转 `completed` 时把 `shareValues` 清空，避免污染下一次启动；`flowStart` 改为保留未运行时编辑的值带入新 run。

### 新增

- **FlowEditor 抽屉**：Flow 列表项的数据库按钮打开 FlowEditor 抽屉（替换旧的 ShareValues Modal），集中编辑工作流名称、`shareValuesKeys`（声明可用 key）以及运行中各 key 的当前值。删除 key 时自动从所有 Agent 的 `allowed_read/write_share_values_keys` 中清理引用。未运行时也能编辑 shareValues 值，会带入下一次 run。
- **AgentEditor 多选授权 UI**：Agent 配置弹窗新增两个 multi-select，分别管理 `allowed_read_share_values_keys` / `allowed_write_share_values_keys`，选项来自当前 Flow 的 `shareValuesKeys`。
- **AskUserQuestion 多问题排队**：同一回合内 AI 抛出多张提问卡片时按顺序排队，回答完一张自动滚到下一张，回答全部完成后才切回 running 状态；提问卡片支持测量高度自适应容器。
- **AgentComplete 写入 shareValues**：可完成模式（auto_complete / require_confirm）下 `AgentComplete` 工具新增可选 `shareValues` 参数，schema 由 `allowed_write_share_values_keys` 动态生成；MCP 端按白名单过滤未授权 key 后写入并通过 `agentComplete` signal 同步到 webview。
- **MCP `getFlowJSONSchema` 工具**：每个 Agent 的 MCP server 新增 `getFlowJSONSchema` 工具，方便 Agent 在生成或修改工作流前直接获取 Flow 的 JSON Schema。
- **回合 / Agent 级费用 breakdown**：基于 SDK `result.modelUsage` 镜像 `ModelTokenUsage` 类型，计算回合增量并在 `agent_complete` 项上展示 session 累计 breakdown，使用 SDK 实际 `costUSD` 而非估算。

### 优化

- **AgentEditor 独立成顶层组件**：从 `AgentFlow/AgentNode/AgentEditor` 抽出移到 `src/webview/components/AgentEditor/`，结构与样式重新整理。
- **ToolUseDetails 拆分**：从 `MessageBubble.tsx` 拆出独立组件（约 424 行），承接所有工具调用详情展示逻辑。
- **公共文本组件抽取**：新增 `text-components/`（`Md`、`CodeRefChip` / `FileRefChip` 等），多处重复代码归一。
- **buildRenderItems 重写**：渲染管线整体精简，移除多处冗余分支；保留 trailing streaming items 移除与 `stop_reason` 标记 streaming 的逻辑。
- **ClaudeExecutor 自带 (runId, sessionId) 校验**：暴露 `runId` / `sessionId` getter 与 `matches(runId, sessionId)` 方法，`FlowRunner` 不再维护 `currentRunId/currentSessionId/currentAgentId` 字段，`checkSession` 直接转发到 executor，避免切换过渡期把旧 sessionId 的 interrupt/userMessage 误派发到新 executor。
- **系统提示词调整**：`agent_prompt` 改为 optional；提示词不再注入 Agent 简介段落（简介只在 UI 展示，不进 prompt）；新增「# 可用数据」与「# 可写数据」两节配合 shareValues 授权读写。
- **默认工作流全面重写**：内置示例工作流根据新的 shareValues 授权模型重新组织，去掉 `enable_share_values` 字段，改用 `shareValuesKeys` + 读写白名单声明。
- **Flow 列表项简化**：`SortableFlowItem` 去掉旧的 ShareValues Modal 与相关状态，改为打开 FlowEditor 抽屉。

### 修复

- **assistant 消息跨 ID 重复**：某些模型（如 glm-5.1）会发 `stop_reason: null` 的完整重述消息，其 `message.id` 与 streaming 事件不同，导致流式片段与完整消息同时显示。`buildRenderItems` 通过移除 trailing streaming items + 按 `stop_reason` 标记 streaming 状态修复。
- **Flow 复制按钮**：`SortableFlowItem` 的复制改用 `copyable.text` 函数式取值，避免点击触发拖拽。

## [0.0.12] - 2026-05-13

### 修复

- **Starting 阶段节点高亮与红点**：修复 `starting` 阶段 AgentNode 无高亮和对话框无红点的问题，改用 `currentAgentId` 替代 `sessions[last].agentId` 判断当前 Agent，使 session 尚未建立时也能正确显示。
- **费用 Tokens 展示**：修复费用与 tokens 展示异常。

### 优化

- **Loading 展示逻辑**：修复 AI 回复 loading 状态的展示逻辑。
- **AskUserQuestion 字体**：调整 AskUserQuestion 提问卡片字体样式，提升可读性。
- **Agent 编辑组件**：优化 AgentEditor 组件结构与样式。

## [0.0.11] - 2026-05-12

### 新增

- **Agent 简介字段**：Agent 配置新增简介字段，用于描述该 Agent 的职责与定位。
- **Mermaid 图绘制**：新增 mermaid 图表渲染能力，支持在聊天消息中展示流程图。

### 优化

- **优化默认工作流**：迭代优化默认 Flow 结构。
- **取消 AgentName 唯一性校验**：不再强制 Agent 名称全局唯一，编辑弹窗中也取消了对名称的唯一性校验，允许用户自由命名。

## [0.0.9] - 2026-05-12

### 新增

- **ShareValues 双向同步数据通道**：`FlowRunState` 新增 `shareValues` 字段，`flowStart` 时初始化为空对象；event 新增 `flow.command.setShareValues`（webview→extension）和 `flow.signal.shareValuesChanged`（extension→webview）；MCP `setShareValues` 工具添加 `onShareValuesChanged` 回调，Agent 写入后即时通知外部；webview 端提供 `DatabaseOutlined` 按钮，支持在 Modal 中增删改 key-value pairs，空 key 自动生成占位名。
- **消息 Token 消耗可视化**：三层 token 信息展示——消息级（每条 AI 消息后显示 input/output/cache+/cache→）、回合级（turn_end 分隔线处展示本轮增量汇总）、Flow 级（ChatPanel header 中展示累计总量）；从 result 消息提取 `total_cost_usd` 优先显示 SDK 实际费用。
- **Flow 运行中可编辑**：取消 flow readonly 的设计，任意时候允许用户更改，但对更改的后果不做承诺。

### 优化

- **提取 `buildRenderItems` 到独立文件并增加 Map 缓存**：以 sessionId 为 key 缓存上次扫描结果，新消息中的 `tool_result` 会回填已有 `tool_use` 项的 result 字段。
- **优化默认工作流与系统提示词**：多次迭代优化默认 Flow 结构和 Agent 提示词措辞。
- **滚动修复**：用户发送消息后强制滚动到 ChatPanel 底部，解决向上滚动后 `shouldScrollRef` 被置为 false 导致的自动滚动失效。
- **算法优化**：消息展示结果计算按照 session 缓存优化。
- **Token 展示优化**：AI 气泡 token 回填解决 assistant 消息可能不携带 usage 的问题；缓存标签改为英文（in/out/cache write/cache read）。
- **清除无用缓存**。

### 修复

- **ShareValues 编辑的4个验证问题**：先清空旧 key 再赋值，删除 key 不再回弹；排除 `shareValuesChanged` signal 追加到 session.messages 避免污染 ChatPanel；未运行时保存给出 warning 反馈；添加按钮生成占位 key 代替空字符串。
- **重复提问卡片与单选选项被当成 Other**：修复 ChatPanel 中重复提问卡片展示问题，修复单选选项被错误归类为 "Other" 自由文本回答。

## [0.0.8] - 2026-05-11

### 新增

- **关闭 Webview 不再中断后台 Agent**：运行态 `FlowRunState` 在 extension 端镜像存储，关闭面板后 Agent 继续在后台运行；重新打开 Webview 时通过 `load` 事件同步全部历史消息与状态，等待用户回复 / 工作流完成等通知照常触达。
- Agent 配置 `auto_complete`（boolean）重命名并扩展为 `complete_mode`（三值枚举）：`auto`（自动完成）/ `confirm`（用户确认后完成）/ `never`（永不完成，MCP 不注册 `AgentComplete` 工具，系统提示词不生成"完成任务"模块）。
- Flow 列表新增**克隆**操作，可一键复制整条工作流。
- 抽取 `useStartFlow` hook 统一启动确认逻辑：`ChatDrawer` 与 `AgentNode` 直接启动按钮共用，非 idle 状态下统一弹 modal 确认（不再静默清空运行数据）。
- `Ctrl+Shift+L`（macOS：`Cmd+Shift+L`）无论是否打开 WebPanel 或 ChatPanel 都可注入代码片段。
- 聊天消息中的代码块支持复制按钮。

### 优化

- **状态机重构**：webview 与 extension 端采用同一份 `updateFlowRunState` reducer 推进 `FlowRunState`，两端状态严格同步；移除字符串类型的可派生值，状态语义更细分。
- **消息副作用统一**：reducer 产出的 `MessageEffect` 集中处理通知 / 自动打开 ChatPanel 等用户交互副作用。
- **Agent 系统提示词**：「任务描述」前置于通用规则，先明确核心职责再补充约束；`no_input=true` 时省略「如何对待用户消息」段落；去除提示词中的"Agent"术语（改用"步骤"），降低元认知负担。
- **聊天面板滚动**：`onWheel` 改为 `onScroll` 监听实际滚动位置（底部阈值 <10px 恢复自动滚动）；回答问题后滚动到最底端；初始定位/切换 Agent 改为直接滚动而非 smooth。
- **消息渲染性能**：消息组件 `memo` 化；流式消息在浏览器空闲时（`requestIdleCallback`）批量提交至 store，避免高频触发重渲染。
- **默认工作流**：动态获取 Flow 的类型而非写死。
- **中断处理**：中断 Agent 时关闭子进程释放内存；`interrupted` 状态下用户输入发为新消息而非重启 query。
- **粘贴 Agent**：不再自动追加重命名后缀，保持原 name。

### 修复

- 修复切换到无输入 Agent（`no_input=true`）时起始消息展示错误。
- 修复 `useForm` 在 AgentEditModal 中的使用方式。
- 修复多处 TypeScript 类型问题。

## [0.0.7] - 2026-05-08

### 新增

- Agent 新增 `enable_share_values` 配置项，默认关闭。仅在显式开启后才会注入 `setShareValues` / `getShareValues` / `getAllShareValues` 三个 MCP 工具，避免无关 Agent 误污染共享上下文。
- Agent 完成后跟随切换 ChatPanel：当前面板正显示刚完成的 Agent 时切到下一个；用户停留在当前 Flow 且 ChatDrawer 未打开时自动打开下一个；其余情况保持不变，靠通知引导。
- `AskUserQuestionCard` 容器高度支持拖拽调整。

### 优化

- "允许直接启动"相关文案统一为 "无输入"，与 `no_input` 字段语义对齐。
- 工具调用成功 / 失败图标由 outlined 改为 filled 实心，色块面积更大、区分度显著提升。
- 消息通知改用 AntD `App.useApp()` 拿到 `message` / `notification` 上下文，确保通知样式与全局主题一致；强化通知触发条件，覆盖更多等待 / 完成场景。
- Agent 系统提示词与默认工作流提示词措辞优化。
- 多处嵌套三元 / `if-else` 改用 `ts-pattern` 的 `match` + `with` / `P.union` 重写。
- Release 流程在打包前自动执行 `prettier --write` 格式化。
- 聊天面板初始 / 流式输出过程中的滚动行为优化。

### 修复

- 修复 `ClaudeExecutor` 复用同一 MCP Server 实例导致中断后再次发送消息时，SDK 对同一 Server 重复 `connect` 抛出 `Already connected to a transport`、被 SDK `.catch` 静默吞错使 `AgentControllerMcp` 工具集体不可用的问题。改为每次 `createQuery` 前先 `close` 旧 mcpServer 再重建。
- MCP 工具（`AgentComplete` / `setShareValues` / `getShareValues` / `getAllShareValues` / `validateFlow`）统一加 `withErrorBoundary` 兜底，失败返回 `isError` 而非静默崩溃，消除 `AgentComplete` 链路的隐性失败。
- `ClaudeExecutor.onComplete` 调换执行顺序：先调 `events.onComplete` 再置 `completed`，避免上层抛错时后续 AI 重试被 `completed` 检查直接吞掉。
- `FlowRunner.onAgentComplete` 包 `try/catch`，失败时 fire `error` signal 后 rethrow，不再吃异常。
- `ClaudeExecutor.kill` 中 `mcpServer.close` 的空 `catch` 改为 `logError`，不再静默丢错。
- 修复 OpenAI 兼容代理下流式 text 气泡不显示 / 顺序错乱：OpenAI 兼容代理把每个 content_block 单独打包为完整 assistant 消息并共享同一 `message.id`，原"按 mid 整段丢 partial"在 thinking 完成后会一并干掉仍在流式的 text partial。改为按 type 计数 + 在 `content_block_start` 处就地插入 streaming partial，对 Anthropic 原生 SDK 行为等价。
- 修复 `AgentComplete` 调用后 executor 立刻 kill、`mcp_tool_result` 不会到达 webview 导致工具气泡永久 spin：当 `session.completed=true` 且工具名含 `AgentComplete` 时视为成功并显示绿勾图标。

## [0.0.6] - 2026-05-07

### 新增

- Agent 配置项 `auto_start` 重命名为 `no_input`，语义更明确：开启后始终以"开始"为初始消息自动运行，忽略用户实际输入。
- Pending `AskUserQuestion` 卡片改为固定在输入框上方，不随消息滚动，回答时无需回滚页面。
- Agent 切换时智能打开 ChatDrawer：无打开时自动打开，目标 Agent 已打开时保持。
- ChatPanel 初始加载时自动滚动到底部。

### 优化

- 聊天气泡与输入框字体、间距调整，提升可读性。
- 工具调用摘要改为显示原始工具名 + 路径/内容，替代中文缩略描述。
- 多选问题允许不选（空数组视为有效回答）。
- 防止终态（completed / stopped / error）之后退回 awaiting 阶段。
- 任一 session 完成后不再显示 loading 指示器。
- 嵌套用户消息（parent_tool_use_id 非空）不再独立渲染。
- 代码片段插入失败时直接在 VSCode 中打开目标文件并显示通知，替代旧的 insertSelectionFailed 事件。
- AgentEditModal 键盘事件：非 Escape 键阻止冒泡，避免误触快捷键。
- MiniMax 大小写修正。

### 修复

- MCP server 在 executor dispose 时正确关闭，避免资源泄漏。
- 工具调用详情 summary 文本溢出处理（省略号截断）。

## [0.0.5] - 2026-05-07

### 新增

- Agent 新增 `auto_start`（允许直接启动）配置：开启后节点操作区显示启动按钮，点击以"开始"为初始消息自动运行该 Agent，无需打开聊天面板手动输入。
- Agent 等待用户回复（awaiting-message / awaiting-question）或 Flow 完成时，若插件面板不可见或窗口失焦，自动弹出 VSCode 系统通知；点击通知可跳转回对应 Agent 的聊天面板。
- 新增 `flow.signal.notifyUser` 和 `flow.signal.focusFlow` 事件契约，支持 Extension ↔ Webview 双端通知联动。
- 默认 `AI 对话` 工作流拆分为三个独立 Agent（glm-5.1 / opus / sonnet），方便按需选择模型。
- AntD `ConfigProvider` 启用 `darkAlgorithm`，与插件整体暗色风格统一。

### 优化

- 消息气泡渲染逻辑重构：`toBubbleItems` 拆分为数据归一化层（`buildRenderItems`）与渲染层（`renderItemToBubble`），流式 partial 与完整 assistant 消息通过 `message.id` 精确配对，消除位置过滤带来的时序问题。
- `AskUserQuestion` 自由文本作答改为按 question 索引追踪，历史态可精确区分哪些问题通过选项回答、哪些通过自由文本回答，标签显示"含自由文本回答"并正确展示内容。
- `maxTurns` 从 100 提升到 1000，支持更长的 Agent 交互。
- 聊天输入框在 `awaiting-question` 状态下显示 loading 动画，提示用户 AI 正在等待回答。
- 画布 `hidden` 时禁止 Delete 键删除节点，避免在不可见状态下误操作。

### 修复

- 修复 Agent 中断后 `result` 消息仍触发 `onAwaitingUser` 的问题：新增 `interrupted` 标记，中断后跳过随之而来的 result 消息。

## [0.0.4] - 2026-05-05

### 新增

- AI 回复支持流式传输，文本块 / thinking 块实时显示。
- 消息气泡中展示工具调用：显示有意义的摘要（读取的文件、执行的命令等），未完成时显示 loading，完成后折叠查看参数详情与执行结果。
- `AskUserQuestion` 提问内容改用 Markdown 渲染，支持代码、链接、列表等富文本格式。
- 模型选择器新增 `gpt-5.5` 选项，并支持大小写不敏感的搜索过滤。
- 内置示例工作流扩展：
  - 在 `常用 Agent 可直接复制` 中新增 `修改代码（无限循环）` 自环 Agent（按用户要求修改代码、生成 commit message 并提交）。
  - 新增 `AI 对话` 默认工作流。
- 适配 Claude Opus 4.7 与新版 `@anthropic-ai/claude-agent-sdk`。
- 多平台分发：发布流程支持 win32 / darwin / linux × x64 / arm64。
- `openPanel` 打开的 Webview 面板设置了插件图标（`resources/icon.svg`）。

### 优化

- `openPanel` 改为在主编辑区打开 Webview（`ViewColumn.One`，原为 `Beside`）。
- 文件打开改用 `ViewColumn.Beside`，使 Webview 与目标文件并排展示。
- `addSelectionToInput` 在无 ChatPanel 时不再自动打开面板；Webview 已打开但 ChatPanel 未展示时，通过 `insertSelectionFailed` 事件回传并由 extension 显示 VS Code 提示。
- 聊天 Drawer 支持拖拽调整宽度、`Esc` 关闭，并调整了默认宽度。
- 节点自动布局时 x 坐标右移 320px，为侧边面板预留空间。
- 工作流列表移动到左下角，移除画布小控件。
- `starting` 阶段禁止中断工作流 / 停止 Agent；启动期间显示骨架屏。
- `FlowList` 在 `AskUserQuestion` / 工具授权等待时显示"等待用户"而非"AI 生成中"。
- Agent 提示词字段由数组改为字符串。
- 默认工作流内容优化。
- `CodeRefChip` / `FileRefChip` 增加 `whiteSpace: pre-wrap` + `wordBreak: break-all`，避免长文件名撑满消息容器。
- 统一 AntD `ConfigProvider`，确保消息中图标颜色正确。
- `thinking` 块为空时不展示；loading 样式与触发条件调整。
- Release 发布流程使用 `--frozen-lockfile` 安装依赖。
- AI 默认使用中文回复。

### 修复

- 修复用户消息气泡中 `code_snippet` / `file_ref` / `attachment` 的前导 HTML 注释被渲染为纯文本的问题。
- 修复 `ChatInput` 复制出的富文本无法粘贴回输入框的问题。
- 修复中断 Agent 后 `streamingBlocks` 残留导致的消息重复展示。
- 修复 `AgentComplete` 的 `content` 与前置 assistant 文本块重复展示的问题。
- 修复 `ChatPanel` 因 `ctx` / `answeredMap` 引用不稳定导致的无限重渲染（`Maximum update depth exceeded`）。
- 修复流式传输完成后 thinking / text 块与 assistant 消息重复渲染：改用位置过滤（`streamCutoff = max(lastResultIdx, lastAssistantIdx)`）替代不可靠的 UUID 匹配。
- 修复 `XMarkdown` 因 `components` 每次渲染重新赋值导致的过度重渲染。
- 修复部分 Agent 状态错误。
- 移除 `AskUserQuestionCard` 的关闭按钮（用户可直接通过输入框作为 Other 自由文本回复）。

## [0.0.3] - 2026-05-04

### 新增

- 聊天输入框改为富文本，支持通过 `Ctrl+V` 粘贴图片 / 文本 / 任意文件并以内联附件形式附加到消息。
- 图片附件在消息中以缩略图展示，外部长文本以独立面板预览。
- 快捷键 `Ctrl+Shift+L` / `Cmd+Shift+L` 在无文本选中时，注入当前文件的全部内容作为代码片段（不带行号）。
- 代码片段 Tag 支持点击跳转：有行范围时打开文件并选中对应行，无行范围时仅打开文件。
- 新增 `pnpm format` 命令（prettier --write）。
- 新增 `pnpm release` 脚本用于一键发布流程。

### 优化

- 调整传给 AI 的消息 / 附件数据格式，减少冗余、提升模型可读性。
- 代码片段的选择与展示逻辑。
- 聊天输入框 `Ctrl` / `Shift` / `Alt` / 系统键 + `Enter` 均可换行。

### 修复

- 添加代码片段失败时不再弹出错误提示。

## [0.0.2] - 2026-05-04

### 变更

- 完善 README 文档。

## [0.0.1] - 2026-05-04

首次发布。

### 核心特性

- 可视化 Agent 工作流：以有向图的方式编排 Agent，每个节点独立配置模型（opus / sonnet / haiku）与思考强度。
- 上下文隔离 + `shareValues` 跨 Agent 数据共享。
- 通过 `@anthropic-ai/claude-agent-sdk` 执行 Agent，内建 `AskUserQuestion` / `Bash` / `Read` 等 Claude Code 工具。
- 工作流启动 / 中断 / 回答问题 / 工具权限审批全链路。
- 自由复制粘贴：Agent 节点（保留内部连接、ID 重映射）、整条 Flow（JSON 序列化导入 / 导出）。
- 内置示例工作流：`工作流生成器`、示例 Agent（模型理解能力测试、飞书通知等）。
- VSCode 编辑器联动：`Ctrl+Shift+L` / `Cmd+Shift+L` 把选区作为带行号的代码引用发送到活跃输入框。
