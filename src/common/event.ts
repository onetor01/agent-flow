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
 * 事件参数中的标识符：
 * - runId: extension 端分配的运行 ID，标识一次 Flow 运行实例
 * - runKey: webview 端分配的 key，传入 flow 内部用于校验响应归属
 * - sessionId: 当前 agent session 的标识，消息交互必须在两端 sessionId 对齐的基础上发生
 *
 * 开启 Flow 的流程：
 * 1. webview 生成 runKey，发起 flowStart command
 * 2. extension 中断当前 Flow，将 runKey 传入新 Flow 内部进行校验，分配新 runId，创建 agent session，发出 flowStart signal
 * 3. webview 校验 signal 中的 runKey 与自己发出的一致后，保存 runId 和 sessionId
 *    （用户可随时开始新 Flow，通过 runKey 校验确保 runId 对应当前请求）
 *
 * 消息交互：
 * - 所有消息（AI/用户）均携带 runId + sessionId，确保归属明确
 * - flow 收到 userMessage command 后，通过 userMessage signal 回显，保证两端数据一致
 *
 * Agent 切换：
 * - agent 选择 output 后，agentComplete 携带新 sessionId 供后续交互使用
 */

/** Flow 信号基础 payload（不含 flowId） */
type FlowSignalPayload = {
  /** Flow 启动成功，携带 key 供 webview 校验归属 */
  flowStart: { runId: string; runKey: string; sessionId: string; agentId: string }
  /** AI 输出（流式），必须在 runId + sessionId 对齐下发生。用户消息会也会被视作aiMessage。 */
  aiMessage: { runId: string; sessionId: string; message: AIMessageType }
  /** Agent 执行完成，选择了输出分支；output.newSessionId 为下一轮交互的新 session */
  agentComplete: {
    runId: string
    sessionId: string
    content: string
    output?: { name: string; newSessionId: string }
    /** Agent 通过 MCP setShareValues 写入的共享数据，作为完成信号的一部分同步给 webview */
    shareValues?: Record<string, string>
  }
  /** Agent被中断了 */
  agentInterrupted: { runId: string; sessionId: string }
  /** agent错误 */
  agentError: { runId: string; agentId: string; err: Error }
  /** flow运行错误 */
  error: { runId?: string; msg: string }
  /** 工具调用命中 must_confirm 或兜底，等待用户确认 */
  toolPermissionRequest: {
    runId: string
    sessionId: string
    toolUseId: string
    toolName: string
    input: unknown
  }
  /**
   * 会话 fork 完成：从源 Flow 复制 transcript 切片到新 Flow。
   * - flowId（由 WithFlowId 注入）= sourceFlowId（源 Flow id）
   * - newFlowId / newRunState：新 Flow 的 id 与对应运行态
   * - agentId：fork 起点所在的 agent id（用于 webview 自动打开 ChatDrawer）
   * - runId：extension 端 fork 时同步 spawn FlowRunner 分配的运行 ID（运行时必须）;
   *   webview 收到后写入 newRunState.runId,后续 sendUserMessage / answerQuestion /
   *   interrupt 都基于此 runId 派发到 runner。FlowRunState.runId 类型保持
   *   `string | undefined` 兼容空闲态,但 fork 信号中此字段必有值。
   *
   * 不携带 newFlow 定义；webview 端自行根据 sourceFlowId 深拷贝 Flow 后将 id 改为
   * newFlowId 加入 flows，并通过既有 save 通道持久化。
   */
  fork: {
    newFlowId: string
    newRunState: FlowRunState
    agentId: string
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
   * webview 发起启动，key 传入 flow 内部用于校验响应归属。
   * `resumeSessionId` 存在时表示 resume 一个已存在的 SDK 会话（fork 出的新 Flow
   * 在用户首次发消息时走此路径），reducer 保留既有 sessions / answeredQuestions
   * / shareValues 不重置。
   */
  flowStart: {
    runKey: string
    agentId: string
    initMessage: UserMessageType
    resumeSessionId?: string
  }
  /** 向当前 Agent 发送用户消息，必须在 runId + sessionId 对齐下发生 */
  userMessage: { runId: string; sessionId: string; message: UserMessageType }
  /** 中断当前 Agent，使其等待用户输入 */
  interrupt: { runId: string; sessionId: string }
  /** 回答 SDK 内建 AskUserQuestion 工具的问题，resolve 对应的 canUseTool 挂起 */
  answerQuestion: {
    runId: string
    sessionId: string
    toolUseId: string
    output: AskUserQuestionOutput
  }
  /** 回答工具权限请求：允许或拒绝当前挂起的工具调用 */
  toolPermissionResult: {
    runId: string
    sessionId: string
    toolUseId: string
    allow: boolean
  }
  /** 彻底终止 Flow：销毁 FlowRunner，state 置终态。仅需 flowId，不要求 runId/sessionId */
  killFlow: object
  /** webview 编辑 shareValues 后同步到 extension */
  setShareValues: { values: Record<string, string> }
  /**
   * 从源 Flow 的某个切片 fork 出新 Flow。
   * - flowId（由 WithFlowId 注入）= 源 Flow id
   * - agentId：fork 起点所在的 agent id（用于 webview 自动打开 ChatDrawer）
   * - target：fork 目标
   *   - `message`：以指定 SDK 消息 UUID 为切片终点（含），fork 后新 Flow 进入 `result` 态
   *   - `askUserQuestion`：以包含该 toolUseId 的 assistant message 为切片终点（不含 tool_result），
   *     新 Flow 进入 `awaiting-question` 态，问题在输入区上方重弹
   */
  fork: {
    agentId: string
    target:
      | { kind: 'message'; messageUuid: string }
      | { kind: 'askUserQuestion'; toolUseId: string }
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
