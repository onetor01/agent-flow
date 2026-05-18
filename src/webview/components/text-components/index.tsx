import { FC, isValidElement, memo, ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Spin } from 'antd'
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { XMarkdown, type ComponentProps as XMarkdownComponentProps } from '@ant-design/x-markdown'
import mermaid from 'mermaid'
import { cn } from '@/webview/utils'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
})

const CopyButton: FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false)
  return (
    <span
      className='cursor-pointer text-[11px] text-[#6c7086] transition-colors hover:text-[#cdd6f4]'
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckOutlined /> : <CopyOutlined />}
    </span>
  )
}
const getTextContent = (node: ReactNode): string => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextContent).join('')
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children
    return getTextContent(children)
  }
  return ''
}

const PreBlock: FC<XMarkdownComponentProps> = ({ children, className }) => {
  const text = getTextContent(children)
  return (
    <div className='group relative'>
      <div className='absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100'>
        <CopyButton text={text} />
      </div>
      <pre className={className}>{children}</pre>
    </div>
  )
}

const MermaidDiagram: FC<{ code: string }> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  const id = useId()

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      try {
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) setSvg(svg)
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Mermaid render error')
      }
    }
    render()
    return () => {
      cancelled = true
    }
  }, [code, id])

  if (error) {
    return (
      <div className='rounded border border-[#f38ba8]/30 bg-[#f38ba8]/5 p-2 text-[12px] text-[#f38ba8]'>
        Mermaid 渲染失败：{error}
        <details className='mt-1'>
          <summary className='cursor-pointer'>查看源码</summary>
          <pre className='mt-1 max-h-40 overflow-auto text-[10px]'>{code}</pre>
        </details>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className='flex items-center gap-2 py-2 text-[12px] text-[#6c7086]'>
        <Spin size='small' /> 渲染中...
      </div>
    )
  }

  return (
    <div ref={containerRef} className='overflow-auto' dangerouslySetInnerHTML={{ __html: svg }} />
  )
}

const CodeBlock: FC<XMarkdownComponentProps> = ({ children, lang, block, streamStatus }) => {
  if (block && lang === 'mermaid' && streamStatus === 'done') {
    const code = getTextContent(children)
    return <MermaidDiagram code={code} />
  }
  // 流式进行中 mermaid 代码尚未完整，先按普通代码块展示
  if (block && lang === 'mermaid' && streamStatus === 'loading') {
    const code = getTextContent(children)
    return (
      <pre className='overflow-auto'>
        <code>{code}</code>
      </pre>
    )
  }
  return <code>{children}</code>
}

const MD_COMPONENTS = { pre: PreBlock, code: CodeBlock }
export const Md: FC<{ content: string } & Style> = memo(({ content, className, style }) => (
  <XMarkdown
    className={cn('x-markdown-dark', className)}
    style={style}
    content={content}
    components={MD_COMPONENTS}
    openLinksInNewTab
    escapeRawHtml
  />
))

export const Copyable: FC<{
  text: string
  children: ReactNode
  /**
   * 与 CopyButton 同列垂直堆叠的额外按钮（如 fork icon）。
   * 渲染顺序：extra 在 CopyButton 之上,共享同一个 `ml-1` 列容器,
   * 避免与 absolute 定位的图标互相遮挡。
   */
  extra?: ReactNode
}> = ({ text, children, extra }) => (
  <div className='flex'>
    {children}
    <div className='ml-1 flex flex-col items-center gap-1'>
      {extra}
      <CopyButton text={text} />
    </div>
  </div>
)
