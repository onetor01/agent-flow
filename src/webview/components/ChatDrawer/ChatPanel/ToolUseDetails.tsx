import { type FC, type ReactNode } from 'react'
import { Spin, Tag } from 'antd'
import {
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  LoadingOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons'
import type { ToolResult } from '@/common'
import { CodeRefChip } from '@/webview/components/CodeRefChip'

// ── 工具元数据 ───────────────────────────────────────────────────────────

type ToolCategory =
  | 'file'
  | 'shell'
  | 'search'
  | 'web'
  | 'agent'
  | 'task'
  | 'flow'
  | 'mcp'
  | 'other'

const CATEGORY_COLORS: Record<ToolCategory, string> = {
  file: 'blue',
  shell: 'orange',
  search: 'purple',
  web: 'cyan',
  agent: 'geekblue',
  task: 'gold',
  flow: 'green',
  mcp: 'magenta',
  other: 'default',
}

/** 解析工具名 —— MCP 工具会带 server 前缀（`server::tool` 或 `mcp__server__tool`） */
function parseToolName(toolName: string): { server?: string; name: string } {
  const dco = toolName.match(/^([^:]+)::(.+)$/)
  if (dco) return { server: dco[1], name: dco[2] }
  const us = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
  if (us) return { server: us[1], name: us[2] }
  return { name: toolName }
}

function getToolCategory(toolName: string): ToolCategory {
  const { server, name } = parseToolName(toolName)
  if (server) return 'mcp'
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
    case 'Glob':
      return 'file'
    case 'Bash':
    case 'TaskStop':
    case 'TaskOutput':
      return 'shell'
    case 'Grep':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Agent':
      return 'agent'
    case 'TodoWrite':
      return 'task'
    case 'CompleteTask':
      return 'flow'
    default:
      return 'other'
  }
}

/** summary 行右侧追加的"主参数"——不重复工具名 */
function getSummaryArg(toolName: string, input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const { name } = parseToolName(toolName)
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return typeof input.file_path === 'string' ? input.file_path : undefined
    case 'Bash':
      return typeof input.command === 'string' ? input.command : undefined
    case 'Grep':
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : undefined
    case 'WebFetch':
      return typeof input.url === 'string' ? input.url : undefined
    case 'WebSearch':
      return typeof input.query === 'string' ? input.query : undefined
    case 'Agent':
      return typeof input.description === 'string' ? input.description : undefined
    case 'TodoWrite': {
      const n = Array.isArray(input.todos) ? input.todos.length : 0
      return n > 0 ? `${n} 项任务` : undefined
    }
    case 'CompleteTask': {
      const out = input?.output?.name ?? input?.output_name
      return typeof out === 'string' ? `→ ${out}` : undefined
    }
    default:
      return undefined
  }
}

// ── 状态 / 度量 ──────────────────────────────────────────────────────────

type RunState = 'pending' | 'success' | 'error'

const StatusIcon: FC<{ state: RunState }> = ({ state }) => {
  if (state === 'success') return <CheckCircleFilled className='text-[#a6e3a1]' />
  if (state === 'error') return <CloseCircleFilled className='text-[#f38ba8]' />
  return <Spin size='small' indicator={<LoadingOutlined className='text-[10px]!' />} />
}

function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M chars`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`
  return `${n} chars`
}

function getResultMeta(result: ToolResult): { lines: number; chars: number } {
  const text = result.text
  return { lines: text ? text.split('\n').length : 0, chars: text.length }
}

// ── input 渲染 ──────────────────────────────────────────────────────────

const PATH_KEY_RE = /^(file_path|notebook_path|directory|path)$/
const URL_KEY_RE = /^url$/

