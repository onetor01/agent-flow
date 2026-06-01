import { produce } from 'immer'
import { match, P } from 'ts-pattern'
import type {
  ExtensionFlowCommandMessage,
  ExtensionFlowSignalMessage,
  ExtensionToWebviewMessage,
  UserMessageType,
} from './event'
import type { AskUserQuestionInput, AskUserQuestionOutput, Agent, Code, Flow } from './index'

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

// ── Phase ────────────────────────────────────────────────────────────────────

/**
 * Flow 级 phase —— 只描述整个 flow 的生命周期。
 * `result` / `awaiting-question` / `awaiting-tool-permission` / `awaiting-complete-confirm`
 * 四态在控制语义上一致（可中断、不可改图），区别仅在等待对象。
 */
export type FlowPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'result'
  | 'interrupted'
  | 'awaiting-question'
  | 'awaiting-tool-permission'
  | 'awaiting-complete-confirm'
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
  | 'awaiting-complete-confirm'
  | 'completed'
  | 'stopped'
  | 'error'

// ── State 数据结构 ───────────────────────────────────────────────────────────

/**
 * 单个 Agent 运行实例 —— phase 由 [getRunPhase](src/common/flowRunState.ts) 从
 * `messages` + `completed` + `state.killed` + `state.pendingQuestions` /
 * `state.pendingToolPermissions` 推断,不存字段。
 */
export type AgentRun = {
  /** 主键 —— flowStart 路径由 webview 生成,next_agent / fork 路径由 extension 生成 */
  runId: string
  agentId: string
  /** SDK 首条消息送达后由 reducer 从 message.session_id 回填 */
  sessionId?: string
  /** 当前 run 的 message 流 */
  messages: ExtensionToWebviewMessage[]
  completed: boolean
  outputName?: string
}

export type PendingQuestion = {
  toolUseId: string
  input: AskUserQuestionInput
  /** 所属 run */
  runId: string
}

export type PendingToolPermission = {
  toolUseId: string
  toolName: string
  input: unknown
  /** 所属 run */
  runId: string
}

