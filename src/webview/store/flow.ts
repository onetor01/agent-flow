import type { NotificationInstance } from 'antd/es/notification/interface'
import { produce } from 'immer'
import { match } from 'ts-pattern'
import { create } from 'zustand'
import type { Flow } from '@/common'
import {
  type AgentPhase,
  type AgentChatInputState,
  type AgentSession,
  type ExtensionFlowCommandMessage,
  type FlowPhase,
  type FlowRunState,
  type PendingQuestion,
  type PendingToolPermission,
  type MessageEffect,
  type UserMessageType,
  type AskUserQuestionOutput,
  type ExtensionToWebviewMessage,
  updateFlowRunState,
  agentChatInputState,
  flowCanBeKilled,
  flowIsDestructiveReadOnly,
} from '@/common'
import type { Agent } from '@/common'
import { clearBuildCacheForSessions } from '../components/ChatDrawer/ChatPanel/buildRenderItems'
import { postMessageToExtension, subscribeExtensionMessage } from '../utils/ExtensionMessage'

// ── 选择器（webview 本地） ────────────────────────────────────────────────

type StoreState = {
  loading: boolean
  flows: Flow[]
  activeFlowId?: string
  /** flow 运行态: flowId -> FlowRunState */
  flowRunStates: Record<string, FlowRunState>
  globalError?: string
  chatDrawer?: ChatDrawerState
  flowListCollapsed: boolean
  /** 当前正在编辑的 agent */
  editingAgent?: { flowId: string; agentId: string }
  /** 当前正在编辑的 flow（用于打开 FlowEditor Drawer） */
  editingFlowId?: string
}

export type ChatDrawerState = {
  flowId: string
  agentId: string
  agentName: string
}

const selectFlowRunState =
  (flowId: string) =>
  (s: StoreState): FlowRunState | undefined =>
    s.flowRunStates[flowId]

export const selectAgentPhase =
  (flowId: string, agentId: string) =>
  (s: StoreState): AgentPhase => {
    const fs = selectFlowRunState(flowId)(s)
    if (!fs) return 'idle'
    const currentAgentId = fs.currentAgentId
    if (currentAgentId === agentId) {
      // FlowPhase 与 AgentPhase 现已对齐，直接透传
      return fs.phase
    }
    const last = [...fs.sessions].reverse().find((sess) => sess.agentId === agentId)
    if (last?.completed) return 'completed'
    return 'idle'
  }

export const selectPendingQuestionFor =
  (flowId: string, agentId: string) =>
  (s: StoreState): PendingQuestion | undefined => {
    const fs = selectFlowRunState(flowId)(s)
    if (!fs || fs.currentAgentId !== agentId) return undefined
    return fs.pendingQuestions[0]
  }
const EMPTY_ARRAY: any[] = []
export const selectPendingQuestionsFor =
  (flowId: string, agentId: string) =>
  (s: StoreState): PendingQuestion[] => {
    const fs = selectFlowRunState(flowId)(s)
    if (!fs || fs.currentAgentId !== agentId) return EMPTY_ARRAY
    return fs.pendingQuestions
  }

export const selectPendingToolPermissionFor =
  (flowId: string, agentId: string) =>
  (s: StoreState): PendingToolPermission | undefined => {
    const fs = selectFlowRunState(flowId)(s)
    if (!fs || fs.currentAgentId !== agentId) return undefined
    return fs.pendingToolPermission
  }

export const selectAnsweredToolPermissions =
  (flowId: string) =>
  (s: StoreState): Record<string, { allow: boolean }> | undefined =>
    s.flowRunStates[flowId]?.answeredToolPermissions

export const selectFlowPhase =
  (flowId: string) =>
  (s: StoreState): FlowPhase =>
    s.flowRunStates[flowId]?.phase ?? 'idle'

export const selectCurrentSession =
  (flowId: string) =>
  (s: StoreState): AgentSession | undefined => {
    const fs = selectFlowRunState(flowId)(s)
    if (!fs) return undefined
    return fs.sessions.find((s) => !s.completed)
  }

