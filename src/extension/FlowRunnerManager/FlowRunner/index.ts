import { execaCommand } from 'execa'
import * as fs from 'fs'
import * as path from 'path'
import { match } from 'ts-pattern'
import * as vscode from 'vscode'
import {
  type Agent,
  type AIMessageType,
  type AskUserQuestionOutput,
  type Code,
  type FlowRunnerCommandEvents,
  type Flow,
  type FlowRunnerSignalEvents,
  UserMessageType,
} from '@/common'
import { logError } from '../../logger'
import { ClaudeExecutor, type ExecutorResult } from './ClaudeExecutor'
import { CodeExecutor } from './CodeExecutor'

/**
 * Windows 上 `bash` 命令可能被 WSL 拦截,需要显式定位 Git Bash 的 bash.exe。
 * 策略:用 `where git` 找到 git.exe 路径,推导同目录下的 bash.exe(Git for Windows 布局:
 * `Git/cmd/git.exe` → `Git/bin/bash.exe`);找不到则尝试常见安装路径。
 * 结果缓存,只解析一次。
 */
let _gitBashPath: string | undefined
let _gitBashResolved = false
async function resolveGitBash(): Promise<string | undefined> {
  if (_gitBashResolved) return _gitBashPath
  _gitBashResolved = true
  try {
    const { stdout } = await execaCommand('where git')
    const gitExe = stdout.trim().split('\n')[0].trim()
    if (gitExe) {
      // Git/cmd/git.exe → Git/bin/bash.exe
      const candidate = path.resolve(path.dirname(gitExe), '..', 'bin', 'bash.exe')
      if (fs.existsSync(candidate)) {
        _gitBashPath = candidate
        return _gitBashPath
      }
    }
  } catch {
    /* where git 失败则继续尝试 */
  }
  // 常见安装路径兜底
  const fallbacks = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  for (const p of fallbacks) {
    if (fs.existsSync(p)) {
      _gitBashPath = p
      return _gitBashPath
    }
  }
  return undefined
}

/**
 * 节点执行器联合 —— ClaudeExecutor 走 AI SDK,CodeExecutor 把 agent.code 当函数体执行。
 * 路由侧 FlowRunner 不区分二者:两者都实现 sendUserMessage / interrupt / answerQuestion /
 * answerToolPermission / answerCompleteConfirm / kill 接口,且 ExecutorEvents 同构。
 */
type Executor = ClaudeExecutor | CodeExecutor

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
  /**
   * 取当前 Flow 最新引用。
   * webview 编辑 agent 后发 `save` 命令会整体替换 currentFlows,旧 Flow 引用会过时;
   * FlowRunner 不持有 flow 字段,所有读 agent / shareValuesKeys 的地方都通过此回调
   * 取最新值,确保 fork 后(lazy 模式构造到首次启动间)用户改 agent 在首次启动时生效。
   */
  getLatestFlow: () => Flow
}

/**
 * 运行时容器:按 runId 持有 ClaudeExecutor。
 *
 * 本期 runtime 仍单 executor 约束(`executors.size <= 1`),`next_agent` 切换时仍 kill
 * 旧 executor 再 set 新 executor。Map 结构是为后期并发触发能力预留容器。
 *
 * 路由规则:所有 command 按 runId 在 Map 中寻址(`checkRun(runId)` = `Map.has(runId)`),
 * Executor 自身不持有任何 run 路由信息。
 *
 * 数据源:Flow 不作为字段持有,统一通过 `getLatestFlow()` 回调实时取,确保外部
 * (PersistedDataController save / setShareValues 等)更新后所有读取链路看到最新值。
 */
export class FlowRunner {
  private executors = new Map<string, Executor>()
  private signalListeners = new Map<keyof FlowRunnerSignalEvents, Set<SignalHandler<any>>>()
  private wildcardListeners = new Set<WildcardSignalHandler>()
  private readonly getLatestShareValues: () => Record<string, string>
  private readonly getLatestFlow: () => Flow

