import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { produce } from 'immer'
import { match, P } from 'ts-pattern'
import type {
  AIMessageType,
  ExtensionFlowCommandMessage,
  ExtensionFlowSignalMessage,
  UserMessageType,
} from './event'
import type { Agent, Code, Flow } from './index'
import { pickInjectedShareValues } from './index'

// ── TokenUsage ────────────────────────────────────────────────────────────

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export const emptyTokenUsage: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
})

/** 从 BetaUsage（可能含 null/undefined 的缓存字段）提取 TokenUsage */
export const extractTokenUsage = (u: {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}): TokenUsage => ({
  input_tokens: u.input_tokens ?? 0,
  output_tokens: u.output_tokens ?? 0,
  cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
})

export const subtractTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input_tokens: a.input_tokens - b.input_tokens,
  output_tokens: a.output_tokens - b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens - b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens - b.cache_read_input_tokens,
})

// ── ModelTokenUsage ───────────────────────────────────────────────────────
//
// SDK result.modelUsage 是 Record<modelName, ModelUsage>（camelCase），自带
// SDK 算好的 costUSD。webview 不直连 SDK，所以在 common 镜像等价类型 + helper：
//   - 计算回合增量（当前 modelUsage 累计 - 上一回合累计）
//   - 在 agent_complete 上展示 session 累计 breakdown

export type ModelTokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  costUSD: number
}

export const emptyModelTokenUsage: ModelTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUSD: 0,
}

export const extractModelTokenUsage = (u: {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  costUSD?: number
}): ModelTokenUsage => ({
  inputTokens: u.inputTokens ?? 0,
  outputTokens: u.outputTokens ?? 0,
  cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
  cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
  costUSD: u.costUSD ?? 0,
})

export const subtractModelTokenUsage = (
  a: ModelTokenUsage,
  b: ModelTokenUsage,
): ModelTokenUsage => ({
  inputTokens: a.inputTokens - b.inputTokens,
  outputTokens: a.outputTokens - b.outputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens - b.cacheCreationInputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens - b.cacheReadInputTokens,
  costUSD: a.costUSD - b.costUSD,
})

export const isModelTokenUsageNonZero = (u: ModelTokenUsage): boolean =>
  u.inputTokens > 0 ||
  u.outputTokens > 0 ||
  u.cacheCreationInputTokens > 0 ||
  u.cacheReadInputTokens > 0

// ── Token 定价与费用 ─────────────────────────────────────────────────────

export type TokenPricing = {
  input: number
  output: number
  cache_write: number
  cache_read: number
}

