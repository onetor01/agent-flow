import { match } from 'ts-pattern'
import type { AskUserQuestionInput, ExtensionToWebviewMessage } from '@/common'
import {
  extractModelTokenUsage,
  isModelTokenUsageNonZero,
  subtractModelTokenUsage,
  type ModelTokenUsage,
} from '@/common'

// ── 类型 ──────────────────────────────────────────────────────────────────

export type ToolResult = { isError: boolean; text: string }

/**
 * fork icon 显隐相关字段：
 * - `messageUuid` 是 fork 切片的 SDK 消息 UUID（user 用上一条 SDK 消息的 uuid;
 *   text/thinking 用所属 assistant 消息的 uuid;turn_end 用本回合最后一条带 uuid
 *   的 SDK 消息 uuid —— 因为 SDK 不把 result 写进 transcript,result.uuid 在
 *   forkSession 里查不到）；缺失时 UI 不显示 fork icon
 * - `turnClosed` 仅用于消息流语义记录（result 出现后所属 turn 闭环），
 *   不再作为 fork icon 守卫的条件 —— fork 守卫只看 messageUuid 是否存在,
 *   避免 fork 切片末端的 thinking/text/turn_end 因 turn 未闭环而无法继续 fork。
 */
export type RenderItem =
  | {
      kind: 'user'
      key: string
      rawContent: unknown
      messageUuid?: string
      turnClosed: boolean
    }
  | {
      kind: 'text'
      key: string
      text: string
      streaming: boolean
      messageUuid?: string
      turnClosed: boolean
    }
  | {
      kind: 'thinking'
      key: string
      text: string
      streaming: boolean
      messageUuid?: string
      turnClosed: boolean
    }
  | {
      kind: 'tool_use'
      key: string
      toolUseId: string
      toolName: string
      input: unknown
      result?: ToolResult
    }
  | {
      kind: 'ask_user_question'
      key: string
      toolUseId: string
      input: AskUserQuestionInput
    }
  | {
      kind: 'turn_end'
      key: string
      isError: boolean
      /** 本回合（自上一条 result 之后）每模型 token 用量增量，多模型分多行展示 */
      modelUsages?: Array<{ model: string; usage: ModelTokenUsage }>
      messageUuid?: string
      /** turn_end 永远闭环（result 一定意味着本回合 tool_use 全部已 result） */
      turnClosed: true
    }
  | {
      kind: 'agent_complete'
      key: string
      outputName?: string
      displayContent?: string
      /** Agent 通过 AgentComplete 写入的 shareValues 变更 */
      shareValues?: Record<string, string>
      /** 截至本 session 结束的 token 累计（按模型拆分），来自最后一条 result.modelUsage */
      modelBreakdown?: Array<{ model: string; usage: ModelTokenUsage }>
      /** 截至本 session 结束的总成本，来自最后一条 result.total_cost_usd */
      totalCost?: number
    }

type CacheEntry = {
  nextScanStart: number
  items: RenderItem[]
  pendingTooluse: Record<string, number>
  /** 上一条 result 的 modelUsage 累计（per model）—— 用于计算本回合增量 */
  prevModelUsage: Record<string, ModelTokenUsage>
  /** 截至最近一条 result 的 total_cost_usd（session 累计成本） */
  lastTotalCost: number
  /**
   * 当前 turn 起始 item 索引（自上一个 turn_end 之后第一条 item）。
   * 遇到 turn_end 时把 [turnStartIdx, turn_end) 区间内所有 item 的 turnClosed 置 true。
   */
  turnStartIdx: number
  /**
   * AgentComplete 的 mcp_tool_use 已出现。该 tool 一旦被调用就标志 agent 决定收尾,
   * 后续 SDK 还可能因为中断时序生成多余消息(text / 重试 tool_use / 失败 tool_result),
   * 这些都应被丢弃,只保留 flow.signal.agentComplete 的「完成卡片」。
   */
  agentCompleteSeen: boolean
}

// ── 缓存 ─────────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>()

export function clearBuildCache(sessionId?: string): void {
  if (sessionId) {
    cache.delete(sessionId)
  } else {
    cache.clear()
  }
}

