import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  AIMessageType,
  AskUserQuestionOutput,
  Code,
  ShareValueKey,
  UserMessageType,
} from '@/common'
import { logError } from '../../logger'
import {
  ExecutorEvents,
  ExecutorMode,
  ExecutorResult,
} from './ClaudeExecutor'

/**
 * CodeExecutor 启动所需的全部数据。与 ClaudeExecutor 对齐:eager 构造时立即取,lazy
 * 延迟到首次 createQuery 时再取(尽管本期 lazy 路径不会走到 CodeExecutor —— fork
 * 不支持 code 节点)。
 *
 * runCommand: 在 VSCode workspaceFolder 下执行 shell 命令的函数,由上层 FlowRunner
 * 注入,透传给 AsyncFunction 作为第三个入参,允许用户代码直接调用系统命令。
 */
export type CodeExecutorOptions = {
  initMessage: UserMessageType
  agent: Code
  currentValues: Record<string, string>
  shareValueKeys: readonly ShareValueKey[]
  runCommand: (command: string, timeout?: number) => Promise<string>
  events: ExecutorEvents
}

/**
 * 把 UserMessageType 的 content 拍平为字符串 —— 入参 `input` 仅传文本,数组形式
 * 取所有 text 块拼接;ToolResultBlockParam 等异常输入退化为空串。
 */
function extractInputText(msg: UserMessageType): string {
  const c = msg.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
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

/** AsyncFunction 构造器 —— 用 new 调用以包装 async function 体 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
  new (...args: string[]): (...a: any[]) => Promise<any>
}

/**
 * 把 code 节点的返回值规整为 ExecutorResult 形态:
 * - 顶层是字符串 → { content: 字符串 }
 * - 顶层是 { output_name?, content?, values? } → 取这三项
 * - undefined / null → { content: '' }
 * - 其他对象/数组 → { content: JSON.stringify(返回值) }
 */
function normalizeCodeResult(raw: unknown): {
  outputName?: string
  content: string
  values?: Record<string, string>
} {
  if (raw === undefined || raw === null) return { content: '' }
  if (typeof raw === 'string') return { content: raw }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const hasShape =
      'output_name' in obj || 'content' in obj || 'values' in obj
    if (hasShape) {
      return {
        outputName: typeof obj.output_name === 'string' ? obj.output_name : undefined,
        content: typeof obj.content === 'string' ? obj.content : '',
        values:
          obj.values && typeof obj.values === 'object'
            ? (obj.values as Record<string, string>)
            : undefined,
      }
    }
    return { content: JSON.stringify(raw) }
  }
  return { content: String(raw) }
}

/**
 * 校验 normalizeCodeResult 的输出是否与 agent 声明的 outputs 匹配:
 * - agent 有 outputs 时,outputName 必须是其中之一;缺失则报错
 * - agent 无 outputs 时,outputName 必须为空
 * 返回 null 表示合法,否则返回错误描述。
 */
function validateCodeOutput(
  agent: Code,
  normalized: { outputName?: string; content: string; values?: Record<string, string> },
): string | null {
  const outputs = agent.outputs
  if (outputs && outputs.length > 0) {
    const validNames = outputs.map((o) => o.output_name)
    if (!normalized.outputName) {
      return `代码节点声明了输出分支 [${validNames.join(', ')}],但返回值缺少 output_name`
    }
    if (!validNames.includes(normalized.outputName)) {
      return `output_name "${normalized.outputName}" 不在声明的输出分支 [${validNames.join(', ')}] 中`
    }
  } else if (normalized.outputName) {
    return `代码节点未声明输出分支,但返回值包含 output_name "${normalized.outputName}"`
  }
  return null
}

/**
 * 代码节点执行器 —— 与 ClaudeExecutor 同构 ExecutorEvents,但不调 AI、不挂 MCP、
 * 不走 SDK。把 agent.code 视为 `async function (input, values, runCommand) { ... }` 函数体执行,
 * 返回值映射为 ExecutorResult。
 *
 * 严格只产出 agentComplete 信号:
 * - 不发 assistant 文本气泡(onMessage 不携任何 assistant message)
 * - 不发 result onMessage(避免 reducer 推到 phase='result' 触发"生成完毕"通知)
 * - 成功:onComplete 直接挂 resultMessage(success 帧仅供 token 统计,不走 onMessage)
 * - 错误:不发 result onMessage、不发 assistant 错误堆栈,直接 onError 让 reducer 切 error 终态;
 *   错误详情通过 logError 落日志
 *
 * ChatDrawer 在 code 节点上的展示形态:仅由上游 AgentComplete.content 注入的 user 气泡 +
 * 本节点 AgentComplete 完成卡片构成,中间不出现 assistant 气泡。
 *
 * 第一版限制:
 * - 不支持作为 fork 起点(无 SDK session 可 fork —— spawnForFork 仅用 ClaudeExecutor)
 * - silent_task / AskUserQuestion / require_confirm 不参与
 * - 一次性执行,完成后 onComplete;sendUserMessage / interrupt / answerQuestion 等是 noop
 */
export class CodeExecutor {
  private agent!: Code
  private events!: ExecutorEvents
  private currentValues!: Record<string, string>
  private runCommand!: (command: string, timeout?: number) => Promise<string>
  private initMessage!: UserMessageType
  private readonly getOptions: () => CodeExecutorOptions
  private optionsApplied = false
  private completed = false
  private disposed = false
  private readonly _sessionId: string = globalThis.crypto.randomUUID()

