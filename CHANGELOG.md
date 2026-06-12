# Changelog

## v0.0.63

- 重构消息模型：每个 run 的消息改为接收事件即累加的半渲染态 ChatMessage[]，不再保留原始 SDK 信号流
- 总是获取最新的 agent 进行对话
- fork 时连同所有子消息一起切片
- 节点上支持快速设置思考强度（effort）与工作模式
- 切下一个 agent 时首条消息注入可读的共享数据
- save flow 时清除无效消息与通知卡片
- 发送消息后立即移除中断状态
- fix: 提问卡片重复显示
- 优化 AskUserQuestion / ExitPlan 卡片样式与默认 flow