export const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export const formatTokenCost = (cost: number): string => {
  if (cost <= 0) return ''
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

// ── SDK 类型派生（indexed access + Extract，零额外依赖） ───────────────────────
type StreamEvent = SDKPartialAssistantMessage['event']
type UserContent = SDKUserMessage['message']['content']
type StreamEventOf<T extends StreamEvent['type']> = Extract<StreamEvent, { type: T }>
type DeltaOf<T extends StreamEventOf<'content_block_delta'>['delta']['type']> = Extract<
  StreamEventOf<'content_block_delta'>['delta'],
  { type: T }
>

// ── 累加态消息模型（ChatItem，直接渲染） ──────────────────────────────────────
//
// 与原始 SDK 信号流不同:接收事件时即累加成可直接渲染的 ChatMessage:
// text/thinking 只经 stream_event delta 累加,assistant 到达时仅标 done + 回填 uuid;
// tool_use 由 content_block_start 建占位、assistant 填完整 input/toolName;
// tool_result 合并进 tool_use 项;每项带 status、保留 parentToolUseId。
//
// 在蓝本 text/thinking/tool_use/user 之外,扩展出三个纯渲染派生项:
// - turn_end:普通回合 result 到达时由 reducer 算 token 增量 / 窗口占用后 push(替代 result 项)。
// - agent_complete:agentComplete 时 push,带 session 累计 breakdown / totalCost / 窗口。
// - error:agentError / error 时 push。
// 渲染层只做 1:1 React 节点映射 + subagent 归组,不再做任何语义合并 / 二次扫描。

/** text/thinking 项的流式状态 */
export type StreamStatus = 'streaming' | 'done' | 'interrupted'
/** tool_use 项的执行状态 */
export type ToolStatus = 'pending' | 'done' | 'interrupted'
export type ToolResult = { isError: boolean; text: string }

/** 上下文窗口占用快照:used = 本次喂给模型的 input+cache 总量,total = 主模型 contextWindow */
export type ContextUsage = { used: number; total: number }
/** 单模型 token 用量条目(turn_end 的回合增量 / agent_complete 的 session 累计) */
export type ModelUsageEntry = { model: string; usage: ModelTokenUsage }

/**
 * 所有 ChatMessage 共有字段。
 * - id:`run.acc.seq++` 单调分配、永不复用 —— 稳定渲染 key。
 * - parentToolUseId:非空 = 来自该 tool_use 的 subagent,用于归组到父气泡下。
 * - uuid:透传 SDK 原生 uuid（供 fork 寻址）;turn_end / agent_complete / error 无 uuid。
 */
type Base = { id: string; parentToolUseId?: string; uuid?: string }

export type TextMessage = Base & { kind: 'text'; status: StreamStatus; text: string }
export type ThinkingMessage = Base & {
  kind: 'thinking'
  status: StreamStatus
  text: string
  signature?: string
}
export type ToolUseMessage = Base & {
  kind: 'tool_use'
  status: ToolStatus
  toolUseId: string
  /** mcp → `${server_name}::${name}`,普通工具 → name */
  toolName: string
  /** 以 assistant 完整 block.input 为准（流式占位期为 {}） */
  input: unknown
  /** tool_result 合并后填充 */
  result?: ToolResult
}
export type UserMessage = Base & {
  kind: 'user'
  rawContent: UserContent
  /** 首条用户消息注入的共享存储 */
  injectedShareValues?: Record<string, string | null>
}
/** 普通回合结束 —— 替代原始 SDK result 信号,携带本回合 token 增量与窗口占用 */
export type TurnEndMessage = Base & {
  kind: 'turn_end'
  isError: boolean
  /** 本回合（自上一条 result 之后）每模型 token 用量增量 */
  modelUsages?: ModelUsageEntry[]
  /** 本回合主模型上下文窗口占用 */
  contextUsage?: ContextUsage
}
/** Agent 完成卡片 —— CompleteTask 成功完成时 push */
export type AgentCompleteMessage = Base & {
  kind: 'agent_complete'
  outputName?: string
  displayContent?: string
  /** Agent 通过 CompleteTask 写入的 values 变更 */
  values?: Record<string, string>
  /** 截至本 session 结束的 token 累计（按模型拆分） */
  modelBreakdown?: ModelUsageEntry[]
  /** 截至本 session 结束的总成本 */
  totalCost?: number
  /** 最后一个 turn 的主模型窗口占用 */
  contextUsage?: ContextUsage
}
/** 错误项 —— agentError / error 时 push */
export type ErrorMessage = Base & { kind: 'error'; message: string }

export type ChatMessage =
  | TextMessage
  | ThinkingMessage
  | ToolUseMessage
  | UserMessage
  | TurnEndMessage
  | AgentCompleteMessage
  | ErrorMessage

// ── Phase ────────────────────────────────────────────────────────────────────

/**
 * Flow 级 phase —— 只描述整个 flow 的生命周期。
 * `result` / `awaiting-tool-permission` 在控制语义上一致（可中断、不可改图），区别仅在等待对象。
 */
export type FlowPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'result'
  | 'interrupted'
  | 'awaiting-tool-permission'
  | 'completed'
  | 'stopped'
  | 'error'

/**
 * Agent 级 phase —— 每个 ChatPanel 只关心自己的状态。
 * 与 FlowPhase 同构（仅在非活跃 agent 上差异：根据是否完成投影为 idle/completed）。
 */
export type AgentPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'result'
  | 'interrupted'
  | 'awaiting-tool-permission'
  | 'completed'
  | 'stopped'
  | 'error'

// ── State 数据结构 ───────────────────────────────────────────────────────────

/**
 * 单个 Agent 运行实例。phase 由 [getRunPhase] 从 messages + 显式标志推断,不存字段。
 *
 * - messages:累加态 ChatMessage[]（原 ExtensionToWebviewMessage[] 原始信号流）。
 * - error/interrupted:累加态无 raw signal 可扫,运行态显式标志承载。
 * - acc:累加中间态,reducer 跨调用保留。Record 而非 Map（immer 友好 + postMessage 可序列化）。
 */
export type AgentRun = {
  /** 主键 —— flowStart 路径由 webview 生成,next_agent / fork 路径由 extension 生成 */
  runId: string
  agentId: string
  /** SDK 首条消息送达后由 reducer 从 message.session_id 回填 */
  sessionId?: string
  /** 当前 run 的累加态消息流 */
  messages: ChatMessage[]
  completed: boolean
  outputName?: string
  /** agentError / error 分支写入 → phase=error */
  error?: string
  /** agentInterrupted→true;下一条 aiMessage 累加时清 false */
  interrupted?: boolean
  /**
   * 累加中间态:
   * - activeBlocks:`${parentToolUseId??''}#${blockIndex}` → messages 下标。
   *   主线与各 subagent 的 blockIndex 各自从 0 计会冲突,复合 key 区分。
   * - toolUseIndex:toolUseId → messages 下标（result 可能先于完整 assistant 到达,故 start 即登记）。
   * - seq:id 计数器。assistant 到达时删流式占位但 seq 不复用 → id 唯一。
   * - prevModelUsage:上一条 result 的 modelUsage 累计（per model）—— 算回合增量 / agent_complete 取 session 累计。
   * - mainModel:SDK system/init 顶层 model —— 上下文窗口仅按主模型 entry 的 contextWindow 计算。
   * - lastTotalCost:最近一条 result 的 total_cost_usd（session 累计成本）。
   * - lastTurnContextUsage:最近一个 turn 的主模型窗口占用,供 agent_complete 卡片复用。
   */
  acc: {
    activeBlocks: Record<string, number>
    toolUseIndex: Record<string, number>
    seq: number
    prevModelUsage: Record<string, ModelTokenUsage>
    mainModel?: string
    lastTotalCost: number
    lastTurnContextUsage?: ContextUsage
  }
}

export type PendingToolPermission = {
  toolUseId: string
  toolName: string
  input: unknown
  /** 所属 run */
  runId: string
}

/**
 * 单个 Flow 的运行态状态 —— extension 与 webview 同步的核心数据。
 *
 * 目前只允许单个活跃的run
 * Flow / Agent / Run 三层 phase 都不存字段,统一由 [getFlowPhase] / [getAgentPhase] /
 * [getRunPhase] 按需从 `runs` + `messages` + `pendings` + `killed` 推断。
 */
export type FlowRunState = {
  /** killFlow 后置 true;[getRunPhase] 据此把所有非终态 run 投影为 stopped */
  killed: boolean
  /** 按追加顺序排列的 AgentRun;首项是 flowStart 创建,后续由 next_agent */
  runs: AgentRun[]
  /**
   * 已回答的工具权限请求:toolUseId -> { allow, updatedInput },用于 UI 回显历史态。
   * updatedInput 供 AskUserQuestion 历史卡片回显用户(或 silent 自动)填写的答案。
   */
  answeredToolPermissions: Record<
    string,
    { allow: boolean; updatedInput?: unknown; message?: string }
  >
  /** 当前未回答的工具权限请求队列(按 runId 区分归属) —— 四类挂起统一入此队列 */
  pendingToolPermissions: PendingToolPermission[]
  /** Flow 运行时的共享数据 */
  shareValues: Record<string, string>
}

// ── 消息的副作用 ────────────────────────────────────────────────────────

export type MessageEffect = {
  flowId: string
  flowName: string
  /** 触发副作用的 run 主键 —— 通知 key 据此区分多 run 同 reason 的并发场景 */
  runId: string
  agentId: string
  agentName: string
  reason: 'result' | 'awaiting-tool-permission' | 'flow-completed' | 'agent-error'
  /** awaiting-tool-permission 时携带,供通知 / 状态标签按工具类型(.includes)出文案 */
  toolName?: string
}

// ── 累加辅助 ──────────────────────────────────────────────────────────────────

const emptyAcc = (): AgentRun['acc'] => ({
  activeBlocks: {},
  toolUseIndex: {},
  seq: 0,
  prevModelUsage: {},
  mainModel: undefined,
  lastTotalCost: 0,
  lastTurnContextUsage: undefined,
})

/** id 计数器 —— 单调自增、永不复用 */
function nextId(run: AgentRun): string {
  return String(run.acc.seq++)
}

/**
 * 把消息插入 run.messages,有 parentToolUseId 时插到父 tool_use 或同 parent 最后一条
 * 子消息之后(保证 subAgent 消息紧邻父 tool_use,而非散落在 run.messages 末尾)。
 * 中间插入会令 insertAt 之后的下标整体后移 —— 同步修正 activeBlocks / toolUseIndex。
 */
function insertAfterParent(
  run: AgentRun,
  item: ChatMessage,
  parentToolUseId: string | undefined,
): number {
  console.log(item)
  if (!parentToolUseId) {
    run.messages.push(item)
    return run.messages.length - 1
  }
  const parentIdx = run.acc.toolUseIndex[parentToolUseId]
  if (parentIdx === undefined) {
    run.messages.push(item)
    return run.messages.length - 1
  }
  // 从父 tool_use 往后扫,找同 parentToolUseId 的最后一条(已插入的兄弟 subAgent 消息)
  let insertAt = parentIdx + 1
  for (let i = parentIdx + 1; i < run.messages.length; i++) {
    if (run.messages[i].parentToolUseId === parentToolUseId) insertAt = i + 1
  }
  run.messages.splice(insertAt, 0, item)
  // 修正被后移的下标
  for (const k of Object.keys(run.acc.activeBlocks)) {
    if (run.acc.activeBlocks[k] >= insertAt) run.acc.activeBlocks[k]++
  }
  for (const id of Object.keys(run.acc.toolUseIndex)) {
    if (run.acc.toolUseIndex[id] >= insertAt) run.acc.toolUseIndex[id]++
  }
  return insertAt
}

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

/** 新建流式 text/thinking 占位项,登记 activeBlocks,返回下标 */
function pushStreamItem(
  run: AgentRun,
  blockKey: string,
  kind: 'text' | 'thinking',
  parentToolUseId: string | undefined,
): number {
  const item: ChatMessage =
    kind === 'text'
      ? { id: nextId(run), kind: 'text', status: 'streaming', text: '', parentToolUseId }
      : { id: nextId(run), kind: 'thinking', status: 'streaming', text: '', parentToolUseId }
  const idx = insertAfterParent(run, item, parentToolUseId)
  run.acc.activeBlocks[blockKey] = idx
  return idx
}

/** 新建 pending tool_use 占位项,登记 activeBlocks + toolUseIndex */
function startTool(
  run: AgentRun,
  blockKey: string,
  toolUseId: string,
  toolName: string,
  parentToolUseId: string | undefined,
): void {
  const item: ToolUseMessage = {
    id: nextId(run),
    kind: 'tool_use',
    status: 'pending',
    toolUseId,
    toolName,
    input: {},
    parentToolUseId,
  }
  const idx = insertAfterParent(run, item, parentToolUseId)
  run.acc.activeBlocks[blockKey] = idx
  run.acc.toolUseIndex[toolUseId] = idx
}

/** content_block_delta:按 blockKey 取项累加;项不存在则 lazy-create */
function applyDelta(
  run: AgentRun,
  blockKey: string,
  delta: DeltaOf<'text_delta' | 'thinking_delta' | 'signature_delta'> | { type: string },
  parentToolUseId: string | undefined,
): void {
  match(delta)
    .with({ type: 'text_delta' }, (d: DeltaOf<'text_delta'>) => {
      const idx =
        run.acc.activeBlocks[blockKey] ?? pushStreamItem(run, blockKey, 'text', parentToolUseId)
      const it = run.messages[idx]
      if (it && it.kind === 'text') it.text += d.text
    })
    .with({ type: 'thinking_delta' }, (d: DeltaOf<'thinking_delta'>) => {
      const idx =
        run.acc.activeBlocks[blockKey] ?? pushStreamItem(run, blockKey, 'thinking', parentToolUseId)
      const it = run.messages[idx]
      if (it && it.kind === 'thinking') it.text += d.thinking
    })
    .with({ type: 'signature_delta' }, (d: DeltaOf<'signature_delta'>) => {
      const idx =
        run.acc.activeBlocks[blockKey] ?? pushStreamItem(run, blockKey, 'thinking', parentToolUseId)
      const it = run.messages[idx]
      if (it && it.kind === 'thinking') it.signature = (it.signature ?? '') + d.signature
    })
    // input_json_delta（partial JSON 不可信,以 assistant 完整 input 为准）、citations 等忽略
    .otherwise(() => {})
}

/** assistant 定稿 tool_use:补完整 input/toolName,不写 status（防 result 先到的 done 回退）;无占位则新建 pending */
function finalizeTool(
  run: AgentRun,
  toolUseId: string,
  toolName: string,
  input: unknown,
  parentToolUseId: string | undefined,
  uuid: string | undefined,
): void {
  const idx = run.acc.toolUseIndex[toolUseId]
  if (idx !== undefined) {
    const it = run.messages[idx]
    if (it && it.kind === 'tool_use') {
      it.input = input
      it.toolName = toolName
      it.uuid = uuid
      return
    }
  }
  const item: ToolUseMessage = {
    id: nextId(run),
    kind: 'tool_use',
    status: 'pending',
    toolUseId,
    toolName,
    input,
    parentToolUseId,
    uuid,
  }
  run.acc.toolUseIndex[toolUseId] = insertAfterParent(run, item, parentToolUseId)
}

/** 合并 tool_result 到对应 tool_use 项:置 done + 填 result;interrupted 项不被迟到 result 翻转 */
function mergeToolResult(
  run: AgentRun,
  toolUseId: string,
  isError: boolean,
  content: unknown,
): void {
  const idx = run.acc.toolUseIndex[toolUseId]
  if (idx === undefined) return
  const it = run.messages[idx]
  if (!it || it.kind !== 'tool_use') return
  if (it.status === 'interrupted') return
  it.status = 'done'
  it.result = { isError: !!isError, text: extractToolResultText(content) }
}

/** 中断:streaming 的 text/thinking、pending 的 tool_use 置 interrupted;done 不回退 */
export function markInterrupted(run: AgentRun): void {
  for (const m of run.messages) {
    if ((m.kind === 'text' || m.kind === 'thinking') && m.status === 'streaming') {
      m.status = 'interrupted'
    } else if (m.kind === 'tool_use' && m.status === 'pending') {
      m.status = 'interrupted'
    }
  }
}

const isToolResultBlock = (b: unknown): boolean =>
  !!b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'

/**
 * 把一条 SDK 消息累加进 run.messages（操作 immer draft 的 run 与 run.acc）。
 * 外层 match 取 stream_event/assistant/user/system,.otherwise 忽略其余分支。
 * result 不在此处理 —— 普通回合 result 由 reducer 显式 push turn_end。
 * userMessage&tool_use_id 为tooluse设置uuid;流式消息不设置uuid；assisant为最后一个thinking/text块设置uuid
 */
function appendSdkMessage(
  run: AgentRun,
  sdkMsg: AIMessageType,
  injectedShareValues?: Record<string, string | null>,
): void {
  match(sdkMsg)
    // ── 流式事件 ──────────────────────────────────────────────
    .with({ type: 'stream_event' }, (m: SDKPartialAssistantMessage) => {
      const parent = m.parent_tool_use_id ?? undefined
      const event = m.event
      match(event)
        .with({ type: 'content_block_start' }, (e: StreamEventOf<'content_block_start'>) => {
          const blockKey = `${parent ?? ''}#${e.index}`
          match(e.content_block)
            .with({ type: 'text' }, () => pushStreamItem(run, blockKey, 'text', parent))
            .with({ type: 'thinking' }, () => pushStreamItem(run, blockKey, 'thinking', parent))
            .with({ type: 'tool_use' }, (b) => startTool(run, blockKey, b.id, b.name, parent))
            .with({ type: 'mcp_tool_use' }, (b) =>
              startTool(run, blockKey, b.id, `${b.server_name}::${b.name}`, parent),
            )
            .otherwise(() => {})
        })
        .with({ type: 'content_block_delta' }, (e: StreamEventOf<'content_block_delta'>) => {
          const blockKey = `${parent ?? ''}#${e.index}`
          applyDelta(run, blockKey, e.delta, parent)
        })
        // content_block_stop / message_* → no-op（统一由 assistant 定稿转 done）
        .otherwise(() => {})
    })
    // ── 完整 assistant ────────────────────────────────────────
    .with({ type: 'assistant' }, (m: SDKAssistantMessage) => {
      const parent = m.parent_tool_use_id ?? undefined
      const uuid = m.uuid
      const blocks = m.message.content
      const prefix = `${parent ?? ''}#`
      // text/thinking 只会出现于 stream_event（delta 累加），assistant 到达时只需
      // 把流式占位转 done；uuid 仅赋给最后一个 text/thinking 块（同一 assistant
      // 消息共享一个 uuid，只暴露一个 fork 入口）
      let lastTextOrThinking: ChatMessage | undefined
      for (const k of Object.keys(run.acc.activeBlocks)) {
        if (!k.startsWith(prefix)) continue
        const it = run.messages[run.acc.activeBlocks[k]]
        if (it && (it.kind === 'text' || it.kind === 'thinking') && it.status === 'streaming') {
          it.status = 'done'
          lastTextOrThinking = it
        }
      }
      if (lastTextOrThinking) lastTextOrThinking.uuid = uuid
      blocks.forEach((block) => {
        match(block)
          .with({ type: 'tool_use' }, (b) => finalizeTool(run, b.id, b.name, b.input, parent, uuid))
          .with({ type: 'mcp_tool_use' }, (b) =>
            finalizeTool(run, b.id, `${b.server_name}::${b.name}`, b.input, parent, uuid),
          )
          .with({ type: 'mcp_tool_result' }, (b) =>
            mergeToolResult(run, b.tool_use_id, b.is_error, b.content),
          )
          .otherwise(() => {})
      })
      // 清掉本条 parent 已处理的 activeBlocks key（下一回合 blockIndex 重新从 0 计）
      for (const k of Object.keys(run.acc.activeBlocks)) {
        if (k.startsWith(prefix)) delete run.acc.activeBlocks[k]
      }
    })
    // ── user（tool_result 优先） ───────────────────────────────
    .with({ type: 'user' }, (m: SDKUserMessage) => {
      const parent = m.parent_tool_use_id ?? undefined
      const content = m.message.content
      if (
        Array.isArray(content) &&
        content.length > 0 &&
        content.every((b) => isToolResultBlock(b))
      ) {
        // tool_result 来源一:user 消息全是 tool_result 块,逐块合并,不建气泡
        for (const b of content) {
          const blk = b as {
            type: string
            tool_use_id?: string
            is_error?: boolean
            content?: unknown
          }
          if (blk.type === 'tool_result' && blk.tool_use_id) {
            mergeToolResult(run, blk.tool_use_id, !!blk.is_error, blk.content)
          }
        }
        return
      }
      if (m.isSynthetic) return
      // 注入 subAgent 的 prompt 不展示
      if (m.parent_tool_use_id != null) return
      run.messages.push({
        id: nextId(run),
        kind: 'user',
        rawContent: content,
        parentToolUseId: parent,
        uuid: m.uuid,
        injectedShareValues,
      })
    })
    // ── system/init:捕获主模型,重置 token 累计中间态（不建展示项） ──
    .with({ type: 'system', subtype: 'init' }, (m) => {
      run.acc.mainModel = m.model
      run.acc.prevModelUsage = {}
      run.acc.lastTotalCost = 0
      run.acc.lastTurnContextUsage = undefined
    })
    // 其余分支（result/tool_progress/...）忽略
    .otherwise(() => {})
}

// ── token 累计（移植自原 buildRenderItems.ts） ────────────────────────────────

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
 * 多 iteration 场景优先取数组末项（最后一次模型实际看到的输入），无 iterations 退回顶层。
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
 * 主模型未确定 / modelUsage 中无该模型 entry / entry 无 contextWindow 一律返回 0。
 */
function readContextWindow(modelUsage: unknown, mainModel: string | undefined): number {
  if (!mainModel || !modelUsage || typeof modelUsage !== 'object') return 0
  const entry = (modelUsage as Record<string, any>)[mainModel]
  if (entry && typeof entry.contextWindow === 'number') return entry.contextWindow
  return 0
}

/**
 * 把一条 result 消息并入 acc 的 session 累计,返回本回合用量增量与窗口占用。
 *
 * 两处调用:
 * - 普通回合 result(aiMessage):用返回的 modelUsages / turnContextUsage 生成 turn_end。
 * - agentComplete.data.result:CompleteTask 暂存后这条 result 不再单独透传为 aiMessage,
 *   只取副作用刷新 acc,让随后的 agent_complete 卡片拿到截至 session 结束的累计 / 成本 / 窗口。
 *
 * 副作用(覆盖式赋值,幂等):
 * - acc.prevModelUsage ← 本条 result.modelUsage 累计
 * - acc.lastTotalCost  ← 本条 result.total_cost_usd
 * - acc.lastTurnContextUsage ← 本回合主模型窗口占用(缺失则保留旧值)
 */
function applyResultToAcc(
  message: unknown,
  acc: AgentRun['acc'],
): {
  modelUsages: ModelUsageEntry[]
  turnContextUsage?: ContextUsage
} {
  // result.modelUsage 是 session 累计；本回合增量 = 当前累计 - 上次累计
  const currModelUsage = readResultModelUsage(message)
  const modelUsages: ModelUsageEntry[] = []
  for (const [model, curr] of Object.entries(currModelUsage)) {
    const prev = acc.prevModelUsage[model]
    const delta = prev ? subtractModelTokenUsage(curr, prev) : curr
    if (isModelTokenUsageNonZero(delta) || delta.costUSD > 0) {
      modelUsages.push({ model, usage: delta })
    }
  }
  // 用本条 result 的累计快照覆盖 prev，供下回合计算增量
  acc.prevModelUsage = currModelUsage
  const cost = (message as any).total_cost_usd
  if (typeof cost === 'number') acc.lastTotalCost = cost

  // 上下文窗口:每 turn 独立按本 result 数据计算,仅主模型 entry 的 contextWindow。
  const contextWindow = readContextWindow((message as any).modelUsage, acc.mainModel)
  const resultUsed = readUsageInputTotal((message as any).usage)
  const turnContextUsage =
    contextWindow > 0 && resultUsed > 0 ? { used: resultUsed, total: contextWindow } : undefined
  if (turnContextUsage) acc.lastTurnContextUsage = turnContextUsage

  return { modelUsages, turnContextUsage }
}

/**
 * 根据现有的 state 和 flows，处理一条 flow.signal.* 或 flow.command.* 消息，
 * 返回新的 FlowRunState 与待触发的 MessageEffect 列表。
 *
 * 单一 reducer 统管状态转移：
 * - signal 路径：extension 发出前 / webview 收到后各 reduce 一次
 * - command 路径：webview 发出前 / extension 收到后各 reduce 一次
 *
 * 特殊入口（绕过终态守卫）：
 * - `flow.command.flowStart`：覆盖式初始化,以 msg.data.runId 为主键创建首个 AgentRun
 * - `killFlow`：任意状态下幂等,所有 run 转 stopped
 *
 * 终态守卫：所有 run 都处于 stopped/completed/error 时,其余消息直接忽略。
 * runId 守卫：非 flowStart 的消息按 msg.data.runId 在 runs 中找 AgentRun,找不到则忽略。
 *
 * 不再把 raw signal 直接 push 进 messages,改由各分支调 appendSdkMessage 累加成
 * ChatMessage;assistant 定稿到达时删除流式占位项、push 完整 done 项。
 */
export function updateFlowRunState(
  msg: ExtensionFlowSignalMessage | ExtensionFlowCommandMessage,
  options: { state: FlowRunState | undefined; flows: Flow[] },
): { state: FlowRunState | undefined; effects: MessageEffect[] } {
  const effects: MessageEffect[] = []
  const { flows, state } = options

  // ── command.flowStart：覆盖式初始化（可在任何 state 下进入，包括 undefined） ──
  if (msg.type === 'flow.command.flowStart') {
    const baseValues = state?.shareValues ?? {}
    const startAgent = flows
      .find((f) => f.id === msg.data.flowId)
      ?.agents?.find((a) => a.id === msg.data.agentId)
    const injectedShareValues =
      startAgent?.node_type === 'code'
        ? { ...baseValues }
        : startAgent
          ? pickInjectedShareValues(startAgent.allowed_read_values_keys ?? [], baseValues)
          : undefined
    const firstRun: AgentRun = {
      runId: msg.data.runId,
      agentId: msg.data.agentId,
      sessionId: undefined,
      messages: [],
      completed: false,
      acc: emptyAcc(),
    }
    // 把 initMessage 累加为首条 user 项（替代直接塞 raw signal）
    appendSdkMessage(firstRun, msg.data.initMessage, injectedShareValues)
    const fresh: FlowRunState = {
      killed: false,
      runs: [firstRun],
      answeredToolPermissions: {},
      pendingToolPermissions: [],
      shareValues: baseValues,
    }
    return { state: fresh, effects }
  }

  if (msg.type === 'flow.command.setShareValues') {
    const base: FlowRunState = {
      killed: false,
      runs: [],
      answeredToolPermissions: {},
      pendingToolPermissions: [],
      ...state,
      shareValues: msg.data.values,
    }
    return { state: base, effects }
  }

  if (!state) return { state: undefined, effects }

  const findFlow = (flowId: string): Flow | undefined => flows.find((f) => f.id === flowId)
  const findAgent = (flow: Flow | undefined, agentId: string): Agent | Code | undefined =>
    flow?.agents?.find((a) => a.id === agentId)

  const pushEffect = (opts: Omit<MessageEffect, 'flowName' | 'agentName'>) => {
    const flow = findFlow(opts.flowId)
    const agent = findAgent(flow, opts.agentId)
    // silent_task / code 节点减少通知:只放行 agent-error / flow-completed /
    // CompleteTask|ExitPlanMode 的确认;result、AskUserQuestion 自动应答、普通工具授权静默。
    if (agent && (agent.node_type === 'code' || agent.work_mode === 'silent_task')) {
      const isConfirmPermission =
        opts.reason === 'awaiting-tool-permission' &&
        (!!opts.toolName?.includes('CompleteTask') || !!opts.toolName?.includes('ExitPlanMode'))
      const allowed =
        opts.reason === 'agent-error' || opts.reason === 'flow-completed' || isConfirmPermission
      if (!allowed) return
    }
    effects.push({
      ...opts,
      flowName: flow?.name ?? '',
      agentName: agent?.agent_name ?? '',
    })
  }

  const next = produce(state, (draft) => {
    const flowId = msg.data.flowId
    const clearPendings = () => {
      // 未回答的权限请求标记为拒绝,供历史卡片回显"已拒绝"状态
      for (const p of draft.pendingToolPermissions) {
        if (!draft.answeredToolPermissions[p.toolUseId]) {
          draft.answeredToolPermissions[p.toolUseId] = { allow: false, message: undefined }
        }
      }
      draft.pendingToolPermissions = []
    }

    // ── command.killFlow:任何状态下强制终止（包括终态,幂等） ──────────
    if (msg.type === 'flow.command.killFlow') {
      draft.killed = true
      clearPendings()
      return
    }

    // ── 终态守卫:已被 killFlow 停止 / 所有 run 都终态时,其余消息忽略 ──
    if (draft.killed) return
    if (draft.runs.length > 0 && draft.runs.every((r) => isTerminalPhase(getRunPhase(r, draft)))) {
      return
    }

    // 寻址当前消息所属 AgentRun（flowStart 信号已建好,后续 signal/command 都按 runId 找）
    const runId = 'runId' in msg.data ? (msg.data.runId as string | undefined) : undefined
    const findRun = (id: string | undefined) =>
      id ? draft.runs.find((r) => r.runId === id) : undefined
    const run = findRun(runId)
    if (!run) return

    // SDK aiMessage 带 session_id,首次见到时回填到对应 AgentRun.sessionId
    if (msg.type === 'flow.signal.aiMessage' && !run.sessionId) {
      const sid = (msg.data.message as { session_id?: string }).session_id
      if (sid) run.sessionId = sid
    }

    match(msg)
      // ── signals ──────────────────────────────────────────────
      .with({ type: 'flow.signal.flowStart' }, () => {})
      .with({ type: 'flow.signal.aiMessage' }, (m) => {
        const { message } = m.data
        // 恢复运行:清中断标志
        run.interrupted = false
        appendSdkMessage(run, message)
        // 普通回合 result 到达 → 算 token 增量 / 窗口占用,push turn_end
        if (message.type === 'result') {
          const { modelUsages, turnContextUsage } = applyResultToAcc(message, run.acc)
          run.messages.push({
            id: nextId(run),
            kind: 'turn_end',
            // 注:SDKResultMessage 无 error 字段（只有 is_error/subtype）,此处沿用原
            // buildRenderItems 表达式,实际恒 false（回合结束恒绿）—— 保持 UI 等价,不修复。
            isError: 'error' in message && !!(message as { error?: unknown }).error,
            modelUsages: modelUsages.length > 0 ? modelUsages : undefined,
            contextUsage: turnContextUsage,
          })
          // 本 run 无未回答权限时触发"生成完毕"
          if (draft.pendingToolPermissions.every((p) => p.runId !== run.runId)) {
            pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'result' })
          }
        }
      })
      .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
        // 合并 agentComplete 携带的 values 到 Flow shareValues（必须最前:nextRun 注入快照读它）
        if (data.values) {
          draft.shareValues = { ...draft.shareValues, ...data.values }
        }
        run.completed = true
        run.outputName = data.output?.name
        // CompleteTask result:只更 acc（token 累计），不 push turn_end（避免 phase 误切 result）
        if (data.result) applyResultToAcc(data.result, run.acc)
        // session 结束时把累计到此刻的 modelUsage / total_cost 作为 breakdown 写到 agent_complete
        const modelBreakdown = Object.entries(run.acc.prevModelUsage)
          .map(([model, usage]) => ({ model, usage }))
          .filter((b) => isModelTokenUsageNonZero(b.usage) || b.usage.costUSD > 0)
        run.messages.push({
          id: nextId(run),
          kind: 'agent_complete',
          outputName: data.output?.name,
          displayContent: data.content,
          values: data.values && Object.keys(data.values).length > 0 ? data.values : undefined,
          modelBreakdown: modelBreakdown.length > 0 ? modelBreakdown : undefined,
          totalCost: run.acc.lastTotalCost > 0 ? run.acc.lastTotalCost : undefined,
          contextUsage: run.acc.lastTurnContextUsage,
        })
        clearPendings()
        const flow = findFlow(flowId)
        const output = data.output
          ? flow?.agents
              ?.find((a) => a.id === run.agentId)
              ?.outputs?.find((o) => o.output_name === data.output!.name)
          : undefined
        const nextAgent = output ? flow?.agents?.find((a) => a.id === output.next_agent) : undefined
        if (nextAgent && data.output.newRunId) {
          // 追加新 AgentRun(由 extension 端生成的 newRunId),把 CompleteTask 的 content 作为
          // 下一个 Agent 的首条用户消息回显（no_input 的 next agent 用 '执行任务',与
          // FlowRunner.doOnCompleteTask 的 nextInitMessage 同源）。
          const nextInitMessage: UserMessageType = {
            type: 'user',
            message: {
              role: 'user',
              content: nextAgent.no_input || !data.content ? '执行任务' : data.content,
            },
            parent_tool_use_id: null,
          }
          const newRun: AgentRun = {
            runId: data.output.newRunId,
            agentId: nextAgent.id,
            sessionId: undefined,
            messages: [],
            completed: false,

            acc: emptyAcc(),
          }
          appendSdkMessage(
            newRun,
            nextInitMessage,
            nextAgent.node_type === 'code'
              ? { ...draft.shareValues }
              : pickInjectedShareValues(
                  nextAgent.allowed_read_values_keys ?? [],
                  draft.shareValues,
                ),
          )
          draft.runs.push(newRun)
        } else {
          // Flow 走到末端:全部 run 完成,清空 shareValues 防污染下次启动
          draft.shareValues = {}
          pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'flow-completed' })
        }
      })
      .with({ type: 'flow.signal.toolPermissionRequest' }, ({ data }) => {
        // 队列追加（toolUseId 去重）
        if (!draft.pendingToolPermissions.some((p) => p.toolUseId === data.toolUseId)) {
          draft.pendingToolPermissions.push({
            toolUseId: data.toolUseId,
            toolName: data.toolName,
            input: data.input,
            runId: run.runId,
          })
        }
        pushEffect({
          flowId,
          runId: run.runId,
          agentId: run.agentId,
          reason: 'awaiting-tool-permission',
          toolName: data.toolName,
        })
      })
      .with({ type: 'flow.signal.agentInterrupted' }, () => {
        run.interrupted = true
        markInterrupted(run)
        clearPendings()
      })
      .with({ type: 'flow.signal.toolPermissionResult' }, ({ data }) => {
        // silent_task 自动应答路径:与 command.toolPermissionResult 同语义,仅入口为 signal,
        // 且不 pushEffect（自动应答无需通知用户）。
        draft.answeredToolPermissions[data.toolUseId] = {
          allow: data.allow,
          updatedInput: data.updatedInput,
          message: data.message,
        }
        draft.pendingToolPermissions = draft.pendingToolPermissions.filter(
          (p) => p.toolUseId !== data.toolUseId,
        )
      })
      .with({ type: 'flow.signal.agentError' }, ({ data }) => {
        run.error = data.err
        run.messages.push({ id: nextId(run), kind: 'error', message: data.err })
        clearPendings()
        pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'agent-error' })
      })
      .with({ type: 'flow.signal.error' }, ({ data }) => {
        run.error = data.msg
        run.messages.push({ id: nextId(run), kind: 'error', message: data.msg })
        clearPendings()
      })
      // ── commands ────────────────────────────────────────────
      .with({ type: 'flow.command.userMessage' }, ({ data }) => {
        run.interrupted = false
        appendSdkMessage(run, data.message)
      })
      .with({ type: 'flow.command.interrupt' }, () => {
        // 等待 flow.signal.agentInterrupted 实际处理
      })
      .with({ type: 'flow.command.toolPermissionResult' }, ({ data }) => {
        draft.answeredToolPermissions[data.toolUseId] = {
          allow: data.allow,
          updatedInput: data.updatedInput,
          message: data.message,
        }
        draft.pendingToolPermissions = draft.pendingToolPermissions.filter(
          (p) => p.toolUseId !== data.toolUseId,
        )
      })
      // ── fork：源 Flow 状态不变,新 Flow 的 RunState 由调用方在 store 外侧写入 ──
      .with({ type: 'flow.signal.fork' }, () => {})
      .with({ type: 'flow.command.fork' }, () => {})
      .exhaustive()
  })

  return { state: next, effects }
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 终态判定 —— stopped / completed / error 三种 */
const isTerminalPhase = (p: AgentPhase): boolean =>
  p === 'completed' || p === 'stopped' || p === 'error'

