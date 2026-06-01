import { useCallback, useRef, type FC, type ReactNode } from 'react'
import { Drawer, Modal } from 'antd'
import {
  agentChatInputState,
  getAgentPhase,
  getRunPhase,
  type AgentPhase,
  type UserMessageType,
} from '@/common'
import { useStartFlow } from '@/webview/hooks/useStartFlow'
import { useFlowStore } from '@/webview/store/flow'
import { ChatInput } from './ChatInput'
import { ChatPanel } from './ChatPanel'
import type { ChatPanelRef } from './ChatPanel'

type Props = {
  /**
   * 当前 chatDrawer state 中的 flowId / agentId / runId(可选)。
   * 全为 undefined 时 ChatPanel 不渲染,但 ChatInput 仍然挂载(全局唯一实例,保留 Slate 草稿)。
   */
  flowId?: string
  /**
   * 优先级 runId > agentId。
   * 给 runId 时按 runId 反查 agentId(精确指向用户当前看的 run);否则用 agentId 直接。
   * 至少要有一个能解析出 agentId,否则 ChatPanel 不渲染。
   */
  runId?: string
  agentId?: string
  /** Drawer 是否可见。关闭时 forceRender 保留 DOM,ChatInput 仍然挂载,但 ChatPanel 会卸载。 */
  open: boolean
  defaultSize?: number
  title?: ReactNode
  onClose?: () => void
}

export const ChatDrawer: FC<Props> = ({
  flowId,
  runId,
  agentId,
  open,
  defaultSize = 700,
  title,
  onClose,
}) => {
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)
  const interruptAgent = useFlowStore((s) => s.interruptAgent)
  const startFlow = useStartFlow()
  const chatPanelRef = useRef<ChatPanelRef>(null)

  // runId 反查 agentId,fallback 到 props.agentId
  const effectiveAgentId = useFlowStore((s): string | undefined => {
    if (!flowId) return undefined
    if (runId) {
      return s.flowRunStates[flowId]?.runs.find((r) => r.runId === runId)?.agentId ?? agentId
    }
    return agentId
  })

  // 当前面板对应的 agent 是否为 code 节点 —— 用于发送前的富文本拦截
  const isCodeNode = useFlowStore((s): boolean => {
    if (!flowId || !effectiveAgentId) return false
    const flow = s.flows.find((f) => f.id === flowId)
    return flow?.agents?.find((a) => a.id === effectiveAgentId)?.node_type === 'code'
  })

  const agentPhase = useFlowStore((s): AgentPhase => {
    if (!flowId || !effectiveAgentId) return 'idle'
    return getAgentPhase(s.flowRunStates[flowId], effectiveAgentId)
  })

  /**
   * 末位活跃 run 的 runId,用于 sendUserMessage / interruptAgent 的派发。
   * 末位 run 必须命中 effectiveAgentId 且 phase 非终态/非 idle。
   */
  const activeRunId = useFlowStore((s): string | undefined => {
    if (!flowId || !effectiveAgentId) return undefined
    const fs = s.flowRunStates[flowId]
    const last = fs?.runs.at(-1)
    if (!fs || !last || last.agentId !== effectiveAgentId) return undefined
    const phase = getRunPhase(last, fs)
    if (phase === 'idle' || phase === 'completed' || phase === 'stopped') return undefined
    return last.runId
  })

  // flowId / agentId 缺失时 ChatInput 不可用,但仍然挂载保留草稿
  const inputState = !flowId || !effectiveAgentId ? 'disabled' : agentChatInputState(agentPhase)
  const onSend = useCallback(
    async (content: UserMessageType['message']['content']): Promise<boolean> => {
      if (!flowId || !effectiveAgentId) return false

      // disabled / loading 状态不允许发送
      if (inputState === 'disabled' || inputState === 'loading') return false

      // code 节点不接收富文本(图片 / 附件 / 其他非 text 块):弹确认提示
      // 用户确认后仅提取 text 块拼接为字符串再发送。
      // 注:本期 CodeExecutor 是 eager 一次性执行,正常路径不会让用户走到 sendUserMessage,
      // 但发送入口仍按节点类型做这层 UI 拦截,避免用户误以为图片可被代码节点处理。
      let effectiveContent = content
      if (isCodeNode && Array.isArray(content)) {
        const hasNonText = content.some((b: any) => b?.type !== 'text')
        if (hasNonText) {
          const ok = await new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: '代码节点无法接收富文本',
              content: '确定提取其中的纯文本继续发送?',
              okText: '继续发送',
              cancelText: '取消',
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            })
          })
          if (!ok) return false
          const textOnly = content
            .filter((b: any) => b?.type === 'text')
            .map((b: any) => b.text ?? '')
            .filter(Boolean)
            .join('\n')
          effectiveContent = textOnly
        }
      }

      // 同会话追问条件:有 active run + phase=result/interrupted
      if (activeRunId && (agentPhase === 'result' || agentPhase === 'interrupted')) {
        sendUserMessage(flowId, activeRunId, effectiveContent)
        chatPanelRef.current?.forceScrollToBottom()
        return true
      }

      // ready (idle / 非活跃 agent 的 result) 或 confirm-required → 启动 flow
      // useStartFlow 内部会根据 FlowPhase !== idle 弹窗确认
      const started = await startFlow(flowId, effectiveAgentId, {
        type: 'user',
        message: { role: 'user', content: effectiveContent },
        parent_tool_use_id: null,
      })
      if (started) chatPanelRef.current?.forceScrollToBottom()
      return started
    },
    [
      flowId,
      effectiveAgentId,
      inputState,
      agentPhase,
      activeRunId,
      isCodeNode,
      startFlow,
      sendUserMessage,
    ],
  )

  return (
    <Drawer
      open={open}
      title={title}
      placement='right'
      mask={false}
      closable={false}
      defaultSize={defaultSize}
      resizable
      forceRender
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
      onClose={onClose}
    >
      <div className='flex flex-1 flex-col overflow-hidden bg-[#1e1e2e]'>
        {flowId && effectiveAgentId ? (
          // key 强制 ChatPanel 在 (flowId, agentId, runId) 切换时重新挂载,避免跨 Flow / 跨 run
          // 共用 React 内部状态(特别是 AskUserQuestionCard 的 selections / otherStates,以及
          // motion.div 的 ask-card key 在 toolUseId 相同时被复用)。
          // fork 出的新 Flow 与源 Flow 的 toolUseId 实际相同(SDK forkSession 不 remap
          // tool_use.id,本侧也不再替换),靠 ChatPanel 的 key 强制 unmount 完成内部 state 隔离;
          // 切到新 Flow / 切到指定 run 视图时整棵 ChatPanel 重建,卡片状态不会复用。
          <ChatPanel
            key={`${flowId}-${effectiveAgentId}-${runId ?? ''}`}
            ref={chatPanelRef}
            flowId={flowId}
            agentId={effectiveAgentId}
            runId={runId}
            onClose={onClose}
          />
        ) : null}
        {/* 保留草稿 此组件必须始终挂载 */}
        <ChatInput
          onSend={onSend}
          status={inputState}
          onCancel={() => {
            if (flowId && activeRunId) {
              interruptAgent(flowId, activeRunId)
            }
          }}
        />
      </div>
    </Drawer>
  )
}
