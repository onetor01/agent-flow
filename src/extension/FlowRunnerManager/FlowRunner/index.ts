import { match } from 'ts-pattern'
import { z } from 'zod'
import {
  type Agent,
  type FlowRunnerCommandEvents,
  type Flow,
  type FlowRunnerSignalEvents,
  UserMessageType,
} from '@/common'
import { logError } from '../../logger'
import { ClaudeExecutor, type ExecutorMode, type ExecutorResult } from './ClaudeExecutor'

const MessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  content: z.string(),
  timestamp: z.string(),
})

type Message = z.infer<typeof MessageSchema>

const StepSchema = z.object({
  agentName: z.string(),
  messages: z.array(MessageSchema),
  output: z
    .object({
      output_name: z.string().optional(),
      content: z.string(),
    })
    .optional(),
})

type Step = z.infer<typeof StepSchema>

const RunStateSchema = z.object({
  currentAgent: z
    .object({
      id: z.string(),
      status: z.enum(['preparing', 'ready', 'generating', 'completed']),
    })
    .optional(),
  steps: z.array(StepSchema),
})

type RunState = z.infer<typeof RunStateSchema>

type SignalHandler<K extends keyof FlowRunnerSignalEvents> = (
  data: FlowRunnerSignalEvents[K],
) => void

type WildcardSignalHandler = (
  event: keyof FlowRunnerSignalEvents,
  data: FlowRunnerSignalEvents[keyof FlowRunnerSignalEvents],
) => void

export type FlowRunnerOptions = {
  /**
   * 取当前 Flow 最新的 shareValues。
   * FlowRunner 不再自己维护 shareValues 副本：构造 ClaudeExecutor 注入 systemPrompt
   * 时调用此回调，由外部（reducer 镜像 FlowRunStateManager）作为唯一真相源。
   */
  getLatestShareValues: () => Record<string, string>
}

export class FlowRunner {
  readonly flow: Flow

  private runState: RunState = { steps: [] }
  private currentExecutor: ClaudeExecutor | null = null
  private signalListeners = new Map<keyof FlowRunnerSignalEvents, Set<SignalHandler<any>>>()
  private wildcardListeners = new Set<WildcardSignalHandler>()
  private readonly getLatestShareValues: () => Record<string, string>

  constructor(flow: Flow, options: FlowRunnerOptions) {
    this.flow = flow
    this.getLatestShareValues = options.getLatestShareValues
  }

  /** 监听所有 signal 事件（通配） */
  listenAllSignals(handler: WildcardSignalHandler): void {
    this.wildcardListeners.add(handler)
  }

  /** 移除通配 signal 事件监听器 */
  removeAllSignalsListener(handler: WildcardSignalHandler): void {
    this.wildcardListeners.delete(handler)
  }

  /** 监听 Flow 发出的 signal 事件 */
  on<K extends keyof FlowRunnerSignalEvents>(event: K, handler: SignalHandler<K>): void {
    let set = this.signalListeners.get(event)
    if (!set) {
      set = new Set()
      this.signalListeners.set(event, set)
    }
    set.add(handler)
  }

  /** 移除 signal 事件监听器 */
  off<K extends keyof FlowRunnerSignalEvents>(event: K, handler: SignalHandler<K>): void {
    this.signalListeners.get(event)?.delete(handler)
  }

  /** 向 Flow 发送 command 指令 */
  emit<K extends keyof FlowRunnerCommandEvents>(event: K, data: FlowRunnerCommandEvents[K]): void {
    match(event as keyof FlowRunnerCommandEvents)
      .with('flow.command.flowStart', () => {
        this.handleFlowStart(data as FlowRunnerCommandEvents['flow.command.flowStart'])
      })
      .with('flow.command.userMessage', () => {
        this.handleUserMessage(data as FlowRunnerCommandEvents['flow.command.userMessage'])
      })
      .with('flow.command.interrupt', () => {
        this.handleInterrupt(data as FlowRunnerCommandEvents['flow.command.interrupt'])
      })
      .with('flow.command.answerQuestion', () => {
        this.handleAnswerQuestion(data as FlowRunnerCommandEvents['flow.command.answerQuestion'])
      })
      .with('flow.command.toolPermissionResult', () => {
        this.handleToolPermissionResult(
          data as FlowRunnerCommandEvents['flow.command.toolPermissionResult'],
        )
      })
      .with('flow.command.killFlow', () => {
        // killFlow 走 FlowRunnerManager.disposeRunner，不在此处处理
      })
      .with('flow.command.setShareValues', () => {
        // FlowRunner 不再维护 shareValues 副本：reducer（webview/FlowRunStateManager）
        // 是唯一真相源，构造 ClaudeExecutor 时通过 getLatestShareValues() 实时取。
      })
      .with('flow.command.fork', () => {
        // fork 由 extension 端 handleFork 直接处理，不进入 FlowRunner
      })
      .exhaustive()
  }

