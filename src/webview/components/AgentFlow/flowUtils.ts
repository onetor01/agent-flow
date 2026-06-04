import { type Node, type Edge, MarkerType } from '@xyflow/react'
import { forceSimulation, forceLink, forceCollide, forceY } from 'd3-force'
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'
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

// ── Flow → ReactFlow 转换 ──────────────────────────────────────────────────

// ── 布局常量 ───────────────────────────────────────────────────────────────
// 节点宽度按 max-w-60 (240px) 估算
const NODE_WIDTH = 240
// 节点高度估算分段（与 AgentNode 样式保持一致）
const HEADER_H = 40
const MODEL_ROW_H = 28
const OUTPUT_ROW_H = 24
const OUTPUT_GAP = 4
const OUTPUT_BLOCK_PADDING = 14 // pt-1.5 + pb-2
// 相邻列之间的间距（x 方向，节点宽 + 留白）
const COLUMN_GAP = NODE_WIDTH + 140
// 同列最多节点数：入口 / 中间 / 出口三类各自按拓扑深度排序后，每 COLUMN_SIZE 个切为一列
const COLUMN_SIZE = 3
// 同列节点垂直最小间距（喂给 d3-force forceCollide）
const NODE_GAP = 32
// d3-force 静态布局迭代次数
const SIM_TICKS = 300

function estimateNodeHeight(agent: Agent | Code): number {
  let h = HEADER_H
  // code 节点没有 model 但显示 'code' 徽章;非 code 分支 agent 已收窄,可直接读 model
  if (agent.node_type === 'code' || agent.model) h += MODEL_ROW_H
  const n = agent.outputs?.length ?? 0
  if (n > 0) h += OUTPUT_BLOCK_PADDING + n * OUTPUT_ROW_H + (n - 1) * OUTPUT_GAP
  return h
}

/** 节点分类：入口（最左、优先级最高）/ 中间 / 出口（最右、优先级最低） */
type Category = 'entry' | 'middle' | 'exit'

/** d3-force 模拟节点：x 锁定为所在列（fx），y 由力模拟决定 */
type LayoutDatum = SimulationNodeDatum & {
  id: string
  height: number
  category: Category
  col: number
}

/**
 * 将 Flow 中的 Agent 列表布局为 ReactFlow 节点。
 *
 * 分两步：
 *  1) 按优先级把节点分为三类，每一类内部再切成若干列（col 决定 x，从左到右递增）：
 *     - entry 入口：is_entry=true 或没有前驱（入度为 0），优先级最高，排最左；
 *     - exit 出口：没有任何 output，或存在某个 output 无有效后继（任一终止分支即出口），
 *       优先级最低，排最右；is_entry 优先于出口判定；
 *     - middle 中间：有 output 且所有 output 都指向存在的节点。
 *     三类各自按「拓扑深度（距入口的最短跳数）」排序，再每 COLUMN_SIZE 个节点切为一列；
 *     列序为 entry 列组 → middle 列组 → exit 列组。
 *     列内按「前驱越少越靠上、前驱相同则后继越多越靠下」给初始 y。
 *  2) 用 d3-force 排列 y：fx 锁定 x 到所在列，forceLink 把相连节点在 y 上拉近以减少连线交叉，
 *     forceCollide 按节点半高防止同列重叠，forceY 轻微回中防整体漂移。
 *
 * d3-force 力模拟天然处理分叉与环（环上节点互相吸引、collide 排斥），无需特殊去环。
 * 最后把模拟中心坐标转换为 ReactFlow 左上角坐标 (x - NODE_WIDTH/2, y - height/2)。
 */
