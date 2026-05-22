import { match } from 'ts-pattern'
import type { Flow, ExtensionFlowCommandEvents, ExtensionToWebviewMessage } from '@/common'
import { FlowRunner } from './FlowRunner'
import type { ExecutorMode } from './FlowRunner/ClaudeExecutor'

type PostMessage = (msg: ExtensionToWebviewMessage) => void
type GetLatestShareValues = (flowId: string) => Record<string, string>

export class FlowRunnerManager {
  private runners = new Map<string, FlowRunner>()
  private postMessage: PostMessage
  private getLatestShareValues: GetLatestShareValues

  constructor(postMessage: PostMessage, getLatestShareValues: GetLatestShareValues) {
    this.postMessage = postMessage
    this.getLatestShareValues = getLatestShareValues
  }

  /**
   * type 形参必须用 `keyof ExtensionFlowCommandEvents` 约束,
   * 让 .with(...) 的字符串实参与事件契约的 key 编译期对齐;
   * 末尾 .exhaustive() 强制穷尽所有分支(包括 flow.command.fork —— 虽然
   * 已在外层 handleFork 截获,这里仍需 noop 分支以满足穷尽校验)。
   * 任何字符串错配(如曾经的 'killFlow')或新增分支遗漏都会编译期失败,
   * 防止 .otherwise 把命令静默吞掉(参见 CLAUDE.md「易踩坑」节)。
   */
  handleCommand(type: keyof ExtensionFlowCommandEvents, data: any): void {
    match(type)
      .with('flow.command.flowStart', () => {
        const { flowId, runId, agentId, flow, initMessage } =
          data as ExtensionFlowCommandEvents['flow.command.flowStart'] & { flow: Flow }
        this.disposeRunner(flowId)
        const runner = new FlowRunner(flow, {
          getLatestShareValues: () => this.getLatestShareValues(flowId),
        })
        runner.listenAllSignals((eventType, signalData) => {
          this.postMessage({
            type: eventType,
            data: { ...signalData, flowId },
          } as ExtensionToWebviewMessage)
        })
        this.runners.set(flowId, runner)
        runner.emit('flow.command.flowStart', { runId, agentId, initMessage })
      })
      .with('flow.command.userMessage', () => {
        const { flowId, ...rest } = data as ExtensionFlowCommandEvents['flow.command.userMessage']
        this.runners.get(flowId)?.emit('flow.command.userMessage', rest)
      })
      .with('flow.command.interrupt', () => {
        const { flowId, ...rest } = data as ExtensionFlowCommandEvents['flow.command.interrupt']
        this.runners.get(flowId)?.emit('flow.command.interrupt', rest)
      })
      .with('flow.command.answerQuestion', () => {
        const { flowId, ...rest } =
          data as ExtensionFlowCommandEvents['flow.command.answerQuestion']
        this.runners.get(flowId)?.emit('flow.command.answerQuestion', rest)
      })
      .with('flow.command.toolPermissionResult', () => {
        const { flowId, ...rest } =
          data as ExtensionFlowCommandEvents['flow.command.toolPermissionResult']
        this.runners.get(flowId)?.emit('flow.command.toolPermissionResult', rest)
      })
      .with('flow.command.setShareValues', () => {
        const { flowId, ...rest } =
          data as ExtensionFlowCommandEvents['flow.command.setShareValues']
        this.runners.get(flowId)?.emit('flow.command.setShareValues', rest)
      })
      .with('flow.command.killFlow', () => {
        const { flowId } = data as ExtensionFlowCommandEvents['flow.command.killFlow']
        this.disposeRunner(flowId)
      })
      .with('flow.command.fork', () => {
        // fork 由 extension 顶层 handleFork 处理,不会进入 runnerManager
      })
      .exhaustive()
  }

  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose()
    }
    this.runners.clear()
  }

  disposeRunner(flowId: string): void {
    const existing = this.runners.get(flowId)
    if (existing) {
      existing.dispose()
      this.runners.delete(flowId)
    }
  }

  /**
   * fork 路径专用：spawn FlowRunner 并启动 ClaudeExecutor。
   * - 调用方需提前生成 runId,以便 webview 收到 signal.fork 后用 runId 派发
   *   sendUserMessage / answerQuestion / interrupt
   * - 不发 flow.signal.flowStart;runId 由 extension 端通过 signal.fork 同步
   * - mode 决定 ClaudeExecutor 启动行为(详见 ClaudeExecutor.ExecutorMode):
   *   - 'lazy': 普通 fork(user/text/thinking/turn_end)
   *   - 'resume-pending': askUserQuestion fork(立即启动 SDK 等 canUseTool)
   */
  spawnForFork(params: {
    flowId: string
    flow: Flow
    agentId: string
    resumeSessionId: string
    runId: string
    mode: ExecutorMode
  }): void {
    const { flowId, flow, agentId, resumeSessionId, runId, mode } = params
    this.disposeRunner(flowId)
    const runner = new FlowRunner(flow, {
      getLatestShareValues: () => this.getLatestShareValues(flowId),
    })
    runner.listenAllSignals((eventType, signalData) => {
      this.postMessage({
        type: eventType,
        data: { ...signalData, flowId },
      } as ExtensionToWebviewMessage)
    })
    this.runners.set(flowId, runner)
    runner.spawnForFork({ runId, agentId, resumeSessionId, mode })
  }
}
