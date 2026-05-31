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
 */
export type RenderItem =
  | {
      kind: 'user'
      key: string
      rawContent: unknown
      messageUuid?: string
    }
  | {
      kind: 'text'
      key: string
      text: string
      streaming: boolean
      messageUuid?: string
    }
  | {
      kind: 'thinking'
      key: string
      text: string
      streaming: boolean
      messageUuid?: string
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
    }
  | {
      kind: 'agent_complete'
      key: string
      outputName?: string
      displayContent?: string
      /** Agent 通过 AgentComplete 写入的 values 变更（reducer 会合并到 Flow.shareValues） */
      values?: Record<string, string>
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
   * 上下文窗口占用快照表：RenderItem.key → { used, total }。
   * 仅 turn_end / agent_complete 写入（per-block 不再展示）。
   * 缺失则不存,渲染层查不到自然不展示（不做兜底）。
   * 每个 turn 完全按本 result 数据独立计算,不做 sticky max。
   */
  contextUsageByItemKey: Map<string, { used: number; total: number }>
  /**
   * Session 主模型(SDK system/init 消息的顶层 model 字段)。上下文窗口仅按主模型计算 ——
   * 多模型 (例如 sonnet 主模型 + haiku 辅助模型) 时 modelUsage 会有多 entry,
   * 只有主模型那条的 contextWindow 反映真实窗口压力。
   */
  mainModel?: string
  /**
   * 最近一条 result 落入 contextUsageByItemKey 的快照,供随后的 agent_complete 卡片复用。
   * 不参与 turn_end 计算 —— turn_end 直接读本 result 数据,这里只是给 agent_complete 兜底
   * 让"session 总结"卡片能展示最后一个 turn 的窗口占用。
   */
  lastTurnContextUsage?: { used: number; total: number }
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

/** 按 runId 列表批量清除缓存(调用方在 flow 重启时把对应 run 的缓存清掉) */
export function clearBuildCacheForRuns(runIds: string[]): void {
  for (const id of runIds) {
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

/**
 * 从 message.usage（snake_case raw API usage）算「本次输入总 tokens」。
 * = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 * 这是真实喂给模型的 token 总量,反映上下文窗口当前装了多少。
 *
 * 多 iteration 场景(server-side tool / 长 tool loop):usage.iterations 是
 * 每次 sampling/compaction 的 per-iteration usage 数组,顶层 usage 在多
 * iteration 时可能是聚合值,直接取顶层会把多轮重复喂入累加,虚高窗口占用。
 * SDK 文档明确:「Calculate the true context window size from the last iteration」
 * —— 优先取数组末项(最后一次模型实际看到的输入),无 iterations 退回顶层。
 */
function readUsageInputTotal(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0
  const u = usage as Record<string, unknown>
  const iterations = u.iterations
  const source =
    Array.isArray(iterations) && iterations.length > 0
      ? (iterations[iterations.length - 1] as Record<string, number | undefined> | null)
      : (u as Record<string, number | undefined>)
  if (!source || typeof source !== 'object') return 0
  return (
    (source.input_tokens ?? 0) +
    (source.cache_read_input_tokens ?? 0) +
    (source.cache_creation_input_tokens ?? 0)
  )
}

/**
 * 从 result.modelUsage 取主模型的 contextWindow。
 * 主模型未确定 / modelUsage 中无该模型 entry / entry 无 contextWindow 一律返回 0,
 * 调用方据此跳过展示(不做兜底)。
 */
function readContextWindow(modelUsage: unknown, mainModel: string | undefined): number {
  if (!mainModel || !modelUsage || typeof modelUsage !== 'object') return 0
  const entry = (modelUsage as Record<string, any>)[mainModel]
  if (entry && typeof entry.contextWindow === 'number') return entry.contextWindow
  return 0
}

/**
 * 把一条 result 消息并入缓存的 session 累计快照,返回本回合用量增量与窗口占用。
 *
 * 两处调用:
 * - result aiMessage(每 turn 结束):用返回的 modelUsages / turnContextUsage 生成 turn_end。
 * - agentComplete.data.result:AgentComplete 暂存后这条 result 不再单独透传为 aiMessage
 *   (见 src/common/event.ts 的 agentComplete.result),不走下面的 result 分支,只取副作用
 *   刷新 cached,让随后的 agent_complete 卡片拿到截至 session 结束的累计 / 成本 / 窗口。
 *
 * 副作用(覆盖式赋值,幂等):
 * - prevModelUsage ← 本条 result.modelUsage 累计(供下回合算增量 / agent_complete 取 session 累计)
 * - lastTotalCost  ← 本条 result.total_cost_usd
 * - lastTurnContextUsage ← 本回合主模型窗口占用(缺失则保留旧值)
 */
function applyResultToCache(
  message: unknown,
  cached: CacheEntry,
): {
  modelUsages: Array<{ model: string; usage: ModelTokenUsage }>
  turnContextUsage?: { used: number; total: number }
} {
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

  // 上下文窗口:每 turn 独立按本 result 数据计算,仅主模型 entry 的 contextWindow。
  // 主模型来自 system/init 消息(见 scanIncremental 的 system 分支),不从 result.model 取 ——
  // result.model 在多模型场景可能切到辅助模型,会让窗口数据抖动。
  // used = result.usage 的 input_total。任何一项缺失则该 turn 不展示。
  const contextWindow = readContextWindow((message as any).modelUsage, cached.mainModel)
  const resultUsed = readUsageInputTotal((message as any).usage)
  const turnContextUsage =
    contextWindow > 0 && resultUsed > 0 ? { used: resultUsed, total: contextWindow } : undefined
  if (turnContextUsage) cached.lastTurnContextUsage = turnContextUsage

  return { modelUsages, turnContextUsage }
}

// ── 核心构建 ─────────────────────────────────────────────────────────────

function scanIncremental(msgs: ExtensionToWebviewMessage[], cached: CacheEntry): void {
  const { items, pendingTooluse, nextScanStart } = cached

  /**
   * 寻找 idx 之前(不包含)最近一条 user/assistant 消息的 uuid。
   *
   * 必须按 message.type 白名单过滤为 'user' | 'assistant':
   * `includePartialMessages: true` 时 SDK 会流出 SDKPartialAssistantMessage
   * (type='stream_event'),其 uuid 是流式事件内部标识,不在 SDK transcript 里。
   * 不过滤会误命中 stream_event uuid → forkSession 报 `Message <uuid> not found`。
   * SDKResultMessage 同理无 uuid（result.uuid 不在 transcript）。
   *
   * 用途:user / turn_end item 的 fork 锚点(user 自己 uuid 常缺、user fork 语义
   * = 截到上一条含 uuid 的 SDK 消息;turn_end fork = 截到本回合最后带 uuid 的 SDK 消息)。
   *
   * @param idx message 的 index
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
      // AgentComplete 暂存后这条 result 不再单独透传为 aiMessage(不走下面的 result 分支),
      // 在此手动并入缓存,否则 modelBreakdown / totalCost / 窗口占用会停留在上一条 result。
      if (data.result) applyResultToCache(data.result, cached)
      // session 结束时把缓存里累计到此刻的 modelUsage / total_cost 作为 breakdown
      // 写到 agent_complete 项上（"session 结束"后展示按模型分布）
      const modelBreakdown = Object.entries(cached.prevModelUsage)
        .map(([model, usage]) => ({ model, usage }))
        .filter((b) => isModelTokenUsageNonZero(b.usage) || b.usage.costUSD > 0)
      const completeKey = `${mIdx}-complete`
      items.push({
        kind: 'agent_complete',
        key: completeKey,
        outputName: data.output?.name,
        displayContent: data.content,
        values: data.values && Object.keys(data.values).length > 0 ? data.values : undefined,
        modelBreakdown: modelBreakdown.length > 0 ? modelBreakdown : undefined,
        totalCost: cached.lastTotalCost > 0 ? cached.lastTotalCost : undefined,
      })
      // agent_complete 上下文占用:复用 turn_end 时落下的 lastTurnContextUsage 快照,
      // 即"最后一个 turn 的窗口占用"。每 turn 独立算,不做 sticky max,因此直接复用快照。
      if (cached.lastTurnContextUsage) {
        cached.contextUsageByItemKey.set(completeKey, cached.lastTurnContextUsage)
      }
      continue
    }

    if (msg.type !== 'flow.signal.aiMessage') continue
    const { message } = msg.data
    const messageUuid = message.uuid

    // 新session 重置缓存信息
    if (message.type === 'system' && message.subtype === 'init') {
      cached.mainModel = message.model
      cached.prevModelUsage = {}
      cached.lastTotalCost = 0
      cached.lastTurnContextUsage = undefined
      continue
    }

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
      })
      continue
    }
    // 累加流式消息
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
      const last = items.at(-1)
      if (last && last.kind === blockType && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + deltaText }
      } else {
        items.push({
          kind: blockType,
          key: `${mIdx}`,
          text: deltaText,
          streaming: true,
        })
      }
      continue
    }

    if (message.type === 'assistant') {
      const blocks = message.message.content
      if (!Array.isArray(blocks)) continue
      // 完整消息到达 移除尾部所有 streaming text/thinking 占位项 后续直接添加完整数据
      while (items.length > 0) {
        const last = items[items.length - 1]
        if ((last.kind === 'text' || last.kind === 'thinking') && last.streaming) {
          items.pop()
        } else {
          break
        }
      }
      blocks.forEach((block, bIdx: number) => {
        const key = `${mIdx}-${bIdx}`
        if (block.type === 'text' && typeof block.text === 'string') {
          items.push({
            kind: 'text',
            key,
            text: block.text,
            streaming: false,
            messageUuid,
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
          })
          return
        }
        if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
          // 匹配AgentControllerMcp提供的AgentComplete tool
          // 此后同一session不应展示
          const toolName =
            'server_name' in block ? `${block.server_name}::${block.name}` : block.name
          if (
            toolName === 'AgentControllerMcp::AgentComplete' ||
            toolName === 'mcp__AgentControllerMcp__AgentComplete' ||
            (block.type === 'mcp_tool_use' &&
              (block as any).server_name === 'AgentControllerMcp' &&
              block.name === 'AgentComplete')
          ) {
            // 创建 render item 让 MessageBubble 可挂 AgentCompleteConfirmCard；
            // pendingAgentCompleteId 非空时 user 消息放行以便处理 tool_result（拒绝 vs 接受）。
            items.push({ kind: 'tool_use', key, toolUseId: block.id, toolName, input: block.input })
            pendingTooluse[block.id] = items.length - 1
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
      const { modelUsages, turnContextUsage } = applyResultToCache(message, cached)

      const turnEndKey = `${mIdx}-result`
      items.push({
        kind: 'turn_end',
        key: turnEndKey,
        isError,
        modelUsages: modelUsages.length > 0 ? modelUsages : undefined,
        // SDK 不把 result 写进 transcript（SessionMessage.type 仅 'user'|'assistant'|'system'），
        // SDKResultMessage 也不带 uuid。turn_end fork 必须落到一个能被 forkSession
        // 识别的节点 —— 取本回合最后一条带 uuid 的 SDK 消息（通常是该回合最后一条
        // assistant），以此为 fork 锚点等价于「fork 到回合结束」。
        messageUuid: findPrevUuid(mIdx),
      })
      if (turnContextUsage) {
        cached.contextUsageByItemKey.set(turnEndKey, turnContextUsage)
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
        contextUsageByItemKey: new Map(),
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

/**
 * 取某个 RenderItem.key 对应的上下文窗口占用快照。
 * - 仅在该 session 已经至少出现过一条带 contextWindow 的 result 后才返回非 undefined
 * - assistant 消息映射的是「该 assistant 消息最后一个气泡」的 key
 * - turn_end / agent_complete 各自的 key
 */
export function getContextUsage(
  sessionId: string,
  itemKey: string,
): { used: number; total: number } | undefined {
  return cache.get(sessionId)?.contextUsageByItemKey.get(itemKey)
}
