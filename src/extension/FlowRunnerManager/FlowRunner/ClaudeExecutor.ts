import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import * as vscode from 'vscode'
import {
  Agent,
  AIMessageType,
  AskUserQuestionOutput,
  buildAgentSystemPrompt,
  matchTool,
  UserMessageType,
} from '@/common'
import { buildAgentMcpServer } from '@/common/extension'
import { log, logError } from '../../logger'

export type ExecutorResult = {
  outputName?: string
  content: string
  values?: Record<string, string>
  /**
   * 本回合 SDK 最后一条 result 消息。AgentComplete 暂存后,result 不再走 onMessage
   * 透传(否则 reducer 会触发 phase='result' 的"生成完毕"通知),改随 onComplete
   * 上抛,由上层写入 agentComplete signal 的 result 字段。
   */
  resultMessage?: AIMessageType
}

/**
 * ClaudeExecutor 启动模式:
 * - 'eager'(默认): 普通启动,构造时立即 createQuery 并 push initMessage
 * - 'lazy': 构造时不 createQuery,等用户首次操作触发(普通 fork:user/text/thinking/turn_end)
 * - 'resume-pending': 构造时立即 createQuery 并 push isSynthetic dummy 启动 SDK
 *   iteration 但不创建新 user turn(askUserQuestion fork,SDK 看到悬空 tool_use 自动调 canUseTool)
 */
export type ExecutorMode = 'eager' | 'lazy' | 'resume-pending'

export type ExecutorEvents = {
  /** 首条 SDK 消息抵达时触发(eager 模式),用于上层在透传前发 flow.signal.flowStart */
  onStarted: () => void
  /** SDK 原始消息透传，不做拆解或缩减 */
  onMessage: (message: AIMessageType) => void
  /** Agent 完成，选择了输出分支 */
  onComplete: (result: ExecutorResult) => void
  /** 工具调用命中 must_confirm 或兜底，等待用户确认 */
  onToolPermissionRequest: (req: { toolUseId: string; toolName: string; input: unknown }) => void
  /** 错误 */
  onError: (err: Error) => void
}

/**
 * Claude SDK 中间层 —— 纯 AI 调度工具,不持有任何 run 路由信息。
 *
 * 职责:
 * - 使用完整的 SDK 类型(AIMessageType / UserMessageType)进行交互
 * - 隐藏内部实现细节(中断后重新 query 等)
 * - 内部 _sessionId 仅用于 SDK resume,不暴露作路由
 *
 * 路由职责完全交给上层 FlowRunner —— 通过 executors: Map<runId, ClaudeExecutor>
 * 在 Map 中按 runId 寻址。Executor 不知道也不需要知道自己绑定的 runId。
 */
export class ClaudeExecutor {
  private readonly agent: Agent
  private readonly prompt: string
  private mcpServer: ReturnType<typeof buildAgentMcpServer> | null = null
  private readonly userInputStream: ReturnType<typeof createMessageChannel<SDKUserMessage>>

  private queryInstance: Query | null = null
  private completed = false
  private disposed = false
  /**
   * 首条 SDK 消息是否已处理。
   * - eager 模式:首条 SDK 消息抵达时触发 onStarted + 透传 initMessage,然后置 true
   * - resume(fork)模式:_sessionId 已知,构造时直接置 true,不再触发 onStarted
   */
  private initEmitted = false
  /**
   * MCP 端 AgentComplete 工具触发后暂存 result，等本回合的 SDK result 消息到达再
   * fire onComplete。否则上层立即 killCurrentExecutor，最后一条 result（含
   * modelUsage / total_cost_usd）会被吞掉。
   */
  private pendingCompleteResult: ExecutorResult | null = null
  /**
   * 等待本回合 SDK result 消息到达的 resolver。任何路径调 SDK interrupt 都靠它
   * 阻塞,确保 onMessage 把 result(含 modelUsage / total_cost_usd)透传到 webview
   * 后再 close。两类触发：用户主动 interrupt + AgentComplete 后内部 interrupt。
   */
  private resolveResultArrived: (() => void) | null = null

  private _sessionId: string | null = null
  private events: ExecutorEvents

