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

领域定义与校验在 [src/common/index.ts](src/common/index.ts)。Flow 定义按作用域持久化到 `.agent-flows.json`：全局（`os.homedir()`）和项目（workspace root）；`FlowRunState` 仅内存，运行态写入 workspaceStore（`~/.agent-flows-projects/<sanitized_cwd>.json` 的 `runStates` 字段）用于崩溃恢复,extension 端 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像;UI 状态仅 webview。

## Extension ↔ Webview 事件契约

事件定义见 [src/common/event.ts](src/common/event.ts)。`flow.command.*` = webview → extension,`flow.signal.*` = extension → webview。`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

标识符：

- `flowId` —— Flow 主键
- `runId` —— 一次 Agent 运行的主键,所有载荷以此寻址。来源:`flowStart` 由 webview 生成,`next_agent` / `fork` 由 extension 生成
- `sessionId` —— Claude SDK session id,挂在 `AgentRun.sessionId`,每切 Agent 换一次;不出现在事件载荷上,由 `aiMessage` 内 SDK 原生 `session_id` 回填

## 单一 reducer

[updateFlowRunState](src/common/flowRunState.ts) 是 Flow 运行态唯一 reducer,signal / command 两条路径上 extension 与 webview 各 reduce 一次,共用同一份保证两端同步。webview 镜像在 [useFlowStore](src/webview/store/flow.ts),extension 镜像在 [FlowRunStateManager](src/extension/FlowRunStateManager.ts)。

`FlowPhase` / `AgentPhase` 同构:`idle | starting | running | result | interrupted | awaiting-tool-permission | completed | stopped | error`,共用 `aggregatePhase(runs)` 按 run 追加顺序跟随末位 run。Phase 不存字段,由 [getRunPhase / getAgentPhase / getFlowPhase](src/common/flowRunState.ts) 推断。

`FlowRunState` 数据结构、`MessageEffect` 4 个 reason(`result` / `awaiting-tool-permission` / `flow-completed` / `agent-error`)、终态守卫见 [flowRunState.ts](src/common/flowRunState.ts) 顶部注释。`run.messages` 是累加态 `ChatMessage[]`（TextMessage / ThinkingMessage / ToolUseMessage / UserMessage / TurnEndMessage / AgentCompleteMessage / ErrorMessage），`appendSdkMessage()` 把 SDK 流式信号转换累加，不存原始 SDK signals；累加模型细节见 [flowRunState.ts](src/common/flowRunState.ts) 顶部注释。

## 运行时层级

extension:[FlowRunnerManager](src/extension/FlowRunnerManager/index.ts)(全局,`Map<flowId, FlowRunner>`) → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts)(一个 Flow,`Map<runId, ClaudeExecutor | CodeExecutor>`,本期 `size <= 1`) → 按 `agent.node_type` 分流:`agent` 走 [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts)(封装 SDK `query`),`code` 走 [CodeExecutor](src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts)(把 `agent.code` 当 `async function (input, values, runCommand, cwd)` 函数体执行,不走 SDK)。**路由职责由 FlowRunner 承担**:executors 按 runId 寻址;Executor 自身不持有 runId/agentId。FlowRunnerOptions 三个回调:`getLatestShareValues`（FlowRunState.shareValues）/ `getLatestFlow`（当前 Flow 定义）/ `getLatestCwd`（FlowRunState.cwd，透传给用户代码的 `cwd` 参数来源；runCommand 本身始终在 VSCode workspace root 执行）—— 均由 FlowRunnerManager.createRunner 在 flowId 闭包内绑定,FlowRunner 实时读不缓存。per-Agent MCP server 在 [src/common/extension.ts](src/common/extension.ts):`CompleteTask`(chat 不挂) / `validateFlow` / `getFlowJSONSchema`,task / silent_task 多挂 `TerminateTask`,`plan_mode=true` 时以 `permissionMode: 'plan'` 传 SDK,SDK 自动内置 `ExitPlanMode`（不在 buildAgentMcpServer 追加）。AskUserQuestion / CompleteTask(require_confirm) / ExitPlanMode / must_confirm 工具的"挂起等待确认"统一走 canUseTool → `toolPermissionRequest` 信号(见「易踩坑」的统一 tool permission 条)。`subAgent` 不挂 `AgentControllerMcp`（禁止 subAgent 通过 CompleteTask / TerminateTask 干扰宿主 Flow 控制链路）。

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

## 双存储（全局 + 项目级 Flow）

Flow 分三个持久化文件：全局（`~/.agent-flows.json`）、工作区（`~/.agent-flows-projects/<sanitized_cwd>.json`）、项目（`<workspaceRoot>/.agent-flows.json`，只读兼容旧版）。

- `Flow.project?: boolean` 是内存/UI 标记，标识 flow 属于项目作用域；不持久化进磁盘 flows 数组（见易踩坑「`project` 字段不入库」）
- `~/.agent-flows.json`：只保存全局 flows（不再写 `workspaceRunStates`）
- `~/.agent-flows-projects/<sanitized_cwd>.json`（workspaceStore）：保存项目 flows + 全量 runStates（含全局 flow 在该 cwd 的运行记录，不区分 flow 来源）→ [src/extension/index.ts](src/extension/index.ts)
- 读取规则：load 时并行加载 globalStore + workspaceStore；workspaceStore 不存在（null）则 fallback 读 projectStore 的 flows（runStates 视为空）
- **默认 flow 注入时机**：全局与项目 flows 同时为空（文件不存在、合法 `{"flows":[]}` 均视为空）时才将 `defaultStore.flows` 作为全局 flows 注入；任一侧有 flow 则不注入
- [PersistedDataController](src/extension/PersistedDataController/index.ts) 的 `globalStore()` / `projectStore(root)` 处理 `PersistedData`；[WorkspacePersistedDataController](src/extension/PersistedDataController/index.ts) 的 `workspaceStore(cwd)` 处理 `WorkspacePersistedData`，路径经 sanitizeCwd 转义（替换路径分隔符/非法字符为 `-`）
- 克隆/粘贴产生的新 flow 自动标 `project: true`；fork 继承源 flow 的 `project` 值（全局 flow fork → 无 project，项目 flow fork → project:true）
- 项目 flows 在 [FlowListPanel](src/webview/components/FlowListPanel/index.tsx) 展示时，有项目 flow 则在其区域上方渲染"文件夹图标 + 项目flow"分割线标题

## 易踩坑(硬约束,不要回退)

每条「标题 → 文件 → 一句话约束」,具体语义看对应代码注释。**只收录涉及核心链路的硬约束**;实现细节在代码注释里。

### 状态机与命令派发

- **handleCommand 必须 `keyof` + `.exhaustive()`** → [FlowRunnerManager.handleCommand](src/extension/FlowRunnerManager/index.ts):分支写完整 `flow.command.*`,不要 `.otherwise`(短名错配会静默吞 → executor 残留烧 token / interrupt 失效)
- **killFlow / clearFlow / flowStart 语义对照** → [flowRunState.ts](src/common/flowRunState.ts) `killFlow` / `clearFlow` / `flowStart` 分支:killFlow 保留 messages / shareValues 并投影 stopped;clearFlow 返回 undefined 彻底清空;flowStart 追加新 run 并保留 messages / shareValues / **cwd**;shareValues 仅在 phase→completed 时清空，**cwd 随 flow-completed 同步清空**;clearFlow 仍删除整个 runState（包含 cwd）；`flow.signal.agentComplete` 携带 `cwd` 时（非 `undefined`）原样写入 `draft.cwd`（含 `null`/空串）；省略/`undefined`→不变（沿用当前 cwd）；使用时 `null`/空串/`undefined` 统一回退默认工作区；ClaudeExecutor 触发的 agentComplete 不携带 cwd，故 Claude agent 完成不影响 cwd
- **cwd 仅存 FlowRunState，禁止写入 Flow 定义** → [FlowEditor](src/webview/components/FlowEditor/index.tsx) / [useFlowStore.setCwd](src/webview/store/flow.ts)：FlowEditor `onValuesChange` 实时调 `setCwd` → `flow.command.setCwd` 双路更新（webview reducer + postMessage），`handleFinish` 的 `save()` draft 不写 cwd；FlowRunner 通过 `getLatestCwd()` 回调实时取，无则回退 workspaceFolder；extension 收到 `setCwd` 命令后与 `killFlow`/`clearFlow` 同路径设置 `pendingProjectStatePersist=true` 并 flush，确保 cwd 写入 workspaceStore.runStates；**setCwd 收到空字符串时 reducer 等同 null 清空（`delete base.cwd`），UI 清空输入即回退"默认工作区"**
- **interrupted 仅末位活跃 run 可恢复** → [getRunPhase](src/common/flowRunState.ts):`interrupted` phase 仅当 run 是 `runs.at(-1)` 时返回,表示用户可继续追问恢复;被后续 `flowStart` 替代的非末位 interrupted run 投影为 `stopped`,不再可恢复;自动 `agentComplete → next_agent` 不受影响(旧 run 优先返回 `completed`)

- **store 命令派发必须传 runId** → [useFlowStore](src/webview/store/flow.ts):`sendUserMessage` / `interruptAgent` / `answerToolPermission` 调用方明确传 `runId`,store 不做"末位非终态 run 回退"(多 run 会乱派发);ChatDrawer 用 `activeRunId`、answerToolPermission 按 toolUseId 反查 `pendingToolPermission.runId`
- **`flow.signal.toolPermissionResult` 与 `flow.command.toolPermissionResult` 同语义** → silent_task 自动应答走 signal(不 pushEffect),人工回答走 command,reducer 两条分支处理一致;不要合并(入口区分对未来场景过滤有用)
- **统一 tool permission 链路(只有一套机制)** → [event.ts](src/common/event.ts) / [flowRunState.ts](src/common/flowRunState.ts):AskUserQuestion / CompleteTask(require_confirm) / ExitPlanMode / must_confirm 四类"挂起等待确认"共用一个 `pendingToolPermissions` 队列、一个 `awaiting-tool-permission` phase、一对 `toolPermissionRequest`/`toolPermissionResult` 事件、一个 `answerToolPermission(toolUseId, allow, opts?)` 方法。preToolUseHook 里各工具"是否/如何挂起"的决策保留(工具固有语义),挂起/回答走统一通道;只在 webview 渲染(卡片/状态标签)与通知文案层面按 toolName 特殊处理(AskUserQuestion 回答 = allow + updatedInput;CompleteTask 拒绝 = deny + message=reason);run 结束时未回答的 pending 权限由 `clearPendings` 自动标记为拒绝(allow=false),UI 卡片展示已拒绝状态
- **preToolUseHook 三级决策链** → [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):deny_tools（`matchToolRule` 黑名单，任一子命令命中即拒绝）→ 特殊工具(AskUserQuestion/CompleteTask require_confirm/ExitPlanMode) → must_confirm_tools（`matchToolRule`，silent_task 自动拒绝，其余挂起）→ `{ continue: true }` 交 Claude Code 自身权限体系 → `canUseTool` 兜底全部放行；`matchTool`（白名单语义，所有子命令匹配）保留备用，`matchToolRule`（黑名单语义，任一子命令匹配）用于 deny/must_confirm，两函数共用 `matchToolImpl`
- **工具类型判定一律 `.includes()`** → MCP 工具 toolName 三处表示不一致:canUseTool 收 `mcp__AgentControllerMcp__X`、ToolUseDetails.tsx 的 parseToolName 算成 `AgentControllerMcp::X`（不要改）、webview 卡片路由。所有按工具类型分流的判定一律 `.includes('CompleteTask'/'ExitPlanMode'/'AskUserQuestion')`(对两种格式都成立),禁止 `=== 'ExitPlanMode'`(与 `::` 格式永不相等)
- **webview load 时 flow 合并保留有消息的 flow** → [src/extension/index.ts](src/extension/index.ts) load 分支:加载时磁盘 flows 为基准;内存中存在但磁盘不存在的 flow,若该 flow 有消息记录(`state.runs.some(r => r.messages.length > 0)`)则追加保留,否则丢弃;防止用户编辑磁盘配置后正在对话的 flow 被无谓丢失
- **`project` 字段不入库** → [stripFlowRuntimeFields](src/common/index.ts) / [extension save handler](src/extension/index.ts):保存前必须调 `stripFlowRuntimeFields` 剥除 `project`;extension save handler 按此字段路由到不同文件;`LiteFlow`(GetFlowJSONSchema) 不含 `project`,AI 无法设置

### 权限卡片与 tool_use 气泡展示规则

[MessageBubble.tsx chatMessageToBubble](src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) `case 'tool_use'` 分支对四类特殊工具(Edit / ExitPlanMode / AskUserQuestion / CompleteTask)的渲染规则:

- **pending 阶段一律底部卡片**:isPending 时消息队列返回 null,由底部固定卡片渲染;CompleteTask 例外 —— pending 确认卡片直接挂在消息队列内
- **失败且无 answered = 系统自动拒绝**:展示为 defaultToolUseItem(tool_use 气泡),不展示权限卡片;此时气泡可挂 fork(Edit/CompleteTask)
- **成功或用户已回答 = 权限卡片**:ToolPermissionCard historical 模式,answered 从 `answeredToolPermissions` 取,loading = 已回答但 result 未到达
- **AskUserQuestion 更严格**:必须 `answered` 存在才渲染历史卡片(它是唯一强制用户交互的 tool);answered 来源 = 用户手动选择 / silent_task 自动应答事件(`flow.signal.toolPermissionResult`);无 answered 时(系统自动拒绝)返回 null 不渲染

### 消息流与 Executor 生命周期

- **CompleteTask.content 作为 next agent 首条消息回显** → [reducer agentComplete 分支](src/common/flowRunState.ts):创建新 `AgentRun` 时 `messages` 预置一条 user `aiMessage`(content = `nextAgent.no_input || currentAgent.no_output ? '执行任务' : data.content`),与 `FlowRunner.doOnCompleteTask` 喂 SDK 的 `nextInitMessage` 同源,改链路两端同改
- **CompleteTask 后 SDK result 不走 onMessage** → [ClaudeExecutor / FlowRunner / reducer](src/common/flowRunState.ts):CompleteTask 已暂存时跳过该 result onMessage,通过 onComplete 上抛;reducer 在 agentComplete 分支取 data.result 只更 acc（token 累计）、不 push turn_end（避免 phase 误切 result 触发"生成完毕"通知），session 累计 breakdown 写入 agent_complete ChatMessage
- **CompleteTask result 缓存与"完成前确认"正交** → [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):`pendingCompleteResult` + `interruptAndAwaitResult`(保证 token 统计完整)是 CompleteTask 固有逻辑,**绝不改动**;require_confirm 的"完成前确认"走统一 tool permission 挂起,二者独立,不要混改
- **shareValues 是 prompt 快照** → [FlowRunner.doOnCompleteTask](src/extension/FlowRunnerManager/FlowRunner/index.ts):切下一 agent 时手动 `{ ...getLatestShareValues(), ...result.values }` 拼快照,否则 nextAgent systemPrompt 看到旧值
- **ClaudeExecutor 路由由 FlowRunner 承担** → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts):用 `executors.get(runId)` 寻址,Executor 不持有 runId/agentId;回调闭包用 `executors.get(runId) !== getExecutor()` 判定过期避免污染新 run
- **ClaudeExecutor 启动模式 `eager` / `lazy`** → [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):构造函数 `(mode, getOptions)`;eager 构造时调 `init()`(仅缓存 prompt 快照 + resumeSessionId)+ createQuery;lazy 用于 fork 和崩溃恢复,首次 `ensureInit` / `createQuery` 时才调。**运行时重取 agent**:canUseTool / createQuery 每次调 `getOptions()` 取最新 agent / events,运行中改 agent 配置(work_mode / must_confirm_tools / deny_tools / outputs / model)立即生效;仅 system prompt 是 `init()` 一次性快照
- **CodeExecutor 与 ClaudeExecutor 同构** → [CodeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts):`node_type='code'` 时 FlowRunner.runAgent 分流 CodeExecutor;函数签名 `async function (input, values, runCommand, cwd)`,入参 `input` = 上游 CompleteTask.content / no_input 时为 `'执行任务'`,`values` = 完整 shareValues(全量读,不受 allowed_read_values_keys 约束),`runCommand` = `async (command: string, timeout?: number) => Promise<string>`(**始终在 VSCode workspace root 执行**；如需在 cwd 路径执行，用户代码应在 command 内自行 `cd \"${cwd}\" && ...`（注意 shell 转义），timeout 单位毫秒,默认 600000 即 10 分钟),`cwd` = 当前工作目录字符串（与 runCommand 同源）;返回 `{ output_name?, content?, values?, **cwd?: string | null** }` 直接驱动下一跳，**返回 cwd string/null/空串时原样写入 FlowRunState.cwd；下一节点以 workspaceRoot 作为 cwd 参数（FlowRunner.runAgent 内 null/空串/undefined 均回退 workspaceRoot，不依赖 reducer 时序）；省略 cwd 时下一节点沿用 FlowRunState.cwd（若为 null/空串仍回退 workspaceRoot）**；values 仅提交代码显式修改的 key（delta 合并到 shareValues，不受 allowed_write_values_keys 约束）;严格只产出 agentComplete 信号 —— 不发 assistant 文本气泡 / 不发 result onMessage,成功路径只挂 onComplete.resultMessage 供 token 统计,错误路径走 logError + onError 切 error 终态;不挂 MCP / 不走 SDK / 不支持作 fork 起点(spawnForFork 校验拒绝)。**中断/结束**:interrupt→CodeExecutor 标记 disposed 并 fire onError 切 `error` 终态(不发 agentInterrupted —— interrupted 是非终态,code 节点 sendUserMessage 是 noop 无法续轮会卡死,FlowRunner.handleInterrupt 对 code 节点 early return);kill→disposed + reducer killed=true 切 `stopped`;两者都靠 run 内多处 `if (this.disposed) return` 吞掉后续 onComplete,阻止跳下一节点与完成卡片(disposed 标记前的极小竞态无法避免)
- **ChatDrawer 向 code 节点发送富文本前必须确认** → [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx):effectiveAgent.node_type='code' 且 content 是含非 text 块的数组时,弹 Modal 确认,用户确认后仅提取 text 块拼接为字符串再发送(避免用户误以为图片/附件可被代码节点处理)
- **FlowRunner 不持有 Flow 字段,统一通过 `getLatestFlow()` 取** → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts) / [FlowRunnerManager.createRunner](src/extension/FlowRunnerManager/index.ts):webview save 命令整体替换 `currentFlows` 后,持有 fork 时刻快照会读到过时 agents / shareValuesKeys;FlowRunner 内 findAgentById / shareValueKeys 的所有读取链路都走 `getLatestFlow()` 回调,与 `getLatestShareValues` 设计一致
- **ChatDrawer 和 ChatInput 必须始终挂载** → [App.tsx](src/webview/App.tsx):为保证 insertSelection 事件在 webview 不可见时也能被接收,ChatDrawer / ChatInput 不可按条件销毁重建;ChatPanel 内部仍按 key 切换 unmount(两者正交)

