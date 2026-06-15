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

`FlowRunnerManager.createRunner` 在 `flowId` 闭包内绑定三个实时回调：

- `getLatestShareValues`：读取 `FlowRunState.shareValues`。
- `getLatestFlow`：读取当前 Flow 定义。
- `getLatestCwd`：读取 `FlowRunState.cwd`。

`FlowRunner` 不缓存 Flow 字段；查 agent、shareValueKeys、cwd 时走回调取最新值。

## ClaudeExecutor

- 构造函数 `(mode, getOptions)`。
- `eager`：构造时 `init()`，缓存 system prompt 快照与 `resumeSessionId`，并创建 query。
- `lazy`：用于 fork 和崩溃恢复，首次 `ensureInit` / `createQuery` 时初始化。
- `canUseTool` / `createQuery` 每次通过 `getOptions()` 取最新 agent / events；运行中修改 `work_mode`、`must_confirm_tools`、`deny_tools`、`outputs`、`model` 立即参与决策。
- system prompt 是 `init()` 时点快照。

## CompleteTask

- `CompleteTask.content` 是 next agent 首条 user 消息来源；`no_input` 或 `no_output` 时使用 `执行任务`。
- CompleteTask 已暂存时，SDK result 不走 `onMessage`，由 `onComplete` 上抛给 reducer 累计 token。
- `pendingCompleteResult` + `interruptAndAwaitResult` 是 CompleteTask 固有逻辑，用于保证 token 统计完整，**绝不改动**；require_confirm 的完成前确认与之正交，不要混改。
- require_confirm 的完成前确认走统一 tool permission 链路，详见 [tool-permission.md](tool-permission.md)。
- 切下一 agent 时手动 `{ ...getLatestShareValues(), ...result.values }` 拼接 prompt 快照，详见 [share-values.md](share-values.md)。

## CodeExecutor

`node_type='code'` 时，FlowRunner.runAgent 分流到 CodeExecutor。CodeExecutor 把 `agent.code` 当以下函数体执行：

```ts
async function (input, values, runCommand, cwd) {}
```

参数：

- `input`：`msg.message?.content`，类型为 `string | ContentBlockParam[]`，直接透传原始富文本内容。
- `values`：完整 shareValues，全量可读。
- `runCommand`：`async (command: string, timeout?: number) => Promise<string>`，始终在 VSCode workspace root 执行；如需在 cwd 路径执行，用户代码须自行 `cd "${cwd}" && ...`（注意 shell 转义）；timeout 默认 600000 毫秒（10 分钟）。
- `cwd`：`FlowRunState.cwd`，未设置时为 `undefined`。

返回值 `{ output_name?, content?, values?, cwd?: string | null }` 直接驱动下一跳：

- `values` 仅提交代码显式修改的 key，delta 合并到 shareValues。
- 返回 `cwd` string / null / 空串时原样写入 FlowRunState；省略时沿用当前值。
- 下一 code 节点收到 null / 空串时按 `undefined` 处理。
- 下一 claude 节点收到 null / 空串 / `undefined` 时回退 workspace root。
- 上述按 node_type 的回退分流在 `FlowRunner.runAgent` 内完成，**不依赖 reducer 时序**。

CodeExecutor 严格只产出 `agentComplete` signal：不发 assistant 文本气泡，不发 result onMessage，不挂 MCP，不走 SDK，不支持作 fork 起点。

中断与结束：

- interrupt：CodeExecutor 标记 disposed 并 fire onError，进入 `error` 终态。**不发 agentInterrupted** —— interrupted 是非终态，code 节点 `sendUserMessage` 是 noop 无法续轮会卡死，故 `FlowRunner.handleInterrupt` 对 code 节点 early return。
- kill：disposed + reducer `killed=true`，进入 `stopped`。
- disposed 后的 onComplete 被吞掉，阻止跳下一节点与完成卡片。

## work_mode

仅 `node_type='agent'` 节点适用：

- `task`：常规推进；系统提示词注入任务描述、完成任务、输出分支；AskUserQuestion **允许**、CompleteTask **必须**、TerminateTask **极端情况下可中止任务**。
- `chat`：长期对话；CompleteTask 不挂载，可写 values 节不注入，`agent_prompt` 视为长期规则。
- `silent_task`：无人值守；result 自动续轮，暴露 TerminateTask；各工具的自动应答 / 接受 / 拒绝明细详见 [tool-permission.md](tool-permission.md)。AgentEditor 首次切换到 silent_task 弹 warning。

silent_task 自动回复（自动续轮 + AskUserQuestion 自动应答 + ExitPlanMode 自动接受 + must_confirm 自动拒绝）受 `SILENT_MAX_AUTO_REPLIES`（默认 30）per-run 上限约束，超过 fire onError 推 agent-error 终态；SDK `maxTurns=60` 作双重兜底。`pushEffect` 过滤白名单只放行 `agent-error`、`flow-completed`、命中 `CompleteTask(require_confirm)` 或 `ExitPlanMode` 确认的 `awaiting-tool-permission`。

## MCP server

per-Agent MCP server 由 [`../src/common/extension.ts`](../src/common/extension.ts) 构建：

- `CompleteTask`：chat 不挂载。
- `TerminateTask`：task / silent_task 挂载。
- `validateFlow`
- `getFlowJSONSchema`

`plan_mode=true` 时以 `permissionMode: 'plan'` 传 SDK，SDK 内置 ExitPlanMode。subAgent 不挂 `AgentControllerMcp`，禁止 subAgent 通过 CompleteTask / TerminateTask 干扰宿主 Flow 控制链路。
