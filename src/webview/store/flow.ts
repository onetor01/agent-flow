import type { NotificationInstance } from 'antd/es/notification/interface'
import { produce } from 'immer'
import { match } from 'ts-pattern'
import { create } from 'zustand'
import type { Flow } from '@/common'
import {
  type AgentPhase,
  type AgentChatInputState,
  type AgentRun,
  type ExtensionFlowCommandMessage,
  type FlowPhase,
  type FlowRunState,
  type PendingQuestion,
  type PendingToolPermission,
  type PendingCompleteConfirm,
  type MessageEffect,
  type UserMessageType,
  type AskUserQuestionOutput,
  type ExtensionToWebviewMessage,
  updateFlowRunState,
  agentChatInputState,
  flowCanBeKilled,
  flowIsDestructiveReadOnly,
  getFlowPhase,
} from '@/common'
import type { Agent, Code } from '@/common'
import { clearBuildCacheForRuns } from '../components/ChatDrawer/ChatPanel/buildRenderItems'
import { postMessageToExtension, subscribeExtensionMessage } from '../utils/ExtensionMessage'

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
  /** agentId 视图 / agentName 展示用;runId 模式下可省略,由 ChatPanel 反查 agentId */
  agentId?: string
  /** 单 run 视图;给定时 ChatPanel 限定到该 run */
  runId?: string
  agentName?: string
}

// ── Store ───────────────────────────────────────────────────────────────────

/** init 参数 —— 从 App.useApp() 拿到的主题化 api（至少包含 notification） */
export type AppApi = { notification: NotificationInstance }

type FlowStoreType = StoreState & {
  /** 初始化：请求 flows 并订阅 extension 消息，返回 cleanup 函数 */
  init: (app: AppApi) => () => void
  setActiveFlowId: (id: string) => void
  setFlowListCollapsed: (collapsed: boolean) => void
  /** 启动 Flow 运行。 */
  runFlow: (flowId: string, agentId: string, initMessage: UserMessageType) => void
  save: (updateFn: (val: Flow[]) => void) => void
  /**
   * 同会话追问 —— 调用方必须在 chatDrawer 上下文里挑出目标 run 的 runId 后传入,
   * store 不再回退到末位非终态 run(多 run 场景下回退会乱派发)。
   */
  sendUserMessage: (
    flowId: string,
    runId: string,
    content: UserMessageType['message']['content'],
  ) => void
  /** 回答 AskUserQuestion —— 调用方持有 pendingQuestion.runId 直接传入 */
  answerQuestion: (
    flowId: string,
    runId: string,
    toolUseId: string,
    output: AskUserQuestionOutput,
  ) => void
  /** 回答工具权限请求 —— 调用方持有 pendingToolPermission.runId 直接传入 */
  answerToolPermission: (flowId: string, runId: string, toolUseId: string, allow: boolean) => void
  /** 回答 CompleteTask 完成前确认 */
  answerCompleteConfirm: (
    flowId: string,
    runId: string,
    toolUseId: string,
    accept: boolean,
    reason?: string,
  ) => void
  /** 中断当前 run —— 调用方决定要中断哪个 run */
  interruptAgent: (flowId: string, runId: string) => void
  killFlow: (flowId: string) => void
  setShareValues: (flowId: string, values: Record<string, string>) => boolean
  /**
   * 触发会话 fork —— 从源 Flow 当前 transcript 切片复制出新 Flow。
   * target.runId 已唯一定位源 RunState 中的 AgentRun;extension 从 located run 反推 agentId,
   * webview 不再传递。
   * 仅 post command,本地不预提交 reducer,等 extension 回 `flow.signal.fork` 后再写入新 Flow。
   */
  forkFlow: (
    sourceFlowId: string,
    target: { kind: 'message'; runId: string; messageUuid: string },
  ) => void
  openChatDrawer: (state: ChatDrawerState) => void
  closeChatDrawer: () => void
  setEditingAgent: (agent?: { flowId: string; agentId: string }) => void
  setEditingFlowId: (id?: string) => void
  copyAgents: (newAgents: (Agent | Code)[], flowId: string) => (Agent | Code)[] | undefined
}