  /** 销毁 FlowRunner，终止当前执行 */
  dispose(): void {
    this.killCurrentExecutor()
    this.signalListeners.clear()
    this.wildcardListeners.clear()
  }

  /**
   * fork 路径专用：以 resume 模式启动一个 ClaudeExecutor，runId / sessionId
   * 都已知，不 fire flow.signal.flowStart（fork 由 extension 端用 flow.signal.fork
   * 替代）。
   *
   * mode:
   * - 'lazy': 普通 fork(user/text/thinking/turn_end)。executor 处于 lazy 态:构造
   *   时不 createQuery、不 push initMessage,等用户首次 sendUserMessage 触发 SDK 启动。
   * - 'resume-pending': askUserQuestion fork。executor 构造时即 createQuery + push
   *   isSynthetic dummy 启动 SDK 但不创建新 user turn,SDK 看到 transcript 末端悬空
   *   tool_use 自动调 canUseTool 挂起 resolver,等用户答题。
   */
  spawnForFork(params: {
    runId: string
    agentId: string
    resumeSessionId: string
    mode: ExecutorMode
  }): void {
    const { runId, agentId, resumeSessionId, mode } = params
    const agent = this.findAgentById(agentId)
    if (!agent) {
      this.fire('flow.signal.error', { msg: `Agent "${agentId}" not found in flow` })
      return
    }
    this.killCurrentExecutor()
    this.runState = { steps: [{ agentName: agent.agent_name, messages: [] }] }
    this.updateAgentStatus(agent.id, 'generating')
    // dummy initMessage：fork 模式下不会被透传到上层、也不会作为 SDK prompt push,
    // 仅作为 ClaudeExecutor 接口占位。'resume-pending' 模式会用单独的 isSynthetic
    // dummy push 给 SDK,'lazy' 模式则等用户首次 sendUserMessage 时以真实消息覆盖。
    const dummyInit: UserMessageType = {
      type: 'user',
      message: { role: 'user', content: '' },
      parent_tool_use_id: null,
    }
    const executor: ClaudeExecutor = new ClaudeExecutor(
      runId,
      dummyInit,
      agent,
      this.getLatestShareValues(),
      {
        onSessionId: () => {
          // fork 路径不 fire flow.signal.flowStart;sessionId 已通过 signal.fork 同步
        },
        onMessage: (message) => {
          if (!executor.sessionId) return
          this.fire('flow.signal.aiMessage', { runId, sessionId: executor.sessionId, message })
        },
        onComplete: (result) => {
          if (this.currentExecutor !== executor) return
          this.onAgentComplete(executor, agent, result)
        },
        onToolPermissionRequest: ({ toolUseId, toolName, input }) => {
          if (!executor.sessionId) return
          this.fire('flow.signal.toolPermissionRequest', {
            runId,
            sessionId: executor.sessionId,
            toolUseId,
            toolName,
            input,
          })
        },
        onError: (err) => {
          logError(`[FlowRunner] agent ${agent.id} error:`, err)
          this.fire('flow.signal.agentError', { runId, agentId: agent.id, err })
          this.updateAgentStatus(agent.id, 'completed')
        },
      },
      resumeSessionId,
      mode,
    )
    this.currentExecutor = executor
  }

  // ── signal 发射 ─────────────────────────────────────────────────────────

  private fire<K extends keyof FlowRunnerSignalEvents>(
    event: K,
    data: FlowRunnerSignalEvents[K],
  ): void {
    const set = this.signalListeners.get(event)
    if (set) {
      for (const handler of set) {
        try {
          handler(data)
        } catch (err) {
          logError(`[FlowRunner] signal handler error (${event}):`, err)
        }
      }
    }
    for (const handler of this.wildcardListeners) {
      try {
        handler(event, data)
      } catch (err) {
        logError(`[FlowRunner] wildcard signal handler error (${event}):`, err)
      }
    }
  }