  /** SDK 在首条消息中分配的会话 ID;`null` 表示尚未建立会话。仅供日志/内部 resume 使用 */
  get sessionId(): string | null {
    return this._sessionId
  }

  /** 挂起中的 AskUserQuestion 权限请求：toolUseId -> resolver */
  private pendingPermissions = new Map<string, (result: PermissionResult) => void>()

  /** 挂起中的工具权限请求：toolUseId -> { resolver, input } */
  private pendingToolPermissions = new Map<
    string,
    { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }
  >()

  /**
   * fork 模式（lazy）：构造时**不**调 createQuery、也不 push initMessage。
   * - 等用户首次 sendUserMessage 时才 createQuery + push（resume 模式下接续 SDK 会话）
   * - 普通 fork（user/text/thinking/turn_end）走此路径
   *
   * fork 模式（resume-pending）：构造时立即 createQuery 启动 SDK,但 push 一条
   * `isSynthetic: true` 的 dummy 消息让 SDK iteration 启动而**不创建新 user turn**。
   * SDK resume 后读取 transcript 末端的悬空 AskUserQuestion tool_use,自动调
   * canUseTool,我们把 resolver 挂起到 pendingPermissions。用户在新 Flow 提交答案
   * 时,answerQuestion 找到 resolver 直接 resolve(走最直接路径,与原 Flow 中
   * askUserQuestion 答题路径一致)。代价:fork 出来即占用一次 SDK resume 连接,
   * 但 token 消耗仅 transcript resume 一次,可接受。askUserQuestion fork 走此路径。
   *
   * pendingAnswers 兜底：极小概率下用户在 SDK 还没调 canUseTool 就提交答案,
   * 此时 resolver 还没挂起,把 output 暂存到 pendingAnswers,canUseTool 触发时消费。
   */
  /** lazy / resume-pending 模式下,user 抢先于 SDK canUseTool 提交答案时的暂存 */
  private pendingAnswers = new Map<string, AskUserQuestionOutput>()

