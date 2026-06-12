import { useCallback, useImperativeHandle, useMemo, useRef, useState, type FC } from 'react'
import { Button, Skeleton, Tag, Tooltip } from 'antd'
import { CloseOutlined, RobotOutlined, SendOutlined, StopOutlined } from '@ant-design/icons'
import { Welcome } from '@ant-design/x'
import { AnimatePresence, motion } from 'motion/react'
import { match, P } from 'ts-pattern'
import type { AskUserQuestionInput, AskUserQuestionOutput, PendingToolPermission } from '@/common'
import {
  formatTokenCount,
  formatTokenCost,
  getAgentPhase,
  getFlowPhase,
  getPendingToolPermissionsFor,
  getRunPhase,
} from '@/common'
import type { AgentRun } from '@/webview/store/flow'
import { useFlowStore, flowCanBeKilled, type AgentPhase } from '@/webview/store/flow'
import { postMessageToExtension } from '@/webview/utils'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { MessageList, type MessageListRef } from './MessageList'
import { ToolPermissionCard } from './ToolPermissionCard'

// 模块级常量 —— useMemo 在「无 pending」时返回稳定空数组,避免新引用触发上层 effect。
const EMPTY_PENDING_TOOL_PERMS: PendingToolPermission[] = []

export type ChatPanelRef = {
  forceScrollToBottom: () => void
}

type Props = {
  flowId: string
  agentId: string
  /**
   * 单 run 视图模式:仅展示该 runId 的消息,phase / pendings 也限定到这一条 run。
   * 不传则按 agentId 视图,展示该 agent 全部 runs 的拼接(原有行为)。
   */
  runId?: string
  /**
   * Token / cost 累计口径。默认 'flow' = 跨 Flow 全部 runs(原有行为);
   * 'view' = 跟随当前视图(runId 视图 = 单 run;agentId 视图 = 该 agent 全部 runs)。
   */
  tokenMode?: 'flow' | 'view'
  onClose?: () => void
  /** 快捷按钮点击时调用,参数与 ChatDrawer.onSend 同签名 */
  onSend?: (content: string) => Promise<boolean>
  ref?: React.Ref<ChatPanelRef>
}

