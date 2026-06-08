# Changelog

## v0.0.57

- 优化交互

## v0.0.56

- 优化布局算法/线样式

## v0.0.55

- 调整折叠消息展示逻辑

## v0.0.54

- 修复编辑逻辑

## v0.0.53

- 优化样式

## v0.0.52

- 原地修改agentName

## v0.0.51

- 解决删除stream-event导致的key重复问题 它会导致虚拟列表显式异常

## v0.0.50

### 优化

- **优化内存 清理消息片段**：流式消息片段（stream_event）在完整 assistant/result 到达后立即清理，避免无限堆积撑爆 extension/webview 两端内存；buildRenderItems 增量缓存新增截断检测，自动恢复扫描索引
- **优化样式**：工具调用气泡摘要行布局调整，summaryArg 参数支持折行显示
- **优化默认 flow**：调整"常用 Agent"预设工作流中节点排列顺序
