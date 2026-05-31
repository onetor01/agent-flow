import {
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type Ref,
} from 'react'
import { App, Divider } from 'antd'
import { Bubble } from '@ant-design/x'
import type { BubbleItemType } from '@ant-design/x/es/bubble/interface'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemoizedFn } from 'ahooks'
import { match } from 'ts-pattern'
import type { AskUserQuestionOutput, PendingQuestion, PendingToolPermission } from '@/common'
import {
  getAnsweredToolPermissions,
  getPendingCompleteConfirmsFor,
  getPendingQuestionsFor,
  getPendingToolPermissionsFor,
} from '@/common'
import type { AgentRun, PendingCompleteConfirm } from '@/webview/store/flow'
import { useFlowStore } from '@/webview/store/flow'
import { toBubbleItems, type AnsweredInfo, type BubbleCtx } from './MessageBubble'

type Item = BubbleItemType

// 模块级常量 —— useMemo / selector 在「无内容」时返回稳定空引用,
// 避免 useSyncExternalStore 因为新 [] / new Set() 误判快照变化触发死循环重渲染。
const EMPTY_RUNS: AgentRun[] = []
const EMPTY_PENDING_QUESTIONS: PendingQuestion[] = []
const EMPTY_PENDING_TOOL_PERMS: PendingToolPermission[] = []
const EMPTY_PENDING_COMPLETE_CONFIRMS: PendingCompleteConfirm[] = []

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

