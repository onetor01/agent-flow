import { memo, useState, type FC, type ReactNode } from 'react'
import { Button, Input, Radio, Tag, Tooltip } from 'antd'
import { BranchesOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import { Bubble, Think } from '@ant-design/x'
import type { AskUserQuestionInput, ExtensionToWebviewMessage, ModelTokenUsage } from '@/common'
import { formatTokenCount, formatTokenCost } from '@/common'
import { CodeRefChip } from '@/webview/components/CodeRefChip'
import { FileRefChip } from '@/webview/components/FileRefChip'
import { CopyButton, Md } from '../../text-components'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { ToolPermissionCard } from './ToolPermissionCard'
import { ToolUseDetails } from './ToolUseDetails'
import {
  buildRenderItems,
  clearBuildCache,
  clearBuildCacheForRuns,
  getContextUsage,
  type RenderItem,
  type ToolResult,
} from './buildRenderItems'

type Props = {
  msg: ExtensionToWebviewMessage
}

export type BubbleCtx = {
  /**
   * 当前挂起的工具权限请求 toolUseId 集合 —— 四类挂起统一(AskUserQuestion / CompleteTask /
   * ExitPlanMode / must_confirm)。AskUserQuestion / tool_use 卡片据此隐藏 pending(改由输入框上方固定卡片渲染);
   * tool_use 卡片据此切 active / historical。
   */
  pendingToolPermissionToolUseIds?: Set<string>
  /** 已回答的工具权限历史:toolUseId -> { allow, updatedInput, message }(AskUserQuestion 答案在 updatedInput;message 为 deny 理由) */
  answeredToolPermissions?: Record<
    string,
    { allow: boolean; updatedInput?: unknown; message?: string }
  >
  /** allow 回调(CompleteTask 接受 / ExitPlanMode 确认 / 普通工具允许) */
  onToolPermissionAllow?: (toolUseId: string) => void
  /** deny 回调(message 供 CompleteTask 拒绝原因回喂模型) */
  onToolPermissionDeny?: (toolUseId: string, message?: string) => void
  onViewPlan?: (planFilePath: string) => void
  /**
   * 触发会话 fork。target.kind:
   * - `message`：以 SDK 消息 UUID 为切片终点
   *
   * 第二个参数 sessionCompleted 由 ChatPanel 在每个 session 上下文中注入，
   * 用于让 fork 触发方决定是否弹 modal 提示「shareValues 一致性不保证」。
   */
  onFork?: (
    target: { kind: 'message'; runId: string; messageUuid: string },
    sessionCompleted: boolean,
  ) => void
}

type RenderedBubble = {
  key: string
  role: 'user' | 'ai' | 'system' | 'divider'
  content: ReactNode
}

// ChatInput 把代码片段 / 文件引用 / 附件序列化为下列 XML：
//   <code_snippet path="..." lines="N[-M]" language="...">\n...body...\n</code_snippet>
//   <file_ref path="..." />
//   <attachment name="..." mime="...">\n...body...\n</attachment>
// 属性值用 escapeAttr 做最小转义（& → &amp;、" → &quot;、< → &lt;），展示时要反转义。

type UserPart =
  | { kind: 'text'; text: string }
  | { kind: 'code_snippet'; path: string; line?: [number, number]; language?: string }
  | { kind: 'file_ref'; path: string }
  | { kind: 'attachment'; name: string; mime: string; text?: string }

function unescapeAttr(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) attrs[m[1]] = unescapeAttr(m[2])
  return attrs
}

