# CLAUDE.md

中文回复。

优先用 `ts-pattern` 替代嵌套的三元表达式 / `if-else` / `switch`。

**功能变动后必须同步文档**：改动事件契约、reducer 行为、运行时层级、work_mode 行为、ShareValues 链路、tool permission、fork、消息派发、恢复 → 回查本文件与 [docs/](docs/) 对应模块。文档与代码对同一功能的描述不一致即视为严重错误，应当询问用户，**不要自行决策**。

**写作约定**：本文是导航地图，只留「标题 + 一句话约束 + 文件路径 / docs 链接」。模块细节与易踩坑写入 [docs/](docs/) 对应子文档。只描述当前状态，不写版本演进过程。

## 项目性质

VSCode 插件 `agent-flow`：用 Agent 编排工作流。Flow 是 Agent 节点组成的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，按 `outputs[i].next_agent` 决定下一跳，通过 Flow 的 `shareValues`（按 key 授权读写）共享数据。

## 三层源码结构

跨层 import 只能经 [src/common/](src/common/)。三个独立 tsconfig：

- [src/common/](src/common/) — 共享层（Zod schema / 类型 / 事件契约 / prompt 构建），webview 应 import `@/common`（不含 SDK）
- [src/extension/](src/extension/) — Node / VSCode 扩展宿主，可 import `@/common/extension`（含 SDK）
- [src/webview/](src/webview/) — React 19 + AntD + `@xyflow/react` + `zustand`(immer)

领域定义与校验在 [src/common/index.ts](src/common/index.ts)。Flow 定义按作用域持久化；`FlowRunState` 是运行态，extension 端由 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像，webview 端由 [useFlowStore](src/webview/store/flow.ts) 镜像；UI 状态仅 webview。细节见 [docs/architecture.md](docs/architecture.md)。

## Extension ↔ Webview 事件契约

事件定义见 [src/common/event.ts](src/common/event.ts)。`flow.command.*` = webview → extension，`flow.signal.*` = extension → webview。`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。细节见 [docs/events.md](docs/events.md)。

标识符：

- `flowId` —— Flow 主键
- `runId` —— 一次 Agent 运行的主键，所有运行载荷以此寻址
- `sessionId` —— Claude SDK session id，挂在 `AgentRun.sessionId`，不出现在事件载荷上，由 `aiMessage` 内 SDK 原生 `session_id` 回填

## flowRunState 双端同构 state 机制

[updateFlowRunState](src/common/flowRunState.ts) 是 Flow 运行态唯一 reducer，signal / command 两条路径上 extension 与 webview 各 reduce 一次，共用同一份保证两端同步。webview 镜像在 [useFlowStore](src/webview/store/flow.ts)，extension 镜像在 [FlowRunStateManager](src/extension/FlowRunStateManager.ts)。

`FlowPhase` / `AgentPhase` 同构：`idle | starting | running | result | interrupted | awaiting-tool-permission | completed | stopped | error`。Phase 不存字段，由 [getRunPhase / getAgentPhase / getFlowPhase](src/common/flowRunState.ts) 推断。细节见 [docs/flow-run-state.md](docs/flow-run-state.md)。

## 模块文档导航

- [docs/README.md](docs/README.md) — docs 总索引、写作约定、阅读顺序。
- [docs/architecture.md](docs/architecture.md) — 三层源码边界、跨层 import、状态归属。
- [docs/common-domain.md](docs/common-domain.md) — common 层 schema、校验、prompt、MCP server。
- [docs/events.md](docs/events.md) — `flow.command.*` / `flow.signal.*`、`openFile.cwd`、标识符、双端派发路径。
- [docs/flow-run-state.md](docs/flow-run-state.md) — `updateFlowRunState`、phase、消息累加、`cwd`、恢复。
- [docs/extension-runtime.md](docs/extension-runtime.md) — FlowRunner、ClaudeExecutor、CodeExecutor、`work_mode`。
- [docs/tool-permission.md](docs/tool-permission.md) — 统一 tool permission、`preToolUseHook`、权限卡片展示。
- [docs/share-values.md](docs/share-values.md) — `shareValues` / `values` 声明、授权读写、事件合并。
- [docs/persistence.md](docs/persistence.md) — 全局/项目/workspaceStore 持久化、默认 flow、`project` 字段。
- [docs/webview-state.md](docs/webview-state.md) — `useFlowStore`、ChatDrawer、当前 run/agent、UI 生命周期。
- [docs/fork.md](docs/fork.md) — fork command/signal、`handleFork`、uuid 映射与限制。

## 核心代码入口

- [src/common/index.ts](src/common/index.ts) — 领域 schema、类型、Flow 校验、prompt 构建。
- [src/common/event.ts](src/common/event.ts) — extension ↔ webview 事件契约。
- [src/common/flowRunState.ts](src/common/flowRunState.ts) — 运行态 reducer、phase 推断、消息累加。
- [src/common/extension.ts](src/common/extension.ts) — per-Agent MCP server 与 extension 专用能力。
- [src/extension/index.ts](src/extension/index.ts) — VSCode extension 入口、持久化、webview 通信、fork。
- [src/extension/FlowRunStateManager.ts](src/extension/FlowRunStateManager.ts) — extension 端运行态镜像。
- [src/extension/FlowRunnerManager/index.ts](src/extension/FlowRunnerManager/index.ts) — runner 管理与 command 分发。
- [src/extension/FlowRunnerManager/FlowRunner/index.ts](src/extension/FlowRunnerManager/FlowRunner/index.ts) — Flow 运行控制与 next_agent 路由。
- [src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) — Claude SDK 执行器。
- [src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts) — code 节点执行器。
- [src/webview/store/flow.ts](src/webview/store/flow.ts) — webview store、运行态镜像、命令派发。
- [src/webview/App.tsx](src/webview/App.tsx) — webview 根组件挂载结构。
