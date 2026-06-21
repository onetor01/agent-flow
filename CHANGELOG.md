# Changelog

## v0.0.87

- 调整静默模式行为：`SILENT_MAX_AUTO_REPLIES` 从 30 降至 5；移除 silent_task 的 SDK `maxTurns=60` 特殊处理
- 优化删除 flow 后的 activeFlow 选择逻辑（考虑项目/全局分组和折叠状态）
- UI 文本：将"全局flow"/"项目flow"统一改为"全局工作流"/"项目工作流"
