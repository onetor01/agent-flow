import { useCallback, useRef, type FC } from 'react'
import { Drawer } from 'antd'
import type { UserMessageType } from '@/common'
import { useStartFlow } from '@/webview/hooks/useStartFlow'
import {
  agentChatInputState,
  selectAgentPhase,
  useFlowStore,
  type AgentPhase,
} from '@/webview/store/flow'
import { ChatInput } from './ChatInput'
import { ChatPanel } from './ChatPanel'
import type { ChatPanelRef } from './ChatPanel'

export const ChatDrawer: FC = () => {
  const chatDrawer = useFlowStore((s) => s.chatDrawer)
  const closeChatDrawer = useFlowStore((s) => s.closeChatDrawer)
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)
  const interruptAgent = useFlowStore((s) => s.interruptAgent)
  const startFlow = useStartFlow()
  const chatPanelRef = useRef<ChatPanelRef>(null)

  const agentPhase = useFlowStore((s): AgentPhase => {
    if (!s.chatDrawer) return 'idle'
    return selectAgentPhase(s.chatDrawer.flowId, s.chatDrawer.agentId)(s)
  })

  const isActiveAgent = useFlowStore((s) => {
    if (!s.chatDrawer) return false
    const fs = s.flowRunStates[s.chatDrawer.flowId]
    return fs?.currentAgentId === s.chatDrawer.agentId
  })

  const inputState = agentChatInputState(agentPhase)
  const onSend = useCallback(
    async (content: UserMessageType['message']['content']): Promise<boolean> => {
      if (!chatDrawer) return false
      const { flowId, agentId } = chatDrawer

      // disabled / loading 状态不允许发送
      if (inputState === 'disabled' || inputState === 'loading') return false

      const fs = useFlowStore.getState().flowRunStates[flowId]
      const hasRunId = !!fs?.runId

      // 同会话追问：有 runId（runner 在跑）+ 当前活跃 agent + result/interrupted
      if (hasRunId && isActiveAgent && (agentPhase === 'result' || agentPhase === 'interrupted')) {
        sendUserMessage(flowId, content)
        chatPanelRef.current?.forceScrollToBottom()
        return true
      }

      // fork 后的延续启动：runId 缺失但 sessions 已含 fork 切片，
      // 取该 agent 最近一条 session 的 sessionId 作为 resumeSessionId
      let resumeSessionId: string | undefined
      if (!hasRunId && fs?.sessions?.length) {
        const lastForAgent = [...fs.sessions].reverse().find((s) => s.agentId === agentId)
        if (lastForAgent) resumeSessionId = lastForAgent.sessionId
      }

      // ready (idle / 非活跃 agent 的 result) 或 confirm-required → 启动 flow
      // useStartFlow 内部会根据 FlowPhase !== idle 弹窗确认（resume 模式跳过弹窗）
      const started = await startFlow(
        flowId,
        agentId,
        {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        },
        resumeSessionId,
      )
      if (started) chatPanelRef.current?.forceScrollToBottom()
      return started
    },
    [chatDrawer, inputState, agentPhase, isActiveAgent, startFlow, sendUserMessage, chatPanelRef],
  )

  return (
    <Drawer
      open={!!chatDrawer}
      placement='right'
      mask={false}
      closable={false}
      defaultSize={700}
      resizable
      forceRender
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
      onClose={() => {
        closeChatDrawer()
      }}
    >
      <div className='flex flex-1 flex-col overflow-hidden bg-[#1e1e2e]'>
        {chatDrawer ? (
          // key 强制 ChatPanel 在 (flowId, agentId) 切换时重新挂载,避免跨 Flow 共用
          // React 内部状态（特别是 AskUserQuestionCard 的 selections / otherStates,
          // 以及 motion.div 的 ask-card key 在 toolUseId 相同时被复用）。
          // fork 出的新 Flow 与源 Flow 的 toolUseId 实际相同(SDK forkSession 不 remap
          // tool_use.id,本侧也不再替换),靠 ChatPanel 的 key=flowId-agentId 强制 unmount
          // 完成内部 state 隔离;切到新 Flow 时整棵 ChatPanel 重建,卡片状态不会复用。
          <ChatPanel
            key={`${chatDrawer.flowId}-${chatDrawer.agentId}`}
            ref={chatPanelRef}
            flowId={chatDrawer.flowId}
            agentId={chatDrawer.agentId}
            agentName={chatDrawer.agentName}
            onClose={closeChatDrawer}
          />
        ) : null}
        <ChatInput
          onSend={onSend}
          status={inputState}
          onCancel={() => {
            if (chatDrawer) {
              interruptAgent(chatDrawer.flowId)
            }
          }}
        />
      </div>
    </Drawer>
  )
}
