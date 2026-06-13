import { useCallback } from 'react'
import { App } from 'antd'
import { match, P } from 'ts-pattern'
import { getFlowPhase, type FlowPhase, type UserMessageType } from '@/common'
import { useFlowStore } from '@/webview/store/flow'

/**
 * 启动 Flow 的公共逻辑：
 * - idle / stopped / result / error / completed → 直接调用 runFlow
 * - 其它状态 → 弹确认框，确认后追加新 run
 */
export function useStartFlow() {
  const { modal } = App.useApp()

  const startFlow = useCallback(
    (flowId: string, agentId: string, initMessage: UserMessageType): boolean | Promise<boolean> => {
      const st = useFlowStore.getState()
      const { runFlow } = st
      const flowPhase: FlowPhase = getFlowPhase(st.flowRunStates[flowId])
      return match(flowPhase)
        .with(P.union('completed', 'error', 'idle', 'stopped'), () => {
          runFlow(flowId, agentId, initMessage)
          return true
        })
        .otherwise(() => {
          return new Promise<boolean>((resolve) => {
            modal.confirm({
              title: '确认运行？',
              content: '其他会话将被关闭。如果需要并行，请使用fork或克隆能力。',
              onOk: () => {
                runFlow(flowId, agentId, initMessage)
                resolve(true)
              },
              onCancel: () => resolve(false),
            })
          })
        })
    },
    [modal],
  )

  return startFlow
}
