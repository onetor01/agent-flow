# CLAUDE.md

中文回复。Agent schema 字段保持 snake_case 与 prompt 对齐。优先用 `ts-pattern` 的 `match` + `.exhaustive()` 替代嵌套三元 / `if-else` / `switch`。

**功能变动后必须同步本文件**：改动事件契约、reducer 行为、运行时层级、work_mode 行为、ShareValues 链路、易踩坑硬约束 → 改完代码后回查相关章节并更新；新增硬约束追加到「易踩坑」节。文档与代码不一致即视为 bug。

**写作约定**：本文是导航地图,只留「标题 + 一句话约束 + 文件路径」,具体字段名/调用链/步骤写在对应代码注释里。新增条目先把细节落到代码注释,本文只引用。**只收录与 AI 对话核心链路相关的硬约束**(消息流 / 状态机 / 事件契约 / ShareValues / fork / 消息派发);单点小约束、UI 杂项、字段映射不进本文。只描述当前状态,不用"改为 xxx"/"不再走 xxx"等变化句式——历史变化属于 commit message。

## 项目性质

VSCode 插件 `agent-flow`：用 Agent 编排工作流。Flow 是 Agent 作为节点的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，按 `outputs[i].next_agent` 决定下一跳，通过 Flow 的 `shareValues`（按 key 授权读写）共享数据。

## 三层源码结构

跨层 import 只能经 [src/common/](src/common/)。三个独立 tsconfig：

- [src/common/](src/common/) — 共享层（Zod schema / 类型 / 事件契约 / prompt 构建），webview 应 import `@/common`（不含 SDK）
- [src/extension/](src/extension/) — Node / VSCode 扩展宿主，可 import `@/common/extension`（含 SDK）
- [src/webview/](src/webview/) — React 19 + AntD + `@xyflow/react` + `zustand`(immer)

领域定义与校验在 [src/common/index.ts](src/common/index.ts)。Flow 定义持久化到 `.agent-flows.json`(`os.homedir()`);`FlowRunState` 仅内存,extension 端 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像;UI 状态仅 webview。

## Extension ↔ Webview 事件契约