/** 按 sessionId 列表批量清除缓存 */
export function clearBuildCacheForSessions(sessionIds: string[]): void {
  for (const id of sessionIds) {
    cache.delete(id)
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────

/** 从 tool_result 的 content 中提取纯文本 */
function extractToolResultText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && b.type === 'text') return b.text ?? ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 把 SDK result.modelUsage 规整为 Record<model, ModelTokenUsage>（剔除非对象项） */
function readResultModelUsage(message: unknown): Record<string, ModelTokenUsage> {
  const raw = (message as any)?.modelUsage
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, ModelTokenUsage> = {}
  for (const [model, value] of Object.entries(raw)) {
    if (value && typeof value === 'object') {
      out[model] = extractModelTokenUsage(value as Record<string, number>)
    }
  }
  return out
}

// ── 核心构建 ─────────────────────────────────────────────────────────────

function scanIncremental(msgs: ExtensionToWebviewMessage[], cached: CacheEntry): void {
  const { items, pendingTooluse, nextScanStart } = cached

  /**
   * 取「该索引之前最后一条 SDK transcript 中带 uuid 的消息」的 uuid。
   * 用于给 user / turn_end item 提供 fork 锚点。
   *
   * **必须按 message.type 白名单过滤为 'user' | 'assistant'**：
   * `includePartialMessages: true` 时 SDK 会流出 SDKPartialAssistantMessage
   * (`type: 'stream_event'`),其 uuid 是流式事件内部标识,不在 SDK transcript 里。
   * 若不过滤会误命中 stream_event uuid,forkSession(srcSessionId, { upToMessageId })
   * 直接报 `Message <uuid> not found`。SDKSystemMessage / SDKResultMessage 也无 uuid 字段。
   *
   * - SDKUserMessage.uuid 是可选的（webview 重放的 user 通常没有,跳过）
   * - SDKUserMessageReplay (type='user', isReplay=true) uuid 必选
   * - SDKAssistantMessage (type='assistant') uuid 必选
   * - 第一条 user（之前没有任何 SDK 消息）会得到 undefined,UI 不显示 fork icon
   */
  const findPrevUuid = (idx: number): string | undefined => {
    for (let j = idx - 1; j >= 0; j--) {
      const prev = msgs[j]
      if (prev.type !== 'flow.signal.aiMessage') continue
      const sdkMsg = prev.data.message as { type?: string; uuid?: string }
      if (sdkMsg.type !== 'user' && sdkMsg.type !== 'assistant') continue
      if (sdkMsg.uuid) return sdkMsg.uuid
    }
    return undefined
  }

  for (let i = nextScanStart; i < msgs.length; i++) {
    const mIdx = i
    const msg = msgs[i]

    if (msg.type === 'flow.signal.agentComplete') {
      const data = msg.data
      // session 结束时把缓存里累计到此刻的 modelUsage / total_cost 作为 breakdown
      // 写到 agent_complete 项上（"session 结束"后展示按模型分布）
      const modelBreakdown = Object.entries(cached.prevModelUsage)
        .map(([model, usage]) => ({ model, usage }))
        .filter((b) => isModelTokenUsageNonZero(b.usage) || b.usage.costUSD > 0)
      items.push({
        kind: 'agent_complete',
        key: `${mIdx}-complete`,
        outputName: data.output?.name,
        displayContent: data.content,
        shareValues:
          data.shareValues && Object.keys(data.shareValues).length > 0
            ? data.shareValues
            : undefined,
        modelBreakdown: modelBreakdown.length > 0 ? modelBreakdown : undefined,
        totalCost: cached.lastTotalCost > 0 ? cached.lastTotalCost : undefined,
      })
      continue
    }

    if (msg.type !== 'flow.signal.aiMessage') continue
    // AgentComplete tool_use 一旦出现就视为本 session 收尾,后续 ai 消息（含
    // 中断时序产生的多余 text / 重试 tool_use / MCP AbortError tool_result）一律丢弃。
    if (cached.agentCompleteSeen) continue
    const { message } = msg.data
    const messageUuid = (message as { uuid?: string }).uuid

    if (message.type === 'user') {
      const rawContent = message.message.content
      if (
        Array.isArray(rawContent) &&
        rawContent.every((b: any) => b && typeof b === 'object' && b.type === 'tool_result')
      ) {
        // tool_result：通过 pendingTooluse 定位对应 tool_use 项并填充 result
        rawContent.forEach((block: any) => {
          if (block?.type !== 'tool_result' || !block.tool_use_id) return
          const idx = pendingTooluse[block.tool_use_id]
          if (idx === undefined) return
          const item = items[idx]
          if (item && item.kind === 'tool_use') {
            items[idx] = {
              ...item,
              result: {
                isError: !!block.is_error,
                text: extractToolResultText(block.content),
              },
            }
          }
          delete pendingTooluse[block.tool_use_id]
        })
        continue
      }
      if (message.isSynthetic) continue
      if (message.parent_tool_use_id) continue
      // user fork 语义：fork 上一条消息 = 让用户重新说一次。messageUuid 取
      // 上一条 SDK 消息的 uuid（不是 user 自己的 uuid,因为 SDKUserMessage.uuid
      // 经常缺失）。第一条 user 没有上一条,messageUuid undefined → UI 不显示 fork icon。
      items.push({
        kind: 'user',
        key: `${mIdx}-user`,
        rawContent,
        messageUuid: findPrevUuid(mIdx),
        turnClosed: false,
      })
      continue
    }

    if (message.type === 'assistant') {
      const blocks = message.message.content
      if (!Array.isArray(blocks)) continue

      // 完整消息到达：移除尾部所有 streaming text/thinking 占位项
      while (items.length > 0) {
        const last = items[items.length - 1]
        if ((last.kind === 'text' || last.kind === 'thinking') && last.streaming) {
          items.pop()
        } else {
          break
        }
      }

      blocks.forEach((block: any, bIdx: number) => {
        // 同一条 assistant 消息中,AgentComplete 之后的 block 一律忽略。
        if (cached.agentCompleteSeen) return
        const key = `${mIdx}-${bIdx}`
        if (block.type === 'text' && typeof block.text === 'string') {
          items.push({
            kind: 'text',
            key,
            text: block.text,
            streaming: false,
            messageUuid,
            turnClosed: false,
          })
          return
        }
        if (block.type === 'thinking' && block.thinking) {
          items.push({
            kind: 'thinking',
            key,
            text: block.thinking,
            streaming: false,
            messageUuid,
            turnClosed: false,
          })
          return
        }
        if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
          const toolName =
            'server_name' in block ? `${block.server_name}::${block.name}` : block.name
          // AgentComplete 是终结型 tool —— 不渲染 tool 卡片(避免被中断的 MCP
          // AbortError 显示为「失败」,也避免成功结果与下方完成卡片重复),
          // 同时作为 session 收尾的标志。后续若 SDK 还流出多余 text / 重试调用,
          // 会被外层 agentCompleteSeen 跳过。
          // MCP tool 的 block.name 形态可能是 `mcp__<server>__AgentComplete`
          // (普通 tool_use),也可能是带 server_name 的 mcp_tool_use,统一按
          // toolName 末段匹配。
          if (
            toolName === 'AgentControllerMcp::AgentComplete' ||
            toolName === 'mcp__AgentControllerMcp__AgentComplete' ||
            (block.type === 'mcp_tool_use' &&
              (block as any).server_name === 'AgentControllerMcp' &&
              block.name === 'AgentComplete')
          ) {
            cached.agentCompleteSeen = true
            return
          }
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            const input = block.input as AskUserQuestionInput | undefined
            if (input && Array.isArray(input.questions)) {
              items.push({ kind: 'ask_user_question', key, toolUseId: block.id, input })
            }
            return
          }
          items.push({
            kind: 'tool_use',
            key,
            toolUseId: block.id,
            toolName,
            input: block.input,
          })
          pendingTooluse[block.id] = items.length - 1
          return
        }
        if (block.type === 'mcp_tool_result' && block.tool_use_id) {
          const idx = pendingTooluse[block.tool_use_id]
          if (idx === undefined) return
          const item = items[idx]
          if (item && item.kind === 'tool_use') {
            items[idx] = {
              ...item,
              result: {
                isError: !!block.is_error,
                text: extractToolResultText(block.content),
              },
            }
          }
          delete pendingTooluse[block.tool_use_id]
          return
        }
      })
      continue
    }

    if (message.type === 'result') {
      const isError = 'error' in message && !!message.error
      // result.modelUsage 是 session 累计；本回合增量 = 当前累计 - 上次累计
      const currModelUsage = readResultModelUsage(message)
      const modelUsages: Array<{ model: string; usage: ModelTokenUsage }> = []
      for (const [model, curr] of Object.entries(currModelUsage)) {
        const prev = cached.prevModelUsage[model]
        const delta = prev ? subtractModelTokenUsage(curr, prev) : curr
        if (isModelTokenUsageNonZero(delta) || delta.costUSD > 0) {
          modelUsages.push({ model, usage: delta })
        }
      }
      // 用本条 result 的累计快照覆盖 prev，供下回合计算增量
      cached.prevModelUsage = currModelUsage
      const cost = (message as any).total_cost_usd
      if (typeof cost === 'number') cached.lastTotalCost = cost

      // 把当前 turn 内（自上一个 turn_end 之后）所有 user/text/thinking item 标记为已闭环
      for (let j = cached.turnStartIdx; j < items.length; j++) {
        const it = items[j]
        if (it.kind === 'user' || it.kind === 'text' || it.kind === 'thinking') {
          items[j] = { ...it, turnClosed: true }
        }
      }

      items.push({
        kind: 'turn_end',
        key: `${mIdx}-result`,
        isError,
        modelUsages: modelUsages.length > 0 ? modelUsages : undefined,
        // SDK 不把 result 写进 transcript（SessionMessage.type 仅 'user'|'assistant'|'system'），
        // SDKResultMessage 也不带 uuid。turn_end fork 必须落到一个能被 forkSession
        // 识别的节点 —— 取本回合最后一条带 uuid 的 SDK 消息（通常是该回合最后一条
        // assistant），以此为 fork 锚点等价于「fork 到回合结束」。
        messageUuid: findPrevUuid(mIdx),
        turnClosed: true,
      })
      cached.turnStartIdx = items.length
      continue
    }

    if (message.type === 'stream_event') {
      const event = message.event as any
      if (event?.type !== 'content_block_delta') continue
      const delta = event.delta
      if (!delta) continue
      const blockType: 'text' | 'thinking' | null =
        delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : null
      if (!blockType) continue
      const deltaText: string =
        delta.type === 'text_delta' ? (delta.text ?? '') : (delta.thinking ?? '')
      if (!deltaText) continue
      // 累加到最后一条同类型 streaming 项；否则新建
      const last = items[items.length - 1]
      if (last && last.kind === blockType && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + deltaText }
      } else {
        const key = `${mIdx}-streaming-${event.index ?? 0}`
        if (blockType === 'text') {
          items.push({
            kind: 'text',
            key,
            text: deltaText,
            streaming: true,
            turnClosed: false,
          })
        } else {
          items.push({
            kind: 'thinking',
            key,
            text: deltaText,
            streaming: true,
            turnClosed: false,
          })
        }
      }
      continue
    }
  }
}

/**
 * 按 sessionId 缓存的渲染项构建器。
 *
 * - 首次调用：扫描全部消息，将扫描中间态与最终产物缓存。
 * - 后续调用：消息未增长则直接返回缓存；消息增长则从断点继续增量扫描。
 */
export function buildRenderItems(
  sessionId: string,
  msgs: ExtensionToWebviewMessage[],
): RenderItem[] {
  const cached = match(cache.has(sessionId))
    .with(true, () => cache.get(sessionId)!)
    .with(false, () => {
      cache.set(sessionId, {
        nextScanStart: 0,
        items: [],
        pendingTooluse: {},
        prevModelUsage: {},
        lastTotalCost: 0,
        turnStartIdx: 0,
        agentCompleteSeen: false,
      })
      return cache.get(sessionId)!
    })
    .exhaustive()

  // 消息未增长 → 直接返回缓存
  if (cached.nextScanStart === msgs.length) {
    return cached.items
  }

  scanIncremental(msgs, cached)
  cached.nextScanStart = msgs.length
  return cached.items
}