  constructor(options: FlowRunnerOptions) {
    this.getLatestShareValues = options.getLatestShareValues
    this.getLatestFlow = options.getLatestFlow
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
      .with('flow.command.answerAgentCompleteConfirm', () => {
        this.handleAnswerCompleteConfirm(
          data as FlowRunnerCommandEvents['flow.command.answerAgentCompleteConfirm'],
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

  /** 销毁 FlowRunner，终止全部 executor */
  dispose(): void {
    for (const [, executor] of this.executors) {
      executor.kill()
    }
    this.executors.clear()
    this.signalListeners.clear()
    this.wildcardListeners.clear()
  }

  /**
   * fork 路径专用:以 lazy 模式启动一个 ClaudeExecutor。runId 由 extension 端预先分配。
   * 不 fire flow.signal.flowStart(fork 由 extension 端用 flow.signal.fork 替代)。
   *
   * lazy 模式:executor 处于 lazy 态,构造时不 createQuery、不 push initMessage,
   * 等用户首次 sendUserMessage 触发 SDK 启动。fork 切片末端只可能是
   * user/text/thinking/turn_end —— SDK 不支持把 askUserQuestion 作为 fork 终点。
   */
  spawnForFork(params: { runId: string; agentId: string; resumeSessionId: string }): void {
    const { runId, agentId, resumeSessionId } = params
    // 提前 fail-fast:agent 必须存在才启动 lazy executor。lazy 闭包内仍会重新查最新 agent
    // 应用变更;若运行期间 agent 被删,fallback 到此处校验过的 initialAgent 不让首次启动崩。
    const initialAgent = this.findAgentById(agentId)
    if (!initialAgent) {
      this.fire('flow.signal.error', { msg: `Agent "${agentId}" not found in flow` })
      return
    }
    // code 节点没有 SDK session,无法 fork;webview 端不应给出 fork 入口。这里只兜底
    if (initialAgent.node_type === 'code') {
      this.fire('flow.signal.error', {
        msg: `代码节点 "${initialAgent.agent_name}" 不支持 fork`,
      })
      return
    }
    // 本期单 executor 约束:fork 时清掉所有现存 executor
    this.killAllExecutors()
    // dummy initMessage:fork 模式下不会被透传到上层、也不会作为 SDK prompt push,
    // 仅作为 ClaudeExecutor 接口占位。
    const dummyInit: UserMessageType = {
      type: 'user',
      message: { role: 'user', content: '' },
      parent_tool_use_id: null,
    }
    const executor: ClaudeExecutor = new ClaudeExecutor('lazy', () => {
      // lazy 模式首次 createQuery 时才进入此闭包:重查 agent / shareValues / shareValuesKeys
      // 取最新值,让构造到首次启动间用户改动 flow/agent 生效。flow 通过 getLatestFlow()
      // 回调取最新引用——webview save 命令会整体替换 currentFlows,持有 fork 时刻快照
      // 会拿到过时的 agents 与 shareValuesKeys。
      const latestFlow = this.getLatestFlow()
      const found = latestFlow.agents?.find((a) => a.id === agentId)
      // fork 仅支持 node_type='agent';若最新 flow 把该节点改成 code,回退到构造时校验过的 initialAgent
      const latestAgent = found && found.node_type !== 'code' ? found : initialAgent
      return {
        initMessage: dummyInit,
        agent: latestAgent,
        currentValues: this.getLatestShareValues(),
        shareValueKeys: latestFlow.shareValuesKeys ?? [],
        events: this.buildExecutorEvents(runId, latestAgent, () => executor),
        resumeSessionId,
        flowBaseUrl: latestFlow.base_url,
        flowApiKey: latestFlow.api_key,
      }
    })
    this.executors.set(runId, executor)
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
    runId,
    agentId,
    initMessage,
  }: FlowRunnerCommandEvents['flow.command.flowStart']): void {
    // 本期单 executor 约束:flowStart 前清掉所有现存 executor
    this.killAllExecutors()

    const agent = this.findAgentById(agentId)
    if (!agent) {
      this.fire('flow.signal.error', { msg: `Agent "${agentId}" not found in flow` })
      return
    }

    const effectiveInitMessage = agent.no_input
      ? {
          type: 'user' as const,
          message: { role: 'user' as const, content: '开始' },
          parent_tool_use_id: null,
        }
      : initMessage
    this.runAgent(runId, effectiveInitMessage, agent, this.getLatestShareValues(), true)
  }

  private handleUserMessage({
    runId,
    message,
  }: FlowRunnerCommandEvents['flow.command.userMessage']): void {
    const executor = this.executors.get(runId)
    if (!executor) return
    executor.sendUserMessage(message)
  }

  private async handleInterrupt({ runId }: FlowRunnerCommandEvents['flow.command.interrupt']) {
    const executor = this.executors.get(runId)
    if (!executor) return
    await executor.interrupt()
    this.fire('flow.signal.agentInterrupted', { runId })
  }

  private handleAnswerQuestion({
    runId,
    toolUseId,
    output,
  }: FlowRunnerCommandEvents['flow.command.answerQuestion']): void {
    const executor = this.executors.get(runId)
    if (!executor) return
    executor.answerQuestion(toolUseId, output)
  }

  private handleToolPermissionResult({
    runId,
    toolUseId,
    allow,
  }: FlowRunnerCommandEvents['flow.command.toolPermissionResult']): void {
    const executor = this.executors.get(runId)
    if (!executor) return
    executor.answerToolPermission(toolUseId, allow)
  }

  private handleAnswerCompleteConfirm({
    runId,
    toolUseId,
    accept,
    reason,
  }: FlowRunnerCommandEvents['flow.command.answerAgentCompleteConfirm']): void {
    const executor = this.executors.get(runId)
    if (!executor) return
    executor.answerCompleteConfirm(toolUseId, accept, reason)
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  /**
   * 启动一个 Agent run:按 node_type 分流 ClaudeExecutor / CodeExecutor 并写入 executors Map。
   * @param fireFlowStartSignal - 是否在首条 SDK 消息抵达时 fire flow.signal.flowStart
   *   (eager 路径需要;fork 路径由外层 spawnForFork 走 signal.fork 替代,故为 false)
   */
  private runAgent(
    runId: string,
    initMessage: UserMessageType,
    agent: Agent | Code,
    currentValues: Record<string, string>,
    fireFlowStartSignal: boolean,
  ): void {
    if (agent.node_type === 'code') {
      const executor: CodeExecutor = new CodeExecutor('eager', () => {
        const latestFlow = this.getLatestFlow()
        const cwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath
        return {
          initMessage,
          agent,
          currentValues,
          shareValueKeys: latestFlow.shareValuesKeys ?? [],
          runCommand: async (command: string, timeout?: number) => {
            // Windows 上 `bash` 会被 WSL 拦截,需要显式定位 Git Bash
            const shell = process.platform === 'win32' ? ((await resolveGitBash()) ?? 'bash') : true
            const { stdout, stderr } = await execaCommand(command, {
              cwd,
              timeout: timeout ?? 600_000,
              shell,
            })
            return stdout + stderr
          },
          events: this.buildExecutorEvents(runId, agent, () => executor, fireFlowStartSignal),
        }
      })
      this.executors.set(runId, executor)
      return
    }
    const executor: ClaudeExecutor = new ClaudeExecutor('eager', () => {
      const latestFlow = this.getLatestFlow()
      return {
        initMessage,
        agent,
        currentValues,
        shareValueKeys: latestFlow.shareValuesKeys ?? [],
        events: this.buildExecutorEvents(runId, agent, () => executor, fireFlowStartSignal),
        flowBaseUrl: latestFlow.base_url,
        flowApiKey: latestFlow.api_key,
      }
    })
    this.executors.set(runId, executor)
  }

  /** 构造 Executor 的事件回调 —— 上层路由(runId、kill)在此闭包注入。
   * 闭包对 ClaudeExecutor / CodeExecutor 同构:onComplete 回调里只比对 executor 引用,
   * 不区分类型,所以 getExecutor 用 Executor 联合即可。 */
  private buildExecutorEvents(
    runId: string,
    agent: Agent | Code,
    getExecutor: () => Executor,
    fireFlowStartSignal: boolean = false,
  ) {
    return {
      onStarted: () => {
        if (fireFlowStartSignal) {
          this.fire('flow.signal.flowStart', { runId, agentId: agent.id })
        }
      },
      onMessage: (message: AIMessageType) => {
        this.fire('flow.signal.aiMessage', { runId, message })
      },
      onComplete: (result: ExecutorResult) => {
        // 只接受当前 Map 里仍然绑定的 executor 的完成事件;切换到下一个 agent 时
        // 旧 executor 已被 kill 并从 Map 中移除,onComplete 即使到达也丢弃。
        if (this.executors.get(runId) !== getExecutor()) return
        this.onAgentComplete(runId, agent, result)
      },
      onToolPermissionRequest: ({
        toolUseId,
        toolName,
        input,
      }: {
        toolUseId: string
        toolName: string
        input: unknown
      }) => {
        this.fire('flow.signal.toolPermissionRequest', {
          runId,
          toolUseId,
          toolName,
          input,
        })
      },
      onCompleteConfirmRequest: ({
        toolUseId,
        input,
      }: {
        toolUseId: string
        input: Record<string, unknown>
      }) => {
        this.fire('flow.signal.agentCompleteConfirmRequest', {
          runId,
          toolUseId,
          input,
        })
      },
      onAnswerQuestion: (toolUseId: string, output: AskUserQuestionOutput) => {
        this.fire('flow.signal.answerQuestion', { runId, toolUseId, output })
      },
      onError: (err: Error) => {
        logError(`[FlowRunner] agent ${agent.id} error:`, err)
        this.fire('flow.signal.agentError', {
          runId,
          agentId: agent.id,
          err: err.message || String(err),
        })
      },
    }
  }

  private onAgentComplete(runId: string, agent: Agent | Code, result: ExecutorResult): void {
    try {
      this.doOnAgentComplete(runId, agent, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError(`[FlowRunner] onAgentComplete failed (agent=${agent.id}):`, err)
      this.fire('flow.signal.error', { msg: `agent complete failed: ${msg}` })
      // 继续向上抛，让 MCP withErrorBoundary 也能把 isError 反馈给 AI
      throw err
    }
  }

  private doOnAgentComplete(runId: string, agent: Agent | Code, result: ExecutorResult): void {
    const { outputName, content } = result

    // 查找下一个 agent
    const selectedOutput = (agent.outputs ?? []).find((o) => o.output_name === outputName)
    const nextAgentId = selectedOutput?.next_agent

    if (nextAgentId) {
      const nextAgent = this.findAgentById(nextAgentId)
      if (!nextAgent) {
        this.fire('flow.signal.error', { msg: `Next agent "${nextAgentId}" not found` })
        return
      }

      // 终结旧 executor(query 仍可能在发送 AgentComplete 的 tool_result 尾音)。
      // 必须 kill 后再建新 executor —— 旧消息不会被错误地挂到新 run 上。本期 runtime
      // 单 executor 约束,kill 旧 executor + Map.delete(oldRunId) + Map.set(newRunId,..)
      this.killExecutor(runId)
      // 切换到下一个 agent
      const nextInitMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: nextAgent.no_input ? '开始' : content },
        parent_tool_use_id: null,
      }
      // 局部叠加:reducer 此刻尚未收到 agentComplete signal,getLatestShareValues 拿到
      // 的还是合并前的值,因此手动叠加 result.values 给 nextAgent 的 systemPrompt。
      // FlowRunner 自身不持有 shareValues 状态——这是临时计算,不是字段维护。
      const nextValues = result.values
        ? { ...this.getLatestShareValues(), ...result.values }
        : this.getLatestShareValues()
      // extension 端为下一个 agent 生成新 runId
      const newRunId = crypto.randomUUID()
      this.runAgent(newRunId, nextInitMessage, nextAgent, nextValues, false)
      this.fire('flow.signal.agentComplete', {
        runId,
        content,
        output: { name: result.outputName!, newRunId },
        values: result.values,
        result: result.resultMessage,
      })
    } else {
      // Flow 结束
      this.killExecutor(runId)
      this.fire('flow.signal.agentComplete', {
        runId,
        output: { name: result.outputName },
        content: result.content,
        values: result.values,
        result: result.resultMessage,
      })
    }
  }

  // ── 工具方法 ────────────────────────────────────────────────────────────

  private findAgentById(id: string): Agent | Code | undefined {
    return (this.getLatestFlow().agents ?? []).find((a) => a.id === id)
  }

  private killExecutor(runId: string): void {
    const executor = this.executors.get(runId)
    if (executor) {
      executor.kill()
      this.executors.delete(runId)
    }
  }

  private killAllExecutors(): void {
    for (const [, executor] of this.executors) {
      executor.kill()
    }
    this.executors.clear()
  }
}
