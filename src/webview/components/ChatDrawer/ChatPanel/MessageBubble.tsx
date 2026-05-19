import { memo, type FC, type ReactNode } from 'react'
import { Tag, Tooltip } from 'antd'
import { BranchesOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { Bubble, Think } from '@ant-design/x'
import type { AskUserQuestionOutput, ExtensionToWebviewMessage, ModelTokenUsage } from '@/common'
import { formatTokenCount, formatTokenCost } from '@/common'
import { CodeRefChip } from '@/webview/components/CodeRefChip'
import { FileRefChip } from '@/webview/components/FileRefChip'
import { Copyable, Md } from '../../text-components'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { ToolPermissionCard } from './ToolPermissionCard'
import { ToolUseDetails } from './ToolUseDetails'
import {
  buildRenderItems,
  clearBuildCache,
  clearBuildCacheForSessions,
  getContextUsage,
  type RenderItem,
} from './buildRenderItems'

type Props = {
  msg: ExtensionToWebviewMessage
}

export type AnsweredInfo = {
  values: Record<string, string[]>
}

export type BubbleCtx = {
  pendingToolUseId?: string
  /** 所有未回答的 AskUserQuestion toolUseId 集合，用于从消息列表中隐藏 */
  pendingToolUseIds?: Set<string>
  answeredMap: Map<string, AnsweredInfo>
  onActiveSubmit?: (toolUseId: string, output: AskUserQuestionOutput) => void
  /** 当前挂起的工具权限请求 toolUseId（若有） */
  pendingToolPermissionToolUseId?: string
  /** 已回答的工具权限历史 */
  answeredToolPermissions?: Record<string, { allow: boolean }>
  onToolPermissionAllow?: (toolUseId: string) => void
  onToolPermissionDeny?: (toolUseId: string) => void
  /**
   * 触发会话 fork。target.kind:
   * - `message`：以 SDK 消息 UUID 为切片终点
   * - `askUserQuestion`：以包含该 toolUseId 的 assistant message 为切片终点（不含 tool_result）
   *
   * 第二个参数 sessionCompleted 由 ChatPanel 在每个 session 上下文中注入，
   * 用于让 fork 触发方决定是否弹 modal 提示「shareValues 一致性不保证」。
   */
  onFork?: (
    target:
      | { kind: 'message'; messageUuid: string }
      | { kind: 'askUserQuestion'; toolUseId: string },
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

/** fork 触发按钮 —— inline 元素,作为 Copyable.extra 与 CopyButton 同列垂直堆叠 */
function ForkButton({ onFork }: { onFork: () => void }): ReactNode {
  return (
    <Tooltip title='从此处 fork 出新工作流'>
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          onFork()
        }}
        className='cursor-pointer text-[11px] text-[#6c7086] transition-colors hover:text-[#cdd6f4]'
      >
        <BranchesOutlined />
      </button>
    </Tooltip>
  )
}

function renderItemToBubble(
  item: RenderItem,
  ctx?: BubbleCtx,
  sessionCompleted = false,
  itemContextUsage?: { used: number; total: number },
): RenderedBubble | null {
  /**
   * 构造 fork icon —— 仅当 ctx.onFork 存在时返回按钮元素,作为 Copyable.extra 注入。
   * fork icon 与 CopyButton 同列垂直堆叠（见 Copyable 组件实现）,不再用 absolute 定位。
   */
  const buildForkIcon = (
    target:
      | { kind: 'message'; messageUuid: string }
      | { kind: 'askUserQuestion'; toolUseId: string },
  ): ReactNode | undefined => {
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
      const fork = item.messageUuid
        ? buildForkIcon({ kind: 'message', messageUuid: item.messageUuid })
        : undefined
      return {
        key: item.key,
        role: 'user',
        content: (
          <Copyable text={copyText} extra={fork}>
            {node}
          </Copyable>
        ),
      }
    }
    case 'text': {
      const md = <Md content={item.text} />
      if (item.streaming) {
        return { key: item.key, role: 'ai', content: md }
      }
      // 与 user 对齐:只要 messageUuid 存在即放行 fork。turn 是否闭环不再作为
      // 守卫条件 —— fork 切片末端的 text 项 turnClosed=false（切片不含后续 result）,
      // 但 fork 本身合法,不能因此拦下。
      const fork = item.messageUuid
        ? buildForkIcon({ kind: 'message', messageUuid: item.messageUuid })
        : undefined
      return {
        key: item.key,
        role: 'ai',
        content: (
          <Copyable text={item.text} extra={fork}>
            {md}
          </Copyable>
        ),
      }
    }
    case 'thinking': {
      const inner = (
        <Think
          title='思考中'
          key={item.key + (item.streaming ? 'streaming' : 'completed')}
          defaultExpanded={item.streaming}
        >
          <Md content={item.text} />
        </Think>
      )
      if (item.streaming) {
        return { key: item.key, role: 'ai', content: inner }
      }
      // 与 user 对齐:只要 messageUuid 存在即放行 fork。同 text 分支说明。
      const fork = item.messageUuid
        ? buildForkIcon({ kind: 'message', messageUuid: item.messageUuid })
        : undefined
      return {
        key: item.key,
        role: 'ai',
        content: (
          <Copyable text={item.text} extra={fork}>
            {inner}
          </Copyable>
        ),
      }
    }
    case 'ask_user_question': {
      if (!ctx) {
        // 无 ctx（单气泡调试场景）：降级为静态历史卡片
        return {
          key: item.key,
          role: 'system',
          content: <AskUserQuestionCard input={item.input} mode='historical' />,
        }
      }
      const isPending = ctx.pendingToolUseIds
        ? ctx.pendingToolUseIds.has(item.toolUseId)
        : ctx.pendingToolUseId === item.toolUseId
      // pending 卡片不在消息列表中渲染（改为固定在输入框上方），只渲染已回答的历史卡片
      if (isPending) return null
      const answered = ctx.answeredMap.get(item.toolUseId)
      const card = (
        <AskUserQuestionCard
          input={item.input}
          mode='historical'
          answeredValues={answered?.values}
        />
      )
      const fork = buildForkIcon({ kind: 'askUserQuestion', toolUseId: item.toolUseId })
      // ask_user_question 卡片自带样式,不通过 Copyable 包裹（无文本可复制）;
      // fork icon 用 inline-flex 直接挂在卡片右侧。
      const content = fork ? (
        <div className='flex items-start gap-1'>
          <div className='min-w-0 flex-1'>{card}</div>
          <div className='shrink-0 pt-1'>{fork}</div>
        </div>
      ) : (
        card
      )
      return {
        key: item.key,
        role: 'system',
        content,
      }
    }
    case 'tool_use': {
      if (ctx) {
        const isPendingPerm = ctx.pendingToolPermissionToolUseId === item.toolUseId
        const answeredPerm = ctx.answeredToolPermissions?.[item.toolUseId]
        if (isPendingPerm || answeredPerm) {
          return {
            key: item.key,
            role: 'system',
            content: (
              <ToolPermissionCard
                toolName={item.toolName}
                input={item.input}
                mode={isPendingPerm ? 'active' : 'historical'}
                answered={answeredPerm}
                onAllow={() => ctx.onToolPermissionAllow?.(item.toolUseId)}
                onDeny={() => ctx.onToolPermissionDeny?.(item.toolUseId)}
              />
            ),
          }
        }
      }
      return {
        key: item.key,
        role: 'ai',
        content: (
          <ToolUseDetails
            toolName={item.toolName}
            input={item.input}
            result={item.result}
            treatNoResultAsSuccess={sessionCompleted && item.toolName.includes('AgentComplete')}
          />
        ),
      }
    }
    case 'turn_end': {
      const modelUsages = item.modelUsages ?? []
      const fork = item.messageUuid
        ? buildForkIcon({ kind: 'message', messageUuid: item.messageUuid })
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
      const shareEntries = item.shareValues ? Object.entries(item.shareValues) : []
      return {
        key: item.key,
        role: 'ai',
        content: (
          <Copyable text={completionText}>
            <div>
              <Tag color='green' className='m-0 text-[10px]'>
                完成{item.outputName ? ` → ${item.outputName}` : ''}
              </Tag>
              {item.displayContent && (
                <div className='mt-2'>
                  <Md content={item.displayContent} />
                </div>
              )}
              {shareEntries.length > 0 && (
                <div className='mt-2 border-t border-[#45475a] pt-2'>
                  <div className='mb-1 text-[10px] text-[#a6adc8]'>共享数据写入</div>
                  <div className='flex flex-col gap-1'>
                    {shareEntries.map(([k, v]) => (
                      <div key={k} className='text-[11px]'>
                        <Tag color='blue' className='m-0 mr-1 text-[10px]'>
                          {k}
                        </Tag>
                        <span className='break-all whitespace-pre-wrap text-[#cdd6f4]'>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
          </Copyable>
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
): RenderedBubble[] {
  const renderItems = buildRenderItems(sessionId, msgs)
  const out: RenderedBubble[] = []
  for (const item of renderItems) {
    const cu = getContextUsage(sessionId, item.key)
    const bubble = renderItemToBubble(item, ctx, sessionCompleted, cu)
    if (!bubble) continue
    out.push(bubble)
    // turn_end / agent_complete 内部已经嵌入 ContextUsageBar；其余 item（user /
    // text / thinking / tool_use / ask_user_question）若 cache 命中,则在该 bubble
    // 后面追加一条独立的 ContextUsageBar 行,以便每条 assistant 消息后都能看到
    // 当前上下文窗口占用。
    if (cu && item.kind !== 'turn_end' && item.kind !== 'agent_complete') {
      out.push({
        key: `${item.key}-ctx`,
        role: 'divider',
        content: <ContextUsageBar used={cu.used} total={cu.total} />,
      })
    }
  }
  return out
}

export { clearBuildCache, clearBuildCacheForSessions }

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
