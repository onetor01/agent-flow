import { memo } from 'react'
import type { CSSProperties, FC } from 'react'
import { App, Badge, Tag, Tooltip, Typography } from 'antd'
import {
  CodeOutlined,
  EditOutlined,
  LoginOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { match } from 'ts-pattern'
import { type Agent, type Code } from '@/common'
import { useStartFlow } from '@/webview/hooks/useStartFlow'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import { CopyButton } from '../../text-components'
import type { AgentNode } from '../flowUtils'

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
  const no_output = agent && 'no_output' in agent && agent.no_output

  const { message } = App.useApp()
  const startFlow = useStartFlow()

  // 用户当前关注的 agent —— runs 末位 agent。
  // completed 且已流转到下一个 agent 时,reducer 已立刻把新 run 追加到末位,
  // 该 agent 自然不在末位,无需单独排除;completed 但是 flow 末端(没有 next_agent)
  // 时仍在末位,用户要看最终结果,保持高亮。
  const isAgentActive = useFlowStore(
    (s) => s.flowRunStates[flowId]?.runs.at(-1)?.agentId === agentId,
  )
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
        <Handle
          type='target'
          position={Position.Left}
          id='input'
          isConnectableStart={false}
          style={{
            ...handleStyle,
            left: -8,
            ...(agent?.no_input ? { background: 'transparent' } : {}),
          }}
        />

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
                <span
                  className='cursor-pointer text-sm'
                  onClick={(e) => {
                    e.stopPropagation()
                    useFlowStore.getState().save((flows) => {
                      const f = flows.find((f) => f.id === flowId)
                      const a = f?.agents?.find((a) => a.id === agentId)
                      if (a) {
                        a.is_entry = !a.is_entry
                      }
                    })
                  }}
                >
                  {icon}
                </span>
              </Tooltip>
            )
          })()}
          <Typography.Text
            ellipsis
            className='m-0 mr-auto overflow-hidden p-0 text-xs font-semibold text-[#cdd6f4]'
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {agentName}
          </Typography.Text>
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
          {agent?.no_input && (
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
          )}
          <EditOutlined
            className='text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'
            onClick={(e) => {
              e.stopPropagation()
              useFlowStore.getState().setEditingAgent({ flowId, agentId })
            }}
          />
        </div>

        {/* Agent 信息：code 节点显示标签,普通 agent 显示 model + plan_mode 快捷切换 */}

        <div className='flex items-center gap-1 px-3 pt-1'>
          {isCodeNode ? (
            <Tag color='cyan' style={{ fontSize: 10 }}>
              code
            </Tag>
          ) : (
            <>
              {agent?.model ? (
                <Tag color='blue' style={{ fontSize: 10 }}>
                  {agent?.model}
                </Tag>
              ) : null}
              <Tooltip title={agent?.plan_mode ? '关闭 Plan 模式' : '开启 Plan 模式'}>
                <span
                  className={cn(
                    'ml-auto cursor-pointer text-xs transition-colors',
                    agent?.plan_mode ? 'text-[#f9e2af]' : 'text-[#6c7086] hover:text-[#f9e2af]',
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    useFlowStore.getState().save((flows) => {
                      const f = flows.find((f) => f.id === flowId)
                      const a = f?.agents?.find((a) => a.id === agentId)
                      if (a && (!a?.node_type || a?.node_type === 'agent')) {
                        a.plan_mode = !a.plan_mode
                      }
                    })
                  }}
                >
                  PLAN
                </span>
              </Tooltip>
            </>
          )}
        </div>

        {/* 输出端口列表 */}
        {outputs.length > 0 && (
          <div className='flex flex-col gap-1 px-3 pt-1.5 pb-2'>
            {outputs.map((output) => (
              <div
                key={output.output_name}
                className='relative flex items-center justify-between rounded bg-[#313244] px-1.5 py-0.5'
              >
                <Tooltip title={output.output_desc || output.output_name} placement='right'>
                  <span className='overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-[#a5b4fc]'>
                    {output.output_name}
                  </span>
                </Tooltip>
                <Handle
                  type='source'
                  position={Position.Right}
                  id={`output-${output.output_name}`}
                  style={{
                    ...handleStyle,
                    right: -8,
                    ...(output.require_confirm ? { background: 'red', borderColor: 'red' } : {}),
                    ...(no_output ? { background: 'transparent' } : {}),
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* 无输出时显示一个默认 source handle */}
        {outputs.length === 0 && (
          <Handle
            type='source'
            position={Position.Bottom}
            id='output-default'
            style={{ visibility: 'hidden' }}
          />
        )}
      </div>
    </>
  )
}

const AgentNodeComponent = memo(AgentNodeInner)
export default AgentNodeComponent
