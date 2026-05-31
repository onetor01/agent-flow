# CLAUDE.md

中文回复。Agent schema 字段保持 snake_case 与 prompt 对齐。优先用 `ts-pattern` 的 `match` + `.exhaustive()` 替代嵌套三元 / `if-else` / `switch`。

**功能变动后必须同步本文件**：改动事件契约、reducer 行为、运行时层级、work_mode 行为、ShareValues 链路、易踩坑硬约束 → 改完代码后回查相关章节并更新；新增硬约束追加到「易踩坑」节。文档与代码不一致即视为 bug。

**写作约定**：本文是导航地图,具体实现细节(字段名/调用链/步骤)写在对应代码注释里。本文每条只留「标题 + 一句话约束 + 文件路径」,从路径进去看代码注释拿完整语义。新增条目时,先把细节落到代码注释,本文只引用。

## 项目性质

VSCode 插件 `agent-flow`：用 Agent 编排工作流。Flow 是 Agent 作为节点的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，按 `outputs[i].next_agent` 决定下一跳，通过 Flow 的 `shareValues`（按 key 授权读写）共享数据。

## 三层源码结构

跨层 import 只能经 [src/common/](src/common/)。三个独立 tsconfig：

- [src/common/](src/common/) — 共享层（Zod schema / 类型 / 事件契约 / prompt 构建），webview 应 import `@/common`（不含 SDK）
- [src/extension/](src/extension/) — Node / VSCode 扩展宿主，可 import `@/common/extension`（含 SDK）
- [src/webview/](src/webview/) — React 19 + AntD + `@xyflow/react` + `zustand`(immer)

领域定义与校验在 [src/common/index.ts](src/common/index.ts)（Flow/Agent/Output、validateFlow、matchTool / matchToolAnySubCommand / splitBashCommand、buildAgentSystemPrompt）。[PersistedDataController](src/extension/PersistedDataController/index.ts) 加载失败整体回退 `defaultStore`。

## Extension ↔ Webview 事件契约

