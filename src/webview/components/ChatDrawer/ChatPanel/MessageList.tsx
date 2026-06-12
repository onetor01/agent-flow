import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { App, Button, Divider } from 'antd'
import { Bubble } from '@ant-design/x'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemoizedFn } from 'ahooks'
import { match } from 'ts-pattern'
import type { ChatMessage } from '@/common'
import { getAnsweredToolPermissions, getPendingToolPermissionsFor } from '@/common'
import type { AgentRun } from '@/webview/store/flow'
import { useFlowStore } from '@/webview/store/flow'
import { postMessageToExtension } from '@/webview/utils'
import {
  type BubbleCtx,
  type RenderedBubble,
  indentBubble,
  chatMessageToBubble,
} from './MessageBubble'

// ── 特殊消息 ────────────────────────────────────────────────────────────────
type LoadingMessage = { kind: 'loading'; id: string }
type DividerMessage = { kind: 'divider'; runId: string; runIndex: number; id: string }
type ShowMoreMessage = { kind: 'show-more'; runId: string; hiddenCount: number; id: string }
type RenderMessage = ChatMessage | LoadingMessage | DividerMessage | ShowMoreMessage
type RenderItem = { runId?: string; message: RenderMessage }

/**
 * 暴露给 ChatPanel 的命令式 API。
 * - scrollBoxNativeElement: 兼容旧调用方,可能用于读取滚动容器
 * - scrollToBottom: 强制贴底,流式新消息时由 ChatPanel 调用
 */
export type MessageListRef = {
  scrollBoxNativeElement: HTMLElement | null
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void
}

type Props = {
  flowId: string
  agentId: string
  /** 单 run 视图;未传则按 agentId 聚合该 agent 全部 runs */
  runId?: string
  loading?: boolean
  ref?: Ref<MessageListRef>
}
const roleStyles = {
  user: {
    placement: 'end' as const,
    variant: 'outlined' as const,
    styles: { content: { background: '#2a2d4a', borderColor: '#585b70' } },
  },
  ai: { placement: 'start' as const, variant: 'filled' as const },
  system: { placement: 'start' as const, variant: 'borderless' as const },
}

