import { Component, ErrorInfo, ReactNode } from 'react'
import { Button, Result, Typography } from 'antd'

const { Paragraph, Text } = Typography

type Props = {
  children: ReactNode
}

type State = {
  hasError: boolean
  error?: Error
  errorInfo?: ErrorInfo
}

/**
 * 顶层错误边界 —— 防止单个组件渲染异常把整个 webview 带成黑屏。
 *
 * 触发场景：
 * - reducer 写入了畸形 state（例如 LLM 调用 AskUserQuestion 时把 questions 传成 string
 *   而非 array,渲染层 .every 抛 TypeError）
 * - 任何子树同步抛错(异步错误不在此范围,需各自 try/catch)
 *
 * 行为：
 * - 显示错误信息与堆栈,提供"重新加载页面"按钮(由 webview 自身 location.reload 触发,
 *   等同于关闭再开 panel —— extension 端 flowRunStates 不受影响)
 * - 错误信息可复制,便于上报
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ error, errorInfo })
    // 同时输出到控制台,便于在 webview devtools 看完整堆栈
    console.error('[agent-flow ErrorBoundary]', error, errorInfo)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    const { error, errorInfo } = this.state
    return (
      <div style={{ padding: 24, height: '100vh', overflow: 'auto', background: '#11111b' }}>
        <Result
          status='error'
          title='Webview 渲染异常'
          subTitle='已被错误边界捕获,extension 端运行态未受影响。常见原因:reducer 写入了畸形 state(如 LLM 把 AskUserQuestion 的 questions 字段传成字符串)。'
          extra={[
            <Button type='primary' key='reload' onClick={this.handleReload}>
              重新加载 Webview
            </Button>,
          ]}
        />
        {error && (
          <div style={{ marginTop: 16, padding: 16, background: '#1e1e2e', borderRadius: 8 }}>
            <Paragraph copyable={{ text: `${error.name}: ${error.message}\n${error.stack ?? ''}` }}>
              <Text strong>{error.name}: </Text>
              <Text>{error.message}</Text>
            </Paragraph>
            {error.stack && (
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  color: '#cdd6f4',
                  maxHeight: 300,
                  overflow: 'auto',
                }}
              >
                {error.stack}
              </pre>
            )}
            {errorInfo?.componentStack && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer' }}>组件栈</summary>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 12,
                    color: '#a6adc8',
                  }}
                >
                  {errorInfo.componentStack}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    )
  }
}
