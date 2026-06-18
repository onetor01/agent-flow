# extension 运行时

## 关键文件

- [`../src/extension/FlowRunnerManager/index.ts`](../src/extension/FlowRunnerManager/index.ts) — 全局 runner 管理与 command 分发。
- [`../src/extension/FlowRunnerManager/FlowRunner/index.ts`](../src/extension/FlowRunnerManager/FlowRunner/index.ts) — 单个 Flow 的运行控制与 next_agent 路由。
- [`../src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts`](../src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) — Claude SDK `query` 封装。
- [`../src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts`](../src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts) — code 节点执行器。
- [`../src/common/extension.ts`](../src/common/extension.ts) — per-Agent MCP server。

## 运行时层级

extension 运行时层级：

`FlowRunnerManager` → `FlowRunner` → `ClaudeExecutor | CodeExecutor`

- `FlowRunnerManager` 全局持有 `Map<flowId, FlowRunner>`。
- `FlowRunner` 按 `runId` 持有 `Map<runId, ClaudeExecutor | CodeExecutor>`，本期同一 Flow 内 `size <= 1`。
- `FlowRunner` 按 `agent.node_type` 分流：`agent` 走 ClaudeExecutor，`code` 走 CodeExecutor。
- 路由职责由 `FlowRunner` 承担，Executor 自身不持有 `runId` / `agentId`。

## FlowRunnerOptions

`FlowRunnerManager.createRunner` 在 `flowId` 闭包内绑定实时回调：

- `getLatestShareValues`：读取 `FlowRunState.shareValues`。
- `getLatestFlow`：读取当前 Flow 定义。
- `getLatestCwd`：读取 `FlowRunState.cwd`。
- `getRunSnapshot`：读取指定 run 的 `AgentRun.shareValuesSnapshot`，供 fork / restore 的 lazy executor 复现源 run 的 shareValues 快照。
- `getRunOverwrite`：读取指定 run 的 `AgentRun.overwrite`，供 fork / restore 的 lazy executor 复现源 run 的临时改写配置。

`FlowRunner` 不缓存 Flow 字段；查 agent、shareValueKeys、cwd、fork / restore 快照时走回调取最新值。

## ClaudeExecutor

- 构造函数 `(mode, getOptions)`。
- `eager`：构造时 `init()`，缓存 system prompt 快照与 `resumeSessionId`，并创建 query。
- `lazy`：用于 fork 和崩溃恢复，首次 `ensureInit` / `createQuery` 时初始化。
- `canUseTool` / `createQuery` 每次通过 `getOptions()` 取最新 agent / events；运行中修改 `work_mode`、`must_confirm_tools`、`deny_tools`、`outputs`、`model` 立即参与决策。
- system prompt 是 `init()` 时点快照。

## CompleteTask

- `CompleteTask.content` 是 next agent 首条 user 消息来源；no_input 或 content 为空时，首条引导由 common 的 `buildNoInputInitMessage(agent)` 按 `work_mode` 生成，extension/reducer/webview 同源：`task`/`silent_task` → 有 agent_prompt 执行 `<task_description>`，无则按系统提示开始执行；`chat` → 依据对话规则开始对话；code 节点 → `执行任务`。
- CompleteTask 已暂存时，SDK result 不走 `onMessage`，由 `onComplete` 上抛给 reducer 累计 token。
- `pendingCompleteResult` + `interruptAndAwaitResult` 是 CompleteTask 固有逻辑，用于保证 token 统计完整，**绝不改动**；require_confirm 的完成前确认与之正交，不要混改。
- require_confirm 的完成前确认走统一 tool permission 链路，详见 [tool-permission.md](tool-permission.md)。
- 切下一 agent 时手动 `{ ...getLatestShareValues(), ...result.values }` 拼接 prompt 快照，详见 [share-values.md](share-values.md)。

## CodeExecutor

`node_type='code'` 时，FlowRunner.runAgent 分流到 CodeExecutor。`agent.code` 存储完整的 async function 表达式：

```ts
async function run(input, values, runCommand, cwd, askUserQuestion, vscode) { /* body */ }
```

CodeExecutor 通过 `new Function('return (...)')()` 求值后调用。

代码编辑器的 JSDoc 类型声明由 common 层 `buildCodeJSDoc(shareValueKeys, outputs)` 统一生成，extension 临时 `.js` 文件头与 webview 只读展示共用同一函数。webview 右侧面板以独立 `JsDocDisplay` 块展示 JSDoc（Shiki 渲染），下方 `CodeEditor` 传 `hideJSDoc` 跳过内部 JSDoc 拼接，两者分区滚动。

参数：

