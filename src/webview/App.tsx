import { useEffect, type FC } from 'react'
import { App as AntdApp, Spin } from 'antd'
import { useEventListener } from 'ahooks'
import { z } from 'zod'
import { FlowSchema } from '@/common'
import { AgentEditor } from './components/AgentEditor'
import { AgentFlow } from './components/AgentFlow'
import { ChatDrawer } from './components/ChatDrawer'
import { FlowEditor } from './components/FlowEditor'
import { FlowListPanel } from './components/FlowListPanel'
import { useFlowStore } from './store/flow'

export const App: FC = () => {
  const { notification } = AntdApp.useApp()
  const { loading, flows, init } = useFlowStore()
  const globalError = useFlowStore((s) => s.globalError)
  const chatDrawer = useFlowStore((s) => s.chatDrawer)
  const closeChatDrawer = useFlowStore((s) => s.closeChatDrawer)
  const activeFlowId = useFlowStore((s) => s.activeFlowId)

  useEffect(() => init({ notification }), [init, notification])

  // activeFlowId 切换时,按 runs 末位 agent 决定打开/关闭 ChatDrawer。
  // runs 末位 agent = 用户当前要看的对象;runs 为空(idle)或无 active flow 则关闭。
  // completed 且已流转的中间 agent 不会出现在末位(reducer 切换时立刻追加新 run);
  // completed 且无 next_agent 的 flow 末端仍在末位,自动打开让用户看结果。
  // 依赖只放 activeFlowId,flow 定义/runs 现取,避免编辑 Agent 等无关变更触发自动开关。
  useEffect(() => {
    const { openChatDrawer, closeChatDrawer } = useFlowStore.getState()
    if (!activeFlowId) {
      closeChatDrawer()
      return
    }
    const targetAgentId = useFlowStore.getState().flowRunStates[activeFlowId]?.runs.at(-1)?.agentId
    if (targetAgentId) {
      const latestFlow = useFlowStore.getState().flows.find((f) => f.id === activeFlowId)
      const agent = latestFlow?.agents?.find((a) => a.id === targetAgentId)
      openChatDrawer({
        flowId: activeFlowId,
        agentId: targetAgentId,
        agentName: agent?.agent_name ?? '',
      })
    } else {
      closeChatDrawer()
    }
  }, [activeFlowId])

  useEffect(() => {
    if (!globalError) return
    notification.error({
      key: 'globalError',
      duration: 0,
      message: '拓展出现未知错误 请保存数据后重新打开页面',
      description: globalError,
    })
  }, [globalError, notification])
  usePasteFlow()

  if (loading) {
    return (
      <div className='flex h-full w-full items-center justify-center bg-[#11111b]'>
        <Spin size='large' />
      </div>
    )
  }

  return (
    <div className='flex h-full w-full'>
      <div className='relative flex-1'>
        {flows.map((flow) => (
          <AgentFlow key={flow.id} flowId={flow.id} />
        ))}
        <FlowListPanel />
      </div>
      <ChatDrawer
        flowId={chatDrawer?.flowId}
        agentId={chatDrawer?.agentId}
        runId={chatDrawer?.runId}
        open={!!chatDrawer}
        onClose={closeChatDrawer}
      />
      <AgentEditor />
      <FlowEditor />
    </div>
  )
}

const isInputTarget = (e: Event) => {
  const el = e.target
  if (!(el instanceof HTMLElement)) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

const usePasteFlow = () => {
  useEventListener('paste', (e: ClipboardEvent) => {
    if (isInputTarget(e)) return
    const text = e.clipboardData?.getData('text')
    if (!text) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    // 只复制flow agent在<AgentFlow />复制 需要放置在画布里合适的位置
    const { save, setActiveFlowId, setFlowListCollapsed } = useFlowStore.getState()
    const singleFlow = FlowSchema.safeParse(parsed)
    if (singleFlow.success) {
      const newId = crypto.randomUUID()
      save((flows) => {
        flows.push({ ...singleFlow.data, id: newId })
      })
      setActiveFlowId(newId)
      setFlowListCollapsed(false)
      return
    }

    const flowArray = z.array(FlowSchema).safeParse(parsed)
    if (flowArray.success) {
      let lastId = ''
      save((flows) => {
        for (const flow of flowArray.data) {
          lastId = crypto.randomUUID()
          flows.push({ ...flow, id: lastId })
        }
      })
      if (lastId) {
        setActiveFlowId(lastId)
        setFlowListCollapsed(false)
      }
      return
    }
  })
}
