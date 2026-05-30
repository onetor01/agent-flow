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
  AskUserQuestionOutput,
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
 */
export type ExecutorMode = 'eager' | 'lazy'

export type ExecutorEvents = {
  /** 首条 SDK 消息抵达时触发(eager 模式),用于上层在透传前发 flow.signal.flowStart */
  onStarted: () => void
  /** SDK 原始消息透传，不做拆解或缩减 */
  onMessage: (message: AIMessageType) => void
  /** Agent 完成，选择了输出分支 */
  onComplete: (result: ExecutorResult) => void
  /** 工具调用命中 must_confirm 或兜底，等待用户确认 */
  onToolPermissionRequest: (req: { toolUseId: string; toolName: string; input: unknown }) => void
  /**
   * silent_task 模式下 AskUserQuestion 被自动应答时触发,
   * 上层据此 fire `flow.signal.answerQuestion`,reducer 写入 answeredQuestions
   * 并移出 pendingQuestions —— 让 webview 在无人值守模式下也能看到自动答案。
   */
  onAnswerQuestion: (toolUseId: string, output: AskUserQuestionOutput) => void
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
   * @param agent - Agent 定义(model、outputs、prompt 等)
   * @param currentValues - Agent 启动时的可读 values 快照(注入系统提示词,运行中不重读)
   * @param shareValueKeys - Flow 声明的全部共享数据 key 与 desc(注入系统提示词的「# 可读数据」/「# 可写数据」节)
   * @param resumeSessionId - 若提供，构造时即以该 sessionId resume 已有 SDK 会话
   *   （fork 后的延续启动走此路径）；否则首次握手由 SDK 分配。
   * @param mode - fork 路径专用模式:
   *   - 'eager'(默认):构造时立即 createQuery 并 push initMessage(原非 fork 路径)
   *   - 'lazy':构造时不 createQuery、不 push initMessage,等用户首次操作触发(普通 fork)
   */
  constructor(
    initMessage: UserMessageType,
    agent: Agent,
    currentValues: Record<string, string>,
    shareValueKeys: readonly ShareValueKey[],
    events: ExecutorEvents,
    resumeSessionId?: string,
    mode: ExecutorMode = 'eager',
  ) {
    this.agent = agent
    this.events = events
    this.userInputStream = createMessageChannel<SDKUserMessage>()
    // values 是写在系统提示词里的 不能即时读写 可以直接构造
    this.prompt = buildAgentSystemPrompt(agent, shareValueKeys, currentValues)
    if (resumeSessionId) {
      // resume 模式：sessionId 已知;fork 路径(lazy)不透传 initMessage
      // —— run.messages 切片已有真实历史,initMessage 只是接口占位/dummy。
      this._sessionId = resumeSessionId
      this.initEmitted = true
    }
    if (mode === 'eager') {
      this.createQuery(initMessage)
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
   * 回答当前挂起的 AskUserQuestion：在 canUseTool 中已挂起 resolver 时直接 resolve。
   * 找不到 resolver 时静默忽略（无 fork 兜底路径,SDK 不支持 askUserQuestion fork）。
   */
  answerQuestion(toolUseId: string, output: AskUserQuestionOutput): void {
    log('[ClaudeExecutor] answerQuestion', {
      toolUseId,
      hasResolver: this.pendingPermissions.has(toolUseId),
      pendingPermissionKeys: Array.from(this.pendingPermissions.keys()),
      hasQueryInstance: !!this.queryInstance,
      sessionId: this._sessionId,
    })
    const resolver = this.pendingPermissions.get(toolUseId)
    if (!resolver) return
    this.pendingPermissions.delete(toolUseId)
    resolver({
      behavior: 'allow',
      updatedInput: {
        questions: output.questions,
        answers: output.answers,
        ...(output.annotations ? { annotations: output.annotations } : {}),
      },
    })
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
      // silent_task 是无人值守模式：直接以占位字符串自动应答，不挂起。
      // 同步 fire onAnswerQuestion 让 webview 通过 flow.signal.answerQuestion 看到自动答案,
      // 与人工回答的展示路径(answeredQuestions / 移出 pendingQuestions)保持一致。
      if (this.agent.work_mode === 'silent_task') {
        const askInput = input as AskUserQuestionInput
        const questions = askInput.questions ?? []
        const answers: Record<string, string> = {}
        for (const q of questions) {
          answers[q.question] = SILENT_ASK_AUTO_ANSWER
        }
        const output: AskUserQuestionOutput = { questions, answers }
        this.events.onAnswerQuestion?.(toolUseID, output)
        return Promise.resolve({
          behavior: 'allow',
          updatedInput: { questions, answers },
        })
      }
      log('[ClaudeExecutor] canUseTool AskUserQuestion', { toolUseID })
      // 挂起，等待 answerQuestion() 被调用
      return new Promise<PermissionResult>((resolve) => {
        this.pendingPermissions.set(toolUseID, resolve)
      })
    }
    const { auto_allowed_tools, must_confirm_tools } = this.agent
    const toolInput = input as Record<string, unknown>
    // 优先级 1：命中 must_confirm 列表，始终要求确认。
    // Bash 命令级：组合命令中任一子命令命中即要求确认（防绕过）
    if (
      must_confirm_tools &&
      (matchTool(toolName, must_confirm_tools, toolInput) ||
        matchToolAnySubCommand(toolName, must_confirm_tools, toolInput))
    ) {
      return this.requestToolPermission(toolUseID, toolName, toolInput)
    }
    // 优先级 2：auto_allowed 为 true 或命中数组，直接放行。
    // Bash 命令级：组合命令需所有子命令都命中才自动放行（matchTool 内置语义）
    if (auto_allowed_tools === true) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    if (auto_allowed_tools && matchTool(toolName, auto_allowed_tools, toolInput)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    // 兜底：silent_task 永远没有用户在场,未授权工具直接 deny;否则要求用户确认
    if (this.agent.work_mode === 'silent_task') {
      return Promise.resolve({
        behavior: 'deny',
        message: `silent_task 模式未授权工具 "${toolName}",请在 auto_allowed_tools 中显式加入。`,
      })
    }
    return this.requestToolPermission(toolUseID, toolName, toolInput)
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
      onTerminate: (reason) => {
        // silent_task 专用:模型确定无法完成时调 terminateTask 工具触发。
        // 标记 disposed 让 for-await 退出,fire onError 让 reducer 把 run 推到 error 终态;
        // 同时 interrupt SDK 让流尽快收尾(不阻塞回调,异常吞掉即可)。
        if (this.completed || this.disposed) return
        this.disposed = true
        this.pendingCompleteResult = null
        this.rejectAllPendingPermissions('terminated')
        this.events.onError(new Error(`terminateTask: ${reason}`))
        this.queryInstance?.interrupt().catch((err) => {
          logError('[ClaudeExecutor] interrupt after terminateTask failed:', err)
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
      mcpServers: { AgentControllerMcp: this.mcpServer },
      permissionMode: 'default',
      canUseTool: this.canUseTool,
      cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
      includePartialMessages: true,
    }
    // if (this.agent.work_mode === 'silent_task') {
    //   options.maxTurns = 10
    // }
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
          } else if (
            // silent_task 自动续轮:本回合无 AgentComplete、未中断、未销毁、SDK 未报错,
            // 直接 push 一条「继续」让模型推进下一步。直到模型调 AgentComplete 或
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
 * - SILENT_MAX_TURNS: 给 SDK options.maxTurns 兜底,防止模型不调 AgentComplete 无限循环。
 */
const SILENT_ASK_AUTO_ANSWER = '自行处理'
const SILENT_CONTINUE_TEXT = '自行处理'

/** silent_task 自动续轮用的 user 消息。session_id 在 result 之后已确定。 */
function buildSilentContinueMessage(sessionId: string | null): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: SILENT_CONTINUE_TEXT },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  }
}
