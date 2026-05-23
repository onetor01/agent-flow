import { groupBy } from 'lodash-es'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

export * from './event'
export * from './flowRunState'

// ── Flow Schemas & Types ────────────────────────────────────────────────────────────────

/** Agent 的输出分支，同时定义有向图中的一条边 */
export const OutputSchema = z.object({
  output_name: z.string().describe('分支名称（在当前 agent 内唯一）'),
  output_desc: z.string().optional().describe('分支描述（写入提示词，指导 AI 选择正确的输出分支）'),
  next_agent: z.string().optional().describe('下一个进入的 agent 的 id，省略则表示工作流终点'),
})

/** @see {@link OutputSchema} */
export type Output = z.infer<typeof OutputSchema>

/** Agent，具有多轮对话能力的独立任务执行单元 */
export const AgentSchema = z.object({
  id: z.string().describe('Agent 唯一 ID'),
  model: z.string().min(1).describe('使用的模型，可选 "sonnet"（复杂推理）或 "haiku"（快速简单）'),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('AI 思考的努力程度，影响响应速度与质量的权衡'),
  agent_name: z.string().describe('Agent 名称，flow 内唯一'),
  agent_desc: z.string().optional().describe('Agent 简介，简要描述该 Agent 的职责与定位'),
  agent_prompt: z.string().describe('系统提示词，定义 Agent 的行为与职责，要具体可执行').optional(),
  outputs: z.array(OutputSchema).optional().describe('输出分支，可以连接任意数量的 agent'),
  auto_allowed_tools: z
    .union([z.literal(true), z.array(z.string())])
    .optional()
    .describe(
      '自动允许执行的工具：true 表示全部放行；字符串数组为白名单。特殊值 "MCP" 匹配所有 mcp__* 工具',
    ),
  must_confirm_tools: z
    .array(z.string())
    .optional()
    .describe(
      '必须用户确认的工具名；优先级高于 auto_allowed_tools。特殊值 "MCP" 匹配所有 mcp__* 工具',
    ),
  work_mode: z
    .enum(['task', 'chat', 'silent_task'])
    .describe(
      '工作方式：task-任务达成后调用 AgentComplete 提交结果；chat-与用户的持续长期对话；silent_task-无人值守自动循环，必须通过 AgentComplete 终止',
    ),
  no_input: z
    .boolean()
    .optional()
    .describe(
      '无输入启动：true 时节点操作区显示启动按钮，点击时始终以"开始"为初始消息自动运行（忽略用户实际输入）',
    ),
  allowed_read_values_keys: z
    .array(z.string())
    .optional()
    .describe('允许读取的 values key 子集；Agent 仅能通过系统提示词看到这些 key 的当前值'),
  allowed_write_values_keys: z
    .array(z.string())
    .optional()
    .describe('允许写入的 values key 子集；Agent 仅能在 AgentComplete 时写入这些 key'),
})

/** @see {@link AgentSchema} */
export type Agent = z.infer<typeof AgentSchema>

/** 共享数据 key 声明：key 为字段名，desc 仅用于设计期标注语义（不进入 prompt / MCP schema） */
export const ShareValueKeySchema = z.object({
  key: z.string().describe('共享数据 key 名称，在 Flow 内唯一'),
  desc: z.string().optional().describe('共享数据语义描述'),
})

/** @see {@link ShareValueKeySchema} */
export type ShareValueKey = z.infer<typeof ShareValueKeySchema>

/** Agent 作为节点构成的有向图 */
export const FlowSchema = z.object({
  id: z.string().describe('Flow 唯一标识'),
  name: z.string().describe('Flow 名称'),
  flow_desc: z.string().optional().describe('Flow 描述'),
  agents: z.array(AgentSchema).optional().describe('当前 Flow 内的 agent，其 outputs 定义了连接边'),
  shareValuesKeys: z.array(ShareValueKeySchema).optional().describe('Flow 可用的共享数据 key 集合'),
})

/** @see {@link FlowSchema} */
export type Flow = z.infer<typeof FlowSchema>

/** AskUserQuestion 工具的 input 结构（SDK 内建工具，claude_code 预设提供） */
export type AskUserQuestionOption = {
  label: string
  description: string
  preview?: string
}
export type AskUserQuestionItem = {
  question: string
  header: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
}
export type AskUserQuestionInput = {
  questions: AskUserQuestionItem[]
}
export type AskUserQuestionOutput = {
  questions: AskUserQuestionItem[]
  /** 每个 question 对应的答案；多选以英文逗号分隔 */
  answers: Record<string, string>
  annotations?: Record<string, { notes?: string; preview?: string }>
}

