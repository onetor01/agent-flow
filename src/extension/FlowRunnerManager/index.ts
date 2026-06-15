import { match } from 'ts-pattern'
import type { Flow, ExtensionFlowCommandEvents, ExtensionToWebviewMessage } from '@/common'
import { FlowRunner } from './FlowRunner'

type PostMessage = (msg: ExtensionToWebviewMessage) => void
type GetLatestShareValues = (flowId: string) => Record<string, string>
type GetLatestFlow = (flowId: string) => Flow | undefined
type GetLatestCwd = (flowId: string) => string | undefined | null

export class FlowRunnerManager {
  private runners = new Map<string, FlowRunner>()
  private postMessage: PostMessage
  private getLatestShareValues: GetLatestShareValues
  private getLatestFlow: GetLatestFlow
  private getLatestCwd: GetLatestCwd

  constructor(
    postMessage: PostMessage,
    getLatestShareValues: GetLatestShareValues,
    getLatestFlow: GetLatestFlow,
    getLatestCwd: GetLatestCwd,
  ) {
    this.postMessage = postMessage
    this.getLatestShareValues = getLatestShareValues
    this.getLatestFlow = getLatestFlow
    this.getLatestCwd = getLatestCwd
  }

  /**
   * 构造 FlowRunner 时注入 flow 数据源 —— FlowRunner 不再持有 flow 字段,
   * 所有读取链路通过 getLatestFlow(flowId) 实时取,确保 webview save 后改的 agent
   * 能立即在 lazy 启动闭包里被读到。flowId 在此处闭包绑定,FlowRunner 内无需感知。
   */
  private createRunner(flowId: string): FlowRunner {
    const runner = new FlowRunner({
      getLatestShareValues: () => this.getLatestShareValues(flowId),
      getLatestFlow: () => {
        const flow = this.getLatestFlow(flowId)
        if (!flow) throw new Error(`[FlowRunnerManager] flow "${flowId}" not found`)
        return flow
      },
      getLatestCwd: () => this.getLatestCwd(flowId),
    })
    runner.listenAllSignals((eventType, signalData) => {
      this.postMessage({
        type: eventType,
        data: { ...signalData, flowId },
      } as ExtensionToWebviewMessage)
    })
    return runner
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
        const { flowId, runId, agentId, initMessage } =
          data as ExtensionFlowCommandEvents['flow.command.flowStart']
        this.disposeRunner(flowId)
        const runner = this.createRunner(flowId)
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
      .with('flow.command.clearFlow', () => {
        const { flowId } = data as ExtensionFlowCommandEvents['flow.command.clearFlow']
        this.disposeRunner(flowId)
      })
      .with('flow.command.setCwd', () => {
        // cwd state 已由 flowRunStateManager.applyCommand 处理；FlowRunner 通过
        // getLatestCwd() 回调实时取，不需要额外派发
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
   * fork 路径专用：spawn FlowRunner 并启动 ClaudeExecutor（lazy 模式）。
   * - 调用方需提前生成 runId,以便 webview 收到 signal.fork 后用 runId 派发
   *   sendUserMessage / answerToolPermission / interrupt
   * - 不发 flow.signal.flowStart;runId 由 extension 端通过 signal.fork 同步
   * - 调用前必须先把 newFlow 写入 currentFlows,FlowRunner 通过 getLatestFlow(flowId)
   *   实时取最新引用(lazy 闭包内读到的是用户改 agent 后的最新值)
   */
  spawnForFork(params: {
    flowId: string
    agentId: string
    resumeSessionId: string
    runId: string
  }): void {
    const { flowId, agentId, resumeSessionId, runId } = params
    this.disposeRunner(flowId)
    const runner = this.createRunner(flowId)
    this.runners.set(flowId, runner)
    runner.spawnForFork({ runId, agentId, resumeSessionId })
  }

  /** 崩溃恢复时为持久化 run 注册 lazy executor，语义同 spawnForFork */
  spawnForRestore(params: {
    flowId: string
    runId: string
    agentId: string
    resumeSessionId: string
  }): void {
    const { flowId, agentId, resumeSessionId, runId } = params
    this.disposeRunner(flowId)
    const runner = this.createRunner(flowId)
    this.runners.set(flowId, runner)
    runner.spawnForFork({ runId, agentId, resumeSessionId })
  }
}
