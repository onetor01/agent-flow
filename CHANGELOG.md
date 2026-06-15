# Changelog

## v0.0.73

- feat: Code 节点 `cwd` 参数未设置时为 `undefined`（不再回退工作区根目录），用户代码可自行判断处理；Claude 节点仍回退工作区根目录
- fix: 默认 flow 优化——"输入需求"改为"在worktree处理需求" code 节点（自动创建 worktree 并设置 cwd）；需求分析节点新增入口标记；分支规则仅在非主工作区时生成 branchName
- UI: "默认工作区" 统一改为 "主工作区"