function agentsToNodes(flowId: string, agents: (Agent | Code)[]): AgentNode[] {
  if (agents.length === 0) return []

  const agentMap = new Map(agents.map((a) => [a.id, a]))

  // 入度 / 出度（排除自环），并收集力模拟用的边
  const inDeg = new Map<string, number>(agents.map((a) => [a.id, 0]))
  const outDeg = new Map<string, number>(agents.map((a) => [a.id, 0]))
  const links: SimulationLinkDatum<LayoutDatum>[] = []
  for (const a of agents) {
    for (const o of a.outputs ?? []) {
      if (!o.next_agent || !agentMap.has(o.next_agent) || o.next_agent === a.id) continue
      outDeg.set(a.id, (outDeg.get(a.id) ?? 0) + 1)
      inDeg.set(o.next_agent, (inDeg.get(o.next_agent) ?? 0) + 1)
      links.push({ source: a.id, target: o.next_agent })
    }
  }

  // 邻接表（仅含有效边），用于多源 BFS 求拓扑深度
  const adj = new Map<string, string[]>(agents.map((a) => [a.id, []]))
  for (const l of links) adj.get(l.source as string)!.push(l.target as string)

  // 分类：entry 优先级最高（最左）、exit 最低（最右）、middle 居中；is_entry 优先于出口判定
  // 出口判定额外条件：若某 output 指向 is_entry 节点，则该节点也被视作出口（回环到入口层）
  const categoryOf = (a: Agent | Code): Category => {
    if (a.is_entry || (inDeg.get(a.id) ?? 0) === 0) return 'entry'
    const outs = a.outputs ?? []
    const allHaveSuccessor =
      outs.length > 0 &&
      outs.every(
        (o) => o.next_agent && agentMap.has(o.next_agent) && !agentMap.get(o.next_agent)!.is_entry,
      )
    return allHaveSuccessor ? 'middle' : 'exit'
  }

  // 拓扑深度：从所有 entry 节点多源 BFS 的最短跳数；环中不可达节点取最大深度排到末尾
  const depth = new Map<string, number>()
  let frontier = agents.filter((a) => categoryOf(a) === 'entry').map((a) => a.id)
  for (const id of frontier) depth.set(id, 0)
  while (frontier.length > 0) {
    const next: string[] = []
    for (const u of frontier) {
      const du = depth.get(u)!
      for (const v of adj.get(u) ?? []) {
        if (!depth.has(v)) {
          depth.set(v, du + 1)
          next.push(v)
        }
      }
    }
    frontier = next
  }
  const depthOf = (id: string) => depth.get(id) ?? Number.MAX_SAFE_INTEGER

  const data: LayoutDatum[] = agents.map((a) => ({
    id: a.id,
    height: estimateNodeHeight(a),
    category: categoryOf(a),
    col: 0,
  }))
  const dataById = new Map(data.map((d) => [d.id, d]))

  // 三类各自按拓扑深度排序后每 COLUMN_SIZE 个切为一列；列序 entry → middle → exit（x 递增）
  const CATEGORIES: Category[] = ['entry', 'middle', 'exit']
  let col = 0
  for (const cat of CATEGORIES) {
    const group = data.filter((d) => d.category === cat)
    // 拓扑深度越小越靠左列；同深度则前驱越少越靠上、前驱相同后继越多越靠下
    group.sort(
      (a, b) =>
        depthOf(a.id) - depthOf(b.id) ||
        (inDeg.get(a.id) ?? 0) - (inDeg.get(b.id) ?? 0) ||
        (outDeg.get(b.id) ?? 0) - (outDeg.get(a.id) ?? 0),
    )
    for (let i = 0; i < group.length; i += COLUMN_SIZE) {
      const colNodes = group.slice(i, i + COLUMN_SIZE)
      colNodes.forEach((d, j) => {
        d.col = col
        d.fx = col * COLUMN_GAP
        d.y = (j - (colNodes.length - 1) / 2) * (d.height + NODE_GAP)
      })
      col++
    }
  }

  // d3-force 静态布局：x 由 fx 锁定，只优化 y
  const sim = forceSimulation(data)
    .force(
      'link',
      forceLink<LayoutDatum, SimulationLinkDatum<LayoutDatum>>(links)
        .id((d) => d.id)
        .distance(0)
        .strength(0.08),
    )
    .force(
      'collide',
      forceCollide<LayoutDatum>()
        .radius((d) => d.height / 2 + NODE_GAP / 2)
        .strength(1),
    )
    .force('y', forceY<LayoutDatum>(0).strength(0.02))
    .stop()
  for (let i = 0; i < SIM_TICKS; i++) sim.tick()

  return agents.map((a) => {
    const d = dataById.get(a.id)!
    return {
      id: a.id,
      type: 'agent',
      // 模拟中心坐标 → ReactFlow 左上角坐标
      position: { x: (d.x ?? 0) - NODE_WIDTH / 2, y: (d.y ?? 0) - d.height / 2 },
      data: {
        flowId,
        agentId: a.id,
        agentName: a.agent_name,
        noPredecessors: (inDeg.get(a.id) ?? 0) === 0,
      },
    }
  })
}

/** 将 Flow 中 Agent 的 outputs 转换为 ReactFlow 边 */
function agentsToEdges(agents: (Agent | Code)[]): Edge[] {
  const edges: Edge[] = []
  for (const agent of agents) {
    for (const output of agent.outputs ?? []) {
      if (!output.next_agent) continue
      const edgeKey = `${agent.id}->${output.next_agent}:${output.output_name}`
      edges.push({
        id: edgeKey,
        source: agent.id,
        target: output.next_agent,
        sourceHandle: `output-${output.output_name}`,
        type: 'midArrow',
        animated: false,
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
  return {
    nodes: agentsToNodes(flow.id, agents),
    edges: agentsToEdges(agents),
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