/** 持久化到本地的 flows */
export const PersistedDataSchema = z.object({ flows: z.array(FlowSchema) })

/** @see {@link PersistedDataSchema} */
export type PersistedData = z.infer<typeof PersistedDataSchema>

// ── Flow 校验 ──────────────────────────────────────────────────────────────────

/** Flow 语义校验结果 */
export type FlowValidationResult = {
  /** 重复的 agent id 列表 */
  duplicateAgentIds?: string[]
  /** 重复的 agent_name 列表 */
  duplicateAgentNames?: string[]
  /** 引用了不存在 agent 的 output，按源 agent_name 分组，值为非法引用的 next_agent id 数组 */
  invalidNextAgent?: Record<string, string[]>
  /** 同一 agent 内重复的 output_name，按 agent_name 分组，值为重复的 output_name 数组 */
  duplicateOutputNames?: Record<string, string[]>
}

/**
 * 校验 Flow 合法性
 *
 * 语义校验规则：
 * - id 在 flow 内唯一
 * - agent_name 在 flow 内唯一
 * - output_name 在同一 agent 内唯一
 * - next_agent 引用的 agent id 存在
 *
 * @param flow - 待校验的 Flow 对象
 */
export function validateFlow(flow: Flow): FlowValidationResult {
  const result: FlowValidationResult = {}
  const { agents = [] } = flow

  // 校验 id 在 flow 内唯一
  const agentIds = agents.map((a) => a.id)
  const idsGrouped = groupBy(agentIds)
  const duplicateAgentIds = Object.entries(idsGrouped)
    .filter(([, ids]) => ids.length > 1)
    .map(([id]) => id)
  if (duplicateAgentIds.length > 0) {
    result.duplicateAgentIds = duplicateAgentIds
  }

  // 校验"output_name 在同一 agent 内唯一"/"next_agent 引用的 agent id 存在"
  const duplicateOutputNames: Record<string, string[]> = {}
  const invalidNextAgent: Record<string, string[]> = {}
  const validAgentIds = new Set(agentIds)

  for (const agent of agents) {
    const { agent_name, outputs = [] } = agent
    const outputsGroupedByName = groupBy(outputs, (v) => v.output_name)
    const dupOutputs = Object.entries(outputsGroupedByName)
      .filter(([, items]) => items.length > 1)
      .map(([output_name]) => output_name)
    if (dupOutputs.length > 0) {
      duplicateOutputNames[agent_name] = dupOutputs
    }

    const badNextAgents = outputs
      .map((o) => o.next_agent)
      .filter((na): na is string => na !== undefined)
      .filter((na) => !validAgentIds.has(na))
    if (badNextAgents.length > 0) {
      invalidNextAgent[agent_name] = badNextAgents
    }
  }

  if (Object.keys(duplicateOutputNames).length > 0) {
    result.duplicateOutputNames = duplicateOutputNames
  }
  if (Object.keys(invalidNextAgent).length > 0) {
    result.invalidNextAgent = invalidNextAgent
  }

  return result
}

/** 通配符：匹配所有 `mcp__*` 工具。用于 auto_allowed_tools / must_confirm_tools 的字符串项 */
export const MCP_WILDCARD = 'MCP'

/** Claude Code 预设提供的常见工具名，用于 AgentEditModal 的候选项 */
export const BUILTIN_TOOL_NAMES = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'AskUserQuestion',
  'SlashCommand',
  'Skill',
  'Agent',
] as const

/**
 * 判断工具名是否命中给定的 pattern 列表。
 *
 * 规则：
 * - 字面量相等（大小写敏感）
 * - 特殊值 "MCP" 匹配所有以 `mcp__` 开头的工具（即任意 MCP 工具）
 */
export function matchTool(toolName: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === MCP_WILDCARD) {
      if (toolName.startsWith('mcp__')) return true
    } else if (p === toolName) {
      return true
    }
  }
  return false
}

/**
 * 构建 Agent 系统提示词
 *
 * 根据 `work_mode` 选取不同的提示词骨架：
 * - `task`：把 `agent_prompt` 视作**任务描述**，
 *   要求 Agent 围绕该任务推进，并在产物达成后调用 AgentComplete
 * - `chat`：把 `agent_prompt` 视作**长期对话规则**，
 *   会话不会结束、禁止调用 AgentComplete，用户消息就是新的对话输入
 * - `silent_task`：无人值守自动循环，AskUserQuestion 会被自动应答，
 *   每轮 result 后由系统自动以「继续」续轮，必须通过 AgentComplete 终止
 */
