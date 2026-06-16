# Changelog

## v0.0.76

- 默认选中project flow
- 调整脚本

## v0.0.75

- 优化fallback逻辑

## v0.0.74

- feat: 重构工具鉴权链路——`preToolUseHook` 只做硬拒绝，`canUseTool` 承接 AskUserQuestion、CompleteTask(require_confirm)、ExitPlanMode、must_confirm_tools 等 Agent Flow 确认逻辑；silent_task 自动拒绝纳入自动回复上限统计
- feat: Webview 行内 code 命中文件引用时可点击跳转，`openFile` 携带 `cwd` 支持相对路径解析
- feat: Code 节点支持接收 `string | ContentBlockParam[]` 富文本输入，完成卡片与用户消息可正常渲染富文本内容
- feat: Flow 列表支持折叠全局 / 项目分组，`cwd` 支持快速删除交互
- fix: 多轮优化默认 flow、flow 样式、文本复制逻辑和代码引用富文本展示
- chore: 更新预设 Flow 同步脚本，同时写入 `preset-flows.json` 与根目录 `.agent-flows.json`
- docs: 建立 docs/ 模块文档体系并同步 CLAUDE.md 导航