事件定义见 [src/common/event.ts](src/common/event.ts)。`flow.command.*` = webview → extension,`flow.signal.*` = extension → webview。`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

标识符：

- `flowId` —— Flow 主键
- `runId` —— 一次 Agent 运行的主键,所有载荷以此寻址。来源:`flowStart` 由 webview 生成,`next_agent` / `fork` 由 extension 生成
- `sessionId` —— Claude SDK session id,挂在 `AgentRun.sessionId`,每切 Agent 换一次;不出现在事件载荷上,由 `aiMessage` 内 SDK 原生 `session_id` 回填

## 单一 reducer

[updateFlowRunState](src/common/flowRunState.ts) 是 Flow 运行态唯一 reducer,signal / command 两条路径上 extension 与 webview 各 reduce 一次,共用同一份保证两端同步。webview 镜像在 [useFlowStore](src/webview/store/flow.ts),extension 镜像在 [FlowRunStateManager](src/extension/FlowRunStateManager.ts)。

`FlowPhase` / `AgentPhase` 同构:`idle | starting | running | result | interrupted | awaiting-question | awaiting-tool-permission | awaiting-complete-confirm | completed | stopped | error`,共用 `aggregatePhase(runs)`。Phase 不存字段,由 [getRunPhase / getAgentPhase / getFlowPhase](src/common/flowRunState.ts) 推断。

`FlowRunState` 数据结构、`MessageEffect` 6 个 reason、终态守卫见 [flowRunState.ts](src/common/flowRunState.ts) 顶部注释。silent_task 仅放行 `agent-error` / `flow-completed` / `awaiting-complete-confirm`(详见 `pushEffect`)。

## 运行时层级

extension:[FlowRunnerManager](src/extension/FlowRunnerManager/index.ts)(全局,`Map<flowId, FlowRunner>`) → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts)(一个 Flow,`Map<runId, ClaudeExecutor>`,本期 `size <= 1`) → [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts)(封装 SDK `query`)。**路由职责由 FlowRunner 承担**:executors 按 runId 寻址;ClaudeExecutor 自身不持有 runId/agentId。per-Agent MCP server 在 [src/common/extension.ts](src/common/extension.ts):`AgentComplete`(chat 不挂) / `validateFlow` / `getFlowJSONSchema`,silent_task 多挂 `terminateTask`。

webview:[App](src/webview/App.tsx) → `<AgentFlow>` + `<ChatDrawer>`,状态收敛到 [useFlowStore](src/webview/store/flow.ts)。

**用户当前要看的 agent = `runs.at(-1)?.agentId`**:reducer 处理 `agentComplete` 切 next_agent 时立刻追加新 run 到末位。AgentNode 高亮 / ChatDrawer 自动切换 / `activeRunId` 同会话追问判定都按这条规则在调用点内联,不要重新引入跨场景 `getActiveAgentId` 工具。

## ShareValues 授权读写

Flow 级共享存储,Agent 视角是按 key 授权的 `values` 契约。链路细节见对应代码:

- 声明:`Flow.shareValuesKeys` —— [src/common/index.ts](src/common/index.ts) `ShareValueKeySchema`(删 key 自动从 `allowed_read/write_values_keys` 清理)
- 读:[buildAgentSystemPrompt](src/common/index.ts) 注入「# 可读写数据」+「# 可用数据」节;**prompt 时点快照,运行中改值需切下一 agent 生效**
- 写:仅 [AgentComplete](src/common/extension.ts) 的 `values` 参数,schema 由 `allowed_write_values_keys` 动态生成,未授权 key 静默丢弃;`chat` 模式无 AgentComplete 故无法写
- 事件:`flow.signal.agentComplete.values`(reducer 合并到 `state.shareValues`)/ `flow.command.setShareValues`(full replace,无 runId,未运行也能编辑)
- 运行时取值:extension 端 `getLatestShareValues(flowId)` → [FlowRunStateManager](src/extension/FlowRunStateManager.ts);`FlowRunner` 不持有副本
- 命名:Flow 视角 = `shareValues`,Agent 视角 = `values`

## work_mode 三态

- **task**:常规推进。系统提示词注入「任务描述 / 完成任务 / 输出分支」,AskUserQuestion 允许、AgentComplete 必须
- **chat**:长期对话。AgentComplete 不挂载、可写 values 节不注入,`agent_prompt` 视为长期规则
- **silent_task**:无人值守。AskUserQuestion 自动应答 / result 自动续轮 / canUseTool 默认 deny / `pushEffect` 仅放行 error|completed|awaiting-complete-confirm / 暴露 `terminateTask` MCP / AgentEditor 首次切换弹 warning。详见 [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) 与 reducer `pushEffect`

## 易踩坑(硬约束,不要回退)

每条「标题 → 文件 → 一句话约束」,具体语义看对应代码注释。

- **handleCommand 必须 `keyof` + `.exhaustive()`** → [FlowRunnerManager.handleCommand](src/extension/FlowRunnerManager/index.ts):分支写完整 `flow.command.*`,不要 `.otherwise`(短名错配会静默吞 → executor 残留烧 token / interrupt 失效)
- **killFlow vs flowStart 语义对照** → [flowRunState.ts](src/common/flowRunState.ts) `killFlow` / `flowStart` 分支:killFlow 保留 messages / shareValues;flowStart 清 messages、shareValues 透传;shareValues 仅在 phase→completed 时清空
- **next_agent 是 id 不是 name** → [useFlowStore.copyAgents](src/webview/store/flow.ts):复制 Agent 必须重新生成 id 并通过 `idMap` 重映射 `next_agent`
- **状态分层** → Flow 定义→`.agent-flows.json`(`os.homedir()`);`FlowRunState` 仅内存,extension 端 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像;UI 状态仅 webview
- **ChatPanel 开始运行** → [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx):`phase === 'idle'` 直启;非 idle 非 awaiting 要 modal 确认(清空运行数据)
- **webview 粘贴双路径** → `<AgentFlow>` 内 = 粘贴 Agent(保留内部连接 / ID 重映射);画布空白 / App 层 = 作为 Flow JSON 导入
- **CodeRef.line** → [ChatInput.tsx](src/webview/components/ChatDrawer/ChatInput.tsx):`line?: [number, number]`,整文件 = `undefined`;`Ctrl+Shift+L`(Mac `Cmd+Shift+L`)选中文字注入带行片段、无选中注入整文件
- **assistant 完整消息 = 流式终点,回合用量唯一真相 = result** → [buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts):只 pop streaming 占位、不做跨 ID 复读去重;token 用量 / 上下文 used 全从 result 取
- **shareValues 是 prompt 快照** → [FlowRunner.doOnAgentComplete](src/extension/FlowRunnerManager/FlowRunner/index.ts):切下一 agent 时手动 `{ ...getLatestShareValues(), ...result.values }` 拼快照,否则 nextAgent systemPrompt 看到旧值
- **ClaudeExecutor 路由由 FlowRunner 承担** → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts):用 `executors.get(runId)` 寻址,Executor 不持有 runId/agentId;回调闭包用 `executors.get(runId) !== getExecutor()` 判定过期避免污染新 run
- **ClaudeExecutor 启动模式 `eager` / `lazy`** → [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):eager 立即 createQuery + push initMessage;lazy 用于 fork,等用户首次 sendUserMessage 触发。fork target 仅 `kind: 'message'`(SDK 不支持 askUserQuestion 作 fork 终点)
- **AgentComplete 后 SDK result 不走 onMessage** → [ClaudeExecutor / FlowRunner / reducer](src/common/flowRunState.ts):AgentComplete 已暂存时跳过该 result onMessage,通过 onComplete 上抛;reducer 不单独包成 aiMessage(result 挂 `agentComplete.data.result` 随 signal 进 messages),buildRenderItems 在 agentComplete 分支调 `applyResultToCache(data.result)` 取 token,不走 result 分支;原因是避免 phase 误切到 result 触发"生成完毕"通知
- **fork 切片 uuid 用双 transcript 映射** → [handleFork](src/extension/index.ts):并发取源 session 与新 session transcript，按位置建 `srcUuid→newUuid` 映射，替换 slicedMessages 中所有带 uuid 的 SDK 消息；不再用 webview 序列顺序对齐（webview echo 无 uuid 会错位），否则二次 fork 报 `Message <uuid> not found`
- **findPrevUuid 必须排除 stream_event uuid** → [buildRenderItems.findPrevUuid](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts):仅放行 SDKUserMessage / SDKUserMessageReplay / SDKAssistantMessage,误命中 stream_event uuid 会让 forkSession 报 `Message <uuid> not found`
- **fork 走 handleFork 路径** → [handleFork](src/extension/index.ts):`setRunState` + `spawnForFork` 起 FlowRunner + lazy executor → 发 `flow.signal.fork`;webview push 新 Flow / 切 active / 打开 ChatDrawer。用户首次发消息走 `sendUserMessage` 不经 `flowStart`
- **fork target 带 runId 不带 agentId** → `flow.command.fork.target = { kind: 'message', runId, messageUuid }`:webview RenderItem 知道自己属于哪个 run(MessageList 按 run 维度遍历),extension `locateFork` 单 loop 按 runId 查;`flow.signal.fork` 也只带 runId,webview 从 `newRunState.runs.at(-1).agentId` 反推
- **store 命令派发必须传 runId** → [useFlowStore](src/webview/store/flow.ts):`sendUserMessage` / `interruptAgent` / `answerQuestion` / `answerToolPermission` 调用方明确传 `runId`,store 不做"末位非终态 run 回退"(多 run 会乱派发);ChatDrawer 用 `activeRunId`、answerQuestion 用 `pendingQuestion.runId`、answerToolPermission 按 toolUseId 反查
- **ChatPanel 跨 Flow / 跨 run 切换必须 unmount** → [ChatDrawer](src/webview/components/ChatDrawer/index.tsx):给 ChatPanel 加 `key={`${flowId}-${agentId}-${runId ?? ''}`}`,避免 AskUserQuestionCard selections / motion.div ask-card key 在新旧 Flow / run 间被复用(fork 出的新 Flow 与源 Flow toolUseId 实际相同,SDK forkSession 不 remap)
- **zustand selector 禁止返回新数组 / 新对象** → [ChatPanel](src/webview/components/ChatDrawer/ChatPanel/index.tsx) / [MessageList](src/webview/components/ChatDrawer/ChatPanel/MessageList.tsx):`s.x.filter(...)` / `... ?? []` / `... ?? {}` 每次新引用 → `useSyncExternalStore` 用 `Object.is` 判定快照变化 → 死循环。取原始引用稳定字段,过滤在 `useMemo` 里;空结果用模块级常量(如 `EMPTY_PENDING_QUESTIONS`);多个派生值拆多 selector
- **AgentComplete.content 作为 next agent 首条消息回显** → [reducer agentComplete 分支](src/common/flowRunState.ts):创建新 `AgentRun` 时 `messages` 预置一条 user `aiMessage`(content = `nextAgent.no_input ? '开始' : data.content`),与 `FlowRunner.doOnAgentComplete` 喂 SDK 的 `nextInitMessage` 同源,改链路两端同改
- **`flow.signal.answerQuestion` 与 `flow.command.answerQuestion` 同语义** → silent_task 自动应答走 signal,人工回答走 command,reducer 两条分支处理一致;不要合并(入口区分对未来场景过滤有用)
- **Bash 命令级权限：all-match vs any-match 不对称** → [src/common/index.ts](src/common/index.ts) `matchTool` / `matchToolAnySubCommand`：auto_allowed 用 matchTool（所有子命令都命中才放行，防绕过）；must_confirm 额外调 matchToolAnySubCommand（任一子命令命中即要求确认）；裸 `Bash` 不受此逻辑影响，直接整工具匹配
- **require_confirm 只拦截 canUseTool，silent_task 不自动应答** → [ClaudeExecutor.canUseTool](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):`mcp__AgentControllerMcp__AgentComplete` + `require_confirm===true && work_mode!=='chat'` 时挂 pending、fire `onCompleteConfirmRequest`；silent_task 模式下此路径同样挂起，不自动放行，必须用户人工确认。