export type PendingCompleteConfirm = {
  toolUseId: string
  /** AgentComplete MCP 工具的原始入参（content / output_name / values 等） */
  input: Record<string, unknown>
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
  /** 已回答的 AskUserQuestion：toolUseId -> 用户提交的答案，用于 UI 回显历史态 */
  answeredQuestions: Record<string, AskUserQuestionOutput>
  /** 当前未回答的 AskUserQuestion 队列(按 runId 区分归属) */
  pendingQuestions: PendingQuestion[]
  /** 已回答的工具权限请求：toolUseId -> allow，用于 UI 回显历史态 */
  answeredToolPermissions: Record<string, { allow: boolean }>
  /** 当前未回答的工具权限请求队列(按 runId 区分归属) */
  pendingToolPermissions: PendingToolPermission[]
  /** 当前挂起的 AgentComplete 完成前确认队列(按 runId 区分归属) */
  pendingCompleteConfirms: PendingCompleteConfirm[]
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
  reason:
    | 'result'
    | 'awaiting-question'
    | 'awaiting-tool-permission'
    | 'awaiting-complete-confirm'
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
 * - `flow.command.flowStart`：覆盖式初始化,以 msg.data.runId 为主键创建首个 AgentRun
 * - `killFlow`：任意状态下幂等,所有 run 转 stopped
 *
 * 终态守卫：所有 run 都处于 stopped/completed/error 时,其余消息直接忽略。
 * runId 守卫：非 flowStart 的消息按 msg.data.runId 在 runs 中找 AgentRun,找不到则忽略。
 */
export function updateFlowRunState(
  msg: ExtensionFlowSignalMessage | ExtensionFlowCommandMessage,
  options: { state: FlowRunState | undefined; flows: Flow[] },
): { state: FlowRunState | undefined; effects: MessageEffect[] } {
  const effects: MessageEffect[] = []
  const { flows, state } = options

  // ── command.flowStart：覆盖式初始化（可在任何 state 下进入，包括 undefined） ──
  if (msg.type === 'flow.command.flowStart') {
    const firstRun: AgentRun = {
      runId: msg.data.runId,
      agentId: msg.data.agentId,
      sessionId: undefined,
      messages: [
        {
          type: 'flow.signal.aiMessage',
          data: { ...msg.data, message: msg.data.initMessage },
        },
      ],
      completed: false,
    }
    const fresh: FlowRunState = {
      killed: false,
      runs: [firstRun],
      answeredQuestions: {},
      answeredToolPermissions: {},
      pendingQuestions: [],
      pendingToolPermissions: [],
      pendingCompleteConfirms: [],
      shareValues: state?.shareValues ?? {},
    }
    return {
      state: fresh,
      effects,
    }
  }

  if (msg.type === 'flow.command.setShareValues') {
    const base: FlowRunState = {
      killed: false,
      runs: [],
      answeredQuestions: {},
      answeredToolPermissions: {},
      pendingQuestions: [],
      pendingToolPermissions: [],
      pendingCompleteConfirms: [],
      ...state,
      shareValues: msg.data.values,
    }
    return {
      state: base,
      effects,
    }
  }

  if (!state) return { state: undefined, effects }

  const findFlow = (flowId: string): Flow | undefined => flows.find((f) => f.id === flowId)
  const findAgent = (flow: Flow | undefined, agentId: string): Agent | Code | undefined =>
    flow?.agents?.find((a) => a.id === agentId)

  const pushEffect = (opts: Omit<MessageEffect, 'flowName' | 'agentName'>) => {
    const flow = findFlow(opts.flowId)
    const agent = findAgent(flow, opts.agentId)
    // 静默模式的agent减少通知 代码节点也通知
    if (
      agent &&
      (agent.node_type === 'code' || agent.work_mode === 'silent_task') &&
      opts.reason !== 'agent-error' &&
      opts.reason !== 'flow-completed' &&
      opts.reason !== 'awaiting-complete-confirm'
    )
      return
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
      draft.pendingToolPermissions = []
      draft.pendingCompleteConfirms = []
    }

    // ── command.killFlow:任何状态下强制终止(包括终态,幂等) ──────────
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

    // 寻址当前消息所属 AgentRun(flowStart 信号已建好,后续 signal/command 都按 runId 找)
    const runId = 'runId' in msg.data ? (msg.data.runId as string | undefined) : undefined
    const findRun = (id: string | undefined) =>
      id ? draft.runs.find((r) => r.runId === id) : undefined
    const run = findRun(runId)
    if (!run) return

    // signal 统一追加到对应 run 的消息流
    if (msg.type.startsWith('flow.signal.')) {
      run.messages.push(msg as ExtensionFlowSignalMessage)
    }

    // SDK aiMessage 带 session_id,首次见到时回填到对应 AgentRun.sessionId
    if (msg.type === 'flow.signal.aiMessage' && !run.sessionId) {
      const sid = (msg.data.message as { session_id?: string }).session_id
      if (sid) run.sessionId = sid
    }

    const prevPendingToolUseId = draft.pendingQuestions[0]?.toolUseId

    match(msg)
      // ── signals ──────────────────────────────────────────────
      .with({ type: 'flow.signal.flowStart' }, () => {})
      .with({ type: 'flow.signal.aiMessage' }, (m) => {
        const { message } = m.data
        if (message.type === 'result') {
          if (draft.pendingQuestions.length === 0) {
            pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'result' })
          }
          return
        }
        const found = extractPendingQuestions(m, draft.answeredQuestions, run.runId)
        if (found.length > 0) {
          // 追加到队列尾部（去重：已存在的 toolUseId 不重复加入）
          const existingIds = new Set(draft.pendingQuestions.map((q) => q.toolUseId))
          for (const q of found) {
            if (!existingIds.has(q.toolUseId)) {
              draft.pendingQuestions.push(q)
              existingIds.add(q.toolUseId)
            }
          }
          // 只在从无 pending 或换到新 toolUseId 时才通知
          if (found[0].toolUseId !== prevPendingToolUseId) {
            pushEffect({
              flowId,
              runId: run.runId,
              agentId: run.agentId,
              reason: 'awaiting-question',
            })
          }
        }
      })
      .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
        // 合并 agentComplete 携带的 values 到 Flow shareValues
        if (data.values) {
          draft.shareValues = { ...draft.shareValues, ...data.values }
        }
        run.completed = true
        run.outputName = data.output?.name
        clearPendings()
        const flow = findFlow(flowId)
        const output = data.output
          ? flow?.agents
              ?.find((a) => a.id === run.agentId)
              ?.outputs?.find((o) => o.output_name === data.output!.name)
          : undefined
        const nextAgent = output ? flow?.agents?.find((a) => a.id === output.next_agent) : undefined
        if (nextAgent && data.output.newRunId) {
          // 追加新 AgentRun(由 extension 端生成的 newRunId)。
          // 把 AgentComplete 的 content 作为下一个 Agent 的首条用户消息回显 ——
          // FlowRunner.doOnAgentComplete 已经把同一份 content 喂给了 SDK prompt,
          // 这里只是让 UI 与运行时输入对齐(no_input 的 next agent 用 '开始',与
          // FlowRunner 的 nextInitMessage 同源)。
          const nextInitMessage: UserMessageType = {
            type: 'user',
            message: { role: 'user', content: nextAgent.no_input ? '开始' : data.content },
            parent_tool_use_id: null,
          }
          draft.runs.push({
            runId: data.output.newRunId,
            agentId: nextAgent.id,
            sessionId: undefined,
            messages: [
              {
                type: 'flow.signal.aiMessage',
                data: {
                  flowId,
                  runId: data.output.newRunId,
                  message: nextInitMessage,
                },
              },
            ],
            completed: false,
          })
        } else {
          // Flow 走到末端:全部 run 完成,清空 shareValues 防污染下次启动
          draft.shareValues = {}
          pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'flow-completed' })
        }
      })
      .with({ type: 'flow.signal.toolPermissionRequest' }, ({ data }) => {
        // 队列追加(toolUseId 去重),理论上单 executor 不会出现重复请求
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
        })
      })
      .with({ type: 'flow.signal.agentInterrupted' }, () => {
        clearPendings()
      })
      .with({ type: 'flow.signal.answerQuestion' }, ({ data }) => {
        // silent_task 自动应答路径：与 command.answerQuestion 同语义
        draft.answeredQuestions[data.toolUseId] = data.output
        draft.pendingQuestions = draft.pendingQuestions.filter(
          (q) => q.toolUseId !== data.toolUseId,
        )
      })
      .with({ type: 'flow.signal.agentCompleteConfirmRequest' }, ({ data }) => {
        // 队列追加（toolUseId 去重）
        if (!draft.pendingCompleteConfirms.some((c) => c.toolUseId === data.toolUseId)) {
          draft.pendingCompleteConfirms.push({
            toolUseId: data.toolUseId,
            input: data.input,
            runId: run.runId,
          })
        }
        pushEffect({
          flowId,
          runId: run.runId,
          agentId: run.agentId,
          reason: 'awaiting-complete-confirm',
        })
      })
      .with({ type: 'flow.signal.agentError' }, () => {
        clearPendings()
        pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'agent-error' })
      })
      .with({ type: 'flow.signal.error' }, () => {
        clearPendings()
      })
      // ── commands ────────────────────────────────────────────
      .with({ type: 'flow.command.userMessage' }, ({ data }) => {
        // 把用户消息作为 aiMessage 回显追加到 run.messages,消费者侧统一
        run.messages.push({
          type: 'flow.signal.aiMessage',
          data: {
            flowId,
            runId: data.runId,
            message: data.message,
          },
        })
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
      })
      .with({ type: 'flow.command.toolPermissionResult' }, ({ data }) => {
        draft.answeredToolPermissions[data.toolUseId] = { allow: data.allow }
        draft.pendingToolPermissions = draft.pendingToolPermissions.filter(
          (p) => p.toolUseId !== data.toolUseId,
        )
      })
      .with({ type: 'flow.command.answerAgentCompleteConfirm' }, ({ data }) => {
        draft.pendingCompleteConfirms = draft.pendingCompleteConfirms.filter(
          (c) => c.toolUseId !== data.toolUseId,
        )
      })
      // ── fork：源 Flow 状态完全不变,新 Flow 的 RunState 由调用方在 store 外侧写入 ──
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
 * 按 run 自身的数据推断 phase —— SSOT 是 `run.messages` + `run.completed` +
 * `state.killed` + `state.pendingQuestions` / `state.pendingToolPermissions`。
 *
 * 单个 run 的优先级:
 * - error                       消息流中出现过 agentError / error signal
 * - completed                   run.completed === true
 * - stopped                     state.killed (未已终态时投影为 stopped)
 * - awaiting-tool-permission    state.pendingToolPermissions 中有属于本 run 的项
 * - awaiting-question           state.pendingQuestions 中有属于本 run 的项
 * - interrupted                 末条 aiMessage 之后出现过 agentInterrupted
 * - result / running            末条 aiMessage 是 result type / 其它
 * - starting                    无任何消息(刚 push 进 runs 还没收到 signal)
 */
