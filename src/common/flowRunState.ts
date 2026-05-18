import { produce } from 'immer'
import { match, P } from 'ts-pattern'
import type {
  ExtensionFlowCommandMessage,
  ExtensionFlowSignalMessage,
  ExtensionToWebviewMessage,
} from './event'
import type { AskUserQuestionInput, AskUserQuestionOutput, Agent, Flow } from './index'

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

/** 各模型的每百万 token 定价（美元） */
export const MODEL_PRICING: Record<string, TokenPricing> = {
  opus: { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  sonnet: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  haiku: { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
}

export const calculateTokenCost = (usage: TokenUsage, model: string): number => {
  const p = MODEL_PRICING[model]
  if (!p) return 0
  const mTok = 1_000_000
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cache_write +
      usage.cache_read_input_tokens * p.cache_read) /
    mTok
  )
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

// ── Phase ────────────────────────────────────────────────────────────────────

/**
 * Flow 级 phase —— 只描述整个 flow 的生命周期。
 * `result` / `awaiting-question` / `awaiting-tool-permission` 三态在控制语义上一致
 * （可中断、不可改图），区别仅在等待对象。
 */
export type FlowPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'result'
  | 'interrupted'
  | 'awaiting-question'
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
  | 'awaiting-question'
  | 'awaiting-tool-permission'
  | 'completed'
  | 'stopped'
  | 'error'

// ── State 数据结构 ───────────────────────────────────────────────────────────

export type AgentSession = {
  sessionId: string
  agentId: string
  /** 当前session的message */
  messages: ExtensionToWebviewMessage[]
  completed: boolean
  outputName?: string
}

export type PendingQuestion = {
  toolUseId: string
  input: AskUserQuestionInput
  /** 所属 session，用于切换 agent 时自然失效 */
  sessionId: string
}

export type PendingToolPermission = {
  toolUseId: string
  toolName: string
  input: unknown
  /** 所属 session，用于切换 agent 时自然失效 */
  sessionId: string
}

/**
 * 单个 Flow 的运行态状态 —— extension 与 webview 同步的核心数据。
 * 只包含与一次 run 生命周期相关的信息。
 */
export type FlowRunState = {
  /** webview 生成，用于防止多次 run的竞态问题 仅在flowStart使用 */
  runKey?: string
  /** extension 生成的唯一ID 在校验runKey后生成 */
  runId?: string
  phase: FlowPhase
  /** 每个flow拥有的session */
  sessions: AgentSession[]
  /** 已回答的 AskUserQuestion：toolUseId -> 用户提交的答案，用于 UI 回显历史态 */
  answeredQuestions: Record<string, AskUserQuestionOutput>
  /** 当前未回答的 AskUserQuestion 队列（按出现顺序），显式存储（不从消息反推） */
  pendingQuestions: PendingQuestion[]
  /** 已回答的工具权限请求：toolUseId -> allow，用于 UI 回显历史态 */
  answeredToolPermissions: Record<string, { allow: boolean }>
  /** 当前未回答的工具权限请求 */
  pendingToolPermission?: PendingToolPermission
  /**
   * 当前活跃 Agent 的 id —— 作为"当前 Agent"的唯一真相。
   * 与最后一个 session 的 agentId 对齐，但在 `starting`（尚未建 session）阶段也可用。
   */
  currentAgentId?: string
  /** Flow 运行时的共享数据，Agent 通过 MCP 读写，webview 可查看/编辑 */
  shareValues: Record<string, string>
}

// ── 消息的副作用 ────────────────────────────────────────────────────────

export type MessageEffect = {
  flowId: string
  flowName: string
  agentId: string
  agentName: string
  reason:
    | 'result'
    | 'awaiting-question'
    | 'awaiting-tool-permission'
    | 'flow-completed'
    | 'agent-error'
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
 * - `flow.command.flowStart`：覆盖式初始化；state 可为空
 * - `killFlow`：任意状态都强制置 `stopped`
 *
 * 终态守卫：phase ∈ {stopped, completed, error} 时，其余消息直接忽略。
 * runId 守卫：非 flowStart 的消息要求 draft.runId 与 msg.data.runId 对齐。
 */
export function updateFlowRunState(
  msg: ExtensionFlowSignalMessage | ExtensionFlowCommandMessage,
  options: { state: FlowRunState | undefined; flows: Flow[] },
): { state: FlowRunState | undefined; effects: MessageEffect[] } {
  const effects: MessageEffect[] = []
  const { flows, state } = options

  // ── command.flowStart：覆盖式初始化（可在任何 state 下进入，包括 undefined） ──
  if (msg.type === 'flow.command.flowStart') {
    // resumeSessionId 存在 → fork 后的延续启动，保留既有 sessions / answered* / shareValues
    if (msg.data.resumeSessionId && state) {
      return {
        state: {
          ...state,
          runKey: msg.data.runKey,
          phase: 'starting',
          currentAgentId: msg.data.agentId,
        },
        effects,
      }
    }
    return {
      state: {
        runKey: msg.data.runKey,
        phase: 'starting',
        sessions: [],
        answeredQuestions: {},
        answeredToolPermissions: {},
        currentAgentId: msg.data.agentId,
        pendingQuestions: [],
        shareValues: state?.shareValues ?? {},
      },
      effects,
    }
  }

  if (msg.type === 'flow.command.setShareValues') {
    return {
      state: {
        phase: 'idle',
        sessions: [],
        answeredQuestions: {},
        answeredToolPermissions: {},
        pendingQuestions: [],
        ...state,
        shareValues: msg.data.values,
      },
      effects,
    }
  }

  if (!state) return { state: undefined, effects }

  const findFlow = (flowId: string): Flow | undefined => flows.find((f) => f.id === flowId)
  const findAgent = (flow: Flow | undefined, agentId: string): Agent | undefined =>
    flow?.agents?.find((a) => a.id === agentId)

  const pushEffect = (opts: Omit<MessageEffect, 'flowName' | 'agentName'>) => {
    const flow = findFlow(opts.flowId)
    const agent = findAgent(flow, opts.agentId)
    effects.push({
      ...opts,
      flowName: flow?.name ?? '',
      agentName: agent?.agent_name ?? '',
    })
  }

  const next = produce(state, (draft) => {
    const flowId = msg.data.flowId
    const clearPendings = () => {
      draft.pendingQuestions = []
      draft.pendingToolPermission = undefined
    }

    // ── command.killFlow：任何状态下强制终止（包括终态，幂等） ──────────
    if (msg.type === 'flow.command.killFlow') {
      draft.phase = 'stopped'
      clearPendings()
      draft.runId = undefined
      return
    }

    // ── 终态守卫：其余消息在终态下忽略 ───────────────────────────────
    const isTerminal = match(draft.phase)
      .with(P.union('stopped', 'completed', 'error'), () => true)
      .otherwise(() => false)
    if (isTerminal) return

    // ── signal.flowStart：runKey 校验后初始化首个 session ─────────────
    if (msg.type === 'flow.signal.flowStart') {
      if (draft.runKey !== msg.data.runKey) return
      draft.runId = msg.data.runId
      draft.phase = 'running'
      draft.currentAgentId = msg.data.agentId
      clearPendings()
      // resume 模式：sessions 里已有匹配 sessionId（fork 切片）的会话则复用
      const existing = draft.sessions.find((s) => s.sessionId === msg.data.sessionId)
      if (existing) {
        existing.completed = false
        existing.outputName = undefined
      } else {
        draft.sessions.push({
          sessionId: msg.data.sessionId,
          agentId: msg.data.agentId,
          messages: [],
          completed: false,
        })
      }
      return
    }

    // ── 其余消息：runId 对齐守卫 ──────────────────────────────────
    const runId = 'runId' in msg.data ? msg.data.runId : undefined
    if (draft.runId !== runId) return

    const flow = findFlow(flowId)
    const session = draft?.sessions?.find((s) => !s.completed)
    const currentAgentId = draft.currentAgentId

    // signal 统一追加到当前 session 的消息流
    if (msg.type.startsWith('flow.signal.')) {
      session?.messages.push(msg as ExtensionFlowSignalMessage)
    }

    const prevPendingToolUseId = draft.pendingQuestions[0]?.toolUseId

    match(msg)
      // ── signals ──────────────────────────────────────────────
      .with({ type: 'flow.signal.aiMessage' }, (m) => {
        const { message } = m.data
        if (message.type === 'result') {
          draft.phase = 'result'
          if (draft.pendingQuestions.length === 0 && currentAgentId) {
            pushEffect({ flowId, agentId: currentAgentId, reason: 'result' })
          }
          return
        }
        if (session) {
          const found = extractPendingQuestions(m, draft.answeredQuestions, session.sessionId)
          if (found.length > 0) {
            // 追加到队列尾部（去重：已存在的 toolUseId 不重复加入）
            const existingIds = new Set(draft.pendingQuestions.map((q) => q.toolUseId))
            for (const q of found) {
              if (!existingIds.has(q.toolUseId)) {
                draft.pendingQuestions.push(q)
                existingIds.add(q.toolUseId)
              }
            }
            draft.phase = 'awaiting-question'
            // 只在从无 pending 或换到新 toolUseId 时才通知
            if (found[0].toolUseId !== prevPendingToolUseId) {
              pushEffect({ flowId, agentId: session.agentId, reason: 'awaiting-question' })
            }
            return
          }
        }
        // 只在没有未回答的提问/权限请求时才设为 running
        if (draft.pendingQuestions.length === 0 && !draft.pendingToolPermission) {
          draft.phase = 'running'
        }
      })
      .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
        // 合并 agentComplete 携带的 shareValues
        if (data.shareValues) {
          draft.shareValues = { ...draft.shareValues, ...data.shareValues }
        }
        if (session) {
          session.completed = true
          session.outputName = data.output?.name
        }
        clearPendings()
        const output = data.output
          ? flow?.agents
              ?.find((a) => a.id === currentAgentId)
              ?.outputs?.find((o) => o.output_name === data.output!.name)
          : undefined
        const nextAgent = output ? flow?.agents?.find((a) => a.id === output.next_agent) : undefined
        if (nextAgent && data.output) {
          draft.phase = 'running'
          draft.currentAgentId = nextAgent.id
          draft.sessions.push({
            sessionId: data.output.newSessionId,
            agentId: nextAgent.id,
            messages: [],
            completed: false,
          })
        } else {
          draft.phase = 'completed'
          draft.shareValues = {}
          if (currentAgentId) {
            pushEffect({ flowId, agentId: currentAgentId, reason: 'flow-completed' })
          }
        }
      })
      .with({ type: 'flow.signal.toolPermissionRequest' }, ({ data }) => {
        draft.pendingToolPermission = {
          toolUseId: data.toolUseId,
          toolName: data.toolName,
          input: data.input,
          sessionId: data.sessionId,
        }
        draft.phase = 'awaiting-tool-permission'
        if (currentAgentId) {
          pushEffect({ flowId, agentId: currentAgentId, reason: 'awaiting-tool-permission' })
        }
      })
      .with({ type: 'flow.signal.agentInterrupted' }, () => {
        draft.phase = 'interrupted'
        clearPendings()
      })
      .with({ type: 'flow.signal.agentError' }, ({ data }) => {
        draft.phase = 'error'
        clearPendings()
        pushEffect({ flowId, agentId: data.agentId, reason: 'agent-error' })
      })
      .with({ type: 'flow.signal.error' }, () => {
        draft.phase = 'error'
        clearPendings()
      })
      // ── commands ────────────────────────────────────────────
      .with({ type: 'flow.command.userMessage' }, ({ data }) => {
        // 把用户消息作为 aiMessage 回显追加到 session.messages，消费者侧统一
        if (session) {
          session.messages.push({
            type: 'flow.signal.aiMessage',
            data: {
              flowId,
              runId: data.runId,
              sessionId: data.sessionId,
              message: data.message,
            },
          })
        }
        draft.phase = 'running'
      })
      .with({ type: 'flow.command.interrupt' }, () => {
        // 等待 flow.signal.agentInterrupted 实际处理
      })
      .with({ type: 'flow.command.answerQuestion' }, ({ data }) => {
        draft.answeredQuestions[data.toolUseId] = data.output
        // 从队列中移除已回答的问题
        draft.pendingQuestions = draft.pendingQuestions.filter(
          (q) => q.toolUseId !== data.toolUseId,
        )
        // 如果队列中还有待回答问题，保持 awaiting-question 状态
        if (draft.pendingQuestions.length === 0) {
          draft.phase = 'running'
        }
      })
      .with({ type: 'flow.command.toolPermissionResult' }, ({ data }) => {
        draft.answeredToolPermissions[data.toolUseId] = { allow: data.allow }
        if (draft.pendingToolPermission?.toolUseId === data.toolUseId) {
          draft.pendingToolPermission = undefined
        }
        draft.phase = 'running'
      })
      // ── fork：源 Flow 状态完全不变，新 Flow 的 RunState 由调用方在 store 外侧写入 ──
      .with({ type: 'flow.signal.fork' }, () => {})
      .with({ type: 'flow.command.fork' }, () => {})
      .exhaustive()
  })

  return { state: next, effects }
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 从 assistant 消息中抽取所有未回答的 AskUserQuestion */
function extractPendingQuestions(
  msg: Extract<ExtensionToWebviewMessage, { type: 'flow.signal.aiMessage' }>,
  answered: Record<string, AskUserQuestionOutput>,
  sessionId: string,
): PendingQuestion[] {
  const m = msg.data.message
  if (m.type !== 'assistant') return []
  const blocks = m.message.content
  if (!Array.isArray(blocks)) return []
  const result: PendingQuestion[] = []
  for (const block of blocks) {
    if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue
    if (answered[block.id]) continue
    const input = block.input as AskUserQuestionInput | undefined
    if (!input || !Array.isArray(input.questions)) continue
    result.push({ toolUseId: block.id, input, sessionId })
  }
  return result
}

// ── UI helper ────────────────────────────────────────────────────────────────

/**
 * ChatInput 的状态语义 —— 由 AgentPhase 投影。
 * - `ready`：可直接发送（idle / result：result 走 sendUserMessage 同会话追问）
 * - `disabled`：按钮灰，既不能发也不能中断（starting：握手中无 runId/sessionId，interrupt 是 no-op）
 * - `loading`：按钮变停止键，可中断不可发（running / awaiting-question / awaiting-tool-permission）
 * - `confirm-required`：可发但要弹窗确认覆盖运行（completed / stopped / error；弹窗在 useSendUserMessage 里）
 */
export type AgentChatInputState = 'ready' | 'disabled' | 'loading' | 'confirm-required'

export const agentChatInputState = (p: AgentPhase): AgentChatInputState =>
  match(p)
    .with(P.union('idle', 'result', 'interrupted'), () => 'ready' as const)
    .with('starting', () => 'disabled' as const)
    .with(
      P.union('running', 'awaiting-question', 'awaiting-tool-permission'),
      () => 'loading' as const,
    )
    .with(P.union('completed', 'stopped', 'error'), () => 'confirm-required' as const)
    .exhaustive()
// 取消flow readonly的设计 任意时候允许用户更改
export const flowIsDestructiveReadOnly = (p: FlowPhase) =>
  // eslint-disable-next-line no-constant-binary-expression
  false && (p === 'running' || p === 'starting')
export const flowCanBeKilled = (p: FlowPhase) =>
  match(p)
    .with(
      P.union(
        'interrupted',
        'starting',
        'running',
        'result',
        'awaiting-question',
        'awaiting-tool-permission',
      ),
      () => true,
    )
    .with(P.union('idle', 'completed', 'stopped', 'error'), () => false)
    .exhaustive()
