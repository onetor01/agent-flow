import { FC, PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp, ConfigProvider, theme } from 'antd'
import zh_CN from 'antd/es/locale/zh_CN'
import { StyleProvider } from '@ant-design/cssinjs'
import { XProvider } from '@ant-design/x'
import '@ant-design/x-markdown/themes/dark.css'
import zh_CN_X from '@ant-design/x/locale/zh_CN'
import 'dayjs/locale/zh-cn'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './global.css'
import './utils/ExtensionMessage'

/** antd 首屏样式 样式兼容 本地化 主题等 */
const AntdProvider: FC<PropsWithChildren> = (props) => {
  return (
    <StyleProvider layer>
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <XProvider
          locale={{ ...zh_CN, ...zh_CN_X }}
          theme={{ algorithm: theme.darkAlgorithm }}
          bubble={{
            className:
              'p-0.5! [&_.ant-bubble-content]:py-1! [&_.ant-bubble-content]:px-2! [&_.ant-bubble-content]:min-h-[unset]!',
          }}
        >
          <AntdApp className='app'> {props.children}</AntdApp>
        </XProvider>
      </ConfigProvider>
    </StyleProvider>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <ErrorBoundary>
      <AntdProvider>
        <App />
      </AntdProvider>
    </ErrorBoundary>,
  )
}
