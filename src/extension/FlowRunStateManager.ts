import { produce } from 'immer'
import type { ExtensionFlowCommandMessage, ExtensionFlowSignalMessage, Flow } from '@/common'
import type { FlowRunState, MessageEffect } from '@/common'
import { updateFlowRunState } from '@/common'

/**
 * extension 端镜像 webview 的 `flowRunStates`：把 webview 关闭时仍在运行的 flow 状态留在 extension 内。
 *
 * 数据流：
 * - flow.command.* 抵达时 → applyCommand 走一遍 common 的 updateFlowRunState reducer
 * - 任何 flow.signal.* 经 postMessage 出去前 → applySignal 走一遍 common 的 updateFlowRunState reducer
 * - 工作流 load/save 触发 flows 变更 → applyFlows 清理已删除 flow 的 state（caller 负责 kill runner）
 */
export class FlowRunStateManager {
  private flowRunStates: Record<string, FlowRunState> = {}
  private flows: Flow[] = []
  private onNotifyUser?: (effect: MessageEffect) => void

  setNotifyHandler(handler: (effect: MessageEffect) => void): void {
    this.onNotifyUser = handler
  }

  /** 当前所有 flow 的运行态快照 */
  getFlowRunStates(): Record<string, FlowRunState> {
    return this.flowRunStates
  }

  /**
   * 直接注入指定 flowId 的运行态。fork 路径专用：fork 出的新 Flow 复制源 Flow
   * 的 RunState 切片后以新 flowId 写入,绕过 reducer。
   */
  setRunState(flowId: string, state: FlowRunState): void {
    this.flowRunStates = produce(this.flowRunStates, (draft) => {
      draft[flowId] = state
    })
  }

  /** 应用一条 flow.command.* 消息：command 路径由 caller 在派发 runner 前调用，不产生通知 */
  applyCommand(msg: ExtensionFlowCommandMessage): void {
    const flowId = msg.data.flowId
    const existing = this.flowRunStates[flowId]
    const { state } = updateFlowRunState(msg, {
      state: existing,
      flows: this.flows,
    })
    this.flowRunStates = produce(this.flowRunStates, (draft) => {
      if (state) {
        draft[flowId] = state
      } else {
        delete draft[flowId]
      }
    })
  }

  /** 应用一条 flow.signal.* 消息 */
  applySignal(msg: ExtensionFlowSignalMessage): void {
    const flowId = msg.data.flowId

    const existing = this.flowRunStates[flowId]
    if (!existing) return

    const { state, effects } = updateFlowRunState(msg, {
      state: existing,
      flows: this.flows,
    })
    this.flowRunStates = produce(this.flowRunStates, (draft) => {
      if (state) draft[flowId] = state
    })

    // extension 端自行处理通知（VSCode notification）
    for (const e of effects) {
      this.onNotifyUser?.(e)
    }
  }

  /**
   * 同步最新 flows 列表，并清理被删除 flow 对应的运行态。
   * 对每个被删除的 flowId 先回调 onRemove（caller 在此 kill runner），再删 state。
   */
  applyFlows(newFlows: Flow[], onRemove: (flowId: string) => void): void {
    const validIds = new Set(newFlows.map((f) => f.id))
    const removedIds = Object.keys(this.flowRunStates).filter((id) => !validIds.has(id))
    for (const flowId of removedIds) {
      onRemove(flowId)
    }
    if (removedIds.length > 0) {
      this.flowRunStates = produce(this.flowRunStates, (draft) => {
        for (const flowId of removedIds) delete draft[flowId]
      })
    }
    this.flows = newFlows
  }
}
