import { useCallback } from 'react'
import { App } from 'antd'
import type { UserMessageType } from '@/common'
import { useFlowStore, selectFlowPhase, type FlowPhase } from '@/webview/store/flow'

/**
 * 启动 Flow 的公共逻辑：
 * - idle → 直接调用 runFlow
 * - 非 idle → 弹确认框，确认后清空运行数据再启动
 */
export function useStartFlow() {
  const { modal } = App.useApp()

  const startFlow = useCallback(
    (flowId: string, agentId: string, initMessage: UserMessageType): boolean | Promise<boolean> => {
      const st = useFlowStore.getState()
      const { runFlow } = st
      const flowPhase: FlowPhase = selectFlowPhase(flowId)(st)

      if (flowPhase === 'idle') {
        runFlow(flowId, agentId, initMessage)
        return true
      }

      return new Promise<boolean>((resolve) => {
        modal.confirm({
          title: '确认运行',
          content: '当前工作流数据会被清空，如果想保留数据，可以复制工作流再运行',
          onOk: () => {
            runFlow(flowId, agentId, initMessage)
            resolve(true)
          },
          onCancel: () => resolve(false),
        })
      })
    },
    [modal],
  )

  return startFlow
}