/**
 * 按 run 自身的数据推断 phase（最简策略）—— SSOT 是 run 上的显式标志 + messages 末项。
 *
 * 优先级:
 * - error                       run.error 非空
 * - completed                   run.completed === true
 * - stopped                     state.killed
 * - awaiting-tool-permission    state.pendingToolPermissions 中有属于本 run 的项
 * - interrupted                 run.interrupted === true
 * - result / running            末项 kind 是 turn_end / 其它
 * - starting                    无任何消息
 */
export function getRunPhase(run: AgentRun, state: FlowRunState): AgentPhase {
  if (run.error) return 'error'
  if (run.completed) return 'completed'
  if (state.killed) return 'stopped'
  if (state.pendingToolPermissions.some((p) => p.runId === run.runId))
    return 'awaiting-tool-permission'
  if (run.interrupted) return 'interrupted'
  const last = run.messages.at(-1)
  if (!last) return 'starting'
  return last.kind === 'turn_end' ? 'result' : 'running'
}

/**
 * 按多 run 优先级聚合 phase —— Flow 与 Agent 同用此函数（FlowPhase ≡ AgentPhase）。
 *
 * 优先级:error > awaiting-tool-permission > result > running > starting >
 * interrupted > stopped > completed。
 */
function aggregatePhase(phases: AgentPhase[]): FlowPhase {
  if (phases.length === 0) return 'idle'
  if (phases.includes('error')) return 'error'
  const order: AgentPhase[] = [
    'awaiting-tool-permission',
    'result',
    'running',
    'starting',
    'interrupted',
  ]
  for (const phase of order) {
    if (phases.includes(phase)) return phase
  }
  if (phases.includes('stopped')) return 'stopped'
  if (phases.includes('completed')) return 'completed'
  return 'idle'
}

