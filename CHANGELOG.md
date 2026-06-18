# Changelog

## v0.0.83

- feat: 模型输入框动态过滤与 Enter 确认——输入与去 `[1m]` 后模型名相等时展示全部候选模型；ModelEditor Enter 键视为确认
- 优化默认 flow 配置
- feat: 分支操作与清理节点支持三选一（push / 删除 / 保留）
- feat: CompleteTask / ExitPlanMode 工具入参 Zod 校验——`canUseTool` 对入参做 `safeParse`，非法即拒绝并返回「参数错误」前缀消息；抽取 `buildCompleteTaskInputShape(agent)` 复用 CompleteTask input shape
- feat: result error subtype 触发 onError 进入 error 终态——SDK result 非 `success` subtype 时触发 `onError`，flow 进入 error 终态
- fix: 持久化读取错误
