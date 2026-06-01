import { type Node, type Edge, MarkerType } from '@xyflow/react'
import type { Agent, Code, Flow } from '@/common'

// ── Node / Edge 数据类型 ────────────────────────────────────────────────────

/** Agent 节点携带的额外数据（其他数据通过 FlowStore 获取） */
export type AgentNodeData = {
  flowId: string
  agentId: string
  agentName: string
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
// 层与层之间的水平间距
const LAYER_GAP = 120
// 同一层内节点之间的垂直间距
const SIBLING_GAP = 40

function estimateNodeHeight(agent: Agent | Code): number {
  let h = HEADER_H
  // code 节点没有 model 但显示 'code' 徽章;非 code 分支 agent 已收窄,可直接读 model
  if (agent.node_type === 'code' || agent.model) h += MODEL_ROW_H
  const n = agent.outputs?.length ?? 0
  if (n > 0) h += OUTPUT_BLOCK_PADDING + n * OUTPUT_ROW_H + (n - 1) * OUTPUT_GAP
  return h
}

/**
 * 将 Flow 中的 Agent 列表布局为 ReactFlow 节点。
 *
 * 算法：Sugiyama 风格的分层布局（左→右，与节点左右 handle 方向一致）
 *   1. 最长路径分层：入度为 0 的 agent 为源，沿 outputs 做一次前向松弛，
 *      level(v) = max(level(u)) + 1。环/孤点 fallback 到 level 0。
 *   2. 层内重心排序：按父节点在上一层中的平均下标排序，降低交叉。
 *   3. 高度感知垂直堆叠：每层按估算高度竖排，整层整体在 y=0 居中。
 */
function agentsToNodes(flowId: string, agents: (Agent | Code)[]): AgentNode[] {
  if (agents.length === 0) return []

  const agentMap = new Map(agents.map((a) => [a.id, a]))

  // 1) 分层：入度 + 最长路径松弛
  const inDegree = new Map<string, number>()
  const parents = new Map<string, string[]>()
  for (const a of agents) {
    inDegree.set(a.id, 0)
    parents.set(a.id, [])
  }
  for (const a of agents) {
    for (const o of a.outputs ?? []) {
      if (o.next_agent && agentMap.has(o.next_agent)) {
        inDegree.set(o.next_agent, (inDegree.get(o.next_agent) ?? 0) + 1)
        parents.get(o.next_agent)!.push(a.id)
      }
    }
  }

  const level = new Map<string, number>()
  const sources = agents.filter((a) => inDegree.get(a.id) === 0)
  const queue: string[] = sources.map((a) => a.id)
  for (const id of queue) level.set(id, 0)

  // 有环则无源，fallback：全部放 level 0
  const maxIter = agents.length * agents.length + 1
  let head = 0
  let iter = 0
  while (head < queue.length && iter++ < maxIter) {
    const id = queue[head++]
    const lv = level.get(id)!
    for (const o of agentMap.get(id)?.outputs ?? []) {
      if (!o.next_agent || !agentMap.has(o.next_agent)) continue
      const cur = level.get(o.next_agent) ?? -1
      if (lv + 1 > cur) {
        level.set(o.next_agent, lv + 1)
        queue.push(o.next_agent)
      }
    }
  }
  for (const a of agents) if (!level.has(a.id)) level.set(a.id, 0)

  // 压缩 level：环会导致松弛膨胀（同一节点被反复入队推高 level），
  // 将实际使用的 level 映射为连续整数以消除空隙。对 DAG 无影响。
  const uniqueLevels = [...new Set(level.values())].sort((a, b) => a - b)
  const compactMap = new Map(uniqueLevels.map((lv, idx) => [lv, idx]))
  for (const [id, lv] of level) {
    level.set(id, compactMap.get(lv)!)
  }

  // 2) 分组 & 层内重心排序
  const levelGroups = new Map<number, string[]>()
  for (const a of agents) {
    const lv = level.get(a.id)!
    if (!levelGroups.has(lv)) levelGroups.set(lv, [])
    levelGroups.get(lv)!.push(a.id)
  }
  const sortedLevels = [...levelGroups.keys()].sort((a, b) => a - b)

  const layerOrder = new Map<number, string[]>()
  // 第一层按 agents 原顺序稳定排列
  layerOrder.set(sortedLevels[0], levelGroups.get(sortedLevels[0])!.slice())

  for (let i = 1; i < sortedLevels.length; i++) {
    const prevIndex = new Map(layerOrder.get(sortedLevels[i - 1])!.map((id, idx) => [id, idx]))
    const ids = levelGroups.get(sortedLevels[i])!.slice()
    ids.sort((x, y) => {
      const barycenter = (id: string): number => {
        const ps = parents.get(id) ?? []
        const idxs = ps.map((p) => prevIndex.get(p)).filter((v): v is number => v !== undefined)
        if (idxs.length === 0) return Number.POSITIVE_INFINITY
        return idxs.reduce((s, v) => s + v, 0) / idxs.length
      }
      return barycenter(x) - barycenter(y)
    })
    layerOrder.set(sortedLevels[i], ids)
  }

  // 3) 高度感知垂直堆叠：整层居中
  const nodes: AgentNode[] = []
  for (const lv of sortedLevels) {
    const ids = layerOrder.get(lv)!
    const heights = ids.map((id) => estimateNodeHeight(agentMap.get(id)!))
    const totalH = heights.reduce((s, h) => s + h, 0) + (ids.length - 1) * SIBLING_GAP
    let y = -totalH / 2
    const x = lv * (NODE_WIDTH + LAYER_GAP)
    ids.forEach((id, idx) => {
      const a = agentMap.get(id)!
      nodes.push({
        id: a.id,
        type: 'agent',
        position: { x, y },
        data: { flowId, agentId: a.id, agentName: a.agent_name },
      })
      y += heights[idx] + SIBLING_GAP
    })
  }

  return nodes
}

/** 将 Flow 中 Agent 的 outputs 转换为 ReactFlow 边 */
function agentsToEdges(agents: (Agent | Code)[]): Edge[] {
  const edges: Edge[] = []
  for (const agent of agents) {
    for (const output of agent.outputs ?? []) {
      if (!output.next_agent) continue
      edges.push({
        id: `${agent.id}->${output.next_agent}:${output.output_name}`,
        source: agent.id,
        target: output.next_agent,
        sourceHandle: `output-${output.output_name}`,
        type: 'midArrow',
        animated: false,
        style: { stroke: '#6366f1', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
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
        model: '',
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
