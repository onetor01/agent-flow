# docs 导航

本文档目录承载 `CLAUDE.md` 之外的模块细节与硬约束。根文档只保留项目导航、核心机制入口和对应链接。

## 写作约定

- 全部使用中文。
- 只描述当前状态，不写版本演进过程。
- 硬约束归属到最相关模块；跨模块场景只在主文档完整描述，其他文档链接引用。
- 代码级字段、调用链、状态机细节优先链接源码与代码注释，文档只记录 AI 对话核心链路的约束。

## 阅读顺序

1. [architecture.md](architecture.md) — 项目分层、源码边界、状态归属。
2. [events.md](events.md) — extension ↔ webview 事件契约与派发规则。
3. [flow-run-state.md](flow-run-state.md) — 双端同构 reducer、phase、消息累加、恢复。
4. [extension-runtime.md](extension-runtime.md) — FlowRunner / Executor / work_mode / MCP。
5. [webview-state.md](webview-state.md) — store、ChatDrawer、当前 run/agent 与 UI 生命周期。
6. 其他专题文档按改动模块回查。

## 模块索引

- [architecture.md](architecture.md) — 三层源码结构、import 边界、Flow 定义/运行态/UI 状态归属。
- [common-domain.md](common-domain.md) — common 层 schema、校验、prompt 构建、MCP server 与 SDK 消息说明。
- [events.md](events.md) — `flow.command.*` / `flow.signal.*`、`openFile.cwd`、标识符、双端派发路径。
- [flow-run-state.md](flow-run-state.md) — `updateFlowRunState`、phase 推断、`MessageEffect`、`cwd`、恢复。
- [extension-runtime.md](extension-runtime.md) — extension 运行层级、ClaudeExecutor、CodeExecutor、`work_mode`。
- [tool-permission.md](tool-permission.md) — 统一 tool permission 链路、`preToolUseHook`、权限卡片展示。
- [share-values.md](share-values.md) — `shareValues` / `values` 声明、授权读写、事件合并、运行时取值。
- [persistence.md](persistence.md) — 全局/项目/workspaceStore 持久化、默认 flow 注入、`project` 字段。
- [webview-state.md](webview-state.md) — `useFlowStore`、ChatDrawer、active run/agent、通知与挂载约束。
- [fork.md](fork.md) — fork command/signal、`handleFork`、transcript uuid 映射与限制。
