import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { throttle } from 'lodash-es'
import * as path from 'path'
import { match, P } from 'ts-pattern'
import * as vscode from 'vscode'
import type {
  AgentRun,
  ExtensionFlowCommandEvents,
  ExtensionFlowCommandMessage,
  ExtensionFlowSignalMessage,
  ExtensionFromWebviewMessage,
  ExtensionToWebviewMessage,
  Flow,
  FlowRunState,
  PersistedData,
} from '@/common'
import { markInterrupted } from '@/common'
import { FlowRunStateManager } from './FlowRunStateManager'
import { FlowRunnerManager } from './FlowRunnerManager'
import { PersistedDataController } from './PersistedDataController'
import { initLogger, log, logError, summarizeLogPayload } from './logger'

/** 扩展名 → VSCode languageId（仅覆盖常见语言，未命中时保持 plaintext） */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

export function activate(context: vscode.ExtensionContext) {
  initLogger(context)
  let currentPanel: vscode.WebviewPanel | undefined
  /** webview 是否已就绪：以收到 load command 为准。dispose 时重置为 false */
  let webviewReady = false
  /** webview load前的消息/缓存的ai消息 */
  let pendingMessages: ExtensionToWebviewMessage[] = []

  // 把 runner / 持久化 / 状态镜像 提到 activate 作用域：webview 关闭后这些对象继续存活，
  // 等下次开 panel 重连。
  const flowStore = new PersistedDataController()
  const flowRunStateManager = new FlowRunStateManager()
  let currentFlows: PersistedData = { flows: [] }

  const postMessageToWebview = (msg: ExtensionToWebviewMessage) => {
    if (msg.type === 'batchMessages') {
      // 拆分为普通消息 否则flushMessages发送的批量消息会包含批量消息
      msg.data.forEach(postMessageToWebview)
      return
    }
    log('[Extension → Webview]', msg.type, summarizeLogPayload(msg.type, msg.data))
    if (msg.type === 'load') {
      webviewReady = true
      // load必须在最前面
      pendingMessages.unshift(msg)
    } else {
      pendingMessages.push(msg)
    }
    // signal 进入前先喂给状态镜像，确保 webview 不在时 extension 这边状态依然完整
    if (msg.type.startsWith('flow.signal.')) {
      flowRunStateManager.applySignal(msg as ExtensionFlowSignalMessage)
    }
    flushMessages()
    if (msg.type !== 'flow.signal.aiMessage' || msg.data.message.type !== 'stream_event') {
      // 非流式消息直接发送
      flushMessages.flush()
    }
  }
  const flushMessages = throttle(
    () => {
      if (currentPanel && pendingMessages.length > 0 && webviewReady) {
        currentPanel.webview.postMessage({ type: 'batchMessages', data: pendingMessages })
        pendingMessages = []
      }
    },
    300,
    {
      leading: true,
    },
  )

  // notifyUser webPanel不存在或不可见 弹 VSCode 通知。
  // notifyUser: 当 panel 不存在或不可见时弹 VSCode 通知。
  flowRunStateManager.setNotifyHandler((data) => {
    const { agentName, flowId, flowName, reason, toolName } = data

    if (currentPanel && currentPanel.visible) return

    // awaiting-tool-permission 按 toolName 分流文案(.includes 对 mcp__ 与 :: 两种格式都成立)
    const toolPermLabel = (): string => {
      if (toolName?.includes('AskUserQuestion')) return `Agent「${agentName}」需要回答`
      if (toolName?.includes('CompleteTask')) return `Agent「${agentName}」等待完成确认`
      if (toolName?.includes('ExitPlanMode')) return `Agent「${agentName}」计划已生成`
      return `Agent「${agentName}」请求授权`
    }

    const msg = match(reason)
      .with('result', () => `Agent「${agentName}」生成完毕`)
      .with('awaiting-tool-permission', () => toolPermLabel())
      .with('flow-completed', () => `工作流「${flowName}」已完成`)
      .with('agent-error', () => `Agent「${agentName}」运行出错`)
      .exhaustive()
    vscode.window.showInformationMessage(msg, '查看').then((choice) => {
      if (choice !== '查看') return
      postMessageToWebview({
        type: 'focusFlow',
        data: { flowId },
      })
      vscode.commands.executeCommand('agent-flow.openPanel')
      currentPanel?.reveal(undefined, true)
    })
  })

  const runnerManager = new FlowRunnerManager(
    postMessageToWebview,
    (flowId) => flowRunStateManager.getFlowRunStates()[flowId]?.shareValues ?? {},
    (flowId) => currentFlows.flows.find((f) => f.id === flowId),
  )

  /**
   * 在源 RunState 的指定 run 中定位 fork 切片终点。
   * target.runId 已唯一定位 AgentRun,这里只在该 run 的 messages 内寻 messageUuid。
   * - `messageIdx` 为 target 命中的 ChatMessage 在 run.messages 中的索引,
   *   handleFork 据此 slice(0, messageIdx + 1) 裁剪 messages,确保 webview
   *   端切片与 SDK transcript 一致(不含切片终点之后的内容)。
   * - 同一条 assistant 的多个 block 在累加态模型中是多条 ChatMessage 但共享同一 uuid,
   *   取**最后一个**匹配下标以包含整条 assistant 的全部 block。
   */
  type ForkTarget = ExtensionFlowCommandEvents['flow.command.fork']['target']
  const locateFork = (
    state: FlowRunState,
    target: ForkTarget,
  ):
    | {
        runIdx: number
        sessionId: string | undefined
        messageIdx: number
        upToMessageId: string
      }
    | undefined => {
    const runIdx = state.runs.findIndex((r) => r.runId === target.runId)
    if (runIdx < 0) return undefined
    const run = state.runs[runIdx]
    let messageToolUseId: string | undefined
    let messageIdx = -1
    for (let j = 0; j < run.messages.length; j++) {
      const curMessage = run.messages[j]
      if (run.messages[j].uuid === target.messageUuid) {
        messageIdx = j
        if (curMessage.kind === 'tool_use') {
          messageToolUseId = curMessage.toolUseId
        }
      }
      // 需要包含所有子消息
      if (curMessage.parentToolUseId === messageToolUseId) {
        messageIdx = j
      }
    }

    if (messageIdx < 0) return undefined
    return {
      runIdx,
      sessionId: run.sessionId,
      messageIdx,
      upToMessageId: target.messageUuid,
    }
  }

  /**
   * 处理 fork command：调 SDK forkSession 复制 transcript 切片，立即 spawn FlowRunner
   * (lazy 模式 resume) 拿到 runId 写入 newRunState,然后发 `flow.signal.fork`。
   *
   * 关键点：
   * 1. **按 upToMessageId 裁剪 messages**：防止 webview 端切片包含切片终点之后的内容
   *    （如 thinking fork 不应显示后续 result）
   * 2. **用 SDK getSessionMessages 对齐 webview 切片末端 session 的 message uuid**：
   *    forkSession 会重映射所有 message UUID,若 webview 切片仍持有源 uuid,后续
   *    在新 Flow 中再次 fork 时 locateFork 命中的 sdkMsg.uuid 是源 uuid,
   *    forkSession(newSessionId, { upToMessageId: srcUuid }) 在新 session 中找
   *    不到该 uuid,直接报错。
   * 3. **同步 spawn FlowRunner**：拿到 runId 写入 newRunState,webview 后续可正常
   *    sendUserMessage / answerToolPermission / interrupt（不再 silent drop）
   */
  const handleFork = async (
    data: ExtensionFlowCommandEvents['flow.command.fork'],
  ): Promise<void> => {
    const { flowId: sourceFlowId, target } = data
    const sourceFlow = currentFlows.flows.find((f) => f.id === sourceFlowId)
    const sourceState = flowRunStateManager.getFlowRunStates()[sourceFlowId]
    if (!sourceFlow || !sourceState) {
      logError('[fork] source flow / state missing', sourceFlowId)
      return
    }
    const located = locateFork(sourceState, target)
    if (!located || !located.upToMessageId || !located.sessionId) {
      logError('[fork] target not located', target)
      return
    }
    const { runIdx, sessionId: srcSessionId, messageIdx, upToMessageId } = located
    // agentId 由 target.runId 定位到的 run 反推 —— spawnForFork 启动 FlowRunner 需要,
    // signal 不再单独携带(webview 端从 newRunState.runs.at(-1).agentId 反推)
    const agentId = sourceState.runs[runIdx].agentId

    const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath
    let newSessionId: string
    try {
      const result = await forkSession(srcSessionId, { upToMessageId, dir })
      newSessionId = result.sessionId
    } catch (err) {
      logError('[fork] forkSession failed', err)
      return
    }

    // 复制并裁剪 runs:保留 [0, runIdx),target 所在 run
    // 替换为新 runId、completed 重置;messages 按 messageIdx 裁剪到切片终点(含)
    const newRunId = globalThis.crypto.randomUUID()
    const newRuns = sourceState.runs.slice(0, runIdx).map((r) => structuredClone(r))
    const targetRun = sourceState.runs[runIdx]
    const slicedMessages = targetRun.messages
      .slice(0, messageIdx + 1)
      .map((m) => structuredClone(m))
    // 用双 transcript（源 session + 新 session）建 srcUuid→newUuid 映射，
    // 据此替换切片中所有带 uuid 的 ChatMessage（累加态模型 uuid 在项顶层）。
    // forkSession 的新 session transcript 是源 session 的保序前缀切片，按位置严格对应，
    // 这是唯一可靠的对齐方式（webview echo 无 uuid，顺序对齐会错位导致贴错 uuid）。
    try {
      const [srcTranscript, newTranscript] = await Promise.all([
        getSessionMessages(srcSessionId, { dir }),
        getSessionMessages(newSessionId, { dir }),
      ])
      const uuidMap = new Map<string, string>()
      const len = Math.min(srcTranscript.length, newTranscript.length)
      for (let i = 0; i < len; i++) {
        const srcUuid = srcTranscript[i].uuid
        const newUuid = newTranscript[i].uuid
        if (srcUuid && newUuid) uuidMap.set(srcUuid, newUuid)
      }
      for (const m of slicedMessages) {
        if (!m.uuid) continue
        const remapped = uuidMap.get(m.uuid)
        if (remapped) {
          m.uuid = remapped
        } else {
          logError('[fork] uuid not in srcTranscript mapping, keeping original', m.uuid)
        }
      }
    } catch (err) {
      // 拿不到 transcript 时不阻断 fork,仅打日志;UI 仍能进入新 Flow,只是再 fork 会失败
      logError('[fork] getSessionMessages failed, message uuid not remapped', err)
    }

    // 累加态 acc 重建:activeBlocks 清空(流式区已截断);toolUseIndex 从 sliced tool_use 项重建;
    // seq 取 sliced 长度(id 单调不复用);prevModelUsage/lastTotalCost/mainModel/lastTurnContextUsage
    // 保留 clone 值(fork 是 resume 同 session,token 累计延续)。
    const baseRun = structuredClone(targetRun)
    const toolUseIndex: Record<string, number> = {}
    slicedMessages.forEach((m, i) => {
      if (m.kind === 'tool_use') toolUseIndex[m.toolUseId] = i
    })
    const newRun: AgentRun = {
      ...baseRun,
      runId: newRunId,
      sessionId: newSessionId,
      messages: slicedMessages,
      completed: false,
      outputName: undefined,
      // structuredClone 会带过旧 error → getRunPhase 返 error 而非 interrupted,显式清除
      error: undefined,
      // fork 后置 interrupted 让 getRunPhase 推断为 'interrupted'(ChatInput ready 可发消息)
      interrupted: true,
      acc: {
        ...baseRun.acc,
        activeBlocks: {},
        toolUseIndex,
        seq: slicedMessages.length,
      },
    }
    // 切片末端未定稿的 streaming/pending 项标记为 interrupted(替代原追加 agentInterrupted 信号)
    markInterrupted(newRun)
    newRuns.push(newRun)

    const newRunState: FlowRunState = {
      killed: false,
      runs: newRuns,
      answeredToolPermissions: { ...sourceState.answeredToolPermissions },
      pendingToolPermissions: [],
      shareValues: { ...sourceState.shareValues },
    }

    const newFlowId = globalThis.crypto.randomUUID()
    const newFlow: Flow = { ...structuredClone(sourceFlow), id: newFlowId }
    currentFlows = { ...currentFlows, flows: [...currentFlows.flows, newFlow] }
    // applyFlows 会同步 flows 给 flowRunStateManager.flows,但不会清掉新 flow 的 state
    flowRunStateManager.applyFlows(currentFlows.flows, (flowId) =>
      runnerManager.disposeRunner(flowId),
    )
    flowRunStateManager.setRunState(newFlowId, newRunState)

    // 立即 spawn FlowRunner 启动 SDK(lazy 模式);runId 已确定,webview 后续派发的
    // userMessage / answerToolPermission / interrupt 都能正常匹配到此 runner。
    // fork 切片末端只可能是 user/text/thinking/turn_end —— SDK 不支持把
    // askUserQuestion 作为 fork 终点。
    // newFlow 已写入 currentFlows,FlowRunner 通过 getLatestFlow(flowId) 实时取——
    // lazy 闭包首次启动时会读到用户改 agent 后的最新值。
    runnerManager.spawnForFork({
      flowId: newFlowId,
      agentId,
      resumeSessionId: newSessionId,
      runId: newRunId,
    })

    postMessageToWebview({
      type: 'flow.signal.fork',
      data: { flowId: sourceFlowId, newFlowId, newRunState, runId: newRunId },
    })
  }

  const openPanel = vscode.commands.registerCommand('agent-flow.openPanel', () => {
    if (currentPanel) {
      currentPanel.reveal(undefined, true)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      'agentFlow',
      'Agent Flow',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    )
    currentPanel = panel
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg')
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri)

    panel.webview.onDidReceiveMessage(async (e: ExtensionFromWebviewMessage) => {
      log('[Webview → Extension]', e.type, summarizeLogPayload(e.type, e.data))
      match(e)
        .with({ type: 'load' }, async () => {
          const diskFlows = await flowStore.load()
          const memoryFlows = currentFlows.flows
          const memoryRunStates = flowRunStateManager.getFlowRunStates()
          const hasMessages = (flowId: string) => {
            const state = memoryRunStates[flowId]
            return state?.runs?.some((r) => r.messages?.length > 0) ?? false
          }
          // 合并时磁盘 flow 为基准
          const mergedFlows = diskFlows.flows
          // 追加磁盘不存在且内存有消息的flow
          const diskFlowIds = new Set(diskFlows.flows.map((f) => f.id))
          for (const memFlow of memoryFlows) {
            if (!diskFlowIds.has(memFlow.id) && hasMessages(memFlow.id)) {
              mergedFlows.push(memFlow)
            }
          }

          currentFlows = { flows: mergedFlows }
          flowRunStateManager.applyFlows(currentFlows.flows, (flowId) =>
            runnerManager.disposeRunner(flowId),
          )
          postMessageToWebview({
            type: 'load',
            data: {
              flows: currentFlows.flows,
              flowRunStates: flowRunStateManager.getFlowRunStates(),
            },
          })
        })
        .with({ type: 'save' }, async ({ data }) => {
          const storeData: PersistedData = { flows: data }
          currentFlows = storeData
          flowRunStateManager.applyFlows(currentFlows.flows, (flowId) =>
            runnerManager.disposeRunner(flowId),
          )
          await flowStore.save(storeData)
        })
        .with({ type: 'previewAttachment' }, async ({ data }) => {
          const { name, content } = data
          try {
            const ext = name.toLowerCase().split('.').pop()
            const language = ext ? LANG_BY_EXT[ext] : undefined
            const doc = await vscode.workspace.openTextDocument({ language, content })
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.One,
              preview: true,
            })
          } catch (err) {
            logError('previewAttachment failed', err)
          }
        })
        .with({ type: 'openFile' }, async ({ data }) => {
          const { filename, line, placement } = data
          const folders = vscode.workspace.workspaceFolders
          if (!path.isAbsolute(filename) && !folders?.length) return
          try {
            const uri = path.isAbsolute(filename)
              ? vscode.Uri.file(filename)
              : vscode.Uri.joinPath(folders![0].uri, filename)
            const doc = await vscode.workspace.openTextDocument(uri)
            const editor = await vscode.window.showTextDocument(
              doc,
              match(placement)
                .with('beside', () => vscode.ViewColumn.Beside)
                .otherwise(() => vscode.ViewColumn.Active),
            )
            if (line) {
              const [startLine, endLine] = line
              const startPos = new vscode.Position(Math.max(0, startLine - 1), 0)
              const endPos = new vscode.Position(Math.max(0, endLine - 1), Number.MAX_SAFE_INTEGER)
              editor.selection = new vscode.Selection(startPos, endPos)
              editor.revealRange(
                new vscode.Range(startPos, endPos),
                vscode.TextEditorRevealType.InCenter,
              )
            }
          } catch {
            // 文件不存在或无法打开时静默忽略
          }
        })
        .with({ type: P.string.startsWith('flow.command.') }, async (e) => {
          // fork 是特殊命令：不走 runner，由 extension 自己处理 SDK forkSession
          if (e.type === 'flow.command.fork') {
            await handleFork(e.data as ExtensionFlowCommandEvents['flow.command.fork'])
            return
          }
          // 先镜像到 state（flowStart 路径的覆盖式初始化也由 reducer 完成；killFlow 会置 stopped）
          flowRunStateManager.applyCommand(e as ExtensionFlowCommandMessage)
          const { type, data } = e
          if (type === 'flow.command.flowStart') {
            const { flowId } = data as ExtensionFlowCommandEvents['flow.command.flowStart']
            // flow 必须存在才能启动;FlowRunner 内部通过 getLatestFlow 实时取,
            // 这里只做 fail-fast 校验,不再把 flow 注入到 data 里
            const flow = currentFlows.flows.find((f) => f.id === flowId)
            if (!flow) return
            runnerManager.handleCommand(type, data)
          } else {
            runnerManager.handleCommand(type, data)
          }
        })
        .exhaustive()
    })

    panel.onDidDispose(() => {
      currentPanel = undefined
      webviewReady = false
      pendingMessages = []
      // 故意不 disposeAll：runner 与 flowStateManager 在 webview 关闭后继续工作，
      // 下次重新打开 panel 时通过 load 把当前状态发回 webview。
    })
  })

  const addSelectionToInput = vscode.commands.registerCommand(
    'agent-flow.addSelectionToInput',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const { selection, document } = editor
      const selectedText = document.getText(selection)
      const insertMsg: ExtensionToWebviewMessage = selectedText
        ? {
            type: 'insertSelection',
            data: {
              text: selectedText,
              languageId: document.languageId,
              filename: vscode.workspace.asRelativePath(document.uri),
              line: [selection.start.line + 1, selection.end.line + 1],
            },
          }
        : {
            type: 'insertSelection',
            data: {
              text: document.getText(),
              languageId: document.languageId,
              filename: vscode.workspace.asRelativePath(document.uri),
            },
          }
      postMessageToWebview(insertMsg)
      vscode.commands.executeCommand('agent-flow.openPanel')
      currentPanel?.reveal(undefined, true)
    },
  )

  context.subscriptions.push(openPanel, addSelectionToInput)
}

export function deactivate() {}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'index.css'),
  )
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'index.js'),
  )

  return `
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Flow</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script src="${scriptUri}"></script>
</body>
</html>
`
}