export function getRunPhase(run: AgentRun, state: FlowRunState): AgentPhase {
  if (
    run.messages.some((m) => m.type === 'flow.signal.agentError' || m.type === 'flow.signal.error')
  ) {
    return 'error'
  }
  if (run.completed) return 'completed'
  if (state.killed) return 'stopped'
  if (state.pendingToolPermissions.some((p) => p.runId === run.runId))
    return 'awaiting-tool-permission'
  if (state.pendingCompleteConfirms.some((c) => c.runId === run.runId))
    return 'awaiting-complete-confirm'
  if (state.pendingQuestions.some((q) => q.runId === run.runId)) return 'awaiting-question'
  // 倒序找:agentInterrupted 在末条 aiMessage 之后出现 → interrupted;反之视为已恢复
  for (let i = run.messages.length - 1; i >= 0; i--) {
    const m = run.messages[i]
    if (m.type === 'flow.signal.agentInterrupted') return 'interrupted'
    if (m.type === 'flow.signal.aiMessage') break
  }
  // 末条 aiMessage 决定 result / running
  for (let i = run.messages.length - 1; i >= 0; i--) {
    const m = run.messages[i]
    if (m.type === 'flow.signal.aiMessage') {
      const inner = m.data.message as { type?: string }
      return inner.type === 'result' ? 'result' : 'running'
    }
  }
  return 'starting'
}

