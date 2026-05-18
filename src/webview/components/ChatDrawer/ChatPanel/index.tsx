import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FC,
  type WheelEventHandler,
} from 'react'
import { App, Button, Skeleton, Tag, Tooltip } from 'antd'
import { BranchesOutlined, CloseOutlined, RobotOutlined, StopOutlined } from '@ant-design/icons'
import { Welcome } from '@ant-design/x'
import type { BubbleListRef } from '@ant-design/x/es/bubble/interface'
import { AnimatePresence, motion } from 'motion/react'
import { match, P } from 'ts-pattern'
import type { AskUserQuestionOutput } from '@/common'
import { calculateTokenCost, formatTokenCount, formatTokenCost } from '@/common'
import type { AgentSession } from '@/webview/store/flow'
import {
  useFlowStore,
  selectAgentPhase,
  selectFlowPhase,
  selectPendingQuestionsFor,
  selectPendingToolPermissionFor,
  selectAnsweredToolPermissions,
  flowCanBeKilled,
  type AgentPhase,
} from '@/webview/store/flow'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import type { AnsweredInfo, BubbleCtx } from './MessageBubble'
import { MessageList } from './MessageList'

export type ChatPanelRef = {
  forceScrollToBottom: () => void
}

type Props = {
  flowId: string
  agentId: string
  agentName: string
  onClose?: () => void
  ref?: React.Ref<ChatPanelRef>
}

/** 从 answeredQuestions 构建 toolUseId -> AnsweredInfo 映射 */
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