function parseUserParts(text: string): UserPart[] {
  const parts: UserPart[] = []
  // 可选前导 HTML 注释 + 三种 tag 之一：自闭合（file_ref）或成对（code_snippet / attachment）
  const re =
    /(?:<!--[\s\S]*?-->\n?)?<(code_snippet|file_ref|attachment)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: 'text', text: text.slice(lastIndex, m.index) })
    }
    const tag = m[1]
    const attrs = parseAttrs(m[2])
    if (tag === 'code_snippet') {
      let line: [number, number] | undefined
      const lm = (attrs.lines ?? '').match(/^(\d+)(?:-(\d+))?$/)
      if (lm) {
        const start = parseInt(lm[1], 10)
        const end = lm[2] ? parseInt(lm[2], 10) : start
        line = [start, end]
      }
      parts.push({ kind: 'code_snippet', path: attrs.path ?? '', line, language: attrs.language })
    } else if (tag === 'file_ref') {
      parts.push({ kind: 'file_ref', path: attrs.path ?? '' })
    } else if (tag === 'attachment') {
      const body = m[3] ?? ''
      // 去掉序列化时额外包裹的首尾换行（见 attachmentToXml）
      const text = body.replace(/^\n/, '').replace(/\n$/, '')
      parts.push({ kind: 'attachment', name: attrs.name ?? '', mime: attrs.mime ?? '', text })
    }
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) parts.push({ kind: 'text', text: text.slice(lastIndex) })
  return parts
}

function codeRefLabel(path: string, line?: [number, number]): string {
  if (!line) return path
  return line[0] === line[1] ? `${path}:${line[0]}` : `${path}:${line[0]}-${line[1]}`
}

/** 渲染单个 text block 的各 part（文本/代码片段/文件引用/附件） */
function renderTextBlockParts(
  text: string,
  keyPrefix: string,
  copyParts: string[],
  nodes: ReactNode[],
): void {
  const parts = parseUserParts(text)
  parts.forEach((p, j) => {
    const key = `${keyPrefix}-${j}`
    if (p.kind === 'text') {
      if (p.text.length === 0) return
      copyParts.push(p.text)
      nodes.push(
        <span key={key} className='whitespace-pre-wrap'>
          {p.text}
        </span>,
      )
      return
    }
    if (p.kind === 'code_snippet') {
      copyParts.push(codeRefLabel(p.path, p.line))
      nodes.push(
        <span key={key} className='mx-0.5 inline-flex align-middle'>
          <CodeRefChip codeRef={{ filename: p.path, line: p.line }} />
        </span>,
      )
      return
    }
    if (p.kind === 'file_ref') {
      copyParts.push(p.path)
      nodes.push(
        <span key={key} className='mx-0.5 inline-flex align-middle'>
          <CodeRefChip codeRef={{ filename: p.path }} />
        </span>,
      )
      return
    }
    // attachment
    copyParts.push(`📎 ${p.name}`)
    nodes.push(
      <span key={key} className='mx-0.5 inline-flex align-middle'>
        <FileRefChip data={{ id: `att-${key}`, name: p.name, mimeType: p.mime, text: p.text }} />
      </span>,
    )
  })
}

/** 渲染用户消息内容 —— 代码片段 / 文件 / 图片均以 chip 形式内联展示，允许换行 */
function renderUserContent(rawContent: unknown): { copyText: string; node: ReactNode } {
  if (typeof rawContent === 'string') {
    const copyParts: string[] = []
    const nodes: ReactNode[] = []
    renderTextBlockParts(rawContent, 'str', copyParts, nodes)
    return {
      copyText: copyParts.join(''),
      node: <div className='leading-relaxed wrap-break-word'>{nodes}</div>,
    }
  }
  if (!Array.isArray(rawContent)) {
    const s = JSON.stringify(rawContent)
    return {
      copyText: s,
      node: <div className='wrap-break-word whitespace-pre-wrap'>{s}</div>,
    }
  }
  const copyParts: string[] = []
  const nodes: ReactNode[] = []
  rawContent.forEach((block: any, i: number) => {
    if (!block || typeof block !== 'object') return
    if (block.type === 'text') {
      renderTextBlockParts(block.text ?? '', String(i), copyParts, nodes)
      return
    }
    if (block.type === 'image') {
      const mime = block.source?.media_type ?? 'image/png'
      const base64 = block.source?.data ?? ''
      copyParts.push('[图片]')
      nodes.push(
        <span key={i} className='mx-0.5 inline-flex align-middle'>
          <FileRefChip data={{ id: `img-${i}`, name: '图片', mimeType: mime, base64 }} />
        </span>,
      )
    }
  })
  return {
    copyText: copyParts.join('\n'),
    node: <div className='leading-relaxed wrap-break-word'>{nodes}</div>,
  }
}