  // ── command 处理 ────────────────────────────────────────────────────────

  private handleFlowStart({
    runKey,
    agentId,
    initMessage,
    resumeSessionId,
  }: FlowRunnerCommandEvents['flow.command.flowStart']): void {
    // 中断当前运行
    this.killCurrentExecutor()

    // 校验 agent 存在
    const agent = this.findAgentById(agentId)
    if (!agent) {
      this.fire('flow.signal.error', { msg: `Agent "${agentId}" not found in flow` })
      return
    }

    // 重置运行状态。shareValues 不再由 FlowRunner 维护——构造 ClaudeExecutor 时
    // 通过 getLatestShareValues() 直接从 reducer 取最新值。
    this.runState = { steps: [] }
    const runId = crypto.randomUUID()

    // 启动 agent（sessionId 由 executor 从 SDK 获取后回调）
    const effectiveInitMessage = agent.no_input
      ? {
          type: 'user' as const,
          message: { role: 'user' as const, content: '开始' },
          parent_tool_use_id: null,
        }
      : initMessage
    this.runAgent(
      runId,
      effectiveInitMessage,
      agent,
      this.getLatestShareValues(),
      (sessionId) => {
        this.fire('flow.signal.flowStart', {
          runId,
          runKey,
          sessionId,
          agentId: agent.id,
        })
      },
      resumeSessionId,
    )
  }

  private handleUserMessage({
    runId,
    sessionId,
    message,
  }: FlowRunnerCommandEvents['flow.command.userMessage']): void {
    if (!this.checkSession(runId, sessionId)) return
    if (!this.currentExecutor) return

    // 直接转发完整 UserMessageType 给 executor（回显由 reducer 两端就地追加，此处不再 fire aiMessage）
    this.currentExecutor.sendUserMessage(message)
  }

  private async handleInterrupt({
    runId,
    sessionId,
  }: FlowRunnerCommandEvents['flow.command.interrupt']) {
    const executor = this.currentExecutor
    if (!executor?.matches(runId, sessionId)) return

    // 调用 executor 的 interrupt，内部处理中断+后续 resume 逻辑
    await executor.interrupt()
    this.updateAgentStatus(executor.agentId, 'ready')
    this.fire('flow.signal.agentInterrupted', { runId, sessionId })
  }

  private handleAnswerQuestion({
    runId,
    sessionId,
    toolUseId,
    output,
  }: FlowRunnerCommandEvents['flow.command.answerQuestion']): void {
    if (!this.checkSession(runId, sessionId)) return
    if (!this.currentExecutor) return
    this.currentExecutor.answerQuestion(toolUseId, output)
  }

