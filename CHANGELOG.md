# Changelog

## v0.0.81

- 更新模型

## v0.0.80

- refactor: 精简可选模型列表——`MODELS` 收敛为 `opus[1m]` / `sonnet[1m]` / `qwen3.7-max[1m]` / `glm-5.1[1m]` / `gpt-5.5[1m]`，并同步优化默认 Flow 各节点的模型搭配
- fix: Agent 节点 "Other" 选项无法正确展示——AskUserQuestion 的 `showOther`（默认隐藏）反转为 `hiddenOther`（默认展示，置 true 隐藏），common schema / `buildCodeJSDoc` / CodeExecutor / AskUserQuestionCard 同步
- fix: 画布存在文本选区时 `Ctrl+C` 交还浏览器复制文本，不再劫持为复制节点
- refactor: 优化 silent_task 引导语——自动续轮 / 自动拒绝文案引用 `<completion_contract>` 提示收尾（CompleteTask / TerminateTask）
- refactor: no_input 节点启动按钮初始消息改用 `buildNoInputInitMessage(agent)`，与三端同源引导一致