// ── Selector ────────────────────────────────────────────────────────────────

export function getFlowPhase(state: FlowRunState | undefined): FlowPhase {
  if (!state) return 'idle'
  return aggregatePhase(state.runs.map((r) => getRunPhase(r, state)))
}

/** 取该 agent 所有 run 的 phase 聚合;该 agent 无 run 则 idle */
export function getAgentPhase(state: FlowRunState | undefined, agentId: string): AgentPhase {
  if (!state) return 'idle'
  return aggregatePhase(
    state.runs.filter((r) => r.agentId === agentId).map((r) => getRunPhase(r, state)),
  )
}

const EMPTY_PENDING_TOOL_PERMISSIONS: PendingToolPermission[] = []

/**
 * 取属于该 agent 的 pendingToolPermissions —— 引用稳定:全属于→原引用;全不属于→空常量;混合→filter 新数组。
 */
export function getPendingToolPermissionsFor(
  state: FlowRunState | undefined,
  agentId: string,
): PendingToolPermission[] {
  if (!state) return EMPTY_PENDING_TOOL_PERMISSIONS
  const list = state.pendingToolPermissions
  if (list.length === 0) return EMPTY_PENDING_TOOL_PERMISSIONS
  const runIdToAgent = new Map(state.runs.map((r) => [r.runId, r.agentId]))
  let allBelong = true
  let anyBelong = false
  for (const p of list) {
    const a = runIdToAgent.get(p.runId)
    if (a === agentId) anyBelong = true
    else allBelong = false
  }
  if (allBelong) return list
  if (!anyBelong) return EMPTY_PENDING_TOOL_PERMISSIONS
  return list.filter((p) => runIdToAgent.get(p.runId) === agentId)
}

