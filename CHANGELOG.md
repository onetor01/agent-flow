# Changelog

## v0.0.7

- 优化交互

## v0.0.86

- fix: interrupt 后屏蔽 SDK error_during_execution 误报——新增 `interruptRequested` 标志，用户主动 interrupt() 时置 true，SDK result 非 success 时不再触发 onError
- fix: 完整打印错误日志
- 优化样式