/**
 * 按多 run 优先级聚合 phase —— Flow 与 Agent 同用此函数(FlowPhase ≡ AgentPhase)。
 *
 * 优先级(从高到低):
 * - error                       任一 run 出错即整体 error(跨越终态边界)
 * - awaiting-tool-permission    需用户立即处理
 * - awaiting-question           需用户回答
 * - result                      有结果待消费
 * - running / starting          运行中
 * - interrupted                 中断后未推进
 * - stopped > completed         全部非 error 终态时,主动中断优先于自然完成
 */
function aggregatePhase(phases: AgentPhase[]): FlowPhase {
  if (phases.length === 0) return 'idle'
  if (phases.includes('error')) return 'error'
  const order: AgentPhase[] = [
    'awaiting-tool-permission',
    'awaiting-complete-confirm',
    'awaiting-question',
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

/** 从 assistant 消息中抽取所有未回答的 AskUserQuestion */
function extractPendingQuestions(
  msg: Extract<ExtensionToWebviewMessage, { type: 'flow.signal.aiMessage' }>,
  answered: Record<string, AskUserQuestionOutput>,
  runId: string,
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
    result.push({ toolUseId: block.id, input, runId })
  }
  return result
}

// ── Selector ────────────────────────────────────────────────────────────────

const EMPTY_PENDING_QUESTIONS: PendingQuestion[] = []

export function getFlowPhase(state: FlowRunState | undefined): FlowPhase {
  if (!state) return 'idle'
  return aggregatePhase(state.runs.map((r) => getRunPhase(r, state)))
}

/** 取该 agent 所有 run 的 phase 聚合(优先级与 Flow phase 同);该 agent 无 run 则 idle */
export function getAgentPhase(state: FlowRunState | undefined, agentId: string): AgentPhase {
  if (!state) return 'idle'
  return aggregatePhase(
    state.runs.filter((r) => r.agentId === agentId).map((r) => getRunPhase(r, state)),
  )
}

/**
 * 取属于该 agent 的 pendingQuestions —— 引用稳定:
 * - 所有 q 都属于该 agent → 直接返回 state.pendingQuestions(原引用)
 * - 全部不属于 → 返回常量 EMPTY_PENDING_QUESTIONS
 * - 混合(理论上单 executor 不会出现) → 返回新数组(消费端按需 useMemo 兜底)
 */
export function getPendingQuestionsFor(
  state: FlowRunState | undefined,
  agentId: string,
): PendingQuestion[] {
  if (!state) return EMPTY_PENDING_QUESTIONS
  const list = state.pendingQuestions
  if (list.length === 0) return EMPTY_PENDING_QUESTIONS
  const runIdToAgent = new Map(state.runs.map((r) => [r.runId, r.agentId]))
  let allBelong = true
  let anyBelong = false
  for (const q of list) {
    const a = runIdToAgent.get(q.runId)
    if (a === agentId) anyBelong = true
    else allBelong = false
  }
  if (allBelong) return list
  if (!anyBelong) return EMPTY_PENDING_QUESTIONS
  return list.filter((q) => runIdToAgent.get(q.runId) === agentId)
}

const EMPTY_PENDING_TOOL_PERMISSIONS: PendingToolPermission[] = []

/**
 * 取属于该 agent 的 pendingToolPermissions —— 引用稳定策略与 getPendingQuestionsFor 一致。
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
): Record<string, { allow: boolean }> | undefined {
  return state?.answeredToolPermissions
}

const EMPTY_PENDING_COMPLETE_CONFIRMS: PendingCompleteConfirm[] = []

/**
 * 取属于该 agent 的 pendingCompleteConfirms —— 引用稳定策略与 getPendingQuestionsFor 一致。
 */
export function getPendingCompleteConfirmsFor(
  state: FlowRunState | undefined,
  agentId: string,
): PendingCompleteConfirm[] {
  if (!state) return EMPTY_PENDING_COMPLETE_CONFIRMS
  const list = state.pendingCompleteConfirms
  if (list.length === 0) return EMPTY_PENDING_COMPLETE_CONFIRMS
  const runIdToAgent = new Map(state.runs.map((r) => [r.runId, r.agentId]))
  let allBelong = true
  let anyBelong = false
  for (const c of list) {
    const a = runIdToAgent.get(c.runId)
    if (a === agentId) anyBelong = true
    else allBelong = false
  }
  if (allBelong) return list
  if (!anyBelong) return EMPTY_PENDING_COMPLETE_CONFIRMS
  return list.filter((c) => runIdToAgent.get(c.runId) === agentId)
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
    .with(
      P.union(
        'starting',
        'running',
        'awaiting-question',
        'awaiting-tool-permission',
        'awaiting-complete-confirm',
      ),
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
        'awaiting-complete-confirm',
      ),
      () => true,
    )
    .with(P.union('idle', 'completed', 'stopped', 'error'), () => false)
    .exhaustive()
