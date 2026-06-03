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
  AskUserQuestionInput,
  buildAgentSystemPrompt,
  matchTool,
  matchToolAnySubCommand,
  ShareValueKey,
  UserMessageType,
} from '@/common'
import { buildAgentMcpServer } from '@/common/extension'
import { log, logError } from '../../logger'

export type ExecutorResult = {
  outputName?: string
  content: string
  values?: Record<string, string>
  /**
   * 本回合 SDK 最后一条 result 消息。CompleteTask 暂存后,result 不再走 onMessage
   * 透传(否则 reducer 会触发 phase='result' 的"生成完毕"通知),改随 onComplete
   * 上抛,由上层写入 agentComplete signal 的 result 字段。
   */
  resultMessage?: AIMessageType
}

/**
 * ClaudeExecutor 启动模式:
 * - 'eager': 普通启动,构造时立即取 options + createQuery + push initMessage
 * - 'lazy': 构造时不取 options 也不 createQuery,等用户首次操作触发首次 createQuery 时
 *   才调用 getOptions() 取最新 agent / shareValues / events,允许构造到首次启动间外部
 *   改动 flow/agent 并应用新数据。fork 路径用此模式。
 */
export type ExecutorMode = 'eager' | 'lazy'

/**
 * ClaudeExecutor 启动所需的全部数据。eager 模式构造时立即取,lazy 模式延迟到首次
 * createQuery 触发时再取——这样调用方能在闭包里返回最新的 agent / shareValues。
 */
export type ExecutorOptions = {
  initMessage: UserMessageType
  agent: Agent
  currentValues: Record<string, string>
  shareValueKeys: readonly ShareValueKey[]
  events: ExecutorEvents
  resumeSessionId?: string
  flowBaseUrl?: string
  flowApiKey?: string
}