export const selectCurrentAgentId =
  (flowId: string) =>
  (s: StoreState): string | undefined => {
    const fs = selectFlowRunState(flowId)(s)
    return fs?.currentAgentId
  }

// ── Store ───────────────────────────────────────────────────────────────────

/** init 参数 —— 从 App.useApp() 拿到的主题化 api（至少包含 notification） */
export type AppApi = { notification: NotificationInstance }

type FlowStoreType = StoreState & {
  /** 初始化：请求 flows 并订阅 extension 消息，返回 cleanup 函数 */
  init: (app: AppApi) => () => void
  setActiveFlowId: (id: string) => void
  setFlowListCollapsed: (collapsed: boolean) => void
  /**
   * 启动 Flow 运行。
   * `resumeSessionId` 存在时表示 resume fork 出的新 Flow（不清空 sessions / 不重置 build cache）。
   */
  runFlow: (
    flowId: string,
    agentId: string,
    initMessage: UserMessageType,
    resumeSessionId?: string,
  ) => void
  save: (updateFn: (val: Flow[]) => void) => void
  sendUserMessage: (flowId: string, content: UserMessageType['message']['content']) => void
  answerQuestion: (flowId: string, toolUseId: string, output: AskUserQuestionOutput) => void
  answerToolPermission: (flowId: string, toolUseId: string, allow: boolean) => void
  interruptAgent: (flowId: string) => void
  killFlow: (flowId: string) => void
  setShareValues: (flowId: string, values: Record<string, string>) => boolean
  /**
   * 触发会话 fork —— 从源 Flow 当前 transcript 切片复制出新 Flow。
   * 仅 post command,本地不预提交 reducer,等 extension 回 `flow.signal.fork` 后再写入新 Flow。
   */
  forkFlow: (
    sourceFlowId: string,
    agentId: string,
    target:
      | { kind: 'message'; messageUuid: string }
      | { kind: 'askUserQuestion'; toolUseId: string },
  ) => void
  openChatDrawer: (flowId: string, agentId: string, agentName: string) => void
  closeChatDrawer: () => void
  setEditingAgent: (agent?: { flowId: string; agentId: string }) => void
  setEditingFlowId: (id?: string) => void
  copyAgents: (newAgents: Agent[], flowId: string) => Agent[] | undefined
}

// Re-export 类型和工具函数，保持现有引用兼容
export type {
  AgentPhase,
  AgentChatInputState,
  AgentSession,
  FlowPhase,
  FlowRunState,
  PendingQuestion,
  PendingToolPermission,
}
export { agentChatInputState, flowCanBeKilled, flowIsDestructiveReadOnly }

