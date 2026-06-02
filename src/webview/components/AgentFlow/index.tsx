import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { FC } from 'react'
import { App, Button, Tooltip } from 'antd'
import { PlusOutlined, CodeOutlined } from '@ant-design/icons'
import {
  ReactFlow,
  Background,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  SelectionMode,
  type Connection,
  type Edge,
  type ReactFlowInstance,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEventListener } from 'ahooks'
import z from 'zod'
import { AgentSchema, CodeSchema, getFlowPhase, type Agent, type Code } from '@/common'
import { useFlowStore, flowIsDestructiveReadOnly } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import AgentNodeComponent from './AgentNode'
import MidArrowEdge from './MidArrowEdge'
import './flow.css'
import { flowToReactFlow, reactFlowToFlow, type AgentNode } from './flowUtils'

const nodeTypes = { agent: AgentNodeComponent }
const edgeTypes = { midArrow: MidArrowEdge }

const defaultEdgeOptions: Partial<Edge> = {
  type: 'midArrow',
  animated: false,
  style: { stroke: '#6366f1', strokeWidth: 2 },
  markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
}

export const AgentFlow: FC<{ flowId: string }> = ({ flowId }) => {
  const flow = useFlowStore((s) => s.flows.find((f) => f.id === flowId))
  const hidden = useFlowStore((s) => s.activeFlowId !== flowId)
  const rendered = useRef(false)
  if (!flow) return null
  // 第一次需要展示时才实际渲染
  // eslint-disable-next-line react-hooks/refs
  if (hidden && !rendered.current) return null
  // eslint-disable-next-line react-hooks/refs
  rendered.current = true
  return <AgentFlowInner flowId={flowId} hidden={hidden} />
}