// ── 渲染层 ───────────────────────────────────────────────────────────────
// 纯把 RenderItem 转 React 节点，不再涉及消息流的语义合并。

/** 单条按模型 token 用量行：模型名 + in/out/cache write/cache read + cost */
function ModelUsageRow({ model, usage }: { model: string; usage: ModelTokenUsage }) {
  const parts: string[] = []
  if (usage.inputTokens > 0) parts.push(`in ${formatTokenCount(usage.inputTokens)}`)
  if (usage.outputTokens > 0) parts.push(`out ${formatTokenCount(usage.outputTokens)}`)
  if (usage.cacheCreationInputTokens > 0)
    parts.push(`cache write ${formatTokenCount(usage.cacheCreationInputTokens)}`)
  if (usage.cacheReadInputTokens > 0)
    parts.push(`cache read ${formatTokenCount(usage.cacheReadInputTokens)}`)
  const tokensText = parts.length > 0 ? `${parts.join(' · ')} tokens` : ''
  const costStr = usage.costUSD > 0 ? formatTokenCost(usage.costUSD) : ''
  return (
    <div className='text-[10px] text-[#6c7086]'>
      <span className='font-semibold text-[#a6adc8]'>{model}</span>
      {tokensText ? ` · ${tokensText}` : ''}
      {costStr ? ` · ${costStr}` : ''}
    </div>
  )
}

/**
 * 上下文窗口占用条 —— 展示「最后一次 API 调用真实喂给模型的 input + cache 总量 / 模型上下文窗口」。
 * 占用率越高颜色越红：>=80% 红、>=50% 黄、其余灰。
 * 仅 turn_end / agent_complete 内部使用 —— 普通气泡不展示 token,避免误以为是单 block 开销。
 */
function ContextUsageBar({ used, total }: { used: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, used / total) : 0
  const pct = Math.round(ratio * 100)
  const barColor = ratio >= 0.8 ? '#f38ba8' : ratio >= 0.5 ? '#f9e2af' : '#a6adc8'
  return (
    <div className='flex items-center gap-1.5 text-[10px] text-[#6c7086]'>
      <span>上下文</span>
      <div className='h-1 w-16 overflow-hidden rounded-full bg-[#45475a]'>
        <div
          className='h-full rounded-full transition-all'
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
      <span>
        {formatTokenCount(used)} / {formatTokenCount(total)} ({pct}%)
      </span>
    </div>
  )
}

/** fork 触发按钮 */
export function ForkButton({ onFork }: { onFork: () => void }): ReactNode {
  return (
    <Tooltip title='从此处 fork 出新工作流'>
      <BranchesOutlined
        onClick={(e) => {
          e.stopPropagation()
          onFork()
        }}
        className='text-xs text-[#6c7086] transition-colors hover:text-[#cdd6f4]'
      />
    </Tooltip>
  )
}

/** 思考块气泡内容 —— 收起时 fork+CopyButton 横向排列，展开时保持原有竖排列 */
const ThinkingContent: FC<{ text: string; itemKey: string; fork?: ReactNode }> = ({
  text,
  itemKey,
  fork,
}) => {
  const [expanded, setExpanded] = useState(false)
  const think = (
    <Think title='思考中' key={itemKey} expanded={expanded} onExpand={setExpanded}>
      <Md content={text} />
    </Think>
  )
  if (expanded) {
    return (
      <div className='flex'>
        {think}
        <div className='ml-1 flex flex-col items-center gap-1'>
          {fork}
          <CopyButton text={text} />
        </div>
      </div>
    )
  }
  return (
    <div className='flex items-center gap-1'>
      {think}
      {fork}
      <CopyButton text={text} />
    </div>
  )
}