function renderInputValue(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className='text-[#6c7086]'>—</span>
  }
  if (typeof value === 'string') {
    if (value.length === 0) return <span className='text-[#6c7086]'>(空)</span>
    if (PATH_KEY_RE.test(key)) {
      return (
        <span className='inline-flex align-middle'>
          <CodeRefChip codeRef={{ filename: value }} />
        </span>
      )
    }
    if (URL_KEY_RE.test(key)) {
      return (
        <a
          href={value}
          target='_blank'
          rel='noreferrer noopener'
          className='break-all text-[#89b4fa] hover:underline'
        >
          {value}
        </a>
      )
    }
    if (value.includes('\n') || value.length > 80) {
      return (
        <pre className='m-0 max-h-32 overflow-auto rounded bg-[#181825] p-1.5 text-[10px] break-all whitespace-pre-wrap text-[#a6adc8]'>
          {value}
        </pre>
      )
    }
    return <span className='break-all whitespace-pre-wrap text-[#a6adc8]'>{value}</span>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className='text-[#fab387]'>{String(value)}</span>
  }
  return (
    <pre className='m-0 max-h-32 overflow-auto rounded bg-[#181825] p-1.5 text-[10px] break-all whitespace-pre-wrap text-[#a6adc8]'>
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

const KeyValueList: FC<{ input: Record<string, unknown> }> = ({ input }) => {
  const entries = Object.entries(input)
  if (entries.length === 0) return null
  return (
    <div className='space-y-1'>
      {entries.map(([k, v]) => (
        <div key={k} className='flex flex-wrap items-baseline gap-2 text-[10px]'>
          <span className='shrink-0 font-mono text-[#cba6f7]'>{k}</span>
          <div className='min-w-0 flex-1 break-all'>{renderInputValue(k, v)}</div>
        </div>
      ))}
    </div>
  )
}

// ── 工具特化 input ──────────────────────────────────────────────────────

const TodoListPreview: FC<{ todos: any[] }> = ({ todos }) => (
  <div className='space-y-1'>
    {todos.map((todo, i) => {
      const status = todo?.status as string | undefined
      const content = String(todo?.content ?? '')
      const activeForm = todo?.activeForm ? String(todo.activeForm) : undefined
      let icon: ReactNode
      let textCls = 'text-[#cdd6f4]'
      if (status === 'completed') {
        icon = <CheckOutlined className='text-[#a6e3a1]' />
        textCls = 'text-[#6c7086] line-through'
      } else if (status === 'in_progress') {
        icon = <Spin size='small' indicator={<LoadingOutlined className='text-[10px]!' />} />
        textCls = 'text-[#fab387]'
      } else {
        icon = <MinusCircleOutlined className='text-[#6c7086]' />
      }
      const display = status === 'in_progress' && activeForm ? activeForm : content
      return (
        <div key={i} className='flex items-start gap-1.5 text-[11px]'>
          <span className='mt-0.5 shrink-0'>{icon}</span>
          <span className={`break-all ${textCls}`}>{display}</span>
        </div>
      )
    })}
  </div>
)

const BashInput: FC<{ input: Record<string, unknown> }> = ({ input }) => {
  const command = String(input.command ?? '')
  const description = input.description ? String(input.description) : undefined
  const timeout = typeof input.timeout === 'number' ? input.timeout : undefined
  const runInBg = !!input.run_in_background
  return (
    <div className='space-y-1.5'>
      {description ? <div className='text-[10px] text-[#a6adc8]'>{description}</div> : null}
      <pre className='m-0 max-h-40 overflow-auto rounded bg-[#181825] p-1.5 text-[11px] break-all whitespace-pre-wrap text-[#a6e3a1]'>
        <span className='text-[#6c7086] select-none'>$ </span>
        {command}
      </pre>
      {(timeout || runInBg) && (
        <div className='flex gap-2 text-[10px] text-[#6c7086]'>
          {timeout ? <span>timeout {timeout}ms</span> : null}
          {runInBg ? <span>· background</span> : null}
        </div>
      )}
    </div>
  )
}

const EditInput: FC<{ input: Record<string, unknown> }> = ({ input }) => {
  const filePath = input.file_path ? String(input.file_path) : ''
  const oldStr = String(input.old_string ?? '')
  const newStr = String(input.new_string ?? '')
  const replaceAll = !!input.replace_all
  return (
    <div className='space-y-1'>
      {filePath && (
        <div className='flex flex-wrap items-center gap-1 text-[10px]'>
          <CodeRefChip codeRef={{ filename: filePath }} />
          {replaceAll && (
            <Tag className='m-0 text-[10px]' color='gold'>
              replace_all
            </Tag>
          )}
        </div>
      )}
      <pre className='m-0 max-h-32 overflow-auto rounded border-l-2 border-[#f38ba8]/40 bg-[#f38ba8]/5 p-1.5 text-[10px] break-all whitespace-pre-wrap text-[#f38ba8]'>
        {oldStr.split('\n').map((line, i) => (
          <div key={i}>- {line}</div>
        ))}
      </pre>
      <pre className='m-0 max-h-32 overflow-auto rounded border-l-2 border-[#a6e3a1]/40 bg-[#a6e3a1]/5 p-1.5 text-[10px] break-all whitespace-pre-wrap text-[#a6e3a1]'>
        {newStr.split('\n').map((line, i) => (
          <div key={i}>+ {line}</div>
        ))}
      </pre>
    </div>
  )
}

const WriteInput: FC<{ input: Record<string, unknown> }> = ({ input }) => {
  const filePath = input.file_path ? String(input.file_path) : ''
  const content = String(input.content ?? '')
  const lines = content.split('\n').length
  const chars = content.length
  return (
    <div className='space-y-1'>
      {filePath && (
        <div className='flex flex-wrap items-center gap-1 text-[10px] text-[#6c7086]'>
          <CodeRefChip codeRef={{ filename: filePath }} />
          <span>
            · {lines} lines · {formatChars(chars)}
          </span>
        </div>
      )}
      <pre className='m-0 max-h-40 overflow-auto rounded bg-[#181825] p-1.5 text-[10px] break-all whitespace-pre-wrap text-[#a6adc8]'>
        {content}
      </pre>
    </div>
  )
}

function renderInputBody(toolName: string, input: unknown): ReactNode {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  if (Object.keys(obj).length === 0) return null
  const { name } = parseToolName(toolName)

  switch (name) {
    case 'Bash':
      return <BashInput input={obj} />
    case 'Edit':
      return <EditInput input={obj} />
    case 'Write':
      return <WriteInput input={obj} />
    case 'TodoWrite':
      return Array.isArray(obj.todos) ? <TodoListPreview todos={obj.todos as any[]} /> : null
    default:
      return <KeyValueList input={obj} />
  }
}

// ── result 渲染 ──────────────────────────────────────────────────────────

const ResultBody: FC<{ result: ToolResult }> = ({ result }) => {
  if (!result.text) {
    return <div className='text-[10px] text-[#6c7086]'>（空结果）</div>
  }
  const cls = result.isError
    ? 'm-0 max-h-60 overflow-auto rounded border border-[#f38ba8]/30 bg-[#f38ba8]/5 p-1.5 text-[10px] break-all whitespace-pre-wrap text-[#f38ba8]'
    : 'm-0 max-h-60 overflow-auto rounded bg-[#181825] p-1.5 text-[10px] break-all whitespace-pre-wrap text-[#a6adc8]'
  return <pre className={cls}>{result.text}</pre>
}

// ── 主入口 ───────────────────────────────────────────────────────────────

type Props = {
  toolName: string
  input: unknown
  result?: ToolResult
  /** 无 result 时是否视为成功 —— 仅 CompleteTask 用 */
  treatNoResultAsSuccess?: boolean
  onOpenChange?: (open: boolean) => void
}

export const ToolUseDetails: FC<Props> = ({
  toolName,
  input,
  result,
  treatNoResultAsSuccess = false,
  onOpenChange,
}) => {
  const { server, name } = parseToolName(toolName)
  const category = getToolCategory(toolName)
  const summaryArg = getSummaryArg(toolName, input)
  const state: RunState = result
    ? result.isError
      ? 'error'
      : 'success'
    : treatNoResultAsSuccess
      ? 'success'
      : 'pending'

  const meta = result && !result.isError ? getResultMeta(result) : undefined
  const inputBody = renderInputBody(toolName, input)

  return (
    <details
      className='flex flex-1 flex-col overflow-hidden text-[11px] text-[#a6adc8]'
      onToggle={(e) => onOpenChange?.((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className='flex flex-1 cursor-pointer list-none items-center gap-1.5 overflow-hidden [&::-webkit-details-marker]:hidden'>
        <span className='shrink-0'>
          <StatusIcon state={state} />
        </span>
        <Tag
          color={CATEGORY_COLORS[category]}
          className='m-0 shrink-0 px-1 py-0 text-[10px] leading-3.5'
          variant='filled'
        >
          {server ?? name}
        </Tag>
        {server ? <span className='shrink-0 font-medium text-[#cdd6f4]'>{name}</span> : null}
        {summaryArg && (
          <span className='min-w-0 flex-1 truncate break-all text-[#7f849c]'>{summaryArg}</span>
        )}
        {!summaryArg && <span className='flex-1' />}
        {state === 'pending' && (
          <span className='shrink-0 text-[10px] text-[#6c7086]'>运行中…</span>
        )}
        {state === 'error' && (
          <Tag color='error' className='m-0 shrink-0 text-[10px]' variant='filled'>
            失败
          </Tag>
        )}
        {state === 'success' && meta && meta.chars > 0 && (
          <span className='shrink-0 text-[10px] text-[#6c7086]'>
            {meta.lines > 1 ? `${meta.lines}L · ` : ''}
            {formatChars(meta.chars)}
          </span>
        )}
      </summary>
      <div className='mt-1.5 ml-1 space-y-1.5 border-l-2 border-[#313244] pl-2'>
        {inputBody}
        {result ? (
          <div className='space-y-1'>
            <div className='flex items-center gap-1 text-[10px] text-[#6c7086]'>
              {result.isError ? (
                <CloseCircleFilled className='text-[#f38ba8]' />
              ) : (
                <CheckCircleFilled className='text-[#a6e3a1]' />
              )}
              <span>结果</span>
              {meta && meta.chars > 0 && (
                <span>
                  · {meta.lines > 1 ? `${meta.lines} lines · ` : ''}
                  {formatChars(meta.chars)}
                </span>
              )}
            </div>
            <ResultBody result={result} />
          </div>
        ) : null}
      </div>
    </details>
  )
}