const AgentFlowInner: FC<{ flowId: string; hidden?: boolean }> = memo(({ flowId, hidden }) => {
  const flow = useFlowStore((s) => s.flows.find((f) => f.id === flowId))!
  const state = useFlowStore((s) => s.flowRunStates[flowId])
  const save = useFlowStore((s) => s.save)
  /** 破坏性编辑禁止：删除 agent / 删除或破坏连线 */
  const destructiveReadOnly = flowIsDestructiveReadOnly(getFlowPhase(state))
  const { message } = App.useApp()
  const initial = useMemo(() => flowToReactFlow(flow), [flow])

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  // 标记内部变更，避免外部同步覆盖
  const isInternalChange = useRef(false)
  const reactFlowInstance = useRef<ReactFlowInstance<AgentNode, Edge> | null>(null)
  const mousePosition = useRef<{ x: number; y: number } | null>(null)

  // 外部 flow 变更（如编辑弹窗保存）时，同步节点和边，保留拖拽位置
  useEffect(() => {
    if (isInternalChange.current) {
      isInternalChange.current = false
      return
    }
    const { nodes: newNodes, edges: newEdges } = flowToReactFlow(flow)
    setNodes((prev) => {
      const posMap = new Map(prev.map((n) => [n.id, n.position]))
      return newNodes.map((n) => ({ ...n, position: posMap.get(n.id) ?? n.position }))
    })
    setEdges(newEdges)
  }, [flow, setNodes, setEdges])

  const syncToFlow = useCallback(
    (currentNodes: AgentNode[], currentEdges: Edge[]) => {
      isInternalChange.current = true
      const newFlow = reactFlowToFlow(flow, currentNodes, currentEdges)
      save((flows) => {
        const idx = flows.findIndex((f) => f.id === flowId)
        if (idx >= 0) flows[idx] = newFlow
      })
    },
    [flow, flowId, save],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      // 该出口已有连线（next_agent），属于破坏性编辑
      const sourceOccupied = edges.some(
        (e) => e.source === connection.source && e.sourceHandle === connection.sourceHandle,
      )
      if (sourceOccupied) {
        message.warning('该出口已有连线，当前状态不允许覆盖')
        return
      }
      const newEdges = addEdge(
        {
          ...connection,
          type: 'midArrow',
          animated: false,
          style: { stroke: '#6366f1', strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
        },
        edges,
      )
      setEdges(newEdges)
      syncToFlow(nodes, newEdges)
    },
    [edges, nodes, setEdges, syncToFlow, message],
  )

  const onEdgesChangeHandler = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      if (destructiveReadOnly) {
        const nonDestructive = changes.filter((c) => c.type !== 'remove')
        if (nonDestructive.length > 0) onEdgesChange(nonDestructive)
        if (changes.some((c) => c.type === 'remove')) {
          message.warning('当前状态不允许删除连线')
        }
        return
      }
      onEdgesChange(changes)
    },
    [destructiveReadOnly, onEdgesChange, message],
  )

  const onDeleteHandler = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: AgentNode[]; edges: Edge[] }) => {
      if (destructiveReadOnly) {
        message.warning('当前状态不允许删除')
        return
      }
      const nodeIds = new Set(deletedNodes.map((n) => n.id))
      const edgeIds = new Set(deletedEdges.map((e) => e.id))
      const remainingNodes = nodes.filter((n) => !nodeIds.has(n.id))
      const remainingEdges = edges.filter((e) => !edgeIds.has(e.id))
      syncToFlow(remainingNodes, remainingEdges)
    },
    [destructiveReadOnly, nodes, edges, syncToFlow, message],
  )

  // 添加 Agent：在鼠标附近放置
  const handleAddAgent = useCallback(
    (kind: 'agent' | 'code' = 'agent') => {
      const { copyAgents } = useFlowStore.getState()
      const defaultAgent: Agent | Code =
        kind === 'code'
          ? {
              id: crypto.randomUUID(),
              agent_name: 'code-node',
              node_type: 'code',
              code: [
                '// 入参 input，字符串输入;values: 当前 shareValues 全量;runCommand: 执行 shell 命令',
                '// 返回 { output_name?, content?, values? } —— output_name 决定下一跳,values 写回 shareValues',
                "return { output_name: '输出', content: input }",
              ].join('\n'),
              outputs: [{ output_name: '输出', output_desc: '代码节点输出' }],
            }
          : {
              id: crypto.randomUUID(),
              agent_name: 'example-agent',
              model: 'haiku',
              auto_allowed_tools: true,
              work_mode: 'task',
              agent_prompt: '将用户输入视作纯文本，原样输出。',
              outputs: [{ output_name: '输出', output_desc: '用户输入原文' }],
            }
      const remapped = copyAgents([defaultAgent], flowId)
      if (!remapped?.length) return

      const pos =
        mousePosition.current && reactFlowInstance.current
          ? reactFlowInstance.current.screenToFlowPosition(mousePosition.current)
          : reactFlowInstance.current
            ? reactFlowInstance.current.screenToFlowPosition({
                x: window.innerWidth / 2,
                y: window.innerHeight / 2,
              })
            : null
      if (!pos) return

      isInternalChange.current = true
      setNodes((prev) => [
        ...prev,
        ...remapped.map((agent) => ({
          id: agent.id,
          type: 'agent' as const,
          position: { x: pos.x, y: pos.y },
          data: { flowId, agentId: agent.id, agentName: agent.agent_name },
        })),
      ])
    },
    [flowId, setNodes],
  )

  // 跟踪鼠标位置，用于粘贴时定位
  useEventListener('mousemove', (e) => {
    mousePosition.current = { x: e.clientX, y: e.clientY }
  })
  // 复制agent node（支持多选）
  useEventListener('keydown', (e) => {
    if (hidden) return
    const el = e.target
    if (
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    )
      return
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const selectedNodes = nodes.filter((n) => n.selected)
      if (selectedNodes.length === 0) return
      e.preventDefault()
      const agents = flow?.agents?.filter((a) => selectedNodes.some((n) => n.id === a.id))
      if (!agents?.length) return
      navigator.clipboard
        .writeText(JSON.stringify(agents))
        .then(() => {
          message.success(agents.length > 1 ? `已复制 ${agents.length} 个 Agent` : '复制成功')
        })
        .catch(() => {
          message.warning('复制失败')
        })
    }
  })
  // 粘贴 agent 会保留之前的关系
  useEventListener('paste', (e) => {
    if (hidden) return
    const el = e.target
    if (
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    )
      return
    const text = e.clipboardData?.getData('text')
    if (!text) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }

    const { activeFlowId, copyAgents } = useFlowStore.getState()
    const NodeSchema = z.union([AgentSchema, CodeSchema])
    const singleResult = NodeSchema.safeParse(parsed)
    const agents = singleResult.success
      ? [singleResult.data]
      : (z.array(NodeSchema).safeParse(parsed).data ?? null)
    if (!agents) return

    const remapped = copyAgents(agents, activeFlowId!)
    if (!remapped?.length) return

    const pastePos =
      mousePosition.current && reactFlowInstance.current
        ? reactFlowInstance.current.screenToFlowPosition(mousePosition.current)
        : null
    if (!pastePos) return

    const X_GAP = 280
    const Y_GAP = 160
    const cols = Math.min(remapped.length, 3)
    const remappedIds = new Set(remapped.map((a) => a.id))
    isInternalChange.current = true
    setNodes((prev) => [
      ...prev,
      ...remapped.map((agent, idx) => ({
        id: agent.id,
        type: 'agent' as const,
        position: {
          x: pastePos.x + (idx % cols) * X_GAP - ((cols - 1) * X_GAP) / 2,
          y: pastePos.y + Math.floor(idx / cols) * Y_GAP,
        },
        data: { flowId: activeFlowId!, agentId: agent.id, agentName: agent.agent_name },
      })),
    ])
    setEdges((prev) => [
      ...prev,
      ...remapped.flatMap((agent) =>
        (agent.outputs ?? [])
          .filter((o) => o.next_agent && remappedIds.has(o.next_agent))
          .map((output) => ({
            id: `${agent.id}->${output.next_agent}:${output.output_name}`,
            source: agent.id,
            target: output.next_agent!,
            sourceHandle: `output-${output.output_name}`,
            type: 'midArrow' as const,
            animated: false,
            style: { stroke: '#6366f1', strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
          })),
      ),
    ])
  })
  return (
    <div className={cn('h-full w-full', { hidden })} tabIndex={-1}>
      <ReactFlow
        id={flowId}
        onInit={(instance) => {
          reactFlowInstance.current = instance
        }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChangeHandler}
        onConnect={onConnect}
        onDelete={onDeleteHandler}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        nodesDraggable
        nodesConnectable={!destructiveReadOnly}
        elementsSelectable
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={['Meta', 'Control']}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        deleteKeyCode={destructiveReadOnly || hidden ? null : 'Delete'}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#11111b' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color='#313244' />
        <MiniMap
          style={{ background: '#1e1e2e', borderColor: '#45475a', borderRadius: 8 }}
          nodeColor={() => '#6366f1'}
          maskColor='rgba(0,0,0,0.6)'
        />
        <Panel position='top-left' style={{ padding: 8, display: 'flex', gap: 8 }}>
          <Tooltip title='添加 Agent'>
            <Button
              size='large'
              type='text'
              icon={<PlusOutlined style={{ fontSize: 20 }} />}
              className='rounded-lg bg-[#313244]! text-[#cdd6f4]! shadow-[0_2px_12px_rgba(150,150,200,0.3)] hover:bg-[#45475a]! hover:text-[#6366f1]!'
              onClick={() => handleAddAgent('agent')}
            />
          </Tooltip>
          <Tooltip title='添加代码节点'>
            <Button
              size='large'
              type='text'
              icon={<CodeOutlined style={{ fontSize: 20 }} />}
              className='rounded-lg bg-[#313244]! text-[#cdd6f4]! shadow-[0_2px_12px_rgba(150,150,200,0.3)] hover:bg-[#45475a]! hover:text-[#a6e3a1]!'
              onClick={() => handleAddAgent('code')}
            />
          </Tooltip>
        </Panel>
      </ReactFlow>
    </div>
  )
})