export const useFlowStore = create<FlowStoreType>((set, get) => {
  const immerSet = (updateFn: (draft: FlowStoreType) => void) => {
    set(produce(updateFn))
  }

  /** 由 init 注入，来自 <AntdApp> 的 App.useApp()，保证 notification 继承 ConfigProvider 主题 */
  let notificationApi: NotificationInstance | null = null

  /** 追踪当前所有已弹出的通知 key，便于按 flow 批量销毁 */
  const activeNotificationKeys = new Set<string>()
  const destroyFlowNotifications = (flowId: string) => {
    const prefix = `flow-notify-${flowId}-`
    for (const key of [...activeNotificationKeys]) {
      if (key.startsWith(prefix)) {
        notificationApi?.destroy(key)
        activeNotificationKeys.delete(key)
      }
    }
  }

  /** 判断是否应该弹出 webview 通知 */
  const shouldNotify = (effect: MessageEffect): boolean => {
    // a. 页面不可见时始终通知
    if (document.hidden) return true
    const { activeFlowId, chatDrawer } = get()
    // b. activeFlowId 与消息来源不一致时通知
    if (activeFlowId !== effect.flowId) return true
    // c. ChatPanel 已打开且 agentId 不一致时通知
    if (chatDrawer && chatDrawer.agentId !== effect.agentId) return true
    return false
  }

  /** 自动打开 ChatPanel：当 activeFlowId 匹配且 ChatPanel 未打开时 */
  const autoOpenChatDrawer = (effect: MessageEffect) => {
    const { activeFlowId, chatDrawer } = get()
    if (activeFlowId === effect.flowId && !chatDrawer) {
      immerSet((d) => {
        d.chatDrawer = { ...effect }
      })
    }
  }

  /** 把 updateFlowRunState 返回的 notifications 翻译成 antd notification.info 调用 */
  const fireNotifications = (effects: MessageEffect[]) => {
    for (const n of effects) {
      // 自动打开 ChatPanel（result / awaiting-question / awaiting-tool-permission / flow-completed）
      if (
        n.reason === 'result' ||
        n.reason === 'awaiting-question' ||
        n.reason === 'awaiting-tool-permission' ||
        n.reason === 'flow-completed'
      ) {
        autoOpenChatDrawer(n)
      }
      // 通知判定
      if (!shouldNotify(n)) continue
      const key = `flow-notify-${n.flowId}-${n.agentId}-${n.reason}`
      activeNotificationKeys.add(key)
      notificationApi?.info({
        key,
        duration: 0,
        message: match(n.reason)
          .with('result', () => `Agent「${n.agentName}」生成完毕`)
          .with('awaiting-question', () => `Agent「${n.agentName}」需要回答`)
          .with('awaiting-tool-permission', () => `Agent「${n.agentName}」请求授权`)
          .with('flow-completed', () => `工作流「${n.flowName}」已完成`)
          .with('agent-error', () => `Agent「${n.agentName}」运行出错`)
          .exhaustive(),
        onClose: () => {
          activeNotificationKeys.delete(key)
        },
        onClick: () => {
          notificationApi?.destroy(key)
          activeNotificationKeys.delete(key)
          immerSet((d) => {
            d.activeFlowId = n.flowId
            d.chatDrawer = { flowId: n.flowId, agentId: n.agentId, agentName: n.agentName }
            d.editingAgent = undefined
          })
        },
      })
    }
  }

  /**
   * 发送一条 command：先在本地 reducer 里推进 state，再 post 给 extension。
   * 两端走同一份 reducer，保证状态推进同步。
   */
  const dispatchCommand = (msg: ExtensionFlowCommandMessage) => {
    const { flows, flowRunStates } = get()
    const flowId = msg.data.flowId
    const existing = flowRunStates[flowId]
    const { state, effects } = updateFlowRunState(msg, { state: existing, flows })
    immerSet((draft) => {
      if (state) {
        draft.flowRunStates[flowId] = state
      } else {
        delete draft.flowRunStates[flowId]
      }
    })
    postMessageToExtension(msg)
    fireNotifications(effects)
  }

  return {
    loading: true,
    flows: [],
    activeFlowId: undefined,
    chatDrawer: undefined,
    flowRunStates: {},
    flowListCollapsed: false,
    editingFlowId: undefined,

    init: (app) => {
      notificationApi = app.notification
      const onMessage = (msg: ExtensionToWebviewMessage) => {
        // 全局事件（非 flow.signal.*）不进入 updateFlowRunState：直接落到 store
        if (msg.type === 'load') {
          immerSet((draft) => {
            draft.loading = false
            draft.flows = msg.data.flows
            draft.flowRunStates = msg.data.flowRunStates
            draft.activeFlowId = msg.data.flows[0]?.id
          })
          return
        }
        if (msg.type === 'error') {
          console.error(msg)
          immerSet((draft) => {
            draft.globalError = (msg.data as { message?: string })?.message ?? String(msg.data)
          })
          return
        }
        if (msg.type === 'insertSelection') {
          // 由 ChatInput 直接订阅处理,store 不参与
          return
        }
        if (msg.type === 'focusFlow') {
          immerSet((draft) => {
            draft.activeFlowId = msg.data.flowId
            draft.editingAgent = undefined
          })
          return
        }
        // fork signal：源 Flow 状态不变，需要在 store 中复制 sourceFlow 定义、
        // 写入新 RunState、切到新 Flow、打开 ChatDrawer，并触发 save 持久化。
        if (msg.type === 'flow.signal.fork') {
          const { flowId: sourceFlowId, newFlowId, newRunState, agentId } = msg.data
          const { flows } = get()
          const sourceFlow = flows.find((f) => f.id === sourceFlowId)
          if (!sourceFlow) return
          const newFlow: Flow = { ...structuredClone(sourceFlow), id: newFlowId }
          const nextAgent = newFlow.agents?.find((a) => a.id === agentId)
          immerSet((draft) => {
            draft.flows.push(newFlow)
            draft.flowRunStates[newFlowId] = newRunState
            draft.activeFlowId = newFlowId
            draft.chatDrawer = {
              flowId: newFlowId,
              agentId,
              agentName: nextAgent?.agent_name ?? '',
            }
            draft.editingAgent = undefined
          })
          // 持久化新 flow 列表
          postMessageToExtension({ type: 'save', data: get().flows })
          return
        }
        // 其余皆为 flow.signal.*：交给 updateFlowRunState 这一信号驱动的 reducer
        const { flows, flowRunStates, chatDrawer } = get()
        const flowId = msg.data.flowId
        const existing = flowRunStates[flowId]
        if (!existing) return

        // 记录 agentComplete 前的状态，用于自动切换 ChatPanel
        const prevLastSession = existing.sessions[existing.sessions.length - 1]
        const prevLastAgentId = prevLastSession?.agentId

        const { state, effects } = updateFlowRunState(msg, {
          state: existing,
          flows,
        })
        immerSet((draft) => {
          if (!state) return
          draft.flowRunStates[flowId] = state

          // agentComplete 时：如果 ChatPanel 正打开的是已完成的 agent，切到下一个 agent
          if (msg.type === 'flow.signal.agentComplete') {
            const newLastSession = state.sessions[state.sessions.length - 1]
            if (
              chatDrawer?.flowId === flowId &&
              chatDrawer.agentId === prevLastAgentId &&
              newLastSession &&
              newLastSession.agentId !== prevLastAgentId
            ) {
              const nextAgent = flows
                .find((f) => f.id === flowId)
                ?.agents?.find((a) => a.id === newLastSession.agentId)
              draft.chatDrawer = {
                flowId,
                agentId: newLastSession.agentId,
                agentName: nextAgent?.agent_name ?? chatDrawer.agentName,
              }
            }
          }
        })
        fireNotifications(effects)
      }

      const cleanup = subscribeExtensionMessage(onMessage)
      postMessageToExtension({ type: 'load', data: undefined })
      return cleanup
    },
    runFlow: (flowId, agentId, initMessage, resumeSessionId) => {
      const { flows, flowRunStates } = get()
      const flow = flows.find((f) => f.id === flowId)
      if (!flow) return
      const agent = flow.agents?.find((a) => a.id === agentId)
      const effectiveInitMessage: UserMessageType = agent?.no_input
        ? {
            type: 'user',
            message: { role: 'user', content: '开始' },
            parent_tool_use_id: null,
          }
        : initMessage
      // resume 模式保留 fork 切片对应 sessions 的 build 缓存（按 newSessionId 索引），
      // 普通启动则清除该 flow 旧 sessions 的缓存以避免内存泄漏
      if (!resumeSessionId) {
        const existingState = flowRunStates[flowId]
        if (existingState?.sessions?.length) {
          clearBuildCacheForSessions(existingState.sessions.map((s) => s.sessionId))
        }
      }
      const runKey = crypto.randomUUID()
      dispatchCommand({
        type: 'flow.command.flowStart',
        data: {
          flowId,
          runKey,
          agentId,
          initMessage: effectiveInitMessage,
          resumeSessionId,
        },
      })
    },
    setActiveFlowId: (id) => {
      destroyFlowNotifications(id)
      immerSet((draft) => {
        draft.activeFlowId = id
      })
    },
    setFlowListCollapsed: (collapsed) => {
      immerSet((draft) => {
        draft.flowListCollapsed = collapsed
      })
    },
    openChatDrawer: (flowId, agentId, agentName) => {
      immerSet((draft) => {
        draft.chatDrawer = { flowId, agentId, agentName }
      })
    },
    closeChatDrawer: () => {
      immerSet((draft) => {
        draft.chatDrawer = undefined
      })
    },
    setEditingAgent: (agent) => {
      immerSet((draft) => {
        draft.editingAgent = agent
      })
    },
    setEditingFlowId: (id) => {
      immerSet((draft) => {
        draft.editingFlowId = id
      })
    },
    save: (updateFn) => {
      immerSet((draft) => {
        updateFn(draft.flows)
      })
      postMessageToExtension({ type: 'save', data: get().flows })
    },
    sendUserMessage: (flowId, content) => {
      const { flowRunStates } = get()
      const fs = flowRunStates[flowId]
      const sessionId = fs?.sessions.find((s) => !s.completed)?.sessionId
      if (!fs?.runId || !sessionId) return
      dispatchCommand({
        type: 'flow.command.userMessage',
        data: {
          flowId,
          runId: fs.runId,
          sessionId,
          message: {
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
          },
        },
      })
    },
    answerQuestion: (flowId, toolUseId, output) => {
      const { flowRunStates } = get()
      const fs = flowRunStates[flowId]
      const sessionId = fs?.sessions.find((s) => !s.completed)?.sessionId
      if (!fs?.runId || !sessionId) return
      dispatchCommand({
        type: 'flow.command.answerQuestion',
        data: { flowId, runId: fs.runId, sessionId, toolUseId, output },
      })
    },
    answerToolPermission: (flowId, toolUseId, allow) => {
      const { flowRunStates } = get()
      const fs = flowRunStates[flowId]
      const sessionId = fs?.sessions.find((s) => !s.completed)?.sessionId
      if (!fs?.runId || !sessionId) return
      dispatchCommand({
        type: 'flow.command.toolPermissionResult',
        data: { flowId, runId: fs.runId, sessionId, toolUseId, allow },
      })
    },
    interruptAgent: (flowId) => {
      const { flowRunStates } = get()
      const fs = flowRunStates[flowId]
      if (!fs || !flowCanBeKilled(fs.phase)) return
      const sessionId = fs.sessions.find((s) => !s.completed)?.sessionId
      if (!fs.runId || !sessionId) return
      dispatchCommand({
        type: 'flow.command.interrupt',
        data: { flowId, runId: fs.runId, sessionId },
      })
    },
    killFlow: (flowId) => {
      const { flowRunStates } = get()
      const fs = flowRunStates[flowId]
      if (!fs || !flowCanBeKilled(fs.phase)) return
      dispatchCommand({
        type: 'flow.command.killFlow',
        data: { flowId },
      })
    },
    setShareValues: (flowId, values) => {
      dispatchCommand({
        type: 'flow.command.setShareValues',
        data: { flowId, values },
      })
      return true
    },
    forkFlow: (sourceFlowId, agentId, target) => {
      // 不本地预提交：fork 由 extension 完成 SDK forkSession + 准备 newRunState 后回 signal,
      // 由 onMessage 中的 'flow.signal.fork' 路径写入新 Flow / 切 activeFlowId / 打开 ChatDrawer。
      postMessageToExtension({
        type: 'flow.command.fork',
        data: { flowId: sourceFlowId, agentId, target },
      })
    },
    copyAgents: (newAgents, flowId) => {
      let remapped: Agent[] = []
      get().save((flows) => {
        const flow = flows.find((f) => f.id === flowId)
        if (!flow) return

        const idMap = new Map<string, string>()
        for (const agent of newAgents) {
          idMap.set(agent.id, crypto.randomUUID())
        }

        remapped = newAgents.map((agent) => ({
          ...agent,
          id: idMap.get(agent.id)!,
          outputs: agent.outputs?.map((output) => ({
            ...output,
            next_agent: output.next_agent !== undefined ? idMap.get(output.next_agent) : undefined,
          })),
        }))

        flow.agents = [...(flow.agents ?? []), ...remapped]
      })
      return remapped
    },
  }
})