事件定义见 [src/common/event.ts](src/common/event.ts)。`flow.command.*` = webview → extension,`flow.signal.*` = extension → webview。`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

标识符：

- `flowId` —— Flow 主键
- `runId` —— 一次 Agent 运行的主键,所有载荷以此寻址。来源:`flowStart` 由 webview 生成,`next_agent` / `fork` 由 extension 生成
- `sessionId` —— Claude SDK session id,挂在 `AgentRun.sessionId`,每切 Agent 换一次;不出现在事件载荷上,由 `aiMessage` 内 SDK 原生 `session_id` 回填

## 单一 reducer

[updateFlowRunState](src/common/flowRunState.ts) 是 Flow 运行态唯一 reducer,signal / command 两条路径上 extension 与 webview 各 reduce 一次,共用同一份保证两端同步。webview 镜像在 [useFlowStore](src/webview/store/flow.ts),extension 镜像在 [FlowRunStateManager](src/extension/FlowRunStateManager.ts)。

`FlowPhase` / `AgentPhase` 同构:`idle | starting | running | result | interrupted | awaiting-tool-permission | completed | stopped | error`,共用 `aggregatePhase(runs)`。Phase 不存字段,由 [getRunPhase / getAgentPhase / getFlowPhase](src/common/flowRunState.ts) 推断。

`FlowRunState` 数据结构、`MessageEffect` 4 个 reason(`result` / `awaiting-tool-permission` / `flow-completed` / `agent-error`)、终态守卫见 [flowRunState.ts](src/common/flowRunState.ts) 顶部注释。

## 运行时层级

extension:[FlowRunnerManager](src/extension/FlowRunnerManager/index.ts)(全局,`Map<flowId, FlowRunner>`) → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts)(一个 Flow,`Map<runId, ClaudeExecutor | CodeExecutor>`,本期 `size <= 1`) → 按 `agent.node_type` 分流:`agent` 走 [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts)(封装 SDK `query`),`code` 走 [CodeExecutor](src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts)(把 `agent.code` 当 `async function (input, values, runCommand)` 函数体执行,不走 SDK)。**路由职责由 FlowRunner 承担**:executors 按 runId 寻址;Executor 自身不持有 runId/agentId。per-Agent MCP server 在 [src/common/extension.ts](src/common/extension.ts):`CompleteTask`(chat 不挂) / `validateFlow` / `getFlowJSONSchema`,task / silent_task 多挂 `TerminateTask`,`plan_mode=true` 时多挂 `ExitPlanMode`。AskUserQuestion / CompleteTask(require_confirm) / ExitPlanMode / must_confirm 工具的"挂起等待确认"统一走 canUseTool → `toolPermissionRequest` 信号(见「易踩坑」的统一 tool permission 条)。

webview:[App](src/webview/App.tsx) → `<AgentFlow>` + `<ChatDrawer>`,状态收敛到 [useFlowStore](src/webview/store/flow.ts)。

**用户当前要看的 agent = `runs.at(-1)?.agentId`**:reducer 处理 `agentComplete` 切 next_agent 时立刻追加新 run 到末位。AgentNode 高亮 / ChatDrawer 自动切换 / `activeRunId` 同会话追问判定都按这条规则在调用点内联,不要重新引入跨场景 `getActiveAgentId` 工具。

## ShareValues 授权读写

Flow 级共享存储,Agent 视角是按 key 授权的 `values` 契约。链路细节见对应代码:

- 声明:`Flow.shareValuesKeys` —— [src/common/index.ts](src/common/index.ts) `ShareValueKeySchema`(删 key 自动从 `allowed_read/write_values_keys` 清理)
- 读:[buildAgentSystemPrompt](src/common/index.ts) 注入「# 可读写数据」+「# 可用数据」节;**prompt 时点快照,运行中改值需切下一 agent 生效**
- 写:仅 [CompleteTask](src/common/extension.ts) 的 `values` 参数,schema 由 `allowed_write_values_keys` 动态生成,未授权 key 静默丢弃;`chat` 模式无 CompleteTask 故无法写
- 授权范围:`allowed_read/write_values_keys` 仅约束 `node_type='agent'`;`node_type='code'` 节点全量读、返回 values 仅提交代码显式修改的 key（delta 合并到 shareValues，不受 allowed_write 约束）
- 事件:`flow.signal.agentComplete.values`(reducer 合并到 `state.shareValues`)/ `flow.command.setShareValues`(full replace,无 runId,未运行也能编辑)
- 运行时取值:extension 端 `getLatestShareValues(flowId)` → [FlowRunStateManager](src/extension/FlowRunStateManager.ts);`FlowRunner` 不持有副本
- 命名:Flow 视角 = `shareValues`,Agent 视角 = `values`

## work_mode 三态

仅 `node_type='agent'` 节点适用;`node_type='code'` 走 CodeExecutor,不读 work_mode / agent_prompt / model 等字段。

- **task**:常规推进。系统提示词注入「任务描述 / 完成任务 / 输出分支」,AskUserQuestion 允许、CompleteTask 必须、TerminateTask 在极端情况下可中止任务
- **chat**:长期对话。CompleteTask 不挂载、可写 values 节不注入,`agent_prompt` 视为长期规则
- **silent_task**:无人值守。AskUserQuestion 自动应答(allow + 自动答案,经 `flow.signal.toolPermissionResult` 回显历史卡片) / ExitPlanMode 自动接受(allow,同样经 `flow.signal.toolPermissionResult` 回显历史卡片,不触发 pushEffect) / must_confirm_tools 自动拒绝(deny,无人确认故禁止使用) / result 自动续轮 / `pushEffect` 仅放行 `agent-error` / `flow-completed` / `awaiting-tool-permission` 中命中 CompleteTask 的确认(result、AskUserQuestion 自动应答、ExitPlanMode 自动接受、普通工具授权静默) / 暴露 `TerminateTask` MCP / AgentEditor 首次切换弹 warning / 自动回复(自动续轮 + AskUserQuestion 自动应答 + ExitPlanMode 自动接受)受 `SILENT_MAX_AUTO_REPLIES`(默认 30)per-run 上限约束,超过 fire onError 推 agent-error 终态;SDK 层 `maxTurns=60` 作双重兜底。详见 [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) 与 reducer `pushEffect`

## 易踩坑(硬约束,不要回退)

每条「标题 → 文件 → 一句话约束」,具体语义看对应代码注释。**只收录涉及核心链路的硬约束**;实现细节在代码注释里。

### 状态机与命令派发

- **handleCommand 必须 `keyof` + `.exhaustive()`** → [FlowRunnerManager.handleCommand](src/extension/FlowRunnerManager/index.ts):分支写完整 `flow.command.*`,不要 `.otherwise`(短名错配会静默吞 → executor 残留烧 token / interrupt 失效)
- **killFlow vs flowStart 语义对照** → [flowRunState.ts](src/common/flowRunState.ts) `killFlow` / `flowStart` 分支:killFlow 保留 messages / shareValues;flowStart 清 messages、shareValues 透传;shareValues 仅在 phase→completed 时清空
- **store 命令派发必须传 runId** → [useFlowStore](src/webview/store/flow.ts):`sendUserMessage` / `interruptAgent` / `answerToolPermission` 调用方明确传 `runId`,store 不做"末位非终态 run 回退"(多 run 会乱派发);ChatDrawer 用 `activeRunId`、answerToolPermission 按 toolUseId 反查 `pendingToolPermission.runId`
- **`flow.signal.toolPermissionResult` 与 `flow.command.toolPermissionResult` 同语义** → silent_task 自动应答走 signal(不 pushEffect),人工回答走 command,reducer 两条分支处理一致;不要合并(入口区分对未来场景过滤有用)
- **统一 tool permission 链路(只有一套机制)** → [event.ts](src/common/event.ts) / [flowRunState.ts](src/common/flowRunState.ts):AskUserQuestion / CompleteTask(require_confirm) / ExitPlanMode / must_confirm 四类"挂起等待确认"共用一个 `pendingToolPermissions` 队列、一个 `awaiting-tool-permission` phase、一对 `toolPermissionRequest`/`toolPermissionResult` 事件、一个 `answerToolPermission(toolUseId, allow, opts?)` 方法。canUseTool 里各工具"是否/如何挂起"的决策保留(工具固有语义),挂起/回答走统一通道;只在 webview 渲染(卡片/状态标签)与通知文案层面按 toolName 特殊处理(AskUserQuestion 回答 = allow + updatedInput;CompleteTask 拒绝 = deny + message=reason);run 结束时未回答的 pending 权限由 `clearPendings` 自动标记为拒绝(allow=false),UI 卡片展示已拒绝状态
- **工具类型判定一律 `.includes()`** → MCP 工具 toolName 三处表示不一致:canUseTool 收 `mcp__AgentControllerMcp__X`、buildRenderItems 算成 `AgentControllerMcp::X`(`ToolUseDetails.parseToolName` 依赖,不要改)、webview 卡片路由。所有按工具类型分流的判定一律 `.includes('CompleteTask'/'ExitPlanMode'/'AskUserQuestion')`(对两种格式都成立),禁止 `=== 'ExitPlanMode'`(与 `::` 格式永不相等)
- **webview load 时 flow 合并保留有消息的 flow** → [src/extension/index.ts](src/extension/index.ts) load 分支:加载时磁盘 flows 为基准;内存中存在但磁盘不存在的 flow,若该 flow 有消息记录(`state.runs.some(r => r.messages.length > 0)`)则追加保留,否则丢弃;防止用户编辑磁盘配置后正在对话的 flow 被无谓丢失

### 消息流与 Executor 生命周期

- **stream_event 固化即清理** → [reducer](src/common/flowRunState.ts) `stripStreamEvents` + [buildRenderItems](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts):reducer 在 aiMessage(assistant/result)/agentComplete(completed)/agentInterrupted 分支删除该 run 全部 stream_event(打字机片段被完整内容取代后永久冗余,不清理会无限堆积撑爆 extension/webview 两端内存);流式中 assistant 未到达不清理,片段照常供打字机消费。删除会让 msgs 下标漂移,故 buildRenderItems 增量扫描不以下标为锚、改以 `lastNonStreamScanned`(已固化非 stream_event 消息计数,对 strip 免疫)定位:每次弹掉尾部 streaming 占位,再按非 se 计数前向跳过已固化区定位扫描起点;流式占位用稳定 per-kind key(`streaming-text`/`streaming-thinking`)避免重挂闪烁
- **CompleteTask.content 作为 next agent 首条消息回显** → [reducer agentComplete 分支](src/common/flowRunState.ts):创建新 `AgentRun` 时 `messages` 预置一条 user `aiMessage`(content = `nextAgent.no_input || currentAgent.no_output ? '执行任务' : data.content`),与 `FlowRunner.doOnCompleteTask` 喂 SDK 的 `nextInitMessage` 同源,改链路两端同改
- **CompleteTask 后 SDK result 不走 onMessage** → [ClaudeExecutor / FlowRunner / reducer](src/common/flowRunState.ts):CompleteTask 已暂存时跳过该 result onMessage,通过 onComplete 上抛;reducer 不单独包成 aiMessage(result 挂 `agentComplete.data.result` 随 signal 进 messages),buildRenderItems 在 agentComplete 分支调 `applyResultToCache(data.result)` 取 token,不走 result 分支;原因是避免 phase 误切到 result 触发"生成完毕"通知
- **CompleteTask result 缓存与"完成前确认"正交** → [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):`pendingCompleteResult` + `interruptAndAwaitResult`(保证 token 统计完整)是 CompleteTask 固有逻辑,**绝不改动**;require_confirm 的"完成前确认"走统一 tool permission 挂起,二者独立,不要混改
- **shareValues 是 prompt 快照** → [FlowRunner.doOnCompleteTask](src/extension/FlowRunnerManager/FlowRunner/index.ts):切下一 agent 时手动 `{ ...getLatestShareValues(), ...result.values }` 拼快照,否则 nextAgent systemPrompt 看到旧值
- **ClaudeExecutor 路由由 FlowRunner 承担** → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts):用 `executors.get(runId)` 寻址,Executor 不持有 runId/agentId;回调闭包用 `executors.get(runId) !== getExecutor()` 判定过期避免污染新 run
- **ClaudeExecutor 启动模式 `eager` / `lazy`** → [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):构造函数 `(mode, getOptions)`;eager 构造时调 `init()`(仅缓存 prompt 快照 + resumeSessionId)+ createQuery;lazy 用于 fork,首次 `ensureInit` / `createQuery` 时才调。**运行时重取 agent**:canUseTool / createQuery 每次调 `getOptions()` 取最新 agent / events,运行中改 agent 配置(work_mode / must_confirm_tools / deny_tools / outputs / model)立即生效;仅 system prompt 是 `init()` 一次性快照
- **CodeExecutor 与 ClaudeExecutor 同构** → [CodeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts):`node_type='code'` 时 FlowRunner.runAgent 分流 CodeExecutor;函数签名 `async function (input, values, runCommand)`,入参 `input` = 上游 CompleteTask.content / no_input 时为 `'执行任务'`,`values` = 完整 shareValues(全量读,不受 allowed_read_values_keys 约束),`runCommand` = `async (command: string, timeout?: number) => Promise<string>`(在 VSCode workspaceFolder 下执行 shell 命令,返回 stdout+stderr;timeout 单位毫秒,默认 600000 即 10 分钟);返回 `{ output_name?, content?, values? }` 直接驱动下一跳;values 仅提交代码显式修改的 key（delta 合并到 shareValues，不受 allowed_write_values_keys 约束）;严格只产出 agentComplete 信号 —— 不发 assistant 文本气泡 / 不发 result onMessage,成功路径只挂 onComplete.resultMessage 供 token 统计,错误路径走 logError + onError 切 error 终态;不挂 MCP / 不走 SDK / 不支持作 fork 起点(spawnForFork 校验拒绝)。**中断/结束**:interrupt→CodeExecutor 标记 disposed 并 fire onError 切 `error` 终态(不发 agentInterrupted —— interrupted 是非终态,code 节点 sendUserMessage 是 noop 无法续轮会卡死,FlowRunner.handleInterrupt 对 code 节点 early return);kill→disposed + reducer killed=true 切 `stopped`;两者都靠 run 内多处 `if (this.disposed) return` 吞掉后续 onComplete,阻止跳下一节点与完成卡片(disposed 标记前的极小竞态无法避免)
- **ChatDrawer 向 code 节点发送富文本前必须确认** → [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx):effectiveAgent.node_type='code' 且 content 是含非 text 块的数组时,弹 Modal 确认,用户确认后仅提取 text 块拼接为字符串再发送(避免用户误以为图片/附件可被代码节点处理)
- **FlowRunner 不持有 Flow 字段,统一通过 `getLatestFlow()` 取** → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts) / [FlowRunnerManager.createRunner](src/extension/FlowRunnerManager/index.ts):webview save 命令整体替换 `currentFlows` 后,持有 fork 时刻快照会读到过时 agents / shareValuesKeys;FlowRunner 内 findAgentById / shareValueKeys 的所有读取链路都走 `getLatestFlow()` 回调,与 `getLatestShareValues` 设计一致
- **ChatDrawer 和 ChatInput 必须始终挂载** → [App.tsx](src/webview/App.tsx):为保证 insertSelection 事件在 webview 不可见时也能被接收,ChatDrawer / ChatInput 不可按条件销毁重建;ChatPanel 内部仍按 key 切换 unmount(两者正交)

### Fork 链路

- **fork 走 handleFork 路径** → [handleFork](src/extension/index.ts):`setRunState` + `spawnForFork` 起 FlowRunner + lazy executor → 发 `flow.signal.fork`;webview push 新 Flow / 切 active / 打开 ChatDrawer。用户首次发消息走 `sendUserMessage` 不经 `flowStart`。fork target 仅 `kind: 'message'`(SDK 不支持 askUserQuestion 作 fork 终点)
- **fork target 带 runId 不带 agentId** → `flow.command.fork.target = { kind: 'message', runId, messageUuid }`:webview RenderItem 知道自己属于哪个 run(MessageList 按 run 维度遍历),extension `locateFork` 单 loop 按 runId 查;`flow.signal.fork` 也只带 runId,webview 从 `newRunState.runs.at(-1).agentId` 反推
- **fork 切片 uuid 用双 transcript 映射** → [handleFork](src/extension/index.ts):并发取源 session 与新 session transcript,按位置建 `srcUuid→newUuid` 映射,替换 slicedMessages 中所有带 uuid 的 SDK 消息;不再用 webview 序列顺序对齐(webview echo 无 uuid 会错位),否则二次 fork 报 `Message <uuid> not found`
- **findPrevUuid 必须排除 stream_event uuid** → [buildRenderItems.findPrevUuid](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts):仅放行 SDKUserMessage / SDKUserMessageReplay / SDKAssistantMessage,误命中 stream_event uuid 会让 forkSession 报 `Message <uuid> not found`
- **来自 subAgent 的 tooluse 不能 fork** → [buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts):subAgent 消息中的 tooluse 块不渲染 fork 按钮,防止 fork 到无法寻址的消息位置
- **ChatPanel 跨 Flow / 跨 run 切换必须 unmount** → [ChatDrawer](src/webview/components/ChatDrawer/index.tsx):给 ChatPanel 加 `key={`${flowId}-${agentId}-${runId ?? ''}`}`,避免 AskUserQuestionCard selections / motion.div ask-card key 在新旧 Flow / run 间被复用(fork 出的新 Flow 与源 Flow toolUseId 实际相同,SDK forkSession 不 remap)