export const ChatPanel: FC<Props> = ({ flowId, agentId, agentName, onClose, ref }) => {
  const killFlow = useFlowStore((s) => s.killFlow)
  const answerQuestion = useFlowStore((s) => s.answerQuestion)
  const answerToolPermission = useFlowStore((s) => s.answerToolPermission)
  const forkFlow = useFlowStore((s) => s.forkFlow)
  const { modal } = App.useApp()

  const phase = useFlowStore(selectAgentPhase(flowId, agentId))
  const flowPhase = useFlowStore(selectFlowPhase(flowId))
  const pendingQuestions = useFlowStore(selectPendingQuestionsFor(flowId, agentId))
  const pendingToolPerm = useFlowStore(selectPendingToolPermissionFor(flowId, agentId))
  const answeredToolPermissions = useFlowStore(selectAnsweredToolPermissions(flowId))
  const allSessions = useFlowStore((s) => s.flowRunStates[flowId]?.sessions)
  const sessions = useMemo<AgentSession[]>(
    () => allSessions?.filter((s) => s.agentId === agentId) ?? [],
    [allSessions, agentId],
  )
  const answeredQuestions = useFlowStore((s) => s.flowRunStates[flowId]?.answeredQuestions)

  // Flow 级累计：token 用 modelUsage（camelCase），费用用 total_cost_usd
  const { totalTokens, totalCost, modelBreakdown } = useMemo(() => {
    if (!allSessions)
      return {
        totalTokens: 0,
        totalCost: 0,
        modelBreakdown: [] as Array<{ model: string; tokens: number; cost: number }>,
      }
    let totalTokens = 0
    let totalCost = 0
    const modelMap = new Map<string, { tokens: number; cost: number }>()
    for (const session of allSessions) {
      // total_cost_usd 是 session 累计值，只取最后一条 result 避免重复累加
      let lastResultCost: number | undefined
      let totalResultTokens: number = 0
      let sessionModel: string | undefined
      for (const msg of session.messages) {
        if (msg.type === 'flow.signal.aiMessage' && msg.data.message.type === 'result') {
          const result = msg.data.message as any
          if (result.modelUsage && typeof result.modelUsage === 'object') {
            for (const mu of Object.values(result.modelUsage) as any[]) {
              totalResultTokens += (mu.inputTokens ?? 0) + (mu.outputTokens ?? 0)
            }
          }
          if (typeof result.total_cost_usd === 'number') {
            lastResultCost = result.total_cost_usd
          }
          // 提取模型名称
          if (!sessionModel && typeof result.model === 'string') {
            sessionModel = result.model
          }
        }
      }
      if (lastResultCost !== undefined) totalCost += lastResultCost
      totalTokens += totalResultTokens
      // 按模型归集
      const m = sessionModel ?? session.agentId
      const entry = modelMap.get(m) ?? { tokens: 0, cost: 0 }
      entry.tokens += totalResultTokens
      if (lastResultCost !== undefined) entry.cost += lastResultCost
      modelMap.set(m, entry)
    }
    const modelBreakdown = Array.from(modelMap.entries()).map(([m, v]) => ({ model: m, ...v }))
    return { totalTokens, totalCost, modelBreakdown }
  }, [allSessions])

  const canKillFlow = flowCanBeKilled(flowPhase)

  // AskUserQuestionCard 容器高度,用户可上下拖动调整
  const [cardHeight, setCardHeight] = useState(240)
  const [dragging, setDragging] = useState(false)
  const answeredMap = useMemo(() => buildAnsweredMap(answeredQuestions ?? {}), [answeredQuestions])

  // 合并所有 pending questions 的 questions 数组到一张卡片
  const mergedInput = useMemo(() => {
    if (pendingQuestions.length === 0)
      return {
        questions: [] as import('@/common').AskUserQuestionItem[],
        toolUseIds: [] as string[],
      }
    const allQuestions: import('@/common').AskUserQuestionItem[] = []
    const toolUseIds: string[] = []
    for (const pq of pendingQuestions) {
      toolUseIds.push(pq.toolUseId)
      for (const q of pq.input.questions ?? []) {
        allQuestions.push(q)
      }
    }
    return { questions: allQuestions, toolUseIds }
  }, [pendingQuestions])

  const showCard = mergedInput.questions.length > 0
  const onToolPermissionAllow = useCallback(
    (toolUseId: string) => answerToolPermission(flowId, toolUseId, true),
    [answerToolPermission, flowId],
  )
  const onToolPermissionDeny = useCallback(
    (toolUseId: string) => answerToolPermission(flowId, toolUseId, false),
    [answerToolPermission, flowId],
  )

  /**
   * fork 触发入口：sessionCompleted=true（历史 session）时弹 modal 提示
   * 「shareValues 一致性不保证」并由用户确认后再发 command；当前 session 直接发。
   */
  const onForkRequest = useCallback(
    (
      target:
        | { kind: 'message'; messageUuid: string }
        | { kind: 'askUserQuestion'; toolUseId: string },
      sessionCompleted: boolean,
    ) => {
      const doFork = () => forkFlow(flowId, agentId, target)
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
    [forkFlow, flowId, agentId, modal],
  )

  // 消息列表自动滚动控制:默认贴底,用户向上滚后停止跟随,滚回底部时恢复
  const messageListRef = useRef<BubbleListRef>(null)
  const shouldScrollRef = useRef(true)

  const handleListWheel = useCallback<WheelEventHandler<HTMLDivElement>>((e) => {
    const dom = messageListRef.current?.scrollBoxNativeElement
    if (!dom) return
    // wheel 事件触发时 scrollTop 尚未更新,叠加 deltaY 预测滚动后位置
    const projectedScrollTop = Math.max(
      0,
      Math.min(dom.scrollHeight - dom.clientHeight, dom.scrollTop + e.deltaY),
    )
    const atBottom = dom.scrollHeight - projectedScrollTop - dom.clientHeight < 30
    shouldScrollRef.current = atBottom
  }, [])

  // 切换 agent 时
  useEffect(() => {
    shouldScrollRef.current = true
  }, [flowId, agentId])

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      const dom = messageListRef.current?.scrollBoxNativeElement
      dom?.scroll({ top: dom.scrollHeight, behavior: 'instant' })
    }, 0)
  }, [])

  const onActiveSubmit = useCallback(
    (_toolUseId: string, output: AskUserQuestionOutput) => {
      // 把合并后的 answers 按原 pendingQuestions 的顺序拆分回每个 toolUseId
      const answersPerQuestion: Record<string, string[]> = {}
      for (const [qText, qAnswers] of Object.entries(output.answers ?? {})) {
        answersPerQuestion[qText] = qAnswers
          .split('\x1F')
          .map((s) => s.trim())
          .filter(Boolean)
      }

      for (const pq of pendingQuestions) {
        const pqAnswers: Record<string, string> = {}
        for (const q of pq.input.questions ?? []) {
          const ans = answersPerQuestion[q.question] ?? []
          pqAnswers[q.question] = ans.join('\x1F')
        }
        answerQuestion(flowId, pq.toolUseId, { questions: pq.input.questions, answers: pqAnswers })
      }

      shouldScrollRef.current = true
      scrollToBottom()
    },
    [answerQuestion, flowId, pendingQuestions, scrollToBottom],
  )

  const pendingToolUseId = showCard ? mergedInput.toolUseIds[0] : undefined
  const pendingToolPermissionToolUseId = pendingToolPerm?.toolUseId
  const pendingToolUseIds = useMemo(
    () => (mergedInput.toolUseIds.length > 0 ? new Set(mergedInput.toolUseIds) : undefined),
    [mergedInput.toolUseIds],
  )
  const ctx = useMemo<BubbleCtx>(
    () => ({
      pendingToolUseId,
      pendingToolUseIds,
      answeredMap,
      onActiveSubmit,
      pendingToolPermissionToolUseId,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
      onFork: onForkRequest,
    }),
    [
      pendingToolUseId,
      pendingToolUseIds,
      answeredMap,
      onActiveSubmit,
      pendingToolPermissionToolUseId,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
      onForkRequest,
    ],
  )

  useImperativeHandle(
    ref,
    () => ({
      forceScrollToBottom: () => {
        shouldScrollRef.current = true
        scrollToBottom()
      },
    }),
    [scrollToBottom],
  )

  // 新消息到达时按需滚到底
  useEffect(() => {
    if (shouldScrollRef.current) scrollToBottom()
  }, [sessions, scrollToBottom])

  const { text: statusText, color: statusColor } = match<
    AgentPhase,
    { text: string; color: 'processing' | 'warning' | 'default' | 'success' | 'error' }
  >(phase)
    .with('starting', () => ({ text: '启动中', color: 'processing' }))
    .with('running', () => ({ text: '生成中', color: 'processing' }))
    .with('result', () => ({ text: '生成完毕', color: 'success' }))
    .with('interrupted', () => ({ text: '已中断', color: 'warning' }))
    .with('awaiting-question', () => ({ text: '需要回答', color: 'warning' }))
    .with('awaiting-tool-permission', () => ({ text: '请求授权', color: 'warning' }))
    .with('completed', () => ({ text: '已完成', color: 'success' }))
    .with('stopped', () => ({ text: '已停止', color: 'default' }))
    .with('error', () => ({ text: '出错', color: 'error' }))
    .with('idle', () => ({ text: '就绪', color: 'default' }))
    .exhaustive()

  return (
    <div
      className='flex h-full flex-col overflow-hidden'
      tabIndex={-1}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
          e.stopPropagation()
        }
      }}
      onPaste={(e) => {
        e.stopPropagation()
      }}
    >
      {/* Header */}
      <div className='flex items-center justify-between border-b border-[#45475a] px-3 py-2'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-semibold text-[#cdd6f4]'>{agentName}</span>
          <Tag color={statusColor} className='m-0 text-[10px]'>
            {statusText}
          </Tag>
          {totalTokens > 0 && (
            <Tag color='default' className='m-0 text-[10px]'>
              {formatTokenCount(totalTokens)} tokens
              {totalCost > 0 ? ` · ${formatTokenCost(totalCost)}` : ''}
            </Tag>
          )}
        </div>
        {canKillFlow && (
          <Tooltip title='停止工作流，不清空shareValues'>
            <Button
              size='small'
              danger
              type='text'
              icon={<StopOutlined />}
              onClick={() => killFlow(flowId)}
            />
          </Tooltip>
        )}
        <Button
          size='small'
          type='text'
          icon={<CloseOutlined />}
          onClick={onClose}
          className='ml-auto'
          style={{ color: '#6c7086' }}
        />
      </div>
      {/* Messages */}
      {match({
        length: sessions.length,
        phase,
        flowPhase,
      })
        .with(
          {
            phase: 'idle',
            flowPhase: P.not('starting'),
          },
          () => (
            <div className='flex flex-1 items-center justify-center px-3'>
              <Welcome
                variant='borderless'
                icon={<RobotOutlined style={{ fontSize: 28, color: '#a6adc8' }} />}
                title={agentName}
                description='暂无消息,发送一条消息以运行当前 Agent。'
              />
            </div>
          ),
        )
        .with({ length: 0 }, () => <Skeleton active className='flex-1 p-4' />)
        .otherwise(() => (
          <MessageList
            ref={messageListRef}
            sessions={sessions}
            ctx={ctx}
            loading={phase === 'running' || phase === 'starting'}
            onWheel={handleListWheel}
          />
        ))}

      {/* Pending AskUserQuestion — 固定在输入框上方,不随消息滚动;顶部 handle 可上下拖动调整高度 */}
      <AnimatePresence>
        {showCard && (
          <motion.div
            key={`ask-card-${mergedInput.toolUseIds.join('-')}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: cardHeight, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              dragging ? { duration: 0 } : { type: 'spring', damping: 24, stiffness: 240 }
            }
            className='flex shrink-0 flex-col overflow-hidden border-t border-[#45475a]'
          >
            <motion.div
              drag='y'
              dragMomentum={false}
              dragElastic={0}
              dragConstraints={{ top: 0, bottom: 0 }}
              onDragStart={() => setDragging(true)}
              onDrag={(_, info) => {
                setCardHeight((h) => Math.max(80, Math.min(600, h - info.delta.y)))
              }}
              onDragEnd={() => setDragging(false)}
              whileHover={{ backgroundColor: '#585b70' }}
              whileDrag={{ backgroundColor: '#74758a' }}
              className='flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-[#313244]'
            >
              <div className='h-0.5 w-8 rounded-full bg-[#6c7086]' />
            </motion.div>
            <div className='relative flex-1 overflow-auto px-3 py-2'>
              {/* pending ask_user_question fork icon —— 当前 session 的 pending,不弹 modal */}
              {pendingQuestions.length > 0 && (
                <Tooltip title='从此处 fork 出新工作流（保留当前问题）'>
                  <Button
                    size='small'
                    type='text'
                    icon={<BranchesOutlined />}
                    onClick={() =>
                      onForkRequest(
                        { kind: 'askUserQuestion', toolUseId: pendingQuestions[0].toolUseId },
                        false,
                      )
                    }
                    className='absolute top-1 right-1 z-10'
                    style={{ color: '#6c7086' }}
                  />
                </Tooltip>
              )}
              <AskUserQuestionCard
                input={mergedInput}
                mode='active'
                onSubmit={(output) => onActiveSubmit(mergedInput.toolUseIds[0], output)}
                onChangeHeight={(h) => {
                  setCardHeight(Math.max(80, Math.min(600, h)))
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
