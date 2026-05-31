import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AskUserQuestionOutput, Flow } from '.'
import type { FlowRunState } from './flowRunState'

/**
 * AI消息类型 — 会话中一切事件的统一类型（判别联合），
 * 包含用户消息、AI回复、流式事件、系统通知、工具进度等全部子类型，
 * 可用 `SDKMessage[]` 完整描述整个会话流。
 *
 * @see sdk-message-types.md
 */
export type AIMessageType = SDKMessage
/**
 * 用户消息类型 — 可表述一切用户行为，
 * 支持文本、图片、文档、工具结果返回、中止工具调用等。
 *
 * @see sdk-message-types.md
 */
export type UserMessageType = SDKUserMessage

/** 为类型的 key 加前缀 */
export type TypeWithPrefix<T extends Record<string, any>, P extends string> = {
  [K in keyof T as `${P}${K & string}`]: T[K]
}

/** 为类型的每个值追加 flowId 字段 */
type WithFlowId<T extends Record<string, any>> = {
  [K in keyof T]: T[K] & { flowId: string }
}

/**
 * 从事件类型得到实际的message类型
 *
 * @example
 * ```ts
 * panel.webview.onDidReceiveMessage((e: EventMessage<ExtensionReceivedEvents>)=>{
 *
 * })
 *
 * const message: EventMessage<ExtensionPostEvents> = //xx
 * panel.webview.postMessage(message)
 * ```
 */
export type EventMessageType<T extends Record<string, any>> = {
  [K in keyof T]: { type: K; data: T[K] }
}[keyof T]

/** extension接受 webview发出的事件 */
export type ExtensionFromWebviewEvents = {
  /** webview 启动时请求所有 flows */
  load: undefined
  /** 全量保存 flows */
  save: Flow[]
  /** 打开文件，line 存在时跳转并选中对应行 */
  openFile: { filename: string; line?: [number, number] }
  /** 在 VSCode 中预览一段外部粘入的文本附件（非文件系统文件） */
  previewAttachment: { name: string; content: string }
} & ExtensionFlowCommandEvents

/** extension发出 webview接受的消息 */
export type ExtensionToWebviewEvents = {
  /** 返回所有 flows，以及 extension 端维护的运行态 */
  load: { flows: Flow[]; flowRunStates: Record<string, FlowRunState> }
  /** extension异常 */
  error: string
  /** 向当前 active 的输入框注入文本（由 VSCode 编辑器侧快捷键触发） */
  insertSelection: {
    text: string
    languageId?: string
    filename?: string
    line?: [number, number]
  }
  /** 从 VSCode 通知栏点击后，聚焦到指定 Flow（纯 UI 导航信号，不涉及具体 run） */
  focusFlow: { flowId: string }
} & ExtensionFlowSignalEvents

/** extension接受 webview发出的消息 */
export type ExtensionFromWebviewMessage = EventMessageType<ExtensionFromWebviewEvents>

/** extension发出 webview接受的消息 */
export type ExtensionToWebviewMessage = EventMessageType<ExtensionToWebviewEvents>

/**
 * Flow 事件
 *
 * 标识符:
 * - runId: 一次 Agent 运行的唯一主键。flowStart 路径由 webview 生成随 command 下发,
 *   next_agent / fork 路径由 extension 生成。signal/command 载荷以 runId 为唯一路由主键。
 * - sessionId: SDK 的 session_id,作为运行时属性挂在 AgentRun.sessionId 上。
 *   不再出现在 signal/command 载荷上;SDK 原生消息体内的 session_id 仍随 aiMessage 透传,
 *   reducer 从中提取回填到对应 AgentRun。
 *
 * 启动流程:
 * 1. webview 生成 runId,发 flow.command.flowStart{runId, agentId}
 * 2. extension 接收后 spawn FlowRunner / ClaudeExecutor,首条 SDK 消息携带 session_id 时
 *    回填 runs[runId].sessionId,并发 flow.signal.flowStart{runId, agentId} 推 phase 转 running
 *
 * 消息交互: 所有 signal/command 载荷只带 runId,reducer 在 runs[] 中按 runId 寻址。
 *
 * Agent 切换: agentComplete 携带新 runId(由 extension 生成),reducer 据此追加新 AgentRun。
 */

