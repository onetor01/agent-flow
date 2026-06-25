# Changelog

## v0.0.89

- fix fork: `ToolUseMessage` 新增 `toolResultUuid` 字段，fork 锚点改为 tool result 所在 SDK 消息；`locateFork` 同时匹配 `uuid` 和 `toolResultUuid`；tool result 未到达时不展示 fork 按钮
- fix: `ExitPlanMode` 工具 schema 移除不存在的 `filePath` 参数校验
- 更新模型列表：移除 `glm-5.2[1m]`，预设模型精简为 `opus[1m]` / `sonnet[1m]` / `qwen3.7-max[1m]` / `gpt-5.5[1m]`
- 优化默认 flow 配置