export type ExecutorEvents = {
  /** 首条 SDK 消息抵达时触发(eager 模式),用于上层在透传前发 flow.signal.flowStart */
  onStarted: () => void
  /** SDK 原始消息透传，不做拆解或缩减 */
  onMessage: (message: AIMessageType) => void
  /** Agent 完成，选择了输出分支 */
  onComplete: (result: ExecutorResult) => void
  /**
   * 工具调用挂起,等待用户确认 —— 统一通道:AskUserQuestion / CompleteTask(require_confirm) /
   * ExitPlanMode / must_confirm 工具都走这一个请求。上层据此 fire `flow.signal.toolPermissionRequest`。
   */
  onToolPermissionRequest: (req: { toolUseId: string; toolName: string; input: unknown }) => void
  /**
   * silent_task 模式下工具权限被自动应答时触发(如 AskUserQuestion 自动填答),
   * 上层据此 fire `flow.signal.toolPermissionResult`,reducer 写入 answeredToolPermissions
   * 并移出 pendingToolPermissions —— 让 webview 在无人值守模式下也能回显自动答案。
   */
  onToolPermissionResult: (req: {
    toolUseId: string
    allow: boolean
    updatedInput?: unknown
    message?: string
  }) => void
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
  /** lazy 模式下构造时尚未赋值,首次 createQuery 调 applyOptions 后才确定。eager 模式构造时立即赋值 */
  private agent!: Agent
  /** 同 agent —— buildAgentSystemPrompt 结果,在 applyOptions 内一次性计算 */
  private prompt!: string
  /** SDK 子进程 env 注入项,applyOptions 内确定;空字符串/未提供时不覆盖 process.env */
  private baseUrl?: string
  private apiKey?: string
  private mcpServer: ReturnType<typeof buildAgentMcpServer> | null = null
  private readonly userInputStream: ReturnType<typeof createMessageChannel<SDKUserMessage>>
  /** lazy 模式延迟取 options 的入口;eager 模式构造时也只调用一次后丢弃语义不变 */
  private readonly getOptions: () => ExecutorOptions
  /** options 是否已经 applyOptions 过 —— eager 在构造时即 true,lazy 在首次 createQuery 时翻 true */
  private optionsApplied = false

  private queryInstance: Query | null = null
  private completed = false
  private disposed = false
  /**
   * 首条 SDK 消息是否已处理。
   * - eager 模式:首条 SDK 消息抵达时触发 onStarted + 透传 initMessage,然后置 true
   * - resume(fork)模式:_sessionId 已知,applyOptions 时直接置 true,不再触发 onStarted
   */
  private initEmitted = false
  /**
   * MCP 端 CompleteTask 工具触发后暂存 result，等本回合的 SDK result 消息到达再
   * fire onComplete。否则上层立即 killCurrentExecutor，最后一条 result（含
   * modelUsage / total_cost_usd）会被吞掉。
   */
  private pendingCompleteResult: ExecutorResult | null = null
  /**
   * 等待本回合 SDK result 消息到达的 resolver。任何路径调 SDK interrupt 都靠它
   * 阻塞,确保 onMessage 把 result(含 modelUsage / total_cost_usd)透传到 webview
   * 后再 close。两类触发：用户主动 interrupt + CompleteTask 后内部 interrupt。
   */
  private resolveResultArrived: (() => void) | null = null

  private _sessionId: string | null = null
  /** lazy 模式构造时尚未赋值,首次 createQuery 后由 applyOptions 写入 */
  private events!: ExecutorEvents

  /** SDK 在首条消息中分配的会话 ID;`null` 表示尚未建立会话。仅供日志/内部 resume 使用 */
  get sessionId(): string | null {
    return this._sessionId
  }

  /**
   * 挂起中的工具权限请求：toolUseId -> { resolve, input }。
   * 四类挂起(AskUserQuestion / CompleteTask(require_confirm) / ExitPlanMode / must_confirm)
   * 统一入此 Map,回答统一走 answerToolPermission。
   */
  private pendingToolPermissions = new Map<
    string,
    { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }
  >()

  /**
   * @param mode - 启动模式,见 {@link ExecutorMode}
   * @param getOptions - 返回启动所需全部数据的闭包。
   *   - eager: 构造时立即同步调用一次,作用与原版直传参数一致
   *   - lazy: 构造时不调用,等首次 createQuery 触发再调用 —— 调用方可在闭包内动态返回
   *     最新的 agent / shareValues,把构造到首次启动间的外部改动应用到本次启动
   */
  constructor(mode: ExecutorMode, getOptions: () => ExecutorOptions) {
    this.userInputStream = createMessageChannel<SDKUserMessage>()
    this.getOptions = getOptions
    if (mode === 'eager') {
      const opts = getOptions()
      this.applyOptions(opts)
      this.createQuery(opts.initMessage)
    }
    // mode === 'lazy': 构造时不取 options,等首次 createQuery 时再读最新值
  }

  /**
   * 把 options 应用到实例字段。eager 在构造时调用一次;lazy 在首次 createQuery 调用一次。
   * prompt 由 buildAgentSystemPrompt 一次性生成 —— values 是 prompt 时点快照,运行中改值
   * 不会重读(参见 CLAUDE.md「shareValues 是 prompt 快照」)。
   */
  private applyOptions(opts: ExecutorOptions): void {
    this.agent = opts.agent
    this.events = opts.events
    this.prompt = buildAgentSystemPrompt(opts.agent, opts.shareValueKeys, opts.currentValues)
    this.baseUrl = opts.agent.base_url || opts.flowBaseUrl
    this.apiKey = opts.agent.api_key || opts.flowApiKey
    if (opts.resumeSessionId) {
      // resume 模式：sessionId 已知;fork 路径(lazy)不透传 initMessage
      // —— run.messages 切片已有真实历史,initMessage 只是接口占位/dummy。
      this._sessionId = opts.resumeSessionId
      this.initEmitted = true
    }
    this.optionsApplied = true
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
   * 中断当前生成
   *
   * 内部处理：中断当前 query 但保留 session_id，
   * 后续 sendUserMessage 时自动通过 resume 恢复会话。
   * 对外部来说这些细节不可见。
   */
  async interrupt() {
    if (!this.queryInstance) return
    // 中断时丢弃尚未通知上层的 CompleteTask pending —— 用户主动打断意味着
    // 不要继续切到下一个 agent / 完成 flow。
    this.pendingCompleteResult = null
    this.rejectAllPendingPermissions('interrupted')
    // 用户主动 interrupt：fork lazy 启动后短期内主动打断,SDK 端的 result 可能不会到,
    // 等满 3s 兜底体感很卡。缩短到 800ms,代价是该回合 token 统计可能丢失,但
    // 用户主动打断时这是可接受的。CompleteTask 触发的内部 interrupt 仍保留 3s。
    await this.interruptAndAwaitResult(800)
  }

  /**
   * 触发 SDK interrupt 并阻塞到本回合 result 消息(含 modelUsage / total_cost_usd)
   * 被 for-await 透传给 onMessage 后才 close,否则 token 统计会被丢。timeout 兜底防止
   * SDK 异常导致 hang。两类调用方:
   * - 用户主动 interrupt: 800ms（响应优先,token 统计可丢）
   * - CompleteTask 内部 interrupt: 3000ms（保住 token 统计）
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
    this.rejectAllPendingPermissions('executor disposed')
    this.abortCurrentQuery()
    this.mcpServer?.instance.close().catch((err) => {
      logError('[ClaudeExecutor] mcp server close failed:', err)
    })
    this.mcpServer = null
  }

  /**
   * 回答工具权限请求（统一通道,四类挂起共用）。
   * - allow：放行,updatedInput 覆盖入参(缺省用挂起时存的 input);
   *   AskUserQuestion 回答 = allow + updatedInput={questions,answers,annotations?}
   * - deny：返回带 message 的拒绝结果(缺省 'user denied'),SDK 在本次工具调用处产生
   *   一条 is_error 的 tool_result;CompleteTask 拒绝 = deny + message=reason
   */
  answerToolPermission(
    toolUseId: string,
    allow: boolean,
    opts?: { updatedInput?: unknown; message?: string },
  ): void {
    const pending = this.pendingToolPermissions.get(toolUseId)
    if (!pending) return
    this.pendingToolPermissions.delete(toolUseId)
    if (allow) {
      pending.resolve({
        behavior: 'allow',
        updatedInput: (opts?.updatedInput ?? pending.input) as Record<string, unknown>,
      })
    } else {
      pending.resolve({ behavior: 'deny', message: opts?.message ?? 'user denied' })
    }
  }

  private rejectAllPendingPermissions(reason: string): void {
    for (const [, pending] of this.pendingToolPermissions) {
      pending.resolve({ behavior: 'deny', message: reason })
    }
    this.pendingToolPermissions.clear()
  }

  private canUseTool: CanUseTool = (toolName, input, { toolUseID }) => {
    const toolInput = input as Record<string, unknown>
    if (toolName.includes('AskUserQuestion')) {
      // silent_task 是无人值守模式：直接以占位字符串自动应答，不挂起。
      // 同步 fire onToolPermissionResult 让 webview 通过 flow.signal.toolPermissionResult
      // 回显自动答案,与人工回答的展示路径(answeredToolPermissions)保持一致。
      if (this.agent.work_mode === 'silent_task') {
        const askInput = input as AskUserQuestionInput
        const questions = askInput.questions ?? []
        const answers: Record<string, string> = {}
        for (const q of questions) {
          answers[q.question] = SILENT_ASK_AUTO_ANSWER
        }
        const updatedInput = { questions, answers }
        this.events.onToolPermissionResult({ toolUseId: toolUseID, allow: true, updatedInput })
        return Promise.resolve({ behavior: 'allow', updatedInput })
      }
      // 非 silent：挂起，等待 answerToolPermission() 被调用
      return this.requestToolPermission(toolUseID, toolName, toolInput)
    }
    // require_confirm 粒度按 output 配置：根据 CompleteTask 入参里的 output_name
    // 找到对应 output，require_confirm===true 时拦截挂起;否则直接放行
    // （关键：否则每个 CompleteTask 都弹卡）。chat 模式不挂载 CompleteTask，此分支不会进入。
    if (toolName.includes('CompleteTask')) {
      const completeInput = input as Record<string, unknown>
      const outputName = completeInput.output_name
      const matchedOutput =
        typeof outputName === 'string'
          ? this.agent.outputs?.find((o) => o.output_name === outputName)
          : undefined
      if (matchedOutput?.require_confirm === true) {
        log('[ClaudeExecutor] canUseTool CompleteTask pending confirm', { toolUseID, outputName })
        return this.requestToolPermission(toolUseID, toolName, completeInput)
      }
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    // plan_mode agent 的 ExitPlanMode 工具：拦截并挂起，等待用户确认计划。
    // 确认后 SDK 收到 allow，模型继续执行；拒绝则收到 deny（isError tool_result）。
    // silent_task 无人值守：自动接受，fire onToolPermissionResult 供 webview 历史卡片回显。
    if (toolName.includes('ExitPlanMode')) {
      if (this.agent.work_mode === 'silent_task') {
        this.events.onToolPermissionResult({ toolUseId: toolUseID, allow: true, updatedInput: toolInput })
        return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      }
      return this.requestToolPermission(toolUseID, toolName, toolInput)
    }
    const { must_confirm_tools, deny_tools } = this.agent
    // 优先级 0：命中 deny 列表，直接禁止，不弹窗。
    // Bash 命令级：组合命令中任一子命令命中即禁止（防绕过）
    if (
      deny_tools &&
      (matchTool(toolName, deny_tools, toolInput) ||
        matchToolAnySubCommand(toolName, deny_tools, toolInput))
    ) {
      return Promise.resolve({
        behavior: 'deny',
        message: `禁止使用`,
      })
    }
    // 优先级 1：命中 must_confirm 列表，始终要求确认。
    // Bash 命令级：组合命令中任一子命令命中即要求确认（防绕过）
    if (
      must_confirm_tools &&
      (matchTool(toolName, must_confirm_tools, toolInput) ||
        matchToolAnySubCommand(toolName, must_confirm_tools, toolInput))
    ) {
      return this.requestToolPermission(toolUseID, toolName, toolInput)
    }
    return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
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

  private async createQuery(message: UserMessageType, skipPushInit = false) {
    // lazy 模式首次 createQuery:此刻才取最新 options 应用,允许构造到首次启动间外部
    // 改动 flow/agent。eager 模式构造时已 applyOptions,这里直接跳过。
    if (!this.optionsApplied) {
      this.applyOptions(this.getOptions())
    }
    const isSilentMode = this.agent.work_mode === 'silent_task'
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
        // CompleteTask 触发后不立即通知上层。等 SDK 的 result 消息到达后再 fire，
        // 否则上层会立刻 killCurrentExecutor，把后续的 result（含 modelUsage /
        // total_cost_usd）切掉，token 统计就丢了。
        if (this.completed || this.disposed) return
        if (this.pendingCompleteResult) return
        this.pendingCompleteResult = result
        // 立即 interrupt SDK,避免模型在 CompleteTask 之后继续生成多余文字。
        // interruptAndAwaitResult 会阻塞到 result 消息抵达后才 close,
        // 与用户主动 interrupt 共用同一条等待+关闭路径,token 统计不丢。
        this.interruptAndAwaitResult().catch((err) => {
          logError('[ClaudeExecutor] interrupt after CompleteTask failed:', err)
        })
      },
      onTerminate: (reason) => {
        // 模型确定无法完成时调 TerminateTask 工具触发。
        // 标记 disposed 让 for-await 退出,fire onError 让 reducer 把 run 推到 error 终态;
        // 同时 interrupt SDK 让流尽快收尾(不阻塞回调,异常吞掉即可)。
        if (this.completed || this.disposed) return
        this.disposed = true
        this.pendingCompleteResult = null
        this.rejectAllPendingPermissions('terminated')
        this.events.onError(new Error(`TerminateTask: ${reason}`))
        this.queryInstance?.interrupt().catch((err) => {
          logError('[ClaudeExecutor] interrupt after TerminateTask failed:', err)
        })
      },
    })
    const options: Options = {
      model: this.agent.model,
      effort: this.agent.effort,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: this.prompt,
        // 把 SDK 内置的 cwd / memory / git status 等动态节剥离到首条 user message,
        // system prompt 保住纯静态、可跨会话命中 prompt 缓存。
        excludeDynamicSections: true,
      },
      settingSources: this.agent.isolation_mode ? [] : undefined,
      mcpServers: { AgentControllerMcp: this.mcpServer },
      permissionMode: this.agent.plan_mode ? 'plan' : 'default',
      canUseTool: this.canUseTool,
      cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
      includePartialMessages: true,
    }
    // env 注入:SDK 文档约定 options.env 一旦设置会**替换**整个子进程 env,
    // 因此必须 spread process.env 保住 PATH/HOME 等。仅当 baseUrl / apiKey 任一非空
    // 才覆盖,否则保持默认继承 —— 避免无谓地把整个 process.env 物化到 SDK 子进程。
    if (this.baseUrl || this.apiKey) {
      options.env = {
        ...process.env,
        ...(this.baseUrl ? { ANTHROPIC_BASE_URL: this.baseUrl } : {}),
        ...(this.apiKey ? { ANTHROPIC_AUTH_TOKEN: this.apiKey } : {}),
      }
    }
    if (this.agent.work_mode === 'silent_task') {
      options.maxTurns = 60
    }
    if (this._sessionId) {
      options.resume = this._sessionId
    }
    try {
      this.queryInstance = query({
        prompt: this.userInputStream.iterable,
        options,
      })
      if (!skipPushInit) {
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
        // CompleteTask结果已暂存 视作会话结束 拦截所有消息
        const skipForward = this.pendingCompleteResult !== null
        if (!skipForward) {
          this.events?.onMessage(msg)
        }
        // result 是本回合最后一条消息（带 modelUsage / total_cost_usd）。
        if (msg.type === 'result') {
          // 通知正在等待 result 的 interrupt 路径可以 close 了(用户主动中断
          // 或 CompleteTask 内部触发的 interrupt 都共用此 resolver)。
          this.resolveResultArrived?.()
          this.resolveResultArrived = null
          // 之前 CompleteTask 触发过 onComplete 暂存 pending,此刻才把它通知
          // 给上层,让 token 信息进入 webview 后再切换 / 结束。
          if (this.pendingCompleteResult && !this.completed) {
            const pending = this.pendingCompleteResult
            this.pendingCompleteResult = null
            this.events.onComplete({ ...pending, resultMessage: msg })
            this.completed = true
          } else if (
            // silent_task 自动续轮:本回合无 CompleteTask、未中断、未销毁、SDK 未报错,
            // 直接 push 一条「继续」让模型推进下一步。直到模型调 CompleteTask 或
            // maxTurns 触发 error_max_turns。
            isSilentMode &&
            !this.completed &&
            !this.disposed &&
            msg.subtype === 'success'
          ) {
            const continueMsg = buildSilentContinueMessage(this._sessionId)
            // 同步透传给上层,让 webview 通过 flow.signal.aiMessage 看到自动「继续」消息
            // (SDK 不会 mirror 通过 input stream push 的 user message,这里手动 echo)。
            this.events.onMessage(continueMsg)
            this.userInputStream.push(continueMsg)
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

/**
 * silent_task 模式自动应答 / 续轮 / 兜底常量。
 * - SILENT_ASK_AUTO_ANSWER: AskUserQuestion 被调用时填给每个 question 的 answer。
 *   语义上让模型知道用户不在场,继续自行决策即可。
 * - SILENT_CONTINUE_TEXT: 每轮 result 后系统自动注入的用户消息内容,推动模型推进下一步。
 * - SILENT_MAX_TURNS: 给 SDK options.maxTurns 兜底,防止模型不调 CompleteTask 无限循环。
 */
const SILENT_ASK_AUTO_ANSWER = '自行处理，任务结束后调用CompleteTask，无法结束则调用TerminateTask'
const SILENT_CONTINUE_TEXT = SILENT_ASK_AUTO_ANSWER

/** silent_task 自动续轮用的 user 消息。session_id 在 result 之后已确定。 */
function buildSilentContinueMessage(sessionId: string | null): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: SILENT_CONTINUE_TEXT },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  }
}