/** Flow 信号基础 payload（不含 flowId） */
type FlowSignalPayload = {
  /** Flow 启动成功:ClaudeExecutor 已就绪;getRunPhase 据 messages 推断为 running */
  flowStart: { runId: string; agentId: string }
  /** AI 输出(流式)。SDK message 内嵌的 session_id 由 reducer 回填到对应 AgentRun.sessionId */
  aiMessage: { runId: string; message: AIMessageType }
  /**
   * Agent 执行完成,选择了输出分支。
   * - runId: 当前完成的 Agent run 的 runId
   * - output.newRunId: 切到下一个 agent 时,extension 端生成的新 runId(后续交互的主键)
   */
  agentComplete: {
    runId: string
    content: string
    output?: { name: string; newRunId: string }
    /** Agent 通过 AgentComplete 写入的增量 values，由 reducer 合并到 FlowRunState.shareValues */
    values?: Record<string, string>
    /**
     * 本回合 SDK 最后一条 result 消息(含 modelUsage / total_cost_usd)。
     * AgentComplete 调用成功后,ClaudeExecutor 不再把这条 result 单独透传为 aiMessage
     */
    result?: AIMessageType
  }
  /**
   * silent_task 模式下 AskUserQuestion 由 ClaudeExecutor 自动应答时上抛的信号。
   * 载荷与 `flow.command.answerQuestion` 一致；reducer 处理逻辑也一致
   * （写入 answeredQuestions、移出 pendingQuestions），只是入口换成 signal —— 让
   * webview 在无人值守模式下也能看到自动答案，与人工回答展示路径统一。
   */
  answerQuestion: {
    runId: string
    toolUseId: string
    output: AskUserQuestionOutput
  }
  /** Agent被中断了 */
  agentInterrupted: { runId: string }
  /** agent错误 */
  agentError: { runId: string; agentId: string; err: Error }
  /** flow运行错误 */
  error: { runId?: string; msg: string }
  /** 工具调用命中 must_confirm 或兜底，等待用户确认 */
  toolPermissionRequest: {
    runId: string
    toolUseId: string
    toolName: string
    input: unknown
  }
  /**
   * require_confirm=true 时 Agent 调用 AgentComplete，等待用户确认是否放行。
   * 拒绝时 AgentComplete 会作为 isError tool_result 回喂 Agent。
   */
  agentCompleteConfirmRequest: {
    runId: string
    toolUseId: string
    /** AgentComplete MCP 工具的原始入参（content / output_name / values 等） */
    input: Record<string, unknown>
  }
  /**
   * 会话 fork 完成：从源 Flow 复制 transcript 切片到新 Flow。
   * - flowId（由 WithFlowId 注入）= sourceFlowId（源 Flow id）
   * - newFlowId / newRunState：新 Flow 的 id 与对应运行态
   * - runId：extension 端 fork 时同步 spawn FlowRunner 分配的运行 ID,
   *   webview 收到后写入 newRunState 对应 AgentRun;后续 sendUserMessage / answerQuestion /
   *   interrupt 都基于此 runId 派发到 runner。**所属 agent 由 newRunState.runs.at(-1).agentId 反推**,
   *   不再单独携带 agentId。
   *
   * 不携带 newFlow 定义；webview 端自行根据 sourceFlowId 深拷贝 Flow 后将 id 改为
   * newFlowId 加入 flows，并通过既有 save 通道持久化。
   */
  fork: {
    newFlowId: string
    newRunState: FlowRunState
    runId: string
  }
}

/** FlowRunner 内部信号（不含 flowId，由 FlowRunnerManager 外部注入） */
export type FlowRunnerSignalEvents = TypeWithPrefix<FlowSignalPayload, 'flow.signal.'>

/** Extension 发出的Flow信号（含 flowId，用于 webview 通信） */
export type ExtensionFlowSignalEvents = TypeWithPrefix<
  WithFlowId<FlowSignalPayload>,
  'flow.signal.'
>

/** Extension 发出的Flow信号消息（ExtensionToWebviewMessage 中 flow.signal.* 的子集） */
export type ExtensionFlowSignalMessage = EventMessageType<ExtensionFlowSignalEvents>

/** Flow 指令基础 payload（不含 flowId） */
type FlowCommandPayload = {
  /**
   * webview 发起启动:webview 生成 runId 随 command 下发,作为本次 run 的唯一主键。
   * reducer 收到后覆盖式重置 runs/answered/pendings,并以 runId 创建首个 AgentRun。
   */
  flowStart: {
    runId: string
    agentId: string
    initMessage: UserMessageType
  }
  /** 向指定 run 发送用户消息 */
  userMessage: { runId: string; message: UserMessageType }
  /** 中断指定 run */
  interrupt: { runId: string }
  /** 回答 SDK 内建 AskUserQuestion 工具的问题，resolve 对应的 canUseTool 挂起 */
  answerQuestion: {
    runId: string
    toolUseId: string
    output: AskUserQuestionOutput
  }
  /** 回答工具权限请求：允许或拒绝当前挂起的工具调用 */
  toolPermissionResult: {
    runId: string
    toolUseId: string
    allow: boolean
  }
  /**
   * 回答 AgentComplete 完成前确认：同意则放行 AgentComplete 原流程；
   * 拒绝则 SDK 收到 isError tool_result，Agent 可在同会话继续多轮。
   */
  answerAgentCompleteConfirm: {
    runId: string
    toolUseId: string
    accept: boolean
    /** 拒绝时填写的原因，accept=true 时忽略 */
    reason?: string
  }
  /** 彻底终止 Flow:销毁 FlowRunner,所有 run 转 stopped。仅需 flowId,不要求 runId */
  killFlow: object
  /** webview 编辑 shareValues 后同步到 extension */
  setShareValues: { values: Record<string, string> }
  /**
   * 从源 Flow 的某个切片 fork 出新 Flow。
   * - flowId（由 WithFlowId 注入）= 源 Flow id
   * - target：fork 目标。**target.runId 唯一定位源 RunState 中的 AgentRun**,
   *   extension 在该 run 的 messages 内按 messageUuid 找切片终点,
   *   以指定 SDK 消息 UUID 为切片终点（含），fork 后新 Flow 进入 `result` 态。
   *
   * SDK 不支持把 askUserQuestion 作为 fork 终点 —— 切片末端只能是
   * user/text/thinking/turn_end。
   */
  fork: {
    target: { kind: 'message'; runId: string; messageUuid: string }
  }
}

/** FlowRunner 内部指令（不含 flowId） */
export type FlowRunnerCommandEvents = TypeWithPrefix<FlowCommandPayload, 'flow.command.'>

/** Extension 接收的Flow指令（含 flowId，用于 webview 通信） */
export type ExtensionFlowCommandEvents = TypeWithPrefix<
  WithFlowId<FlowCommandPayload>,
  'flow.command.'
>

/** Extension 接收的Flow指令消息（ExtensionFromWebviewMessage 中 flow.command.* 的子集） */
export type ExtensionFlowCommandMessage = EventMessageType<ExtensionFlowCommandEvents>