function MessageListInner({ flowId, agentId, runId, loading, ref }: Props) {
  // ── 数据订阅 —— 全部用稳定原始引用,过滤 / 转换在 useMemo 中完成 ──────────────
  const fs = useFlowStore((s) => s.flowRunStates[flowId])
  const allRuns = fs?.runs

  // 允许展示一个agent的所有runs或指定runs
  const runs = useMemo<AgentRun[]>(() => {
    if (!allRuns) return []
    if (runId) {
      const r = allRuns.find((r) => r.runId === runId)
      return r ? [r] : []
    }
    return allRuns.filter((r) => r.agentId === agentId)
  }, [allRuns, agentId, runId])

  const { modal } = App.useApp()

  // ctx 构建
  const ctx = useMemo<BubbleCtx>(() => {
    const answeredToolPermissions = getAnsweredToolPermissions(fs)
    // 四类挂起统一订阅 pendingToolPermissions(AskUserQuestion / CompleteTask / ExitPlanMode / must_confirm)
    const pendingToolPerms = (() => {
      if (!fs) return []
      if (runId) {
        const list = fs.pendingToolPermissions
        const filtered = list.filter((p) => p.runId === runId)
        if (filtered.length === list.length) return list
        if (filtered.length === 0) return []
        return filtered
      }
      return getPendingToolPermissionsFor(fs, agentId)
    })()
    const pendingToolPermissionToolUseIds = (() => {
      if (pendingToolPerms.length === 0) return undefined
      return new Set(pendingToolPerms.map((p) => p.toolUseId))
    })()
    return {
      pendingToolPermissionToolUseIds,
      answeredToolPermissions,
      onToolPermissionAllow: (toolUseId) => {
        const state = useFlowStore.getState()
        const fs = state.flowRunStates[flowId]
        if (!fs) return
        const list = runId
          ? fs.pendingToolPermissions.filter((p) => p.runId === runId)
          : getPendingToolPermissionsFor(fs, agentId)
        const p = list.find((p) => p.toolUseId === toolUseId)
        if (!p) return
        state.answerToolPermission(flowId, p.runId, toolUseId, true)
      },
      // deny:message 供 CompleteTask 拒绝原因(回喂模型);其余工具不传 → executor 用 'user denied'
      onToolPermissionDeny: (toolUseId, message) => {
        const state = useFlowStore.getState()
        const fs = state.flowRunStates[flowId]
        if (!fs) return
        const list = runId
          ? fs.pendingToolPermissions.filter((p) => p.runId === runId)
          : getPendingToolPermissionsFor(fs, agentId)
        const p = list.find((p) => p.toolUseId === toolUseId)
        if (!p) return
        state.answerToolPermission(
          flowId,
          p.runId,
          toolUseId,
          false,
          message ? { message } : undefined,
        )
      },
      onViewPlan: (planFilePath) => {
        postMessageToExtension({
          type: 'openFile',
          data: { filename: planFilePath, placement: 'active' },
        })
      },
      /**
       * fork 触发入口：sessionCompleted=true（历史 session）时弹 modal 提示
       * 「shareValues 一致性不保证」并由用户确认后再发 command；当前 session 直接发。
       */
      onFork: (target, sessionCompleted) => {
        const doFork = () => useFlowStore.getState().forkFlow(flowId, target)
        if (!sessionCompleted) {
          doFork()
          return
        }
        modal.confirm({
          title: '从历史会话 fork',
          content: '该会话已完成，shareValues 在 fork 后可能与原值不一致。是否继续？',
          okText: 'fork',
          cancelText: '取消',
          onOk: doFork,
        })
      },
    }
  }, [fs, runId, agentId, flowId, modal])

  // ── 折叠状态 ────────────────────────────────────────────────────────────────
  // 同时只展开一个 run；expandedRunId 为空时自动跟随末位（新 run 追加时自动展开最新）
  const [expandedRunId, setExpandedRunId] = useState<string>()
  const lastRunId = runs.at(-1)?.runId
  const effectiveExpanded = expandedRunId ?? lastRunId

  // ── 列表项构建 ────────────
  const renderItems = useMemo<RenderItem[]>(() => {
    if (runs.length === 0) return []

    const items: RenderItem[] = []

    runs.forEach((run, idx) => {
      const { messages, runId } = run
      const isExpanded = runId === effectiveExpanded
      if (idx > 0) {
        items.push({
          runId,
          message: { kind: 'divider', runId: run.runId, runIndex: idx, id: 'divider' },
        })
      }

      if (!isExpanded) {
        // 折叠态：首条 user + showMore + agent_complete
        const firstUser = messages.find((m) => m.kind === 'user' && !m.parentToolUseId)
        const complete = messages.find((m) => m.kind === 'agent_complete')
        // hidden = 原始消息数 - firstUser 数 - complete 数
        const hiddenCount = run.messages.length - (firstUser ? 1 : 0) - (complete ? 1 : 0)

        if (firstUser) {
          items.push({ runId, message: firstUser })
        }
        if (hiddenCount > 0) {
          items.push({
            runId,
            message: {
              kind: 'show-more',
              runId: run.runId,
              hiddenCount,
              id: `show-more`,
            },
          })
        }
        if (complete) {
          items.push({ runId, message: complete })
        }
        return
      }

      // 展开态直接插入message
      items.push(...messages.map((m) => ({ runId, message: m })))
    })
    const lastRunCompleted = runs.at(-1)?.completed
    if (loading && !lastRunCompleted) {
      items.push({ message: { kind: 'loading', id: `__loading__` } })
    }
    return items
  }, [runs, loading, effectiveExpanded])

  // 诊断:气泡重叠根因排查
  useEffect(() => {
    const seen = new Map<string, number>()
    for (let i = 0; i < renderItems.length; i++) {
      const curItem = renderItems[i]
      const { message, runId } = curItem
      const id = `${runId}-${message.id}`
      if (seen.has(id)) {
        console.warn('[MessageList] 重复 RenderItem key', {
          id,
          flowId,
          agentId,
          existingItem: renderItems[seen.get(id)!],
          duplicateItem: curItem,
        })
      } else {
        seen.set(id, i)
      }
    }
  }, [flowId, agentId, runId, renderItems])

  const scrollerElRef = useRef<HTMLDivElement | null>(null)
  // 是否粘底:用户向上滚则置 false,滚回底部 32px 内置 true
  const shouldScrollRef = useRef(true)

  const virtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => scrollerElRef.current,
    // estimateSize 尽量贴近真实平均高度。常规一行气泡 ~50px、tooluse ~30px,
    estimateSize: () => 50,
    // 视口上下预渲染窗口
    overscan: 30,
    // key包含runId 确保不重复
    getItemKey: (idx) => {
      const { runId, message } = renderItems[idx]
      const key = `${runId}-${message.id}`
      return key
    },
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  /**
   * 直接把 scrollTop 怼到 scrollHeight,与 DOM 真实高度对齐 ——
   * 不走 virtualizer.scrollToIndex,避开「估算高度先算偏移、精确高度异步回填」
   * 导致末尾消息越长越偏的老问题。
   */
  const scrollToEnd = useMemoizedFn((behavior: 'auto' | 'smooth' = 'auto') => {
    const el = scrollerElRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  })

  useLayoutEffect(() => {
    if (!shouldScrollRef.current) return
    scrollToEnd()
    // 有AI消息/首次进入/渲染变化时滚动
  }, [renderItems, totalSize, scrollToEnd])

  useImperativeHandle(
    ref,
    () => ({
      get scrollBoxNativeElement() {
        return scrollerElRef.current
      },
      scrollToBottom(behavior: 'auto' | 'smooth' = 'auto') {
        shouldScrollRef.current = true
        setTimeout(() => scrollToEnd(behavior))
      },
    }),
    [scrollToEnd],
  )

  return (
    <div
      ref={scrollerElRef}
      onScroll={(e) => {
        const dom = e.target as HTMLDivElement
        shouldScrollRef.current = dom.scrollHeight - dom.scrollTop - dom.clientHeight < 32
      }}
      className='chat-bubble-compact min-h-0 flex-1 overflow-x-hidden overflow-y-auto'
    >
      <div className='relative w-full max-w-full overflow-hidden' style={{ height: totalSize }}>
        {virtualItems.map((vi) => {
          const item = renderItems[vi.index]
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className='absolute top-0 left-0 w-full px-3 [&:has(.from-sub-agent)]:ml-4'
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <Message
                flowId={flowId}
                agentId={agentId}
                runId={item.runId}
                message={item.message}
                ctx={ctx}
                setExpandedRunId={setExpandedRunId}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// React 19 允许把 ref 直接放到 props 里。memo 的浅比较仅依赖 (flowId, agentId, runId, loading, ref)
// 几个稳定字段;store 变化由组件内部的 selector 自行订阅,不再因父级重渲染连带刷新。
export const MessageList = memo(MessageListInner)

// ── MessageItem —— 单条列表项渲染，memo 确保 item/ctx 未变时跳过重渲染 ───────────
const Message = memo(function ({
  message,
  ctx,
  flowId,
  runId,
  agentId,
  setExpandedRunId,
}: {
  message: RenderMessage
  ctx: BubbleCtx
  flowId: string
  runId?: string
  agentId: string
  setExpandedRunId: (runId: string) => void
}) {
  const injectedTitle = useFlowStore((s) => {
    const f = s.flows.find((f) => f.id === flowId)
    const a = f?.agents?.find((a) => a.id === agentId)
    return a?.node_type === 'code' ? '共享数据' : '注入数据'
  })
  const completed = useFlowStore((s) => {
    const fs = s.flowRunStates[flowId]
    return fs.runs.find((r) => r.runId === runId)?.completed ?? false
  })
  if (message.kind === 'divider') {
    return (
      <Divider className='my-1 text-[10px]! text-[#6c7086]!'>
        第 {message.runIndex + 1} 次执行
      </Divider>
    )
  }
  if (message.kind === 'show-more') {
    return (
      <div className='flex justify-center'>
        <Button
          size='small'
          type='text'
          className='text-[11px]! text-[#6c7086]!'
          onClick={() => setExpandedRunId(message.runId)}
        >
          显示折叠消息({message.hiddenCount})
        </Button>
      </div>
    )
  }
  if (message.kind === 'loading') {
    return <Bubble placement='start' variant='filled' content={null} loading />
  }
  if (!runId) return null

  // ChatMessage
  const raw = chatMessageToBubble(
    message,
    ctx,
    completed,
    runId,
    message.uuid,
    message.kind === 'user' ? message.injectedShareValues : undefined,
    injectedTitle,
  )
  if (!raw) return null
  const bubbles: RenderedBubble[] = Array.isArray(raw) ? raw : [raw]
  const applied = message.parentToolUseId ? bubbles.map(indentBubble) : bubbles
  return (
    <>
      {applied.map((b) => {
        const { key, ...rest } = b
        return match(b.role)
          .with('divider', () => <Bubble.Divider key={key} {...rest} />)
          .with('system', () => <Bubble.System key={key} {...rest} />)
          .otherwise((role) => {
            const cfg = roleStyles[role as keyof typeof roleStyles] ?? {}
            return <Bubble key={key} {...cfg} {...rest} />
          })
      })}
    </>
  )
})