  /**
   * @param agent - Agent 定义(model、outputs、prompt 等)
   * @param currentValues - Agent 启动时的可读 values 快照(注入系统提示词,运行中不重读)
   * @param resumeSessionId - 若提供，构造时即以该 sessionId resume 已有 SDK 会话
   *   （fork 后的延续启动走此路径）；否则首次握手由 SDK 分配。
   * @param mode - fork 路径专用模式:
   *   - 'eager'(默认):构造时立即 createQuery 并 push initMessage(原非 fork 路径)
   *   - 'lazy':构造时不 createQuery、不 push initMessage,等用户首次操作触发(普通 fork)
   *   - 'resume-pending':构造时立即 createQuery,push 一条 isSynthetic:true 的 dummy
   *     消息启动 SDK iteration 但不创建新 user turn(askUserQuestion fork)
   */
  constructor(
    initMessage: UserMessageType,
    agent: Agent,
    currentValues: Record<string, string>,
    events: ExecutorEvents,
    resumeSessionId?: string,
    mode: ExecutorMode = 'eager',
  ) {
    this.agent = agent
    this.events = events
    this.userInputStream = createMessageChannel<SDKUserMessage>()
    // values 是写在系统提示词里的 不能即时读写 可以直接构造
    this.prompt = buildAgentSystemPrompt(agent, currentValues)
    if (resumeSessionId) {
      // resume 模式：sessionId 已知;fork 路径(lazy/resume-pending)不透传 initMessage
      // —— run.messages 切片已有真实历史,initMessage 只是接口占位/dummy。
      this._sessionId = resumeSessionId
      this.initEmitted = true
    }
    if (mode === 'eager') {
      this.createQuery(initMessage)
    } else if (mode === 'resume-pending') {
      // 用 isSynthetic dummy 启动 SDK iteration 但不创建新 user turn。
      // SDK resume 看到 transcript 末端悬空 AskUserQuestion tool_use 会自动调
      // canUseTool,我们挂起到 pendingPermissions,等用户在 webview 提交答案。
      const synthetic: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: '' },
        parent_tool_use_id: null,
        isSynthetic: true,
      }
      this.createQuery(synthetic)
    }
    // mode === 'lazy': 不 createQuery,等用户操作触发
  }

  /** 转发用户消息 */
  async sendUserMessage(message: SDKUserMessage) {
    if (this.disposed || this.completed) return
    if (this.queryInstance) {
      // 当前 query 仍在运行（如等待 AskUserQuestion 的 tool_result），直接推入流
      this.userInputStream.push(message)
    } else {
      // query 已结束（中断/完成）或 lazy 模式尚未启动，创建新 query 并 resume
      this.createQuery(message)
    }
  }

  /**
   * 回答当前挂起的 AskUserQuestion：
   * - SDK 已挂起（pendingPermissions 有 resolver）：直接 resolve（'resume-pending' 模式
   *   下,SDK 启动后调 canUseTool 已挂起 resolver,这是主路径）
   * - lazy 模式 SDK 还没启动 / pending 已被 reset / 'resume-pending' 但用户抢先一步：
   *   把 output 暂存到 pendingAnswers,并触发 createQuery 启动 SDK（resume 模式 +
   *   isSynthetic dummy 启动 iteration 不创建新 user turn）。SDK 看到悬空 tool_use
   *   重新调 canUseTool 时,canUseTool 内消费 pendingAnswers 直接 resolve。
   */
  answerQuestion(toolUseId: string, output: AskUserQuestionOutput): void {
    log('[ClaudeExecutor] answerQuestion', {
      toolUseId,
      hasResolver: this.pendingPermissions.has(toolUseId),
      pendingPermissionKeys: Array.from(this.pendingPermissions.keys()),
      pendingAnswerKeys: Array.from(this.pendingAnswers.keys()),
      hasQueryInstance: !!this.queryInstance,
      sessionId: this._sessionId,
    })
    const resolver = this.pendingPermissions.get(toolUseId)
    if (resolver) {
      this.pendingPermissions.delete(toolUseId)
      resolver({
        behavior: 'allow',
        updatedInput: {
          questions: output.questions,
          answers: output.answers,
          ...(output.annotations ? { annotations: output.annotations } : {}),
        },
      })
      return
    }
    // 找不到 resolver: lazy 模式 SDK 还没启动,把答案暂存,createQuery 后由 canUseTool 消费
    this.pendingAnswers.set(toolUseId, output)
    if (!this.queryInstance && !this.disposed && !this.completed) {
      log('[ClaudeExecutor] answerQuestion → createQuery (lazy resume)', {
        toolUseId,
        sessionId: this._sessionId,
      })
      // 用 isSynthetic dummy 启动 SDK iteration 不创建新 user turn,与 'resume-pending'
      // 路径一致 —— 让 SDK 自然走到 transcript 末端的悬空 tool_use 触发 canUseTool。
      const synthetic: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: '' },
        parent_tool_use_id: null,
        isSynthetic: true,
      }
      this.createQuery(synthetic)
    }
  }

  /**
   * 中断当前生成
   *
   * 内部处理：中断当前 query 但保留 session_id，
   * 后续 sendUserMessage 时自动通过 resume 恢复会话。
   * 对外部来说这些细节不可见。
   */
  async interrupt() {
    if (!this.queryInstance) return
    // 中断时丢弃尚未通知上层的 AgentComplete pending —— 用户主动打断意味着
    // 不要继续切到下一个 agent / 完成 flow。
    this.pendingCompleteResult = null
    this.rejectAllPendingPermissions('interrupted')
    // 用户主动 interrupt：fork lazy 启动后短期内主动打断,SDK 端的 result 可能不会到,
    // 等满 3s 兜底体感很卡。缩短到 800ms,代价是该回合 token 统计可能丢失,但
    // 用户主动打断时这是可接受的。AgentComplete 触发的内部 interrupt 仍保留 3s。
    await this.interruptAndAwaitResult(800)
  }

  /**
   * 触发 SDK interrupt 并阻塞到本回合 result 消息(含 modelUsage / total_cost_usd)
   * 被 for-await 透传给 onMessage 后才 close,否则 token 统计会被丢。timeout 兜底防止
   * SDK 异常导致 hang。两类调用方:
   * - 用户主动 interrupt: 800ms（响应优先,token 统计可丢）
   * - AgentComplete 内部 interrupt: 3000ms（保住 token 统计）
   */
  private async interruptAndAwaitResult(timeoutMs = 3000): Promise<void> {
    if (!this.queryInstance) return
    const resultArrived = new Promise<void>((r) => {
      this.resolveResultArrived = r
    })
    try {
      await this.queryInstance.interrupt()
    } catch (err) {
      logError('[ClaudeExecutor] queryInstance.interrupt() failed:', err)
    }
    await Promise.race([resultArrived, new Promise<void>((r) => setTimeout(r, timeoutMs))])
    this.resolveResultArrived = null
    this.queryInstance?.close()
    this.queryInstance = null
  }

  /** 终止执行，销毁 executor */
  kill(): void {
    this.disposed = true
    this.pendingCompleteResult = null
    this.pendingAnswers.clear()
    this.rejectAllPendingPermissions('executor disposed')
    this.abortCurrentQuery()
    this.mcpServer?.instance.close().catch((err) => {
      logError('[ClaudeExecutor] mcp server close failed:', err)
    })
    this.mcpServer = null
  }

  /**
   * 回答工具权限请求：allow 则原样放行 input；deny 则返回带 message 的拒绝结果，
   * SDK 会在本次工具调用处产生一条 is_error 的 tool_result。
   */
  answerToolPermission(toolUseId: string, allow: boolean): void {
    const pending = this.pendingToolPermissions.get(toolUseId)
    if (!pending) return
    this.pendingToolPermissions.delete(toolUseId)
    if (allow) {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    } else {
      pending.resolve({ behavior: 'deny', message: 'user denied' })
    }
  }

  private rejectAllPendingPermissions(reason: string): void {
    for (const [, resolver] of this.pendingPermissions) {
      resolver({ behavior: 'deny', message: reason })
    }
    this.pendingPermissions.clear()
    for (const [, pending] of this.pendingToolPermissions) {
      pending.resolve({ behavior: 'deny', message: reason })
    }
    this.pendingToolPermissions.clear()
  }

  private canUseTool: CanUseTool = (toolName, input, { toolUseID }) => {
    if (toolName === 'AskUserQuestion') {
      log('[ClaudeExecutor] canUseTool AskUserQuestion', {
        toolUseID,
        hasPendingAnswer: this.pendingAnswers.has(toolUseID),
        pendingAnswerKeys: Array.from(this.pendingAnswers.keys()),
      })
      // lazy 模式（fork 重答场景）下用户已先一步提交答案：直接 resolve,跳过挂起
      const pending = this.pendingAnswers.get(toolUseID)
      if (pending) {
        this.pendingAnswers.delete(toolUseID)
        return Promise.resolve<PermissionResult>({
          behavior: 'allow',
          updatedInput: {
            questions: pending.questions,
            answers: pending.answers,
            ...(pending.annotations ? { annotations: pending.annotations } : {}),
          },
        })
      }
      // 挂起，等待 answerQuestion() 被调用
      return new Promise<PermissionResult>((resolve) => {
        this.pendingPermissions.set(toolUseID, resolve)
      })
    }
    const { auto_allowed_tools, must_confirm_tools } = this.agent
    // 优先级 1：命中 must_confirm 列表，始终要求确认
    if (must_confirm_tools && matchTool(toolName, must_confirm_tools)) {
      return this.requestToolPermission(toolUseID, toolName, input)
    }
    // 优先级 2：auto_allowed 为 true 或命中数组，直接放行
    if (auto_allowed_tools === true) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    if (auto_allowed_tools && matchTool(toolName, auto_allowed_tools)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    // 兜底：未覆盖的工具默认要求用户确认
    return this.requestToolPermission(toolUseID, toolName, input)
  }

  private requestToolPermission(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.pendingToolPermissions.set(toolUseId, { resolve, input })
      this.events.onToolPermissionRequest({ toolUseId, toolName, input })
    })
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private async createQuery(message: UserMessageType, silent = false) {
    // 同一个 MCP Server 实例不能被 connect 两次（@modelcontextprotocol/sdk
    // Protocol.connect 在 _transport 已存在时直接 throw 'Already connected
    // to a transport'，SDK 把异常吞进 .catch 后只打日志，导致 system message
    // 中 MCP status=failed、AgentControllerMcp 工具集体失效）。
    // 所以每次 createQuery 都释放旧 server 并 build 新的。
    if (this.mcpServer) {
      try {
        await this.mcpServer.instance.close()
      } catch (err) {
        logError('[ClaudeExecutor] previous mcp server close failed:', err)
      }
    }
    this.mcpServer = buildAgentMcpServer({
      agent: this.agent,
      onComplete: (result) => {
        // AgentComplete 触发后不立即通知上层。等 SDK 的 result 消息到达后再 fire，
        // 否则上层会立刻 killCurrentExecutor，把后续的 result（含 modelUsage /
        // total_cost_usd）切掉，token 统计就丢了。
        if (this.completed || this.disposed) return
        if (this.pendingCompleteResult) return
        this.pendingCompleteResult = result
        // 立即 interrupt SDK,避免模型在 AgentComplete 之后继续生成多余文字。
        // interruptAndAwaitResult 会阻塞到 result 消息抵达后才 close,
        // 与用户主动 interrupt 共用同一条等待+关闭路径,token 统计不丢。
        this.interruptAndAwaitResult().catch((err) => {
          logError('[ClaudeExecutor] interrupt after AgentComplete failed:', err)
        })
      },
    })
    const options: Options = {
      maxTurns: 1000,
      model: this.agent.model,
      effort: this.agent.effort,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.prompt },
      mcpServers: { AgentControllerMcp: this.mcpServer },
      permissionMode: 'default',
      canUseTool: this.canUseTool,
      cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
      includePartialMessages: true,
    }
    if (this._sessionId) {
      options.resume = this._sessionId
    }
    try {
      this.queryInstance = query({
        prompt: this.userInputStream.iterable,
        options,
      })
      if (!silent) {
        this.userInputStream.push(message)
      }
      for await (const msg of this.queryInstance) {
        if (this.disposed) break
        if (!this.initEmitted) {
          if (!msg.session_id) {
            this.events.onError(new Error(JSON.stringify(msg)))
            break
          }
          this._sessionId = msg.session_id
          this.initEmitted = true
          this.events.onStarted()
        }
        // AgentComplete 已暂存时,本回合的 result 消息不单独透传给上层(否则
        // reducer 会把 phase 切到 'result' 触发"生成完毕"通知),改随下面的
        // onComplete 通过 agentComplete signal 一并上抛。其他类型消息正常透传。
        const skipForward = msg.type === 'result' && this.pendingCompleteResult !== null
        if (!skipForward) {
          this.events?.onMessage(msg)
        }
        // result 是本回合最后一条消息（带 modelUsage / total_cost_usd）。
        if (msg.type === 'result') {
          // 通知正在等待 result 的 interrupt 路径可以 close 了(用户主动中断
          // 或 AgentComplete 内部触发的 interrupt 都共用此 resolver)。
          this.resolveResultArrived?.()
          this.resolveResultArrived = null
          // 之前 AgentComplete 触发过 onComplete 暂存 pending,此刻才把它通知
          // 给上层,让 token 信息进入 webview 后再切换 / 结束。
          if (this.pendingCompleteResult && !this.completed) {
            const pending = this.pendingCompleteResult
            this.pendingCompleteResult = null
            this.events.onComplete({ ...pending, resultMessage: msg })
            this.completed = true
          }
        }
      }
    } catch (err) {
      if (!this.disposed) {
        this.events.onError(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      this.queryInstance = null
    }
  }

  private abortCurrentQuery(): void {
    this.queryInstance?.close()
    this.queryInstance = null
  }
}

/** 可由外部 push 数据的 AsyncIterable */
function createMessageChannel<T>() {
  const queue: T[] = []
  let resolve: (() => void) | null = null

  const push = (value: T) => {
    queue.push(value)
    resolve?.()
    resolve = null
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0) {
            await new Promise<void>((r) => (resolve = r))
          }
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false }
          }
          return { value: undefined as any, done: true }
        },
      }
    },
  }

  return { push, iterable }
}