### Fork 链路

- **fork 走 handleFork 路径** → [handleFork](src/extension/index.ts):`setRunState` + `spawnForFork` 起 FlowRunner + lazy executor → 发 `flow.signal.fork`;webview push 新 Flow / 切 active / 打开 ChatDrawer。用户首次发消息走 `sendUserMessage` 不经 `flowStart`。SDK 不支持把 askUserQuestion 作 fork 终点
- **fork target 带 runId 不带 agentId** → `flow.command.fork.target = { runId, messageUuid }`:webview RenderItem 知道自己属于哪个 run(MessageList 按 run 维度遍历),extension `locateFork` 单 loop 按 runId 查;`flow.signal.fork` 也只带 runId,webview 从 `newRunState.runs.at(-1).agentId` 反推
- **fork 切片 uuid 用双 transcript 映射** → [handleFork](src/extension/index.ts):并发取源 session 与新 session transcript,按位置建 `srcUuid→newUuid` 映射,替换 slicedMessages 中所有带 uuid 的 SDK 消息;不再用 webview 序列顺序对齐(webview echo 无 uuid 会错位),否则二次 fork 报 `Message <uuid> not found`
- **deriveForkUuid 只取有 uuid 的消息** → [MessageBubble.deriveForkUuid](src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx):text/thinking/tool_use 取自身 uuid,user/turn_end 向前回溯到最近一条有 uuid 的消息;agent_complete/error 无 uuid,不能作 fork 锚点（返回 undefined 不显示 fork 按钮）;流式 status=streaming 的项 uuid 未定稿,不会被回溯命中
- **来自 subAgent 的 tooluse 不能 fork** → [MessageBubble.renderItemToBubble](src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx):subAgent 消息中的 tooluse 块不渲染 fork 按钮,防止 fork 到无法寻址的消息位置;检测子消息归属时必须确保当前 fork 的消息有 toolUseId,无 toolUseId 的消息不作 subAgent 判定
- **ChatPanel 跨 Flow / 跨 run 切换必须 unmount** → [ChatDrawer](src/webview/components/ChatDrawer/index.tsx):给 ChatPanel 加 `key={`${flowId}-${agentId}-${runId ?? ''}`}`,避免 AskUserQuestionCard selections / motion.div ask-card key 在新旧 Flow / run 间被复用(fork 出的新 Flow 与源 Flow toolUseId 实际相同,SDK forkSession 不 remap)

### 运行态恢复

- **恢复项目 flowRunStates 必须先归一化** → [normalizeRestoredFlowRunState](src/common/flowRunState.ts) / [extension/index.ts load 分支](src/extension/index.ts):运行态来源为 workspaceStore 文件的 `runStates` 字段（workspaceStore 不存在时为空）；加载磁盘快照后立即调 `normalizeRestoredFlowRunState`（`killed` 保留原值：killed=true 的 flow 恢复后仍显示 stopped，flowStart 时才重置；清 pendingToolPermissions、未完成 run 置 interrupted+清 acc.activeBlocks+调 markInterrupted）；再为最后一个 interrupted+有 sessionId 的 agent run 调 `runnerManager.spawnForRestore`；code 节点或无 sessionId 时跳过 runner 注册（不报错，仅保留中断态）
