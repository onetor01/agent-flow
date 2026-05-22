import { forwardRef, useMemo, type WheelEventHandler } from 'react'
import { Divider } from 'antd'
import { Bubble } from '@ant-design/x'
import type { BubbleItemType, BubbleListRef } from '@ant-design/x/es/bubble/interface'
import type { AgentRun } from '@/webview/store/flow'
import { toBubbleItems, type BubbleCtx } from './MessageBubble'

type Props = {
  runs: AgentRun[]
  ctx?: BubbleCtx
  loading?: boolean
  onWheel?: WheelEventHandler<HTMLDivElement>
}

const roleMap = {
  user: {
    placement: 'end' as const,
    variant: 'outlined' as const,
    styles: { content: { background: '#2a2d4a', borderColor: '#585b70' } },
  },
  ai: {
    placement: 'start' as const,
    variant: 'filled' as const,
  },
  system: {
    placement: 'start' as const,
    variant: 'borderless' as const,
  },
}

export const MessageList = forwardRef<BubbleListRef, Props>(function MessageList(
  { runs, ctx, loading, onWheel },
  ref,
) {
  const items = useMemo<BubbleItemType[]>(() => {
    const result: BubbleItemType[] = []
    runs.forEach((run, idx) => {
      if (idx > 0) {
        result.push({
          key: `divider-${run.runId}`,
          role: 'divider',
          content: (
            <Divider className='my-1 text-[10px]! text-[#6c7086]!'>第 {idx + 1} 次执行</Divider>
          ),
        })
      }
      // buildRenderItems 内部按 cacheKey 缓存(用 runId 作 key,与 store 端 clearBuildCacheForRuns 对齐)
      toBubbleItems(run.runId, run.messages, ctx, run.completed).forEach((item) => {
        result.push({
          key: `${run.runId}-${item.key}`,
          role: item.role,
          content: item.content,
        })
      })
    })
    return result
  }, [runs, ctx])

  const lastRunCompleted = runs.at(-1)?.completed

  const finalItems = useMemo<BubbleItemType[]>(() => {
    if (!loading || lastRunCompleted) return items
    return [
      ...items,
      {
        key: '__loading__',
        role: 'ai',
        content: null,
        loading: true,
      },
    ]
  }, [items, loading, lastRunCompleted])

  return (
    <div className='flex min-h-0 flex-1 flex-col' onWheel={onWheel}>
      <Bubble.List
        ref={ref}
        autoScroll={false}
        role={roleMap}
        items={finalItems}
        className='chat-bubble-compact min-h-0 flex-1 overflow-y-auto px-3 py-2'
      />
    </div>
  )
})