export function buildAgentSystemPrompt(
  agent: Pick<
    Agent,
    | 'agent_prompt'
    | 'outputs'
    | 'work_mode'
    | 'allowed_read_values_keys'
    | 'allowed_write_values_keys'
    | 'no_input'
    | 'agent_name'
  >,
  currentValues?: Record<string, string>,
): string {
  const {
    agent_prompt,
    outputs = [],
    work_mode,
    allowed_read_values_keys = [],
    allowed_write_values_keys = [],
  } = agent

  const lines: string[] = [
    '始终使用**中文**进行思考和回复。',
    '**简洁**输出，直接给代码或结果，无需解释和推导。',
    '仅修改**用户指定的代码或文件**，**禁止**更改其他任何内容。',
    '**禁止**道歉、表明身份、免责声明等与任务无关的一切内容。',
    '**严格按需求执行**，**禁止**主动优化代码。',
  ]
  match(agent.work_mode)
    .with(P.union('task', 'chat'), () => {
      lines.push('**禁止**凭空推测，使用 Tool 获取有效信息，或使用 AskUserQuestion 询问用户。')
    })
    .with('silent_task', () => {
      lines.push(
        '**禁止**凭空推测，必须通过 Tool 获取有效信息。',
        '**自行决策**，避免使用 AskUserQuestion，不询问用户意见。',
      )
    })
    .exhaustive()
  // Flow 管控数据（可选，仅注入被授权读取的 key） 空值传入null
  if (allowed_read_values_keys.length > 0) {
    const visibleValues: Record<string, string | null> = {}
    for (const key of allowed_read_values_keys) {
      if (currentValues) {
        const value = currentValues[key]
        visibleValues[key] = value !== undefined && value !== '' ? value : null
      } else {
        visibleValues[key] = '<运行时替换>'
      }
    }
    if (Object.keys(visibleValues).length > 0) {
      lines.push(
        '# 可用数据',
        '用户会引用以下值',
        '```json',
        JSON.stringify(visibleValues, null, 2),
        '```',
      )
    }
  }

  // 可写数据：chat 不能写（不调 AgentComplete）；task / silent_task 都通过 AgentComplete 的 values 写入
  if (allowed_write_values_keys.length > 0 && work_mode !== 'chat') {
    lines.push(
      '# 可写数据',
      '当用户要求"记录"、"保存"或"写入"以下任一 key 的值时，**必须**通过 AgentComplete 工具的 `values` 参数输出，仅在 `content` 里描述不算写入。',
      ...allowed_write_values_keys.map((k) => `  - ${k}`),
      '## 写入说明：',
      '- 仅可写入上述列出的 key',
      '- 部分写入即可：未变化的 key 省略不传；省略不等于清空（要清空请显式传空字符串）',
      '- `content` 是本次任务的结果文本；`values` 用于按 key 记录用户要求保存的值',
    )
  }

  // 对话规则：长期对话 / 围绕任务描述完成任务 / 无人值守循环执行
  if (agent_prompt) {
    match(work_mode)
      .with('chat', () => {
        lines.push('# 对话规则', agent_prompt)
      })
      .with(P.union('silent_task', 'task'), (mode) => {
        lines.push('# 对话规则', '下方「任务描述」是本次会话的**最终目标**，全程固定不变。')
        if (mode === 'task') {
          lines.push(
            '你需要围绕该目标与用户进行多轮对话：根据用户输入主动推进、必要时使用 AskUserQuestion 向用户收集信息、读取文件或调用工具补全上下文，直到达成结束条件。',
          )
        }
        if (mode === 'silent_task') {
          lines.push('你需要围绕该目标，充分利用自身能力推进任务，自行决策，避免询问用户。')
        }
        lines.push(
          '## 任务描述',
          agent_prompt,
          '## 完成任务',
          '一旦达成「任务描述」的结束条件，**立即**调用 AgentControllerMcp 的 AgentComplete 工具提交结果并选择输出分支，否则系统会持续以「继续」让你循环。',
          '## 输出分支',
          outputs.length === 0
            ? '此任务没有输出分支。'
            : outputs
                .map((o) => `  - "${o.output_name}"${o.output_desc ? `: ${o.output_desc}` : ''}`)
                .join('\n'),
        )
      })
      .exhaustive()
  }

  if (agent.work_mode === 'silent_task') {
    lines.push(
      '# **停止会话**',
      '**确定无法完成任务时**，调用 AgentControllerMcp 的 `terminateTask` 工具中止任务。例如缺失任务目标、缺失关键信息且无工具可获取、环境异常等极端情况。',
    )
  }
  return lines.join('\n')
}
