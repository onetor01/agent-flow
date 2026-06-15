# Extension ↔ Webview 事件契约

## 关键文件

- [`../src/common/event.ts`](../src/common/event.ts) — 事件类型定义。
- [`../src/extension/index.ts`](../src/extension/index.ts) — extension 端收发与 load/fork 特殊处理。
- [`../src/extension/FlowRunnerManager/index.ts`](../src/extension/FlowRunnerManager/index.ts) — command 路由到 runner / executor。
- [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) — webview 端本地 reducer 与 postMessage。

## 事件方向

- `flow.command.*`：webview → extension。
- `flow.signal.*`：extension → webview。
- 事件分发使用 `match(e).with({ type: P.string.startsWith(...) }, ...)`。

## 标识符

- `flowId`：Flow 主键。
- `runId`：一次 Agent 运行的主键，所有运行载荷以此寻址；`flowStart` 由 webview 生成，`next_agent` / `fork` 由 extension 生成。
- `sessionId`：Claude SDK session id，挂在 `AgentRun.sessionId`；不出现在事件载荷上，由 `aiMessage` 内 SDK 原生 `session_id` 首次回填。生命周期绑定单个 `AgentRun`：每个 Agent run 独立，`next_agent` 新建的 run 初始为 `undefined`，不复用上一 agent 的 SDK session；fork / 恢复通过 `resumeSessionId` 传给 ClaudeExecutor 继续指定 SDK session，但 command / signal 路由仍以 `runId` 为准。code 节点没有 SDK session，首条 SDK 消息前也可能为空。

## 双端派发路径

- webview 发 command 时先本地调用 `updateFlowRunState`，再 postMessage 到 extension。
- extension 收 command 后由 `FlowRunStateManager` 镜像同一 reducer，并把运行控制交给 `FlowRunnerManager`。
- extension 发 signal 前先更新 extension 镜像，再 postMessage 给 webview。
- webview 收 signal 后再次调用同一 reducer，保证两端运行态同构。

## 特殊入口

- `flow.signal.toolPermissionResult` 与 `flow.command.toolPermissionResult` 语义一致，入口不同：silent_task 自动应答走 signal，人工回答走 command。
- `openFile.cwd` 用于 webview 行内 code 文件引用的相对路径解析；extension 端优先按绝对路径打开，否则以 `cwd` 或 workspace root 拼接。
- `flow.command.fork` 由 extension 顶层 `handleFork` 处理；`flow.signal.fork` 由 webview 创建新 Flow 并切换视图，详见 [fork.md](fork.md)。

## 硬约束

- `FlowRunnerManager.handleCommand` 必须用 `keyof` + `.exhaustive()` 写完整 `flow.command.*` 分支，禁止使用吞错兜底。
- 命令派发的 `runId` 传递规则（`sendUserMessage` / `interruptAgent` / `answerToolPermission` 必传，store 不做末位 run 推断）详见 [webview-state.md](webview-state.md)。
- `answerToolPermission` 按 `toolUseId` 反查 `pendingToolPermission.runId`。
- 工具类型分流统一用 `.includes(...)`，详见 [tool-permission.md](tool-permission.md)。