export function getAnsweredToolPermissions(
  state: FlowRunState | undefined,
): Record<string, { allow: boolean; updatedInput?: unknown; message?: string }> | undefined {
  return state?.answeredToolPermissions
}

// ── UI helper ────────────────────────────────────────────────────────────────

/**
 * ChatInput 的状态语义 —— 由 AgentPhase 投影。
 * - `ready`：可直接发送（idle / result：result 走 sendUserMessage 同会话追问）
 * - `disabled`：按钮灰，既不能发也不能中断（starting：握手中无 runId/sessionId，interrupt 是 no-op）
 * - `loading`：按钮变停止键，可中断不可发（running / awaiting-tool-permission）
 * - `confirm-required`：可发但要弹窗确认覆盖运行（completed / stopped / error；弹窗在 useSendUserMessage 里）
 */
export type AgentChatInputState = 'ready' | 'disabled' | 'loading' | 'confirm-required'

export const agentChatInputState = (p: AgentPhase): AgentChatInputState =>
  match(p)
    .with(P.union('idle', 'result', 'interrupted'), () => 'ready' as const)
    .with(P.union('starting', 'running', 'awaiting-tool-permission'), () => 'loading' as const)
    .with(P.union('completed', 'stopped', 'error'), () => 'confirm-required' as const)
    .exhaustive()
export const flowCanBeKilled = (p: FlowPhase) =>
  match(p)
    .with(
      P.union('interrupted', 'starting', 'running', 'result', 'awaiting-tool-permission'),
      () => true,
    )
    .with(P.union('idle', 'completed', 'stopped', 'error'), () => false)
    .exhaustive()
