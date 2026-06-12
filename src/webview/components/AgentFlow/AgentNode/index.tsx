import { memo, useState } from 'react'
import type { CSSProperties, FC, MouseEvent } from 'react'
import { Badge, Input, Tag, Tooltip, Typography } from 'antd'
import {
  BellOutlined,
  CodeOutlined,
  CommentOutlined,
  DisconnectOutlined,
  EditOutlined,
  LoginOutlined,
  LogoutOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { match } from 'ts-pattern'
import { type Agent, type Code } from '@/common'
import { useSilentTaskModeNotification } from '@/webview/hooks/useSilentTaskModeNotification'
import { useStartFlow } from '@/webview/hooks/useStartFlow'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import { CopyButton } from '../../text-components'
import type { AgentNode } from '../flowUtils'
import { ModelEditor } from './ModelEditor'

const handleStyle: CSSProperties = {
  height: 14,
  width: 14,
  border: '4px solid #6366f1',
  background: '#6366f1',
}

const AgentNodeInner: FC<NodeProps<AgentNode>> = (props) => {
  const { data } = props
  const { flowId, agentId, agentName, noPredecessors } = data

  const flow = useFlowStore((s) => s.flows.find((f) => f.id === flowId))
  const agent: Agent | Code | undefined = flow?.agents?.find((a) => a.id === agentId)
  const startFlow = useStartFlow()
  const notifySilentMode = useSilentTaskModeNotification()

  // 用户当前关注的 agent —— runs 末位 agent。
  // completed 且已流转到下一个 agent 时,reducer 已立刻把新 run 追加到末位,
  // 该 agent 自然不在末位,无需单独排除;completed 但是 flow 末端(没有 next_agent)
  // 时仍在末位,用户要看最终结果,保持高亮。
  const isAgentActive = useFlowStore(
    (s) => s.flowRunStates[flowId]?.runs.at(-1)?.agentId === agentId,
  )
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  const commitEdit = () => {
    const trimmed = editValue.trim()
    if (trimmed) {
      useFlowStore.getState().save((flows) => {
        const f = flows.find((f) => f.id === flowId)
        const a = f?.agents?.find((a) => a.id === agentId)
        if (!a) return
        a.agent_name = editValue
      })
    }
    setIsEditing(false)
  }

  const createToggler =
    (field: string, agentOnly = false) =>
    (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation()
      useFlowStore.getState().save((flows) => {
        const f = flows.find((f) => f.id === flowId)
        const a = f?.agents?.find((a) => a.id === agentId)
        if (!a) return
        if (agentOnly && a.node_type === 'code') return
        ;(a as any)[field] = !(a as any)[field]
      })
    }

  const isCodeNode = agent?.node_type === 'code'
  const outputs = agent?.outputs ?? []

  return (
    <>
      <div
        className={cn(
          'max-w-60 min-w-45 rounded-[10px] border border-[#45475a] bg-[#1e1e2e] p-0 text-[13px] shadow-[0_4px_16px_rgba(0,0,0,0.3)] transition-[box-shadow,border-color] duration-200 hover:border-[#6366f1] hover:shadow-[0_4px_24px_rgba(99,102,241,0.25)]',
          isAgentActive && 'agent-node-running border-[#a6e3a1]',
        )}
      >
        {/* target handle：只接受连线，不允许从此拖出连线 */}
        <Tooltip title={agent?.no_input ? '无输入' : '接受输入'}>
          <Handle
            type='target'
            position={Position.Left}
            id='input'
            isConnectableStart={false}
            style={{
              ...handleStyle,
              left: -8,
              cursor: 'pointer',
              pointerEvents: 'all',
              ...(agent?.no_input ? { background: 'transparent' } : {}),
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={createToggler('no_input')}
          />
        </Tooltip>

        {/* 头部 */}
        <div
          className='flex items-center gap-1.5 rounded-t-[10px] border-b border-[#313244] px-3 py-2'
          style={{ background: 'linear-gradient(135deg, #313244, #1e1e2e)' }}
        >
          {(() => {
            const isEntry = agent?.is_entry || noPredecessors
            const icon = match({ isEntry, isCodeNode })
              .with({ isEntry: true }, () => <LoginOutlined className='text-[#a6e3a1]' />)
              .with({ isCodeNode: true }, () => <CodeOutlined className='text-[#94e2d5]' />)
              .otherwise(() => <RobotOutlined className='text-[#cba6f7]' />)
            if (noPredecessors) {
              return <span className='text-sm'>{icon}</span>
            }
            return (
              <Tooltip title={isEntry ? '取消入口' : '设为入口'}>
                <span className='cursor-pointer text-sm' onClick={createToggler('is_entry')}>
                  {icon}
                </span>
              </Tooltip>
            )
          })()}
          {isEditing ? (
            <Input
              autoFocus
              size='small'
              value={editValue}
              className='nodrag nopan mr-auto h-5 min-w-0 flex-1 border-[#6366f1] bg-transparent px-1 text-xs font-semibold text-[#cdd6f4]'
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitEdit()
                }
                if (e.key === 'Escape') setIsEditing(false)
                e.stopPropagation()
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Typography.Text
              ellipsis
              className='m-0 mr-auto cursor-pointer overflow-hidden p-0 text-xs font-semibold text-[#cdd6f4]'
              onClick={(e) => {
                e.stopPropagation()
                setEditValue(agentName)
                setIsEditing(true)
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {agentName}
            </Typography.Text>
          )}
          <CopyButton text={() => JSON.stringify(agent, null, 2)} />
          <Badge dot={isAgentActive} offset={[-2, 2]}>
            <MessageOutlined
              className='mb-0.5 text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'
              onClick={() => {
                const { chatDrawer, openChatDrawer, closeChatDrawer } = useFlowStore.getState()
                if (chatDrawer?.flowId === flowId && chatDrawer?.agentId === agentId) {
                  closeChatDrawer()
                } else {
                  openChatDrawer({ flowId, agentId })
                }
              }}
            />
          </Badge>
          <Tooltip title='直接启动'>
            <PlayCircleOutlined
              className='text-xs text-[#a6adc8] transition-colors hover:text-[#52c41a]'
              onClick={(e) => {
                e.stopPropagation()
                const { openChatDrawer } = useFlowStore.getState()
                openChatDrawer({ flowId, agentId })
                startFlow(flowId, agentId, {
                  type: 'user',
                  message: {
                    role: 'user',
                    content: '执行任务',
                  },
                  parent_tool_use_id: null,
                })
              }}
            />
          </Tooltip>
          <EditOutlined
            className='text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'
            onClick={(e) => {
              e.stopPropagation()
              useFlowStore.getState().setEditingAgent({ flowId, agentId })
            }}
          />
        </div>

        {/* Agent 信息：code 节点显示标签,普通 agent 显示 model + plan_mode 快捷切换 */}

        <div className='flex h-6.5 items-center gap-1 px-3 py-1.5'>
          {match(agent)
            .with(undefined, () => null)
            .with({ node_type: 'code' }, () => <Tag color='cyan'>code</Tag>)
            .with({ node_type: 'agent' }, (agent) => {
              return (
                <>
                  <ModelEditor model={agent.model} flowId={flowId} agentId={agentId} />
                  <Tag
                    className={cn('w-9 cursor-pointer px-0.5 text-center transition')}
                    color={match(agent.effort ?? 'medium')
                      .with('xhigh', () => 'orange')
                      .with('max', () => 'red')
                      .otherwise(() => 'blue')}
                    onClick={(e) => {
                      e.stopPropagation()
                      useFlowStore.getState().save((flows) => {
                        const f = flows.find((f) => f.id === flowId)
                        const a = f?.agents?.find((a) => a.id === agentId)
                        if (!a || a.node_type !== 'agent') return
                        const order = ['low', 'medium', 'high', 'xhigh', 'max'] as const
                        const idx = a.effort ? order.indexOf(a.effort) : 0
                        a.effort = order[(idx + 1) % order.length]
                      })
                    }}
                  >
                    {match(agent.effort)
                      .with('low', () => 'low')
                      .with('medium', () => 'med')
                      .with('high', () => 'high')
                      .with('xhigh', () => 'xhigh')
                      .with('max', () => 'max')
                      .with(undefined, () => 'eff')
                      .exhaustive()}
                  </Tag>
                  <span className='ml-auto flex items-center gap-1'>
                    <Tooltip
                      title={match(agent.work_mode)
                        .with('task', () => '任务模式')
                        .with('chat', () => '对话模式')
                        .with('silent_task', () => '静默模式')
                        .exhaustive()}
                      mouseEnterDelay={0.5}
                    >
                      <span
                        className={cn(
                          'relative inline-flex cursor-pointer items-center text-[#89b4fa] hover:text-[#f9e2af]',
                        )}
                        onClick={(e) => {
                          e.stopPropagation()
                          useFlowStore.getState().save((flows) => {
                            const f = flows.find((f) => f.id === flowId)
                            const a = f?.agents?.find((a) => a.id === agentId)
                            if (!a || a.node_type !== 'agent') return
                            match(a.work_mode)
                              .with('task', () => {
                                a.work_mode = 'silent_task'
                                notifySilentMode()
                              })
                              .with('silent_task', () => {
                                a.work_mode = 'chat'
                              })
                              .with('chat', () => {
                                a.work_mode = 'task'
                              })
                              .exhaustive()
                          })
                        }}
                      >
                        {match(agent.work_mode)
                          .with('task', () => (
                            <ThunderboltOutlined className='text-xs transition-colors' />
                          ))
                          .with('chat', () => (
                            <CommentOutlined className='text-xs transition-colors' />
                          ))
                          .with('silent_task', () => (
                            <>
                              <BellOutlined className='text-xs transition-colors' />
                              <span className='absolute top-1/2 left-1/2 h-[0.9px] w-[1.1em] -translate-1/2 rotate-45 rounded bg-[currentColor] transition' />
                            </>
                          ))
                          .exhaustive()}
                      </span>
                    </Tooltip>
                    <Tooltip
                      title={agent?.isolation_mode ? '隔离模式' : '开启隔离模式'}
                      mouseEnterDelay={0.5}
                    >
                      <DisconnectOutlined
                        className={cn(
                          'cursor-pointer text-xs transition-colors hover:text-[#f9e2af]',
                          agent?.isolation_mode ? 'text-[#f38ba8]' : 'text-[#6c7086]',
                        )}
                        onClick={createToggler('isolation_mode', true)}
                      />
                    </Tooltip>
                    <Tooltip
                      title={agent?.plan_mode ? 'Plan 模式' : '开启 Plan 模式'}
                      mouseEnterDelay={0.5}
                    >
                      <span
                        className={cn(
                          'text-1 mb-0.5 cursor-pointer text-xs transition-colors hover:text-[#f9e2af]',
                          agent?.plan_mode ? 'text-[#89b4fa]' : 'text-[#6c7086]',
                        )}
                        onClick={createToggler('plan_mode', true)}
                      >
                        Plan
                      </span>
                    </Tooltip>
                    <Tooltip title={agent?.no_output ? '无输出' : '有输出'} mouseEnterDelay={0.5}>
                      <span
                        className={cn(
                          'relative inline-flex cursor-pointer items-center hover:text-[#f9e2af]',
                          agent?.no_output ? 'text-[#89b4fa]' : 'text-[#6c7086]',
                          {
                            invisible: agent.work_mode === 'chat',
                          },
                        )}
                        onClick={createToggler('no_output', true)}
                      >
                        <LogoutOutlined className={cn('text-[10px] transition-colors')} />
                        <span className='absolute top-1/2 left-1/2 h-[0.9px] w-[1.1em] -translate-1/2 rotate-45 rounded bg-[currentColor] transition' />
                      </span>
                    </Tooltip>
                  </span>
                </>
              )
            })
            .exhaustive()}
        </div>

        {/* 输出端口列表 */}
        {outputs.length > 0 && (
          <div className='flex flex-col gap-1 px-3 pb-2'>
            {outputs.map((output) => (
              <div
                key={output.output_name}
                className='relative flex items-center justify-between rounded bg-[#313244] px-1.5 py-0.5'
              >
                <Tooltip
                  title={output.output_desc || output.output_name}
                  placement='right'
                  mouseEnterDelay={0.5}
                >
                  <span className='overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-[#a5b4fc]'>
                    {output.output_name}
                  </span>
                </Tooltip>
                <Tooltip
                  title={match({
                    node_type: agent?.node_type,
                    require_confirm: output.require_confirm,
                  })
                    .with({ node_type: 'agent', require_confirm: true }, () => '需要确认')
                    .with({ node_type: 'agent' }, () => '无确认')
                    .otherwise(() => null)}
                  mouseEnterDelay={0.5}
                >
                  <Handle
                    type='source'
                    position={Position.Right}
                    id={`output-${output.output_name}`}
                    style={{
                      ...handleStyle,
                      right: -8,
                      cursor: 'pointer',
                      pointerEvents: 'all',
                      borderColor: '#6366f1',
                      ...(agent?.node_type === 'agent' && output.require_confirm
                        ? { background: '#d32029', borderColor: '#d32029' }
                        : {}),
                      ...(agent?.node_type === 'agent' && agent?.no_output
                        ? { background: 'transparent' }
                        : {}),
                    }}
                    onClick={() => {
                      if (agent?.node_type !== 'agent') return
                      useFlowStore.getState().save((flows) => {
                        const f = flows.find((f) => f.id === flowId)
                        const a = f?.agents?.find((a) => a.id === agentId)
                        const o = a?.outputs?.find((o) => o.output_name === output.output_name)
                        if (!o) return
                        o.require_confirm = !o.require_confirm
                      })
                    }}
                  />
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

const AgentNodeComponent = memo(AgentNodeInner)
export default AgentNodeComponent
