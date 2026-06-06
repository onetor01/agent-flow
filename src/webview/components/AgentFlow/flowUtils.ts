import { type Node, type Edge, MarkerType } from '@xyflow/react'
import * as dagre from '@dagrejs/dagre'
import type { Agent, Code, Flow } from '@/common'

// ── Node / Edge 数据类型 ────────────────────────────────────────────────────

/** Agent 节点携带的额外数据（其他数据通过 FlowStore 获取） */
export type AgentNodeData = {
  flowId: string
  agentId: string
  agentName: string
  /** 入度为 0（无前驱）：布局视作入口层，AgentNode 同 is_entry 显示入口图标 */
  noPredecessors: boolean
}

/** Agent 节点类型 */
export type AgentNode = Node<AgentNodeData, 'agent'>

/** 回环边在 edge.data 上的标记，供 MidArrowEdge 决定是否走上方绕行 */
export type LoopEdgeData = {
  /** target 不在 source 右侧（回指上游）：走上方拱形绕行而非穿过中间节点 */
  isLoop: boolean
  /** 多条回环边的序号，用于错开绕行拱高，避免重叠 */
  loopIndex: number
}

// ── 布局常量 ───────────────────────────────────────────────────────────────
// 节点宽度按 max-w-60 (240px) 估算
const NODE_WIDTH = 240
// 节点高度估算分段（与 AgentNode 样式保持一致）
const HEADER_H = 40
const MODEL_ROW_H = 28
const OUTPUT_ROW_H = 24
const OUTPUT_GAP = 4
const OUTPUT_BLOCK_PADDING = 14 // pt-1.5 + pb-2
// 列中心间距：入口列之间、dagre 相邻 rank 的中心距都按此换算（ranksep = 本值 - 节点宽）
const COLUMN_GAP = NODE_WIDTH + 140
// 入口节点同列最多个数：超过则向右再开一列竖排
const COLUMN_SIZE = 3
// 同列节点垂直最小间距（dagre nodesep / 入口列竖排间距）
const NODE_GAP = 32

function estimateNodeHeight(agent: Agent | Code): number {
  let h = HEADER_H
  // code 节点没有 model 但显示 'code' 徽章;非 code 分支 agent 已收窄,可直接读 model
  if (agent.node_type === 'code' || agent.model) h += MODEL_ROW_H
  const n = agent.outputs?.length ?? 0
  if (n > 0) h += OUTPUT_BLOCK_PADDING + n * OUTPUT_ROW_H + (n - 1) * OUTPUT_GAP
  return h
}

/** 节点中心坐标 */
type Center = { x: number; y: number }

/**
 * 回环边判定：source / target 在同一坐标系下的 x 比较（所有节点等宽，传中心 x 或左上角 x 均可）。
 * target 不在 source 右侧（x 不更大）即为回指边，需走上方绕行而非穿过中间节点。
 */
export function isBackEdge(sourceX: number, targetX: number): boolean {
  return targetX <= sourceX
}

/** 入度（排除自环与指向不存在节点的无效边） */
function computeInDegree(agents: (Agent | Code)[]): Map<string, number> {
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const inDeg = new Map<string, number>(agents.map((a) => [a.id, 0]))
  for (const a of agents) {
    for (const o of a.outputs ?? []) {
      if (!o.next_agent || !agentMap.has(o.next_agent) || o.next_agent === a.id) continue
      inDeg.set(o.next_agent, (inDeg.get(o.next_agent) ?? 0) + 1)
    }
  }
  return inDeg
}

/**
 * 计算每个节点的中心坐标。
 *
 *  1) 入口节点（is_entry=true 或入度 0）保持「每列最多 COLUMN_SIZE 个、竖排在最左」：
 *     按 agents 原序每 COLUMN_SIZE 个切一列，col 决定 x，列内竖排、中心 y 围绕 0。
 *  2) 其余节点交给 dagre（rankdir=LR）做有向图分层；dagre 内部自动去环，无需特殊处理。
 *     dagre 接收全部节点与全部有效边以保证分层正确，入口节点的 dagre 坐标被上面的
 *     「最左多列」覆盖，非入口节点整体右移到入口列右侧（shiftX），并把垂直中心对齐到 0。
 *
 * 返回中心坐标，调用方再转 ReactFlow 左上角坐标。
 */
function computeLayout(agents: (Agent | Code)[], inDeg: Map<string, number>): Map<string, Center> {
  const result = new Map<string, Center>()
  if (agents.length === 0) return result

  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const isEntry = (a: Agent | Code) => a.is_entry === true || (inDeg.get(a.id) ?? 0) === 0
  const entryAgents = agents.filter(isEntry)
  const entryIds = new Set(entryAgents.map((a) => a.id))
  const nonEntry = agents.filter((a) => !entryIds.has(a.id))

  // dagre 全图分层：节点尺寸喂真实估算高度，边为全部有效边（排除自环 / 无效目标）
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: 'LR',
    ranksep: COLUMN_GAP - NODE_WIDTH,
    nodesep: NODE_GAP,
    marginx: 0,
    marginy: 0,
  })
  g.setDefaultEdgeLabel(() => ({}))
  for (const a of agents) g.setNode(a.id, { width: NODE_WIDTH, height: estimateNodeHeight(a) })
  for (const a of agents) {
    for (const o of a.outputs ?? []) {
      if (!o.next_agent || !agentMap.has(o.next_agent) || o.next_agent === a.id) continue
      g.setEdge(a.id, o.next_agent)
    }
  }
  dagre.layout(g)

  // 入口节点：每列最多 COLUMN_SIZE 个竖排在最左，中心 y 围绕 0
  const entryColCount = Math.ceil(entryAgents.length / COLUMN_SIZE)
  entryAgents.forEach((a, i) => {
    const col = Math.floor(i / COLUMN_SIZE)
    const row = i % COLUMN_SIZE
    const colLen = Math.min(COLUMN_SIZE, entryAgents.length - col * COLUMN_SIZE)
    const h = estimateNodeHeight(a)
    result.set(a.id, {
      x: col * COLUMN_GAP,
      y: (row - (colLen - 1) / 2) * (h + NODE_GAP),
    })
  })

  // 非入口节点：dagre 坐标整体右移到入口列右侧，垂直中心对齐到 0
  if (nonEntry.length > 0) {
    const pts = nonEntry.map((a) => {
      const n = g.node(a.id)
      return { id: a.id, x: n?.x ?? 0, y: n?.y ?? 0 }
    })
    const minX = Math.min(...pts.map((p) => p.x))
    const ys = pts.map((p) => p.y)
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2
    // entryColCount 个入口列占据 col 0..entryColCount-1，非入口从下一列起始
    const shiftX = entryColCount * COLUMN_GAP - minX
    for (const p of pts) result.set(p.id, { x: p.x + shiftX, y: p.y - midY })
  }

  return result
}