export const ChatPanel: FC<Props> = ({
  flowId,
  agentId,
  runId,
  tokenMode = 'flow',
  onClose,
  onSend,
  ref,
}) => {
  const killFlow = useFlowStore((s) => s.killFlow)
  const answerToolPermission = useFlowStore((s) => s.answerToolPermission)

  const agentName = useFlowStore(
    (s) =>
      s.flows.find((f) => f.id === flowId)?.agents?.find((a) => a.id === agentId)?.agent_name ?? '',
  )

  // runId 视图:phase 用 getRunPhase 限定到单 run;agentId 视图:跨该 agent 全部 run 聚合
  const phase = useFlowStore((s): AgentPhase => {
    const fs = s.flowRunStates[flowId]
    if (runId) {
      const r = fs?.runs.find((r) => r.runId === runId)
      if (!r || !fs) return 'idle'
      return getRunPhase(r, fs)
    }
    return getAgentPhase(fs, agentId)
  })
  const flowPhase = useFlowStore((s) => getFlowPhase(s.flowRunStates[flowId]))
  // pendingToolPerms 给状态标签 / loading / 底部 AskUserQuestionCard 用;ctx / answered* 在 MessageList。
  // selector 必须返回稳定引用,否则 useSyncExternalStore 在 store 未变时仍因引用不同
  // 持续判定快照变化触发重渲染 → "Maximum update depth exceeded"。
  const fs = useFlowStore((s) => s.flowRunStates[flowId])
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
  // 底部固定 AskUserQuestionCard 只取 AskUserQuestion 类型的挂起项
  const pendingQuestions = useMemo(
    () => pendingToolPerms.filter((p) => p.toolName.includes('AskUserQuestion')),
    [pendingToolPerms],
  )
  // 底部固定工具权限卡片：排除 AskUserQuestion 与 CompleteTask（后者有专属确认卡片）
  const pendingPermCards = useMemo(
    () =>
      pendingToolPerms.filter(
        (p) => !p.toolName.includes('AskUserQuestion') && !p.toolName.includes('CompleteTask'),
      ),
    [pendingToolPerms],
  )
  const allRuns = useFlowStore((s) => s.flowRunStates[flowId]?.runs)
  // runs:仅本组件 token 统计 + Welcome / Skeleton 长度判断用;消息渲染由 MessageList 自己派生
  const runs = useMemo<AgentRun[]>(() => {
    if (!allRuns) return []
    if (runId) {
      const r = allRuns.find((r) => r.runId === runId)
      return r ? [r] : []
    }
    return allRuns.filter((r) => r.agentId === agentId)
  }, [allRuns, agentId, runId])

  // Token / cost 累计:tokenMode = 'flow' 跨 Flow 全部 runs;'view' 用当前视图选出的 runs。
  // 新累加态模型把 session 累计快照存进 run.acc:prevModelUsage(最后一条 result 的 modelUsage 累计,
  // per model)/ lastTotalCost(最后一条 result 的 total_cost_usd),直接读取再跨 run 相加。
  // tokens 含 4 字段 (input + output + cacheCreation + cacheRead),与 turn_end / agent_complete 口径一致。
  const tokenSourceRuns = tokenMode === 'view' ? runs : allRuns
  const { totalTokens, totalCost } = useMemo(() => {
    if (!tokenSourceRuns) return { totalTokens: 0, totalCost: 0 }
    let totalTokens = 0
    let totalCost = 0
    for (const run of tokenSourceRuns) {
      for (const u of Object.values(run.acc.prevModelUsage)) {
        totalTokens +=
          u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens
      }
      totalCost += run.acc.lastTotalCost
    }
    return { totalTokens, totalCost }
  }, [tokenSourceRuns])

  const canKillFlow = flowCanBeKilled(flowPhase)

  // AskUserQuestionCard 容器高度,用户可上下拖动调整
  const [cardHeight, setCardHeight] = useState(240)
  const [dragging, setDragging] = useState(false)

  // 工具权限卡片容器高度
  const [permCardHeight, setPermCardHeight] = useState(240)
  const [permDragging, setPermDragging] = useState(false)

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
      for (const q of (pq.input as AskUserQuestionInput).questions ?? []) {
        allQuestions.push(q)
      }
    }
    return { questions: allQuestions, toolUseIds }
  }, [pendingQuestions])

  const showCard = mergedInput.questions.length > 0

  const messageListRef = useRef<MessageListRef>(null)
  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom()
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
        const questions = (pq.input as AskUserQuestionInput).questions ?? []
        const pqAnswers: Record<string, string> = {}
        for (const q of questions) {
          const ans = answersPerQuestion[q.question] ?? []
          pqAnswers[q.question] = ans.join('\x1F')
        }
        // AskUserQuestion 回答 = allow + updatedInput={questions,answers}
        answerToolPermission(flowId, pq.runId, pq.toolUseId, true, {
          updatedInput: { questions, answers: pqAnswers },
        })
      }

      scrollToBottom()
    },
    [answerToolPermission, flowId, pendingQuestions, scrollToBottom],
  )

  useImperativeHandle(
    ref,
    () => ({
      forceScrollToBottom: () => {
        scrollToBottom()
      },
    }),
    [scrollToBottom],
  )

  const onViewPlan = useCallback((planFilePath: string) => {
    postMessageToExtension({
      type: 'openFile',
      data: { filename: planFilePath, placement: 'active' },
    })
  }, [])

  const onPermAllow = useCallback(
    (perm: PendingToolPermission) => {
      answerToolPermission(flowId, perm.runId, perm.toolUseId, true)
    },
    [answerToolPermission, flowId],
  )

  const onPermDeny = useCallback(
    (perm: PendingToolPermission, reason?: string) => {
      answerToolPermission(
        flowId,
        perm.runId,
        perm.toolUseId,
        false,
        reason ? { message: reason } : undefined,
      )
    },
    [answerToolPermission, flowId],
  )

  // awaiting-tool-permission 标签按本视图首个 pending 的 toolName 分流(.includes)
  const firstPendingToolName = pendingToolPerms[0]?.toolName
  const toolPermStatusLabel = (): string => {
    if (firstPendingToolName?.includes('AskUserQuestion')) return '需要回答'
    if (firstPendingToolName?.includes('CompleteTask')) return '等待完成确认'
    if (firstPendingToolName?.includes('ExitPlanMode')) return '计划等待确认'
    return '请求授权'
  }
  const { text: statusText, color: statusColor } = match<
    AgentPhase,
    { text: string; color: 'processing' | 'warning' | 'default' | 'success' | 'error' }
  >(phase)
    .with('starting', () => ({ text: '启动中', color: 'processing' }))
    .with('running', () => ({ text: '生成中', color: 'processing' }))
    .with('result', () => ({ text: '生成完毕', color: 'success' }))
    .with('interrupted', () => ({ text: '已中断', color: 'warning' }))
    .with('awaiting-tool-permission', () => ({ text: toolPermStatusLabel(), color: 'warning' }))
    .with('completed', () => ({ text: '已完成', color: 'success' }))
    .with('stopped', () => ({ text: '已停止', color: 'default' }))
    .with('error', () => ({ text: '出错', color: 'error' }))
    .with('idle', () => ({ text: '就绪', color: 'default' }))
    .exhaustive()

  return (
    <div
      className='relative flex h-full flex-col overflow-hidden'
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
        length: runs.length,
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
            flowId={flowId}
            agentId={agentId}
            runId={runId}
            loading={
              phase === 'running' ||
              phase === 'starting' ||
              (phase === 'awaiting-tool-permission' &&
                !!firstPendingToolName?.includes('CompleteTask'))
            }
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

      {/* 工具权限卡片 — 固定在底部；ExitPlanMode / must_confirm 类挂起时展示 */}
      <AnimatePresence>
        {pendingPermCards.length > 0 &&
          (() => {
            const perm = pendingPermCards[0]
            const isExitPlan = perm.toolName.includes('ExitPlanMode')
            const planFilePath = isExitPlan
              ? ((perm.input as { planFilePath?: string })?.planFilePath ?? '')
              : ''
            return (
              <motion.div
                key={`perm-card-${perm.toolUseId}`}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: permCardHeight, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={
                  permDragging ? { duration: 0 } : { type: 'spring', damping: 24, stiffness: 240 }
                }
                className='flex shrink-0 flex-col overflow-hidden border-t border-[#45475a]'
              >
                <motion.div
                  drag='y'
                  dragMomentum={false}
                  dragElastic={0}
                  dragConstraints={{ top: 0, bottom: 0 }}
                  onDragStart={() => setPermDragging(true)}
                  onDrag={(_, info) => {
                    setPermCardHeight((h) => Math.max(80, Math.min(600, h - info.delta.y)))
                  }}
                  onDragEnd={() => setPermDragging(false)}
                  whileHover={{ backgroundColor: '#585b70' }}
                  whileDrag={{ backgroundColor: '#74758a' }}
                  className='flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-[#313244]'
                >
                  <div className='h-0.5 w-8 rounded-full bg-[#6c7086]' />
                </motion.div>
                <div className='relative flex-1 overflow-auto px-3 py-2'>
                  <ToolPermissionCard
                    toolName={perm.toolName}
                    input={perm.input}
                    mode='active'
                    onAllow={() => onPermAllow(perm)}
                    onDeny={(reason) => onPermDeny(perm, reason)}
                    exitPlan={
                      isExitPlan
                        ? { planFilePath, onViewPlan: () => onViewPlan(planFilePath) }
                        : undefined
                    }
                    onChangeHeight={(h) => setPermCardHeight(Math.max(80, Math.min(600, h)))}
                  />
                </div>
              </motion.div>
            )
          })()}
      </AnimatePresence>

      {/* 快捷确认/继续悬浮按钮 —— phase=result 时显示"确认",interrupted 时显示"继续" */}
      {(phase === 'result' || phase === 'interrupted') && onSend && (
        <Button
          type='primary'
          size='small'
          className='absolute right-3 bottom-3 z-10 shadow-lg'
          icon={<SendOutlined rotate={-90} />}
          iconPlacement='end'
          onClick={() => {
            const text = phase === 'result' ? '确认' : '继续'
            onSend(text)
          }}
        >
          快捷回复:{phase === 'result' ? '确认' : '继续'}
        </Button>
      )}
    </div>
  )
}
