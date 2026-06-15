import {
  FC,
  isValidElement,
  memo,
  MouseEventHandler,
  ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { Spin, Typography } from 'antd'
import { XMarkdown, type ComponentProps as XMarkdownComponentProps } from '@ant-design/x-markdown'
import mermaid from 'mermaid'
import { match, P } from 'ts-pattern'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import { postMessageToExtension } from '@/webview/utils/ExtensionMessage'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
})

export const CopyButton: FC<
  Style & { text: string | (() => string) | (() => Promise<string>) }
> = ({ text, className, style }) => {
  return (
    <Typography.Text
      className={cn('m-0 p-0 text-xs', className)}
      style={style}
      copyable={{ tooltips: false, text }}
    />
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

/** 文件引用判定白名单扩展名（小写，不含点号） */
const FILE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'yaml',
  'yml',
  'toml',
  'ini',
  'sh',
  'bash',
  'sql',
  'txt',
])

/**
 * 解析文本是否为文件引用。
 * 命中返回 { filename, line? }；line 存在时为 [start, end]（end 默认 = start）。
 * 空串、http(s):// 开头返回 null。Windows 盘符冒号（C:\...）不会误判为行号。
 */
const parseFileRef = (text: string): { filename: string; line?: [number, number] } | null => {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('http://') || trimmed.startsWith('https://')) return null
  const m = trimmed.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/)
  if (!m) return null
  const path = m[1]
  const lineStart = m[2] ? Number(m[2]) : undefined
  const lineEnd = m[3] ? Number(m[3]) : lineStart
  const hasLineSuffix = lineStart !== undefined
  const hasSeparator = path.includes('/') || path.includes('\\')
  const dotIdx = path.lastIndexOf('.')
  const ext = dotIdx > 0 ? path.slice(dotIdx + 1).toLowerCase() : ''
  const hasKnownExt = FILE_EXTENSIONS.has(ext)
  if (!hasLineSuffix && !hasSeparator && !hasKnownExt) return null
  return { filename: path, ...(hasLineSuffix ? { line: [lineStart, lineEnd!] } : {}) }
}

/** 向 extension 发送 openFile 事件 */
const openFileRef = (ref: { filename: string; line?: [number, number] }) => {
  const { chatDrawer, flowRunStates } = useFlowStore.getState()
  const cwd = chatDrawer ? flowRunStates[chatDrawer.flowId]?.cwd : undefined
  const data = ref.line ? { filename: ref.filename, line: ref.line } : { filename: ref.filename }
  postMessageToExtension({
    type: 'openFile',
    data: cwd ? { ...data, cwd } : data,
  })
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
  // mermaid 代码块：渲染完成 → 图表；流式中 → 占位
  if (block && lang === 'mermaid') {
    const code = getTextContent(children)
    return match(streamStatus)
      .with('done', () => <MermaidDiagram code={code} />)
      .otherwise(() => (
        <pre className='overflow-auto'>
          <code>{code}</code>
        </pre>
      ))
  }
  // 行内 code：文本命中文件引用时可点击跳转
  if (!block) {
    const text = getTextContent(children)
    const ref = parseFileRef(text)
    if (ref) {
      return (
        <code
          className='cursor-pointer underline decoration-transparent decoration-dashed transition-colors hover:decoration-current'
          onClick={() => openFileRef(ref)}
        >
          {children}
        </code>
      )
    }
  }
  return <code>{children}</code>
}

const LinkBlock: FC<XMarkdownComponentProps> = ({ children, ...props }) => {
  const { href, ...htmlProps } = props as Record<string, unknown>
  const handleClick: MouseEventHandler<HTMLAnchorElement> = (e) => {
    if (typeof href !== 'string') return
    const ref = parseFileRef(href)
    match({ ref, href })
      .with({ ref: P.not(P.nullish) }, ({ ref }) => {
        e.preventDefault()
        openFileRef(ref)
      })
      .with({ href: P.string.startsWith('http') }, () => {
        // http 链接走原生行为（openLinksInNewTab），不拦截
      })
      .otherwise(() => {
        // 非文件引用也非 http，不拦截
      })
  }
  return (
    <a href={href as string} onClick={handleClick} className='cursor-pointer' {...htmlProps}>
      {children}
    </a>
  )
}

const MD_COMPONENTS = { pre: PreBlock, code: CodeBlock, a: LinkBlock }
export const Md: FC<{ content: string } & Style> = memo(({ content, className, style }) => (
  <XMarkdown
    className={cn('x-markdown-dark', className)}
    style={style}
    content={content}
    components={MD_COMPONENTS}
    openLinksInNewTab
    escapeRawHtml
    dompurifyConfig={{ ALLOW_UNKNOWN_PROTOCOLS: true }}
  />
))