/** 把 answeredQuestions 里 '\x1F' 分隔的多选 join 反向解析成 string[] */
function buildAnsweredMap(
  answeredQuestions: Record<string, AskUserQuestionOutput>,
): Map<string, AnsweredInfo> {
  const answeredMap = new Map<string, AnsweredInfo>()
  for (const [toolUseId, output] of Object.entries(answeredQuestions)) {
    const values: Record<string, string[]> = {}
    for (const [q, a] of Object.entries(output.answers ?? {})) {
      values[q] = (a ?? '')
        .split('\x1F')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    answeredMap.set(toolUseId, { values })
  }
  return answeredMap
}

function MessageListInner({ flowId, agentId, runId, loading, ref }: Props) {
  // ── 数据订阅 —— 全部用稳定原始引用,过滤 / 转换在 useMemo 中完成 ──────────────
  const fs = useFlowStore((s) => s.flowRunStates[flowId])
  const allRuns = fs?.runs
  const answeredQuestions = fs?.answeredQuestions
  const answeredToolPermissions = useMemo(() => getAnsweredToolPermissions(fs), [fs])

  const runs = useMemo<AgentRun[]>(() => {
    if (!allRuns) return EMPTY_RUNS
    if (runId) {
      const r = allRuns.find((r) => r.runId === runId)
      return r ? [r] : EMPTY_RUNS
    }
    return allRuns.filter((r) => r.agentId === agentId)
  }, [allRuns, agentId, runId])

  const pendingQuestions = useMemo(() => {
    if (!fs) return EMPTY_PENDING_QUESTIONS
    if (runId) {
      const list = fs.pendingQuestions
      const filtered = list.filter((q) => q.runId === runId)
      if (filtered.length === list.length) return list
      if (filtered.length === 0) return EMPTY_PENDING_QUESTIONS
      return filtered
    }
    return getPendingQuestionsFor(fs, agentId)
  }, [fs, runId, agentId])

  const pendingToolPerms = useMemo(() => {
    if (!fs) return EMPTY_PENDING_TOOL_PERMS
    if (runId) {
      const list = fs.pendingToolPermissions
      const filtered = list.filter((p) => p.runId === runId)
      if (filtered.length === list.length) return list
      if (filtered.length === 0) return EMPTY_PENDING_TOOL_PERMS
      return filtered
    }
    return getPendingToolPermissionsFor(fs, agentId)
  }, [fs, runId, agentId])

  const pendingCompleteConfirms = useMemo(() => {
    if (!fs) return EMPTY_PENDING_COMPLETE_CONFIRMS
    if (runId) {
      const list = fs.pendingCompleteConfirms
      const filtered = list.filter((c) => c.runId === runId)
      if (filtered.length === list.length) return list
      if (filtered.length === 0) return EMPTY_PENDING_COMPLETE_CONFIRMS
      return filtered
    }
    return getPendingCompleteConfirmsFor(fs, agentId)
  }, [fs, runId, agentId])

  const answerToolPermission = useFlowStore((s) => s.answerToolPermission)
  const answerCompleteConfirm = useFlowStore((s) => s.answerCompleteConfirm)
  const forkFlow = useFlowStore((s) => s.forkFlow)
  const { modal } = App.useApp()

  // ── ctx 构建 —— 历史 ask_user_question 卡片 / fork icon / tool 权限卡片用 ──
  const answeredMap = useMemo(() => buildAnsweredMap(answeredQuestions ?? {}), [answeredQuestions])

  const pendingToolUseIds = useMemo(() => {
    if (pendingQuestions.length === 0) return undefined
    const ids = new Set<string>()
    for (const pq of pendingQuestions) ids.add(pq.toolUseId)
    return ids
  }, [pendingQuestions])

  const pendingToolPermissionToolUseIds = useMemo(() => {
    if (pendingToolPerms.length === 0) return undefined
    return new Set(pendingToolPerms.map((p) => p.toolUseId))
  }, [pendingToolPerms])

  const pendingCompleteConfirmToolUseIds = useMemo(() => {
    if (pendingCompleteConfirms.length === 0) return undefined
    return new Set(pendingCompleteConfirms.map((c) => c.toolUseId))
  }, [pendingCompleteConfirms])

  const onToolPermissionAllow = useCallback(
    (toolUseId: string) => {
      const p = pendingToolPerms.find((p) => p.toolUseId === toolUseId)
      if (!p) return
      answerToolPermission(flowId, p.runId, toolUseId, true)
    },
    [answerToolPermission, flowId, pendingToolPerms],
  )
  const onToolPermissionDeny = useCallback(
    (toolUseId: string) => {
      const p = pendingToolPerms.find((p) => p.toolUseId === toolUseId)
      if (!p) return
      answerToolPermission(flowId, p.runId, toolUseId, false)
    },
    [answerToolPermission, flowId, pendingToolPerms],
  )

  const onCompleteConfirmAccept = useCallback(
    (toolUseId: string) => {
      const c = pendingCompleteConfirms.find((c) => c.toolUseId === toolUseId)
      if (!c) return
      answerCompleteConfirm(flowId, c.runId, toolUseId, true)
    },
    [answerCompleteConfirm, flowId, pendingCompleteConfirms],
  )

  const onCompleteConfirmDeny = useCallback(
    (toolUseId: string, reason: string) => {
      const c = pendingCompleteConfirms.find((c) => c.toolUseId === toolUseId)
      if (!c) return
      answerCompleteConfirm(flowId, c.runId, toolUseId, false, reason)
    },
    [answerCompleteConfirm, flowId, pendingCompleteConfirms],
  )

  /**
   * fork 触发入口：sessionCompleted=true（历史 session）时弹 modal 提示
   * 「shareValues 一致性不保证」并由用户确认后再发 command；当前 session 直接发。
   */
  const onForkRequest = useCallback(
    (
      target: { kind: 'message'; runId: string; messageUuid: string },
      sessionCompleted: boolean,
    ) => {
      const doFork = () => forkFlow(flowId, target)
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
    [forkFlow, flowId, modal],
  )

  const ctx = useMemo<BubbleCtx>(
    () => ({
      pendingToolUseIds,
      answeredMap,
      pendingToolPermissionToolUseIds,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
      pendingCompleteConfirmToolUseIds,
      onCompleteConfirmAccept,
      onCompleteConfirmDeny,
      onFork: onForkRequest,
    }),
    [
      pendingToolUseIds,
      answeredMap,
      pendingToolPermissionToolUseIds,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
      pendingCompleteConfirmToolUseIds,
      onCompleteConfirmAccept,
      onCompleteConfirmDeny,
      onForkRequest,
    ],
  )

  // ── 渲染项 ─────────────────────────────────────────────────────────────────
  const items = useMemo<Item[]>(() => {
    const result: Item[] = []
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
  const finalItems = useMemo<Item[]>(() => {
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

  const scrollerElRef = useRef<HTMLDivElement | null>(null)
  // 是否粘底:用户向上滚则置 false,滚回底部 32px 内置 true
  const shouldScrollRef = useRef(true)

  const virtualizer = useVirtualizer({
    count: finalItems.length,
    getScrollElement: () => scrollerElRef.current,
    // estimateSize 尽量贴近真实平均高度。常规一行气泡 ~50px、tooluse ~30px,
    estimateSize: () => 50,
    // 视口上下预渲染窗口
    overscan: 30,
    getItemKey: (idx) => String(finalItems[idx].key),
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
  }, [finalItems, totalSize, scrollToEnd])

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
          const item = finalItems[vi.index]
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className='absolute top-0 left-0 w-full px-3'
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {renderItem(item)}
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

function renderItem(item: Item) {
  // key 必须从 spread 中剥离 —— React 19 禁止把 key 通过 props 对象间接传入 JSX
  const { key, ...rest } = item
  return match(item.role)
    .with('divider', () => <Bubble.Divider key={key} {...rest} />)
    .with('system', () => <Bubble.System key={key} {...rest} />)
    .otherwise((role) => {
      const cfg = roleStyles[role as keyof typeof roleStyles] ?? {}
      return <Bubble key={key} {...cfg} {...rest} />
    })
}
