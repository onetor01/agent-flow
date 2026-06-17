# Changelog

## v0.0.77

- feat: common 层新增 `buildCodeJSDoc(shareValueKeys, outputs)`，统一 Code 节点 JSDoc 生成；extension 临时 `.js` 文件头与 webview 只读展示（`JsDocDisplay`）共用同一函数，`CodeEditor` 新增 `hideJSDoc` prop
- feat: no_input 引导语统一——新增 `buildNoInputInitMessage(agent)` 按 `work_mode` 生成首条引导，extension / reducer / webview 三端同源回显
- feat: CompleteTask.values 语义明确：可只传改动的 key，每个 value 须给完整新值整值替换
- feat: parseFileRef 支持 GitHub 锚点格式（`path#L639` / `path#L639-L644`）
- feat: fork 使用运行时快照，恢复 fork 起点状态更准确
- fix: Windows 持久化竞态——用 copyFile+unlink 替代 unlink+rename，避免目标文件名短暂占用导致 rename 失败
- fix: 默认 flows 仅在全局 flows 为空时加载；globalStore/workspaceStore 保存增加 try-catch
- fix: 统一 AgentEditor 所有关闭路径清理临时文件（`handleClose`），Drawer onClose / CloseOutlined / onFinish 三条路径一致
- refactor: CodeExecutor 统一 `new Function('return (...)')()` 求值，去掉向后兼容分支
- refactor: extension 仅保留 `onDidSaveTextDocument` 监听，删除 tab 关闭监听
- 优化默认 flow 与脚本