/** 工具调用气泡内容 —— 收起时 fork+CopyButton 横向排列，展开时保持原有竖排列 */
const ToolUseBubbleContent: FC<{
  toolName: string
  input: unknown
  result?: ToolResult
  treatNoResultAsSuccess?: boolean
  copyText: string
  fork?: ReactNode
}> = ({ toolName, input, result, treatNoResultAsSuccess, copyText, fork }) => {
  const [expanded, setExpanded] = useState(false)
  const details = (
    <ToolUseDetails
      toolName={toolName}
      input={input}
      result={result}
      treatNoResultAsSuccess={treatNoResultAsSuccess}
      onOpenChange={setExpanded}
    />
  )
  if (expanded) {
    return (
      <div className='flex'>
        {details}
        <div className='ml-1 flex flex-col items-center gap-1'>
          {fork}
          <CopyButton text={copyText} />
        </div>
      </div>
    )
  }
  return (
    <div className='flex items-center gap-1'>
      {details}
      {fork}
      <CopyButton text={copyText} />
    </div>
  )
}

/** CompleteTask 结果主体：完成分支 Tag + content + 共享数据写入(values)。
 *  被「完成卡片」(agent_complete) 与「完成前确认卡片」复用。 */
const CompleteTaskBody: FC<{
  outputName?: string
  content?: string
  values?: Record<string, string>
}> = ({ outputName, content, values }) => {
  const shareEntries = values ? Object.entries(values) : []
  return (
    <div className='min-w-75'>
      <Tag color='green' className='m-0 text-[10px]'>
        完成{outputName ? ` → ${outputName}` : ''}
      </Tag>
      {content && (
        <div className='mt-2'>
          <Md content={content} />
        </div>
      )}
      {shareEntries.length > 0 && (
        <div className='mt-2 border-t border-[#45475a] pt-2'>
          <div className='mb-1 text-[10px] text-[#a6adc8]'>共享数据写入</div>
          <div className='flex flex-col gap-1'>
            {shareEntries.map(([k, v]) => (
              <div key={k} className='flex flex-col text-[11px]'>
                <Tag color='blue' className='m-0 mr-1 self-start text-[10px]'>
                  {k}
                </Tag>
                <Md className='ml-4' content={v} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 完成前确认卡片 —— 作为 AI 气泡渲染（role:'ai'），样式与 agent_complete 完成气泡完全一致：
 *  左侧 filled 气泡、无自绘边框，气泡外观由 Bubble filled 提供 */
const CompleteTaskConfirmCard: FC<{
  outputName?: string
  content?: string
  values?: Record<string, string>
  onAccept: () => void
  onDeny: (reason: string) => void
}> = ({ outputName, content, values, onAccept, onDeny }) => {
  const [choice, setChoice] = useState<'accept' | 'deny' | null>(null)
  const [reason, setReason] = useState('')

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      if (reason.trim()) onDeny(reason.trim())
    }
  }

  return (
    <div className='flex flex-col gap-2 overflow-x-hidden'>
      <CompleteTaskBody outputName={outputName} content={content} values={values} />
      <div className='flex items-center gap-2 border-t border-[#45475a] pt-2'>
        <ExclamationCircleOutlined className='text-[#f9e2af]' />
        <span className='text-xs font-semibold text-[#cdd6f4]'>完成前确认</span>
      </div>
      <Radio.Group
        value={choice}
        onChange={(e) => {
          const val = e.target.value as 'accept' | 'deny'
          setChoice(val)
          if (val === 'accept') onAccept()
        }}
        className='flex flex-col gap-1'
      >
        <label className='flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-[#313244]'>
          <Radio value='accept' />
          <span className='text-sm text-[#cdd6f4]'>同意</span>
        </label>
        <label className='flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-[#313244]'>
          <Radio value='deny' />
          <span className='text-sm text-[#cdd6f4]'>拒绝</span>
        </label>
      </Radio.Group>
      {choice === 'deny' && (
        <div className='flex flex-col gap-1 pl-6'>
          <Input.TextArea
            autoSize={{ minRows: 1 }}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='请输入拒绝原因...'
            className='overflow-hidden text-sm'
          />
          <div className='flex justify-end'>
            <Button
              type='primary'
              danger
              size='small'
              disabled={!reason.trim()}
              onClick={() => onDeny(reason.trim())}
            >
              发送
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * run 级注入快照展示小节 —— 附加在首条 user 气泡底部。
 * 默认折叠，展开后按 key → value 列表展示（value 为 null 显示灰色「(空)」）。
 * 样式参考 CompleteTaskBody「共享数据写入」块。
 * title 由调用方按 node_type 区分:agent 节点「注入数据」(按 allowed_read 过滤、值空记 null),
 * code 节点「共享数据」(全量 shareValues)。
 */
const InjectedShareValuesSection: FC<{ values: Record<string, string | null>; title: string }> = ({
  values,
  title,
}) => {
  const [expanded, setExpanded] = useState(false)
  const entries = Object.entries(values)
  if (entries.length === 0) return null
  return (
    <div className='flex flex-col'>
      <div
        className='mb-1 cursor-pointer text-xs text-[#a6adc8] select-none'
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '▾' : '▸'} {title}
      </div>
      {expanded && (
        <div className='flex flex-col gap-1'>
          {entries.map(([k, v]) => (
            <div key={k} className='flex flex-col text-[11px]'>
              <Tag color='blue' className='m-0 mr-1 self-start text-[10px]'>
                {k}
              </Tag>
              {v === null ? (
                <span className='ml-4 text-[#6c7086]'>(空)</span>
              ) : (
                <Md className='ml-4' content={v} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function renderItemToBubble(
  item: RenderItem,
  ctx?: BubbleCtx,
  sessionCompleted = false,
  itemContextUsage?: { used: number; total: number },
  runId?: string,
  injectedShareValues?: Record<string, string | null>,
  injectedTitle = '注入数据',
): RenderedBubble | RenderedBubble[] | null {
  /**
   * 构造 fork icon —— 仅当 ctx.onFork 存在时返回按钮元素。
   */
  const buildForkIcon = (target: {
    kind: 'message'
    runId: string
    messageUuid: string
  }): ReactNode | undefined => {
    if (!ctx?.onFork) return undefined
    return <ForkButton onFork={() => ctx.onFork!(target, sessionCompleted)} />
  }
  switch (item.kind) {
    case 'user': {
      const { copyText, node } = renderUserContent(item.rawContent)
      // user fork 语义 = 「让用户重新说一次」= 切到上一条 SDK 消息为止。
      // 只要 messageUuid（findPrevUuid 找到的上一条 SDK 消息 uuid）存在就合法,
      // 不依赖 turn 是否闭环（thinking/text fork 后切片末端 user / agent running 中
      // 的当前 user 都属于 turn 未闭环但 fork 合法的场景）。
      const fork =
        runId && item.messageUuid
          ? buildForkIcon({ kind: 'message', runId, messageUuid: item.messageUuid })
          : undefined
      // 注入快照仅附加在 run 首条 user 气泡内；空对象时不展示
      const hasInjected = injectedShareValues && Object.keys(injectedShareValues).length > 0
      return {
        key: item.key,
        role: 'user',
        content: (
          <div className='flex'>
            <div className='flex flex-col gap-1'>
              {node}
              {hasInjected && (
                <InjectedShareValuesSection values={injectedShareValues} title={injectedTitle} />
              )}
            </div>
            <div className='ml-1 flex flex-col items-center gap-1'>
              {fork}
              <CopyButton text={copyText} />
            </div>
          </div>
        ),
      }
    }
    case 'text': {
      const md = <Md content={item.text} />
      if (item.streaming) {
        return { key: item.key, role: 'ai', content: md }
      }
      const fork =
        runId && item.messageUuid
          ? buildForkIcon({ kind: 'message', runId, messageUuid: item.messageUuid })
          : undefined
      return {
        key: item.key,
        role: 'ai',
        content: (
          <div className='flex'>
            {md}
            <div className='ml-1 flex flex-col items-center gap-1'>
              {fork}
              <CopyButton text={item.text} />
            </div>
          </div>
        ),
      }
    }
    case 'thinking': {
      if (item.streaming) {
        return {
          key: item.key,
          role: 'ai',
          content: (
            <Think title='思考中' key={item.key + 'streaming'} defaultExpanded>
              <Md content={item.text} />
            </Think>
          ),
        }
      }
      // 与 user 对齐:只要 messageUuid 存在即放行 fork。同 text 分支说明。
      const fork =
        runId && item.messageUuid
          ? buildForkIcon({ kind: 'message', runId, messageUuid: item.messageUuid })
          : undefined
      return {
        key: item.key,
        role: 'ai',
        content: <ThinkingContent text={item.text} itemKey={item.key} fork={fork} />,
      }
    }
    case 'tool_use': {
      const isPending = ctx?.pendingToolPermissionToolUseIds?.has(item.toolUseId) ?? false
      const answered = ctx?.answeredToolPermissions?.[item.toolUseId]

      // tool_use 不能作 fork 终点,messageUuid 回退到所属 assistant 消息的 uuid(同 text/thinking)。
      // 与其它分支一致:runId && messageUuid 都存在才渲染 fork icon。
      const fork =
        runId && item.messageUuid
          ? buildForkIcon({ kind: 'message', runId, messageUuid: item.messageUuid })
          : undefined

      // AskUserQuestion：pending 时由底部固定卡片渲染(active)，历史态从 answeredToolPermissions 就地解析答案
      if (item.toolName.includes('AskUserQuestion')) {
        if (isPending) return null
        // 无 ctx（单气泡调试场景）：降级为静态历史卡片
        if (!ctx) {
          return {
            key: item.key,
            role: 'system',
            content: (
              <AskUserQuestionCard
                input={item.input as AskUserQuestionInput}
                mode='historical'
                fork={fork}
              />
            ),
          }
        }
        // 从 answeredToolPermissions.updatedInput 就地解析历史答案
        const answersObj = (
          answered?.updatedInput as { answers?: Record<string, string> } | undefined
        )?.answers
        const answeredValues: Record<string, string[]> | undefined = answersObj
          ? Object.fromEntries(
              Object.entries(answersObj).map(([q, a]) => [
                q,
                (a ?? '')
                  .split('\x1F')
                  .map((s) => s.trim())
                  .filter(Boolean),
              ]),
            )
          : undefined
        return {
          key: item.key,
          role: 'system',
          content: (
            <AskUserQuestionCard
              input={item.input as AskUserQuestionInput}
              mode='historical'
              answeredValues={answeredValues}
              fork={fork}
            />
          ),
        }
      }

      // CompleteTask：完成前确认。pending 时在工具详情下方挂确认卡片;历史只显示工具详情
      // (成功完成由 agent_complete 卡片体现,拒绝则带 isError result)。
      if (item.toolName.includes('CompleteTask')) {
        const completeInput = item.input as Record<string, any> | undefined
        // CompleteTask 仅在被拒绝(带 isError result)时可作 fork 起点;成功完成 / pending 不挂 fork。
        const completeFork = item.result?.isError ? fork : undefined
        const toolUseItem: RenderedBubble = {
          key: item.key,
          role: 'ai',
          content: (
            <ToolUseBubbleContent
              toolName={item.toolName}
              input={item.input}
              result={item.result}
              treatNoResultAsSuccess={sessionCompleted}
              copyText={item.result?.text ?? ''}
              fork={completeFork}
            />
          ),
        }
        if (isPending && ctx) {
          const confirmItem: RenderedBubble = {
            key: item.key + '-confirm',
            role: 'ai',
            content: (
              <CompleteTaskConfirmCard
                outputName={completeInput?.output_name ?? completeInput?.output?.name}
                content={
                  typeof completeInput?.content === 'string' ? completeInput.content : undefined
                }
                values={
                  completeInput?.values && typeof completeInput.values === 'object'
                    ? completeInput.values
                    : undefined
                }
                onAccept={() => ctx.onToolPermissionAllow?.(item.toolUseId)}
                onDeny={(reason) => ctx.onToolPermissionDeny?.(item.toolUseId, reason)}
              />
            ),
          }
          return [toolUseItem, confirmItem]
        }
        return toolUseItem
      }

      // ExitPlanMode：pending 时移至底部卡片；历史态仍内联展示
      if (item.toolName.includes('ExitPlanMode')) {
        if (isPending) return null
        const planFilePath = (item.input as { planFilePath?: string })?.planFilePath ?? ''
        return {
          key: item.key + '-exit-plan',
          role: 'system' as const,
          content: (
            <ToolPermissionCard
              toolName='ExitPlanMode'
              input={item.input}
              mode='historical'
              answered={answered ? { allow: answered.allow, reason: answered.message } : undefined}
              exitPlan={{ planFilePath, onViewPlan: () => ctx!.onViewPlan?.(planFilePath) }}
              fork={fork}
            />
          ),
        }
      }

      // 通用工具权限(must_confirm 等)：pending 显示授权卡片;answered 显示历史授权卡片 + 工具详情;
      // 未触发权限(普通工具)只显示工具详情。
      // 通用工具权限(must_confirm 等)：pending 时移至底部卡片；历史态内联展示授权结果 + 工具详情
      if (isPending) return null
      const permItem: RenderedBubble = {
        key: item.key + '-perm',
        role: 'system',
        content: (
          <ToolPermissionCard
            toolName={item.toolName}
            input={item.input}
            mode='historical'
            answered={answered ? { allow: answered.allow, reason: answered.message } : undefined}
            fork={fork}
          />
        ),
      }
      const toolUseItem: RenderedBubble = {
        key: item.key,
        role: 'ai',
        content: (
          <ToolUseBubbleContent
            toolName={item.toolName}
            input={item.input}
            result={item.result}
            copyText={item.result?.text ?? ''}
            fork={answered ? undefined : fork}
          />
        ),
      }
      if (answered) return [permItem, toolUseItem]
      return toolUseItem
    }
    case 'turn_end': {
      const modelUsages = item.modelUsages ?? []
      const fork =
        runId && item.messageUuid
          ? buildForkIcon({ kind: 'message', runId, messageUuid: item.messageUuid })
          : undefined
      // turn_end 由 antd-x DividerBubble 包装（用 antd Divider 渲染 content）,
      // antd Divider 的 ::before/::after 横线会让 absolute 子元素被遮挡,group-hover
      // 在 divider 容器层级也会失效。所以 fork icon 必须 inline 渲染在 content 内。
      const inner = (
        <div className='inline-flex items-center gap-2'>
          <span className='flex flex-col gap-0.5 text-left'>
            {modelUsages.map((m) => (
              <ModelUsageRow key={m.model} model={m.model} usage={m.usage} />
            ))}
            {itemContextUsage && (
              <ContextUsageBar used={itemContextUsage.used} total={itemContextUsage.total} />
            )}
            <span className='text-[10px] text-[#6c7086]'>
              <CheckCircleOutlined className={item.isError ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'} />
              <span className='ml-1'>{item.isError ? '执行出错' : '回合结束'}</span>
            </span>
          </span>
          {fork && <span className='shrink-0'>{fork}</span>}
        </div>
      )
      return {
        key: item.key,
        role: 'divider',
        content: inner,
      }
    }
    case 'agent_complete': {
      const completionText = [
        item.outputName ? `完成 → ${item.outputName}` : '完成',
        item.displayContent,
      ]
        .filter(Boolean)
        .join('\n')
      const breakdown = item.modelBreakdown ?? []
      return {
        key: item.key,
        role: 'ai',
        content: (
          <div className='flex'>
            <div>
              <CompleteTaskBody
                outputName={item.outputName}
                content={item.displayContent}
                values={item.values}
              />
              {(breakdown.length > 0 || item.totalCost !== undefined || itemContextUsage) && (
                <div className='mt-2 border-t border-[#45475a] pt-2'>
                  <div className='mb-1 text-[10px] text-[#a6adc8]'>session 累计</div>
                  {breakdown.map((b) => (
                    <ModelUsageRow key={b.model} model={b.model} usage={b.usage} />
                  ))}
                  {itemContextUsage && (
                    <div className='mt-1'>
                      <ContextUsageBar
                        used={itemContextUsage.used}
                        total={itemContextUsage.total}
                      />
                    </div>
                  )}
                  {item.totalCost !== undefined && item.totalCost > 0 && (
                    <div className='mt-1 text-[10px] text-[#a6adc8]'>
                      合计 {formatTokenCost(item.totalCost)}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className='ml-1 flex flex-col items-center gap-1'>
              <CopyButton text={completionText} />
            </div>
          </div>
        ),
      }
    }
    case 'error': {
      return {
        key: item.key,
        role: 'ai',
        content: (
          <div className='flex min-w-20 flex-col gap-2'>
            <Tag color={'error'} className='self-start'>
              错误信息
            </Tag>
            <div className='break-all whitespace-pre-wrap'>{item.message}</div>
          </div>
        ),
      }
    }
  }
}

export function toBubbleItems(
  sessionId: string,
  msgs: ExtensionToWebviewMessage[],
  ctx?: BubbleCtx,
  sessionCompleted = false,
  injectedShareValues?: Record<string, string | null>,
  mode?: import('./buildRenderItems').BuildMode,
  injectedTitle?: string,
): RenderedBubble[] {
  const renderItems = buildRenderItems(sessionId, msgs, mode)
  const out: RenderedBubble[] = []
  let firstUserPassed = false
  for (const item of renderItems) {
    const cu = getContextUsage(sessionId, item.key)
    // sessionId 在 MessageList 调用点传的是 run.runId(buildRenderItems 的 cache key 历史命名),
    // 这里把它作为 runId 透传给 buildForkIcon 拼 fork target
    // 注入快照仅透传给首个 user 项，其余项不传
    const injected =
      !firstUserPassed && item.kind === 'user' && injectedShareValues
        ? injectedShareValues
        : undefined
    if (item.kind === 'user') firstUserPassed = true
    const bubble = renderItemToBubble(
      item,
      ctx,
      sessionCompleted,
      cu,
      sessionId,
      injected,
      injectedTitle,
    )
    if (!bubble) continue
    if (Array.isArray(bubble)) out.push(...bubble)
    else out.push(bubble)
  }
  return out
}

export { clearBuildCache, clearBuildCacheForRuns }

/**
 * 保留单气泡渲染入口（可用于调试或非列表场景）。
 * 列表场景请直接使用 Bubble.List + toBubbleItems。
 */
const MessageBubbleInner: FC<Props> = ({ msg }) => {
  const items = toBubbleItems('__debug__', [msg])
  if (items.length === 0) return null
  return (
    <div className='flex flex-col gap-1'>
      {items.map((item) => (
        <Bubble
          key={item.key}
          placement={item.role === 'user' ? 'end' : 'start'}
          content={item.content}
          variant={item.role === 'divider' ? 'borderless' : 'filled'}
        />
      ))}
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleInner)