/** 将 Flow 中的 Agent 列表布局为 ReactFlow 节点 */
function agentsToNodes(
  flowId: string,
  agents: (Agent | Code)[],
  layout: Map<string, Center>,
  inDeg: Map<string, number>,
): AgentNode[] {
  return agents.map((a) => {
    const c = layout.get(a.id) ?? { x: 0, y: 0 }
    const h = estimateNodeHeight(a)
    return {
      id: a.id,
      type: 'agent',
      // 中心坐标 → ReactFlow 左上角坐标
      position: { x: c.x - NODE_WIDTH / 2, y: c.y - h / 2 },
      data: {
        flowId,
        agentId: a.id,
        agentName: a.agent_name,
        noPredecessors: (inDeg.get(a.id) ?? 0) === 0,
      },
    }
  })
}

/** 将 Flow 中 Agent 的 outputs 转换为 ReactFlow 边；按布局结果标记回环边供 MidArrowEdge 绕行 */
function agentsToEdges(agents: (Agent | Code)[], layout: Map<string, Center>): Edge[] {
  const edges: Edge[] = []
  let loopIndex = 0
  for (const agent of agents) {
    const srcX = layout.get(agent.id)?.x ?? 0
    for (const output of agent.outputs ?? []) {
      if (!output.next_agent) continue
      const tgtX = layout.get(output.next_agent)?.x ?? 0
      const loop = isBackEdge(srcX, tgtX)
      const edgeKey = `${agent.id}->${output.next_agent}:${output.output_name}`
      edges.push({
        id: edgeKey,
        source: agent.id,
        target: output.next_agent,
        sourceHandle: `output-${output.output_name}`,
        type: 'midArrow',
        animated: false,
        data: { isLoop: loop, loopIndex: loop ? loopIndex++ : 0 } satisfies LoopEdgeData,
        style: { stroke: '#6366f1', strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#6366f1',
          width: 20,
          height: 20,
        },
      })
    }
  }
  return edges
}

/** 将 Flow 转换为 ReactFlow 的节点和边 */
export function flowToReactFlow(flow: Flow): { nodes: AgentNode[]; edges: Edge[] } {
  const agents = flow.agents ?? []
  const inDeg = computeInDegree(agents)
  const layout = computeLayout(agents, inDeg)
  return {
    nodes: agentsToNodes(flow.id, agents, layout, inDeg),
    edges: agentsToEdges(agents, layout),
  }
}

// ── ReactFlow → Flow 转换 ──────────────────────────────────────────────────

/** 从 ReactFlow 的节点和边还原 Flow（保留 flow 上 agents 以外的所有字段） */
export function reactFlowToFlow(flow: Flow, nodes: AgentNode[], edges: Edge[]): Flow {
  const agents = flow.agents ?? []
  const agentMap = new Map<string, Agent | Code>()

  // 先把节点还原为 Agent，保留原始 outputs（清空 next_agent 以便从边重建）
  for (const node of nodes) {
    const originalAgent = agents.find((a) => a.id === node.id)
    agentMap.set(node.id, {
      ...(originalAgent ?? {
        id: node.id,
        agent_name: node.data.agentName,
        node_type: 'agent',
        model: 'sonnet',
        agent_prompt: '',
        work_mode: 'task' as const,
      }),
      agent_name: node.data.agentName,
      outputs: originalAgent?.outputs?.map((o) => ({ ...o, next_agent: undefined })) ?? [],
    })
  }

  // 从边还原 outputs 的 next_agent
  for (const edge of edges) {
    const sourceAgent = agentMap.get(edge.source)
    if (!sourceAgent) continue
    const outputName = edge.sourceHandle?.startsWith('output-')
      ? edge.sourceHandle.slice('output-'.length)
      : 'default'
    const existingOutput = sourceAgent.outputs?.find((o) => o.output_name === outputName)
    if (existingOutput) {
      existingOutput.next_agent = edge.target
    } else {
      // edge 引用了原始 agent 中不存在的 output，追加
      const originalAgent = agents.find((a) => a.id === edge.source)
      const originalOutput = originalAgent?.outputs?.find((o) => o.output_name === outputName)
      sourceAgent.outputs = sourceAgent.outputs ?? []
      sourceAgent.outputs.push({
        output_name: outputName,
        output_desc: originalOutput?.output_desc ?? '',
        next_agent: edge.target,
      })
    }
  }

  return {
    ...flow,
    agents: [...agentMap.values()],
  }
}