- `input`：`msg.message?.content`，类型为 `string | ContentBlockParam[]`，直接透传原始富文本内容。
- `values`：完整 shareValues，全量可读。
- `runCommand`：`async (command: string, timeout?: number) => Promise<string>`，始终在 VSCode workspace root 执行；如需在 cwd 路径执行，用户代码须自行 `cd "${cwd}" && ...`（注意 shell 转义）；timeout 默认 600000 毫秒（10 分钟）。
- `cwd`：`FlowRunState.cwd`，未设置时为 `undefined`。
- `askUserQuestion`：`async (questions: AskItem[]) => Promise<string[][]>`，向用户异步提问；每个问题返回一个答案数组，用户拒绝时返回空数组；内部复用统一 tool permission 请求 / 回答事件，interrupt / kill 时 reject 异常，调用方需自行 catch。
- `vscode`：VSCode API，可直接调用 extension 宿主侧 `vscode` 模块能力。

返回值 `{ output_name?, content?, values?, cwd?: string | null, overwrite? }` 直接驱动下一跳：

- `values` 仅提交代码显式修改的 key，delta 合并到 shareValues。
- 返回 `cwd` string / null / 空串时原样写入 FlowRunState；省略时沿用当前值。
- `overwrite` 为 `AgentOverwrite` 对象，临时改写下一个 agent 节点的 `work_mode` 与 `outputs[].require_confirm`，仅本次运行生效；CodeExecutor 用 `AgentOverwriteSchema.safeParse` 校验，校验失败时降级为 `undefined`；FlowRunner 在下一 agent 的 ClaudeExecutor `getOptions` 闭包内经 `applyAgentOverwrite` 应用。
- 下一 code 节点收到 null / 空串时按 `undefined` 处理。
- 下一 claude 节点收到 null / 空串 / `undefined` 时回退 workspace root。
- 上述按 node_type 的回退分流在 `FlowRunner.runAgent` 内完成，**不依赖 reducer 时序**。

CodeExecutor 严格只产出 `agentComplete` signal：不发 assistant 文本气泡，不发 result onMessage，不挂 MCP，不走 SDK，不支持作 fork 起点。

中断与结束：

- interrupt：CodeExecutor 标记 disposed、调用 `rejectAllPendingPermissions` 清理所有挂起的 `askUserQuestion` Promise（reject 异常），并 fire onError，进入 `error` 终态。**不发 agentInterrupted** —— interrupted 是非终态，code 节点 `sendUserMessage` 是 noop 无法续轮会卡死，故 `FlowRunner.handleInterrupt` 对 code 节点 early return。
- kill：disposed + `rejectAllPendingPermissions` + reducer `killed=true`，进入 `stopped`。
- disposed 后的 onComplete 被吞掉，阻止跳下一节点与完成卡片。

## work_mode

仅 `node_type='agent'` 节点适用。可被上游 code 节点返回的 `overwrite.work_mode` 临时改写，改写仅影响当次 run，不修改 Flow 定义：

- `task`：常规推进；系统提示词注入任务描述、完成任务、输出分支；AskUserQuestion **允许**、CompleteTask **必须**、TerminateTask **极端情况下可中止任务**。
- `chat`：长期对话；CompleteTask 不挂载，可写 values 节不注入，`agent_prompt` 视为长期规则。
- `silent_task`：无人值守；result 自动续轮，暴露 TerminateTask；各工具的自动应答 / 接受 / 拒绝明细详见 [tool-permission.md](tool-permission.md)。AgentEditor 首次切换到 silent_task 弹 warning。

silent_task 自动回复（自动续轮 + AskUserQuestion 自动应答 + ExitPlanMode 自动接受 + must_confirm 自动拒绝）受 `SILENT_MAX_AUTO_REPLIES`（默认 30）per-run 上限约束，超过 fire onError 推 agent-error 终态；SDK `maxTurns=60` 作双重兜底。`pushEffect` 过滤白名单只放行 `agent-error`、`flow-completed`、命中 `CompleteTask(require_confirm)` 或 `ExitPlanMode` 确认的 `awaiting-tool-permission`。

## MCP server

per-Agent MCP server 由 [`../src/common/extension.ts`](../src/common/extension.ts) 构建：

- `CompleteTask`：chat 不挂载。
- `TerminateTask`：task / silent_task 挂载。
- `validateFlow`
- `getFlowJSONSchema`：暴露 Flow JSON Schema，`agents` 仅含 `LiteAgent`（`node_type='agent'` 节点），Code 节点 schema 不对 AI 暴露。
- `ReadShareValue`：仅 agent、有大值 key 时挂载；从 `init()` 时点快照只读。

`plan_mode=true` 时以 `permissionMode: 'plan'` 传 SDK，SDK 内置 ExitPlanMode。subAgent 不挂 `AgentControllerMcp`，禁止 subAgent 通过 CompleteTask / TerminateTask 干扰宿主 Flow 控制链路。