  private handleToolPermissionResult({
    runId,
    sessionId,
    toolUseId,
    allow,
  }: FlowRunnerCommandEvents['flow.command.toolPermissionResult']): void {
    if (!this.checkSession(runId, sessionId)) return
    if (!this.currentExecutor) return
    this.currentExecutor.answerToolPermission(toolUseId, allow)
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private runAgent(
    runId: string,
    initMessage: UserMessageType,
    agent: Agent,
    currentShareValues: Record<string, string>,
    onSessionId: (sessionId: string) => void,
    resumeSessionId?: string,
  ): void {
    this.updateAgentStatus(agent.id, 'preparing')

    // 初始化当前 step
    this.runState.steps.push({
      agentName: agent.agent_name,
      messages: [],
    })

    this.updateAgentStatus(agent.id, 'generating')

    const executor: ClaudeExecutor = new ClaudeExecutor(
      runId,
      initMessage,
      agent,
      currentShareValues,
      {
        onSessionId,
        onMessage: (message) => {
          if (!executor.sessionId) return
          this.fire('flow.signal.aiMessage', { runId, sessionId: executor.sessionId, message })
        },
        onComplete: (result) => {
          // 只接受当前 executor 的完成事件，防止旧 executor 残留回调污染过渡后的状态
          if (this.currentExecutor !== executor) return
          this.onAgentComplete(executor, agent, result)
        },
        onToolPermissionRequest: ({ toolUseId, toolName, input }) => {
          if (!executor.sessionId) return
          this.fire('flow.signal.toolPermissionRequest', {
            runId,
            sessionId: executor.sessionId,
            toolUseId,
            toolName,
            input,
          })
        },
        onError: (err) => {
          logError(`[FlowRunner] agent ${agent.id} error:`, err)
          this.fire('flow.signal.agentError', { runId, agentId: agent.id, err })
          this.updateAgentStatus(agent.id, 'completed')
        },
      },
      resumeSessionId,
    )
    this.currentExecutor = executor
  }

  private onAgentComplete(executor: ClaudeExecutor, agent: Agent, result: ExecutorResult): void {
    try {
      this.doOnAgentComplete(executor, agent, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError(`[FlowRunner] onAgentComplete failed (agent=${agent.id}):`, err)
      this.fire('flow.signal.error', { msg: `agent complete failed: ${msg}` })
      this.updateAgentStatus(agent.id, 'completed')
      // 继续向上抛，让 MCP withErrorBoundary 也能把 isError 反馈给 AI
      throw err
    }
  }

  private doOnAgentComplete(executor: ClaudeExecutor, agent: Agent, result: ExecutorResult): void {
    const { outputName, content } = result
    const runId = executor.runId
    // 切到下一个 agent 前要先 kill 当前 executor，sessionId 在 kill 后还要带进
    // signal，所以提前快照。executor 进入 onComplete 时一定已经拿到 sessionId。
    const oldSessionId = executor.sessionId!

    // 记录 step output
    const currentStep = this.runState.steps[this.runState.steps.length - 1]
    if (currentStep && outputName) {
      currentStep.output = {
        output_name: outputName,
        content,
      }
    }

    // 查找下一个 agent
    const selectedOutput = (agent.outputs ?? []).find((o) => o.output_name === outputName)
    const nextAgentId = selectedOutput?.next_agent

    if (nextAgentId) {
      const nextAgent = this.findAgentById(nextAgentId)
      if (!nextAgent) {
        this.fire('flow.signal.error', { msg: `Next agent "${nextAgentId}" not found` })
        this.updateAgentStatus(agent.id, 'completed')
        return
      }

      // 终结旧 executor（query 仍可能在发送 AgentComplete 的 tool_result 尾音），
      // 必须 kill 后再建新 executor，否则旧消息会被错误地挂到新 session 上。
      // killCurrentExecutor 会把 this.currentExecutor 置 null —— 此时 webview
      // 仍持有旧 sessionId，checkSession 因为 currentExecutor 为 null 直接拒绝，
      // 旧的 interrupt/userMessage 不会派发到尚未拿到 sessionId 的新 executor。
      this.killCurrentExecutor()
      // 切换到下一个 agent
      const nextInitMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: nextAgent.no_input ? '开始' : content },
        parent_tool_use_id: null,
      }
      // 局部叠加：reducer 此刻尚未收到 agentComplete signal，getLatestShareValues 拿到
      // 的还是合并前的值，因此手动叠加 result.shareValues 给 nextAgent 的 systemPrompt。
      // FlowRunner 自身不持有 shareValues 状态——这是临时计算，不是字段维护。
      const nextShareValues = result.shareValues
        ? { ...this.getLatestShareValues(), ...result.shareValues }
        : this.getLatestShareValues()
      this.runAgent(runId, nextInitMessage, nextAgent, nextShareValues, (newSessionId) => {
        this.fire('flow.signal.agentComplete', {
          runId,
          sessionId: oldSessionId,
          content,
          output: { name: result.outputName!, newSessionId },
          shareValues: result.shareValues,
        })
      })
    } else {
      // Flow 结束
      this.killCurrentExecutor()
      this.fire('flow.signal.agentComplete', {
        runId,
        sessionId: oldSessionId,
        content: result.content,
        shareValues: result.shareValues,
      })
      this.updateAgentStatus(agent.id, 'completed')
    }
  }

  // ── 工具方法 ────────────────────────────────────────────────────────────

  private findAgentById(id: string): Agent | undefined {
    return (this.flow.agents ?? []).find((a) => a.id === id)
  }

  private checkSession(runId: string, sessionId: string): boolean {
    return this.currentExecutor?.matches(runId, sessionId) ?? false
  }

  private killCurrentExecutor(): void {
    if (this.currentExecutor) {
      this.currentExecutor.kill()
      this.currentExecutor = null
    }
  }

  private updateAgentStatus(
    agentId: string,
    status: NonNullable<RunState['currentAgent']>['status'],
  ): void {
    this.runState.currentAgent = { id: agentId, status }
  }
}