// Re-export 类型和工具函数，保持现有引用兼容
export type {
  AgentPhase,
  AgentChatInputState,
  AgentRun,
  FlowPhase,
  FlowRunState,
  PendingQuestion,
  PendingToolPermission,
  PendingCompleteConfirm,
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
    const { activeFlowId, chatDrawer, flowRunStates } = get()
    // b. activeFlowId 与消息来源不一致时通知
    if (activeFlowId !== effect.flowId) return true
    // c. ChatPanel 已打开且 agentId 不一致时通知
    if (chatDrawer) {
      const drawerAgentId =
        chatDrawer.agentId ??
        (chatDrawer.runId
          ? flowRunStates[chatDrawer.flowId]?.runs.find((r) => r.runId === chatDrawer.runId)
              ?.agentId
          : undefined)
      if (drawerAgentId !== effect.agentId) return true
    }
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
      // 自动打开 ChatPanel（result / awaiting-question / awaiting-tool-permission / awaiting-complete-confirm / flow-completed）
      if (
        n.reason === 'result' ||
        n.reason === 'awaiting-question' ||
        n.reason === 'awaiting-tool-permission' ||
        n.reason === 'awaiting-complete-confirm' ||
        n.reason === 'flow-completed'
      ) {
        autoOpenChatDrawer(n)
      }
      // 通知判定
      if (!shouldNotify(n)) continue
      const key = `flow-notify-${n.flowId}-${n.runId}-${n.reason}`
      activeNotificationKeys.add(key)
      notificationApi?.info({
        key,
        duration: 0,
        message: match(n.reason)
          .with('result', () => `Agent「${n.agentName}」生成完毕`)
          .with('awaiting-question', () => `Agent「${n.agentName}」需要回答`)
          .with('awaiting-tool-permission', () => `Agent「${n.agentName}」请求授权`)
          .with('awaiting-complete-confirm', () => `Agent「${n.agentName}」等待完成确认`)
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
          const { flowId: sourceFlowId, newFlowId, newRunState, runId } = msg.data
          const { flows } = get()
          const sourceFlow = flows.find((f) => f.id === sourceFlowId)
          if (!sourceFlow) return
          const newFlow: Flow = { ...structuredClone(sourceFlow), id: newFlowId }
          // fork 出的 run 永远是 newRunState.runs 末位 —— 用 runId 校验防御
          const lastRun = newRunState.runs.at(-1)
          const agentId = lastRun?.runId === runId ? lastRun.agentId : undefined
          const nextAgent = agentId ? newFlow.agents?.find((a) => a.id === agentId) : undefined
          immerSet((draft) => {
            draft.flows.push(newFlow)
            draft.flowRunStates[newFlowId] = newRunState
            draft.activeFlowId = newFlowId
            if (agentId) {
              draft.chatDrawer = {
                flowId: newFlowId,
                agentId,
                agentName: nextAgent?.agent_name ?? '',
              }
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
        const prevLastRun = existing.runs[existing.runs.length - 1]
        const prevLastAgentId = prevLastRun?.agentId

        const { state, effects } = updateFlowRunState(msg, {
          state: existing,
          flows,
        })
        immerSet((draft) => {
          if (!state) return
          draft.flowRunStates[flowId] = state

          // agentComplete 时:如果 ChatPanel 正打开的是已完成的 agent(agentId 视图),切到下一个 agent。
          // runId 视图(chatDrawer.runId 存在)是用户主动锁定的某条 run,不做跟随。
          if (msg.type === 'flow.signal.agentComplete') {
            const newLastRun = state.runs[state.runs.length - 1]
            if (
              chatDrawer?.flowId === flowId &&
              !chatDrawer.runId &&
              chatDrawer.agentId === prevLastAgentId &&
              newLastRun &&
              newLastRun.agentId !== prevLastAgentId
            ) {
              const nextAgent = flows
                .find((f) => f.id === flowId)
                ?.agents?.find((a) => a.id === newLastRun.agentId)
              draft.chatDrawer = {
                flowId,
                agentId: newLastRun.agentId,
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
    runFlow: (flowId, agentId, initMessage) => {
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
      const existingState = flowRunStates[flowId]
      if (existingState?.runs?.length) {
        clearBuildCacheForRuns(existingState.runs.map((r) => r.runId))
      }
      // webview 生成 runId 随 command 下发,作为本次 run 的唯一主键
      const runId = crypto.randomUUID()
      dispatchCommand({
        type: 'flow.command.flowStart',
        data: {
          flowId,
          runId,
          agentId,
          initMessage: effectiveInitMessage,
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
    openChatDrawer: (state) => {
      immerSet((draft) => {
        draft.chatDrawer = state
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
    sendUserMessage: (flowId, runId, content) => {
      dispatchCommand({
        type: 'flow.command.userMessage',
        data: {
          flowId,
          runId,
          message: {
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
          },
        },
      })
    },
    answerQuestion: (flowId, runId, toolUseId, output) => {
      dispatchCommand({
        type: 'flow.command.answerQuestion',
        data: { flowId, runId, toolUseId, output },
      })
    },
    answerToolPermission: (flowId, runId, toolUseId, allow) => {
      dispatchCommand({
        type: 'flow.command.toolPermissionResult',
        data: { flowId, runId, toolUseId, allow },
      })
    },
    answerCompleteConfirm: (flowId, runId, toolUseId, accept, reason) => {
      dispatchCommand({
        type: 'flow.command.answerCompleteTaskConfirm',
        data: { flowId, runId, toolUseId, accept, reason },
      })
    },
    interruptAgent: (flowId, runId) => {
      const { flowRunStates } = get()
      const fs = flowRunStates[flowId]
      if (!fs || !flowCanBeKilled(getFlowPhase(fs))) return
      dispatchCommand({
        type: 'flow.command.interrupt',
        data: { flowId, runId },
      })
    },
    killFlow: (flowId) => {
      const { flowRunStates } = get()
      const fs = flowRunStates[flowId]
      if (!fs || !flowCanBeKilled(getFlowPhase(fs))) return
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
    forkFlow: (sourceFlowId, target) => {
      // 不本地预提交：fork 由 extension 完成 SDK forkSession + 准备 newRunState 后回 signal,
      // 由 onMessage 中的 'flow.signal.fork' 路径写入新 Flow / 切 activeFlowId / 打开 ChatDrawer。
      postMessageToExtension({
        type: 'flow.command.fork',
        data: { flowId: sourceFlowId, target },
      })
    },
    copyAgents: (newAgents, flowId) => {
      let remapped: (Agent | Code)[] = []
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
