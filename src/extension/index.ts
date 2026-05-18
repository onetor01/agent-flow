import { match, P } from 'ts-pattern'
import * as vscode from 'vscode'
import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type {
  AskUserQuestionInput,
  ExtensionFlowCommandEvents,
  ExtensionFlowCommandMessage,
  ExtensionFlowSignalMessage,
  ExtensionFromWebviewMessage,
  ExtensionToWebviewMessage,
  Flow,
  FlowPhase,
  FlowRunState,
  PersistedData,
} from '@/common'
import { FlowRunStateManager } from './FlowRunStateManager'
import { FlowRunnerManager } from './FlowRunnerManager'
import { PersistedDataController } from './PersistedDataController'
import { initLogger, log, logError } from './logger'

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
  /** webview 未就绪时排队的指令型消息（load / insertSelection / focusFlow 等需要 UI 响应的） */
  const pendingMessages: ExtensionToWebviewMessage[] = []

  // 把 runner / 持久化 / 状态镜像 提到 activate 作用域：webview 关闭后这些对象继续存活，
  // 等下次开 panel 重连。
  const flowStore = new PersistedDataController()
  const flowRunStateManager = new FlowRunStateManager()
  let currentFlows: PersistedData = { flows: [] }

  const postMessageToWebview = (msg: ExtensionToWebviewMessage) => {
    // signal 进入前先喂给状态镜像，确保 webview 不在时 extension 这边状态依然完整
    if (msg.type.startsWith('flow.signal.')) {
      flowRunStateManager.applySignal(msg as ExtensionFlowSignalMessage)
    }
    log('[Extension → Webview]', msg.type, msg.data)
    currentPanel?.webview.postMessage(msg)
  }

  /**
   * 把"指令型"消息可靠地送达 webview：
   * - panel 已存在且 webview 已就绪 → 立即发送
   * - 否则推入 pending 队列。若 panel 不存在还会触发 openPanel，
   *   webview 启动并发出 load 后由 flushPending 一次性发送。
   * 用于 insertSelection、focusFlow 等 UI 引导信号 ——
   * 普通 flow.signal.* 走 postMessageToWebview 即可（webview 重开后会通过 load 拿到状态快照）。
   */
  const postMessageWhenReady = (msg: ExtensionToWebviewMessage) => {
    if (currentPanel && webviewReady) {
      // signal 也要让镜像消费一次，保持与 postMessageToWebview 行为一致
      if (msg.type.startsWith('flow.signal.')) {
        flowRunStateManager.applySignal(msg as ExtensionFlowSignalMessage)
      }
      log('[Extension → Webview]', msg.type, msg.data)
      currentPanel.webview.postMessage(msg)
      return
    }
    pendingMessages.push(msg)
    if (!currentPanel) {
      void vscode.commands.executeCommand('agent-flow.openPanel')
    }
  }

  const flushPendingMessages = () => {
    while (pendingMessages.length > 0) {
      const m = pendingMessages.shift()!
      if (m.type.startsWith('flow.signal.')) {
        flowRunStateManager.applySignal(m as ExtensionFlowSignalMessage)
      }
      log('[Extension → Webview]', m.type, m.data)
      currentPanel?.webview.postMessage(m)
    }
  }

  // notifyUser webPanel不存在或不可见 弹 VSCode 通知。
  // notifyUser: 当 panel 不存在或不可见时弹 VSCode 通知。
  flowRunStateManager.setNotifyHandler((data) => {
    const { agentName, flowId, flowName, reason } = data

    if (currentPanel && currentPanel.visible) return

    const msg = match(reason)
      .with('result', () => `Agent「${agentName}」生成完毕`)
      .with('awaiting-question', () => `Agent「${agentName}」需要回答`)
      .with('awaiting-tool-permission', () => `Agent「${agentName}」请求授权`)
      .with('flow-completed', () => `工作流「${flowName}」已完成`)
      .with('agent-error', () => `Agent「${agentName}」运行出错`)
      .exhaustive()
    vscode.window.showInformationMessage(msg, '查看').then((choice) => {
      if (choice !== '查看') return
      postMessageWhenReady({
        type: 'focusFlow',
        data: { flowId },
      })
      currentPanel?.reveal(undefined, true)
    })
  })

  const runnerManager = new FlowRunnerManager(
    postMessageToWebview,
    (flowId) => flowRunStateManager.getFlowRunStates()[flowId]?.shareValues ?? {},
  )

  /**
   * 在源 RunState 的 sessions 中定位 fork target 所在 session 与切片终点。
   * - `messageIdx` 为 target 命中的消息在 sessions[i].messages 中的索引,
   *   handleFork 据此 slice(0, messageIdx + 1) 裁剪 messages,确保 webview
   *   端切片与 SDK transcript 一致（不含切片终点之后的 result / tool_result 等）
   * - 对 askUserQuestion target 还会回填该 toolUseId 的 input 用于新 RunState 的 pendingQuestion
   */
  type ForkTarget = ExtensionFlowCommandEvents['flow.command.fork']['target']
  const locateFork = (
    state: FlowRunState,
    target: ForkTarget,
  ):
    | {
        sessionIdx: number
        sessionId: string
        messageIdx: number
        upToMessageId: string
        askInput?: AskUserQuestionInput
      }
    | undefined => {
    for (let i = 0; i < state.sessions.length; i++) {
      const session = state.sessions[i]
      for (let j = 0; j < session.messages.length; j++) {
        const m = session.messages[j]
        if (m.type !== 'flow.signal.aiMessage') continue
        const sdkMsg = m.data.message as {
          type: string
          uuid?: string
          message?: { content?: unknown }
        }
        if (target.kind === 'message') {
          if (sdkMsg.uuid && sdkMsg.uuid === target.messageUuid) {
            return {
              sessionIdx: i,
              sessionId: session.sessionId,
              messageIdx: j,
              upToMessageId: target.messageUuid,
            }
          }
        } else if (target.kind === 'askUserQuestion') {
          if (sdkMsg.type !== 'assistant') continue
          const blocks = sdkMsg.message?.content
          if (!Array.isArray(blocks)) continue
          for (const block of blocks) {
            if (
              block &&
              typeof block === 'object' &&
              (block as { type?: string; id?: string }).type === 'tool_use' &&
              (block as { id?: string }).id === target.toolUseId
            ) {
              return {
                sessionIdx: i,
                sessionId: session.sessionId,
                messageIdx: j,
                upToMessageId: sdkMsg.uuid ?? '',
                askInput: (block as { input?: AskUserQuestionInput }).input,
              }
            }
          }
        }
      }
    }
    return undefined
  }

  /**
   * 处理 fork command：调 SDK forkSession 复制 transcript 切片，立即 spawn FlowRunner
   * (lazy 模式 resume) 拿到 runId 写入 newRunState,然后发 `flow.signal.fork`。
   *
   * 关键点（v3）：
   * 1. **按 upToMessageId 裁剪 messages**：防止 webview 端切片包含切片终点之后的内容
   *    （如 thinking fork 不应显示后续 result）
   * 2. **保留源 toolUseId**：SDK forkSession 只 remap message uuid,**不改 tool_use.id**;
   *    新/旧 Flow 共用同一 toolUseId 不会污染 React state（ChatPanel 用 `key=flowId-agentId`
   *    在切 Flow / Agent 时强制 unmount AskUserQuestionCard,内部 state 不复用）。
   *    若替换 toolUseId,会导致 SDK resume 时 canUseTool 看到的是源 toolUseId,
   *    pendingAnswers 用新 toolUseId 索引找不到,退化到 pendingPermissions 阻塞挂起。
   * 3. **用 SDK getSessionMessages 对齐 webview 切片末端 session 的 message uuid**：
   *    forkSession 会重映射所有 message UUID,若 webview 切片仍持有源 uuid,后续
   *    在新 Flow 中再次 fork 时 locateFork 命中的 sdkMsg.uuid 是源 uuid,
   *    forkSession(newSessionId, { upToMessageId: srcUuid }) 在新 session 中找
   *    不到该 uuid,直接报错。
   * 4. **同步 spawn FlowRunner**：拿到 runId 写入 newRunState,webview 后续可正常
   *    sendUserMessage / answerQuestion / interrupt（不再 silent drop）
   */
  const handleFork = async (
    data: ExtensionFlowCommandEvents['flow.command.fork'],
  ): Promise<void> => {
    const { flowId: sourceFlowId, agentId, target } = data
    const sourceFlow = currentFlows.flows.find((f) => f.id === sourceFlowId)
    const sourceState = flowRunStateManager.getFlowRunStates()[sourceFlowId]
    if (!sourceFlow || !sourceState) {
      logError('[fork] source flow / state missing', sourceFlowId)
      return
    }
    const located = locateFork(sourceState, target)
    if (!located || !located.upToMessageId) {
      logError('[fork] target not located', target)
      return
    }
    const { sessionIdx, sessionId: srcSessionId, messageIdx, upToMessageId, askInput } = located

    const dir = vscode.workspace.workspaceFolders?.[0].uri.fsPath
    let newSessionId: string
    try {
      const result = await forkSession(srcSessionId, { upToMessageId, dir })
      newSessionId = result.sessionId
    } catch (err) {
      logError('[fork] forkSession failed', err)
      return
    }

    // 复制并裁剪 sessions：保留 [0, sessionIdx)，target 所在 session
    // 替换为 newSessionId、completed 重置；messages 按 messageIdx 裁剪到切片终点（含）
    const newSessions = sourceState.sessions.slice(0, sessionIdx).map((s) => structuredClone(s))
    const targetSession = sourceState.sessions[sessionIdx]
    const slicedMessages = targetSession.messages
      .slice(0, messageIdx + 1)
      .map((m) => structuredClone(m))

    // 用 SDK 端的新 transcript uuid 覆盖切片中 user/assistant 类型 SDK 消息的 uuid
    // —— forkSession remap 后的真实 uuid 必须同步到 webview,否则后续再 fork
    // 时 locateFork 命中的还是源 uuid,SDK 在新 session 中查不到。
    try {
      const newTranscript = await getSessionMessages(newSessionId, { dir })
      let tIdx = 0
      for (const m of slicedMessages) {
        if (m.type !== 'flow.signal.aiMessage') continue
        const sdkMsg = m.data.message as { type?: string; uuid?: string }
        if (sdkMsg.type !== 'user' && sdkMsg.type !== 'assistant') continue
        // webview 主动 echo 的 user 通常无 uuid,不会进 transcript,跳过
        if (!sdkMsg.uuid) continue
        if (tIdx >= newTranscript.length) break
        sdkMsg.uuid = newTranscript[tIdx++].uuid
      }
    } catch (err) {
      // 拿不到 transcript 时不阻断 fork,仅打日志;UI 仍能进入新 Flow,只是再 fork 会失败
      logError('[fork] getSessionMessages failed, message uuid not remapped', err)
    }

    newSessions.push({
      ...structuredClone(targetSession),
      sessionId: newSessionId,
      messages: slicedMessages,
      completed: false,
      outputName: undefined,
    })

    let phase: FlowPhase = 'result'
    const pendingQuestions: FlowRunState['pendingQuestions'] = []
    const answeredQuestions = { ...sourceState.answeredQuestions }
    if (target.kind === 'askUserQuestion' && askInput) {
      // 保留源 toolUseId —— 与 SDK transcript 中 tool_use.id 对齐,
      // 用户答题时 ClaudeExecutor.pendingAnswers 按源 toolUseId 索引,
      // SDK resume 后 canUseTool 用同一 id 直接命中
      phase = 'awaiting-question'
      pendingQuestions.push({
        toolUseId: target.toolUseId,
        input: askInput,
        sessionId: newSessionId,
      })
      // 原 toolUseId 的已答记录无意义,清掉避免 UI 误判
      delete answeredQuestions[target.toolUseId]
    }

    // 提前生成 runId 写入 newRunState（路线 A 核心：webview 收到 signal.fork 时 runId 已就绪）
    const newRunId = globalThis.crypto.randomUUID()
    const newRunState: FlowRunState = {
      runKey: undefined,
      runId: newRunId,
      phase,
      sessions: newSessions,
      answeredQuestions,
      answeredToolPermissions: { ...sourceState.answeredToolPermissions },
      pendingQuestions,
      pendingToolPermission: undefined,
      currentAgentId: agentId,
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

    // 路线 A：立即 spawn FlowRunner 启动 SDK;runId 已确定,webview 后续派发的
    // userMessage / answerQuestion / interrupt 都能正常匹配到此 runner。
    // - askUserQuestion fork: 'resume-pending' 模式,构造时 push isSynthetic dummy
    //   启动 SDK iteration 让其自然走到 transcript 末端的悬空 tool_use,触发 canUseTool
    //   挂起 resolver。用户提交答案时 answerQuestion 直接命中 resolver。
    // - 普通 fork(user/text/thinking/turn_end): 'lazy' 模式,等用户首次操作触发 SDK 启动。
    const forkMode: 'lazy' | 'resume-pending' =
      target.kind === 'askUserQuestion' ? 'resume-pending' : 'lazy'
    runnerManager.spawnForFork({
      flowId: newFlowId,
      flow: newFlow,
      agentId,
      resumeSessionId: newSessionId,
      runId: newRunId,
      mode: forkMode,
    })

    postMessageToWebview({
      type: 'flow.signal.fork',
      data: { flowId: sourceFlowId, newFlowId, newRunState, agentId, runId: newRunId },
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

    // 初始化 panel 可见性

    panel.webview.onDidReceiveMessage(async (e: ExtensionFromWebviewMessage) => {
      log('[Webview → Extension]', e.type, e.data)
      match(e)
        .with({ type: 'load' }, async () => {
          currentFlows = await flowStore.load()
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
          // load 抵达即视为 webview 已就绪：把之前排队的消息一次性发出
          webviewReady = true
          flushPendingMessages()
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
          const { filename, line } = data
          const folders = vscode.workspace.workspaceFolders
          if (!folders?.length) return
          try {
            const uri = vscode.Uri.joinPath(folders[0].uri, filename)
            const doc = await vscode.workspace.openTextDocument(uri)
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
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
            const flow = currentFlows.flows.find((f) => f.id === flowId)
            if (!flow) return
            runnerManager.handleCommand(type, { ...data, flow })
          } else {
            runnerManager.handleCommand(type, data)
          }
        })
        .exhaustive()
    })

    panel.onDidDispose(() => {
      currentPanel = undefined
      webviewReady = false
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
      // panel 不存在时 postMessageWhenReady 会触发 openPanel 并把消息排队等 webview 就绪
      postMessageWhenReady(insertMsg)
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