  /** SDK 兼容字段 —— Code 节点无真实 session,这里只是给上层日志/路由占位 */
  get sessionId(): string | null {
    return this._sessionId
  }

  constructor(mode: ExecutorMode, getOptions: () => CodeExecutorOptions) {
    this.getOptions = getOptions
    if (mode === 'eager') {
      this.applyOptions(getOptions())
      void this.run(this.initMessage)
    }
  }

  private applyOptions(opts: CodeExecutorOptions): void {
    this.agent = opts.agent
    this.events = opts.events
    this.currentValues = opts.currentValues
    this.runCommand = opts.runCommand
    this.initMessage = opts.initMessage
    this.optionsApplied = true
  }

  /** 与 ClaudeExecutor 同构接口:CodeExecutor 一次性执行,完成后 doOnAgentComplete 已 kill 当前 executor,后续 sendUserMessage 不会被路由到这里 */
  async sendUserMessage(_message: SDKUserMessage): Promise<void> {
    // noop —— 见类注释「第一版限制」
  }

  /** 用户主动中断 —— code 函数无可中断 promise,只能标记 disposed 让后续 onComplete 被吞掉。
   * AsyncFunction 仍会跑完,但本回合 onComplete / onMessage 不再透传到上层,
   * reducer 走 agentInterrupted 分支推到 interrupted phase。 */
  async interrupt(): Promise<void> {
    this.disposed = true
  }

  kill(): void {
    this.disposed = true
  }

  /** noop —— code 节点不会触发 AskUserQuestion */
  answerQuestion(_toolUseId: string, _output: AskUserQuestionOutput): void {
    // noop
  }

  /** noop —— code 节点不挂 MCP / 不走 SDK,无 tool permission */
  answerToolPermission(_toolUseId: string, _allow: boolean): void {
    // noop
  }

  /** noop —— code 节点不调 AgentComplete */
  answerCompleteConfirm(_toolUseId: string, _accept: boolean, _reason?: string): void {
    // noop
  }

  /** 执行 code 节点函数体 —— eager 构造时调一次,异常路径走 onError 终态 */
  private async run(msg: UserMessageType): Promise<void> {
    if (!this.optionsApplied) this.applyOptions(this.getOptions())
    if (this.disposed || this.completed) return

    // 首条消息抵达上层 —— 让 reducer 把 phase 推到 running(对应 ClaudeExecutor 的 onStarted)
    try {
      this.events.onStarted()
    } catch (err) {
      logError('[CodeExecutor] onStarted handler threw', err)
    }

    const inputContent = extractInputText(msg)
    // code 节点全量读 shareValues —— 不受 allowed_read_values_keys 约束(那只针对 node_type='agent')
    const valuesArg: Record<string, string> = { ...this.currentValues }
    const codeBody = this.agent.code ?? ''

    let raw: unknown
    try {
      const fn = new AsyncFunction('input', 'values', 'runCommand', codeBody)
      raw = await fn(inputContent, valuesArg, this.runCommand)
    } catch (err) {
      // 严格只产出 agentComplete 信号:错误路径不发 assistant 错误气泡、不发 result onMessage,
      // 错误详情走日志,直接 onError 让 reducer 切 error 终态。
      logError('[CodeExecutor] code execution failed', err)
      if (this.disposed) return
      this.events.onError(err instanceof Error ? err : new Error(String(err)))
      return
    }
    if (this.disposed) return

    const normalized = normalizeCodeResult(raw)
    // 校验 output_name 是否与 agent 声明的 outputs 匹配 —— 不合法则直接 onError 终态
    const validationError = validateCodeOutput(this.agent, normalized)
    if (validationError) {
      logError(`[CodeExecutor] output validation failed: ${validationError}`)
      if (this.disposed) return
      this.events.onError(new Error(`代码节点输出校验失败: ${validationError}`))
      return
    }
    // code 节点 values 与现有 shareValues 合并 —— 不受 allowed_write_values_keys 约束(那只针对 node_type='agent')
    const filteredValues =
      normalized.values && Object.keys(normalized.values).length > 0
        ? { ...this.currentValues, ...normalized.values }
        : undefined

    if (this.completed || this.disposed) return
    this.completed = true
    // 严格只产出 agentComplete:result success 帧不走 onMessage,只挂 onComplete.resultMessage
    // 供 token 统计;reducer 在 agentComplete 分支调 buildRenderItems.applyResultToCache 取值。
    const resultMessage = this.buildResult({ isError: false })
    this.events.onComplete({
      outputName: normalized.outputName,
      content: normalized.content,
      values: filteredValues,
      resultMessage,
    })
  }

  /** 构造 SDK 风格 result 帧 —— 仅作为 onComplete.resultMessage 上抛,不走 onMessage */
  private buildResult(opts: { isError: boolean }): AIMessageType {
    const base = {
      type: 'result' as const,
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: opts.isError,
      num_turns: 1,
      result: '',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: globalThis.crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
      session_id: this._sessionId,
    }
    return (
      opts.isError
        ? { ...base, subtype: 'error_during_execution' }
        : { ...base, subtype: 'success' }
    ) as unknown as AIMessageType
  }
}

// 用于 FlowRunner 联合类型 —— 不要 export ExecutorResult 二次导出避免歧义
export type { ExecutorResult }
