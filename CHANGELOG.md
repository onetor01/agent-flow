# Changelog

# v0.0.66

- 解决ExitPlanModeCard的展示问题

## v0.0.65

- 新增工作流清空与续跑交互：停止后可保留历史继续运行，也可清空全部对话记录和共享数据
- Edit 工具调用以文件变更卡片展示，支持点击在 VSCode 中查看 diff
- 工具调用卡片在 assistant 定稿后统一渲染，自动允许场景下正确展示已应用状态
- 支持项目级 Flow 双存储：全局 Flow 与项目 Flow 分离持久化，工作区运行记录写入 workspaceStore
- 支持查看单次会话的所有文件变更汇总
- 优化 killFlow 整体链路、工具调用展示、日志清理、默认 Flow、文本与样式
