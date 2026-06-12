import { groupBy } from 'lodash-es'
import { match, P } from 'ts-pattern'
import { z } from 'zod'
import { FlowRunStateSchema } from './flowRunState'

export * from './event'
export * from './flowRunState'

// ── Flow Schemas & Types ────────────────────────────────────────────────────────────────

/** Agent 的输出分支，同时定义有向图中的一条边 */
export const OutputSchema = z.object({
  output_name: z.string().describe('分支名称（在当前 agent 内唯一）'),
  output_desc: z.string().optional().describe('分支描述（写入提示词，指导 AI 选择正确的输出分支）'),
  next_agent: z.string().optional().describe('下一个进入的 agent 的 id，省略则表示工作流终点'),
  require_confirm: z.boolean().optional().describe('结束时强制用户确认'),
})

/** @see {@link OutputSchema} */
export type Output = z.infer<typeof OutputSchema>

/** Agent，具有多轮对话能力的独立任务执行单元 */
export const AgentSchema = z.object({
  id: z.string().describe('节点ID'),
  is_entry: z.boolean().optional().describe('建议的入口节点'),
  /**
   * 节点类型,省略即 'agent':走 ClaudeExecutor + AI SDK,与 work_mode/agent_prompt/model 等字段配合。
   * node_type='code' 的节点由 {@link CodeSchema}(从本 schema 派生)定义,走 CodeExecutor 不调 AI。
   */
  node_type: z.literal('agent').describe('节点类型'),
  model: z.string().min(1).describe('模型名称'),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('AI 思考的努力程度，影响响应速度与质量的权衡'),
  agent_name: z.string().describe('节点名称'),
  agent_desc: z.string().optional().describe('节点简介'),
  agent_prompt: z.string().describe('Agent的系统提示词，详细描述Agent的任务和约束').optional(),
  outputs: z.array(OutputSchema).optional().describe('输出分支，每个分支可以选择一个后继'),
  must_confirm_tools: z
    .array(z.string())
    .optional()
    .describe(
      '必须用户确认的工具名；优先级高于 auto_allowed_tools。' +
        '特殊值 "MCP" 匹配所有 mcp__* 工具。' +
        'Bash匹配所有命令，"Bash(cmd)" 匹配命令前缀。' +
        '组合命令中任一子命令命中即要求确认。',
    ),
  deny_tools: z
    .array(z.string())
    .optional()
    .describe(
      '禁止使用的工具名；优先级最高，命中即直接 deny 不弹窗。' +
        '特殊值 "MCP" 匹配所有 mcp__* 工具。' +
        'Bash匹配所有命令，"Bash(cmd)" 匹配命令前缀。' +
        '组合命令中任一子命令命中即禁止。',
    ),
  work_mode: z
    .enum(['task', 'chat', 'silent_task'])
    .describe(
      '工作方式：task-任务达成后调用 CompleteTask 提交结果；chat-与用户的持续长期对话；silent_task-无人值守自动循环，必须通过 CompleteTask 终止',
    ),
  no_input: z.boolean().optional().describe('是否忽略首条消息'),
  no_output: z.boolean().optional().describe('是否阻止本节点输出消息'),
  plan_mode: z.boolean().optional().describe('以Plan 模式开启会话'),
  isolation_mode: z.boolean().optional().describe('不再注入全局/项目/local的settings和CLAUDE.md'),
  allowed_read_values_keys: z
    .array(z.string())
    .optional()
    .describe('允许读取的 shareValues key，会话开始时被注入'),
  allowed_write_values_keys: z
    .array(z.string())
    .optional()
    .describe('允许写入的 shareValues key，仅在 mcp__AgentControllerMcp__CompleteTask 时写入'),
  base_url: z
    .string()
    .optional()
    .describe(
      'Anthropic API base URL 覆盖；非空时优先于 Flow 同名字段，注入 SDK 的 ANTHROPIC_BASE_URL',
    ),
  api_key: z
    .string()
    .optional()
    .describe(
      'Anthropic API key 覆盖；非空时优先于 Flow 同名字段，注入 SDK 的 ANTHROPIC_AUTH_TOKEN',
    ),
})

/** @see {@link AgentSchema} */
export type Agent = z.infer<typeof AgentSchema>

/**
 * Code 节点 —— 从 {@link AgentSchema} 派生,仅保留有向图所需字段 + 代码体。
 * 走 CodeExecutor:把 `code` 当作 `async function (input, values, runCommand) { ... }` 函数体执行,
 * 不调用 AI、不挂 MCP、不走 SDK,运行时不读 model/effort/agent_prompt/work_mode/tools 等字段。
 */
export const CodeSchema = AgentSchema.pick({
  id: true,
  agent_name: true,
  agent_desc: true,
  outputs: true,
  no_input: true,
  is_entry: true,
}).extend({
  node_type: z.literal('code').describe('节点类型'),
  code: z
    .string()
    .describe(
      [
        '代码节点的 JS 函数体.',
        '/**',
        '* @param input string 上游或用户的输入',
        '* @param values Record<string,string> 当前shareValues的全部数据',
        '* @param runCommand (command: string)=>Promise<string> 在当前目录执行shell命令',
        '* @return Promise<{output_name?:string, content:string, values?:Record<string,string>}> 输出分支/输出内容，values会被合并更新至当前shareValues',
        '*/',
        'async function (input, values, runCommand) { /** code的值在这里 */ }',
      ].join('\n'),
    ),
})

/** @see {@link CodeSchema} */
export type Code = z.infer<typeof CodeSchema>

/** 共享数据 key 声明：key 为字段名，desc 仅用于设计期标注语义（不进入 prompt / MCP schema） */
export const ShareValueKeySchema = z.object({
  key: z.string().describe('共享数据 key 名称，在 Flow 内唯一'),
  desc: z.string().optional().describe('共享数据语义描述'),
})

/** @see {@link ShareValueKeySchema} */
export type ShareValueKey = z.infer<typeof ShareValueKeySchema>

/** Agent 作为节点构成的有向图 */
export const FlowSchema = z.object({
  id: z.string().describe('Flow ID'),
  name: z.string().describe('Flow 名称'),
  agents: z
    .array(z.union([AgentSchema, CodeSchema]))
    .optional()
    .describe('当前 Flow 内的 节点'),
  shareValuesKeys: z.array(ShareValueKeySchema).optional().describe('Flow 可用的共享数据 key 集合'),
  base_url: z
    .string()
    .optional()
    .describe(
      'Anthropic API base URL 默认值；Agent 同名字段非空时覆盖，注入 SDK 的 ANTHROPIC_BASE_URL',
    ),
  api_key: z
    .string()
    .optional()
    .describe(
      'Anthropic API key 默认值；Agent 同名字段非空时覆盖，注入 SDK 的 ANTHROPIC_AUTH_TOKEN',
    ),
  project: z
    .boolean()
    .optional()
    .describe('项目级 flow 标记（仅内存/UI，不持久化到磁盘 flows 数组）'),
  icon: z.string().optional().describe('Flow 图标（emoji 或 icon name）'),
})

/** @see {@link FlowSchema} */
export type Flow = z.infer<typeof FlowSchema>

/** 剥除运行时标记（project），保存前调用，确保磁盘 flows 数组不含内存专属字段 */
export function stripFlowRuntimeFields(flow: Flow): Omit<Flow, 'project'> {
  const { project: _, ...rest } = flow
  return rest
}

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
export const PersistedDataSchema = z.object({
  flows: z.array(FlowSchema),
  /** 全局文件使用：按 workspaceRoot 字符串 key 映射到该 workspace 的项目运行态 */
  workspaceRunStates: z.record(z.string(), z.record(z.string(), FlowRunStateSchema)).optional(),
})

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

/** 通配符：匹配所有 `mcp__*` 工具。用于 auto_allowed_tools / must_confirm_tools / deny_tools 的字符串项 */
export const MCP_WILDCARD = 'MCP'

/** Claude Code 预设提供的常见工具名，用于 AgentEditModal 的候选项。
 * 其中 Bash 支持命令级权限控制：`Bash(cmd)` 前缀匹配，
 * 裸 `Bash` 表示整个工具（向后兼容）。详见 {@link matchTool} */
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
 * 按 shell 操作符拆分 Bash 命令为子命令数组。
 *
 * 拆分规则：
 * - 操作符：`&&`、`||`、`|`、`;`、`&`（后台）、换行符
 * - 子 shell `(...)` 内的内容视为独立子命令（去括号后整体作为一个子命令）
 * - 引号（单引号 `'...'`、双引号 `"..."`）内的操作符不触发拆分
 * - 每个子命令 trim 后返回，空串过滤
 *
 * 用于 Bash 命令级权限控制：组合命令中每个子命令都需要独立匹配权限规则，
 * 防止通过 `authorized_cmd && unauthorized_cmd` 绕过限制。
 *
 * @see {@link matchTool}
 */
export function splitBashCommand(command: string): string[] {
  const result: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let parenDepth = 0
  let i = 0

  while (i < command.length) {
    const ch = command[i]

    // 引号状态切换（不在另一种引号内时）
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
      i++
      continue
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
      i++
      continue
    }

    // 引号内：原样累积，不解析操作符
    if (inSingleQuote || inDoubleQuote) {
      current += ch
      i++
      continue
    }

    // 子 shell 括号：跟踪嵌套深度
    if (ch === '(') {
      parenDepth++
      current += ch
      i++
      continue
    }
    if (ch === ')') {
      parenDepth--
      current += ch
      i++
      continue
    }

    // 括号内：原样累积
    if (parenDepth > 0) {
      current += ch
      i++
      continue
    }

    // 双字符操作符：&& 和 ||
    if (i + 1 < command.length) {
      const twoChar = command.slice(i, i + 2)
      if (twoChar === '&&' || twoChar === '||') {
        const trimmed = current.trim()
        if (trimmed) result.push(trimmed)
        current = ''
        i += 2
        continue
      }
    }

    // 单字符操作符：| ; & 和换行
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      const trimmed = current.trim()
      if (trimmed) result.push(trimmed)
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  // 尾部残余
  const trimmed = current.trim()
  if (trimmed) result.push(trimmed)

  return result
}

/**
 * 解析工具权限规则字符串，提取工具名和可选的命令模式。
 *
 * 支持格式：
 * - `Bash(git status)` → `{ toolName: 'Bash', commandPattern: 'git status' }`（前缀匹配）
 * - `Bash` → `{ toolName: 'Bash' }`（裸名，匹配整个工具）
 * - `MCP` → `{ toolName: 'MCP' }`
 * - `Read` → `{ toolName: 'Read' }`
 *
 * @see {@link matchTool}
 */
export function parseToolPattern(pattern: string): { toolName: string; commandPattern?: string } {
  const parenStart = pattern.indexOf('(')
  if (parenStart === -1) {
    return { toolName: pattern }
  }
  const parenEnd = pattern.lastIndexOf(')')
  if (parenEnd <= parenStart) {
    // 格式异常，回退为整体当工具名
    return { toolName: pattern }
  }
  return {
    toolName: pattern.slice(0, parenStart),
    commandPattern: pattern.slice(parenStart + 1, parenEnd),
  }
}

/**
 * 判断单个子命令是否匹配命令模式（前缀匹配）。
 *
 * 子命令 trim 后以 commandPattern 开头即命中。
 *
 * @see {@link matchTool}
 */
export function matchSubCommand(subCmd: string, commandPattern: string): boolean {
  return subCmd.trim().startsWith(commandPattern)
}

/**
 * 判断工具名是否命中给定的 pattern 列表。
 *
 * 规则：
 * - 字面量相等（大小写敏感）
 * - 特殊值 "MCP" 匹配所有以 `mcp__` 开头的工具（即任意 MCP 工具）
 * - `Bash(pattern)` 格式：对 Bash 工具的命令级匹配。
 *   当提供 `input.command` 时，将命令按 shell 操作符拆分为子命令，
 *   **所有子命令都需匹配 pattern** 才算命中（防止组合命令绕过）。
 *   未提供 `input` 或 `input.command` 时，退化为工具名匹配。
 * - 裸 `Bash`（不带括号）：匹配整个 Bash 工具，不检查命令内容
 *
 * @param toolName - SDK 传入的工具名
 * @param patterns - must_confirm_tools 或 deny_tools 的字符串数组
 * @param input - 工具调用的入参（Bash 工具含 `command` 字段）
 */
export function matchTool(
  toolName: string,
  patterns: readonly string[],
  input?: Record<string, unknown>,
): boolean {
  for (const p of patterns) {
    if (p === MCP_WILDCARD) {
      if (toolName.startsWith('mcp__')) return true
      continue
    }

    const parsed = parseToolPattern(p)

    // 工具名不匹配，跳过
    if (parsed.toolName !== toolName) continue

    // 裸工具名（无命令模式）：工具名匹配即命中
    if (!parsed.commandPattern) return true

    // 有命令模式但工具不是 Bash：模式不适用，跳过
    if (toolName !== 'Bash') continue

    // Bash 命令级匹配：需要 input.command
    const command = input?.command
    if (typeof command !== 'string') continue

    // 拆分命令为子命令，**所有**子命令都需匹配（防绕过）
    const subCmds = splitBashCommand(command)
    if (subCmds.length === 0) continue

    const commandPattern = parsed.commandPattern
    const allMatch = subCmds.every((sub) => matchSubCommand(sub, commandPattern))
    if (allMatch) return true
  }
  return false
}

/**
 * Bash 命令级 must_confirm / deny 检查：组合命令中**任一**子命令命中即要求确认或禁止。
 *
 * 与 {@link matchTool} 的区别：matchTool 要求所有子命令都匹配（用于 auto_allowed 防绕过），
 * 本函数只要有一个子命令匹配就返回 true（用于 must_confirm：只要有一个危险命令就需要确认；
 * 用于 deny_tools：只要有一个危险命令即禁止）。
 *
 * 仅对 Bash 工具的 `Bash(pattern)` 规则有意义；非 Bash 工具或裸工具名规则不走此路径。
 *
 * @param toolName - SDK 传入的工具名
 * @param patterns - must_confirm_tools 或 deny_tools 的字符串数组
 * @param input - 工具调用的入参（Bash 工具含 `command` 字段）
 */
export function matchToolAnySubCommand(
  toolName: string,
  patterns: readonly string[],
  input?: Record<string, unknown>,
): boolean {
  if (toolName !== 'Bash') return false
  const command = input?.command
  if (typeof command !== 'string') return false

  const subCmds = splitBashCommand(command)
  if (subCmds.length === 0) return false

  for (const p of patterns) {
    const parsed = parseToolPattern(p)
    if (parsed.toolName !== 'Bash' || !parsed.commandPattern) continue

    const commandPattern = parsed.commandPattern
    if (subCmds.some((sub) => matchSubCommand(sub, commandPattern))) {
      return true
    }
  }
  return false
}

/**
 * 按 allowedReadKeys 过滤 currentValues，生成注入 prompt 的 shareValues 快照字典。
 * 值为 undefined / 空字符串记 null（表示 key 已声明但尚未赋值）。
 */
export function pickInjectedShareValues(
  allowedReadKeys: readonly string[],
  currentValues: Record<string, string> | undefined,
): Record<string, string | null> {
  const result: Record<string, string | null> = {}
  for (const key of allowedReadKeys) {
    const v = currentValues?.[key]
    result[key] = v !== undefined && v !== '' ? v : null
  }
  return result
}

/**
 * 构建 Agent 系统提示词
 *
 * 输出按「变动频率」分三层，越靠上越能跨会话/跨 Agent 命中 prompt 缓存：
 * - **顶部**（配置无关、跨 Agent 不变）：通用回复规则
 * - **中部**（agent 配置相关、运行中不变）：work_mode 分支规则、可读写数据、对话规则、停止会话
 * - **底部**（运行时可变）：可用数据（shareValues 快照）
 *
 * 根据 `work_mode` 选取不同的提示词骨架：
 * - `task`：把 `agent_prompt` 视作**任务描述**，
 *   要求 Agent 围绕该任务推进，并在产物达成后调用 CompleteTask
 * - `chat`：把 `agent_prompt` 视作**长期对话规则**，
 *   会话不会结束、禁止调用 CompleteTask，用户消息就是新的对话输入
 * - `silent_task`：无人值守自动循环，AskUserQuestion 会被自动应答，
 *   每轮 result 后由系统自动以「继续」续轮，必须通过 CompleteTask 终止
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
    | 'no_output'
    | 'agent_name'
  >,
  shareValueKeys?: readonly ShareValueKey[],
  currentValues?: Record<string, string>,
): string {
  const {
    agent_prompt,
    outputs = [],
    work_mode = 'task',
    allowed_read_values_keys = [],
    allowed_write_values_keys = [],
  } = agent

  // ── 顶部：配置无关、跨 Agent 不变 ────────────────────────────────────────
  const lines: string[] = [
    '中文思考与回复，简洁输出，直接给代码或结果，不解释推导过程。',
    '理解用户真实需求，精确改动相关代码。',
    '**禁止**主动优化、重构或任何无关改动，严格遵循代码库既有规范与风格。',
    '**禁止**道歉、表明身份、免责声明等与任务无关的内容。',
    '改动代码前**必须**先阅读所有调用方，理解代码含义与影响范围后再动手。',
  ]

  // ── 中部：agent 配置相关、运行中不变 ─────────────────────────────────────
  match(work_mode)
    .with('task', () => {
      lines.push(
        '**禁止**凭空推测，使用 Tool 获取有效信息，或使用 AskUserQuestion 询问用户。',
        `遇到冲突、歧义或无法满足的需求**必须**明确暴露：通过 AskUserQuestion 询问用户${agent.no_output ? '' : '，或写入 mcp__AgentControllerMcp__CompleteTask 的 `content`'}，**禁止**静默忽略或绕开。`,
      )
    })
    .with('chat', () => {
      lines.push(
        '**禁止**凭空推测，使用 Tool 获取有效信息，或使用 AskUserQuestion 询问用户。',
        '遇到冲突、歧义或无法满足的需求**必须**明确告知用户，**禁止**静默忽略或绕开。',
      )
    })
    .with('silent_task', () => {
      lines.push(
        '**禁止**凭空推测，必须通过 Tool 获取有效信息。',
        '**自行决策**，避免使用 AskUserQuestion，不询问用户意见。',
        '决策中遇到的冲突、歧义、风险或不确定项**必须**完整写入 mcp__AgentControllerMcp__CompleteTask 的 `content`，**禁止**静默忽略。',
      )
    })
    .exhaustive()

  // 可读写数据：合并节，集中声明 key 含义，再分列读 / 写授权。chat 不能写
  const descByKey = new Map<string, string | undefined>(
    (shareValueKeys ?? []).map((k) => [k.key, k.desc]),
  )
  const keyLine = (k: string) => {
    const desc = descByKey.get(k)
    return desc ? `  - ${k}: ${desc}` : `  - ${k}`
  }
  const writableKeys = work_mode === 'chat' ? [] : allowed_write_values_keys
  const declaredKeys = Array.from(new Set([...allowed_read_values_keys, ...writableKeys]))
  if (declaredKeys.length > 0) {
    lines.push(
      '# 外部数据',
      '## key 和语义',
      '本次会话中会出现外部数据，它们的key和语义如下。可以通过语义引用这些数据。',
    )
    lines.push(...declaredKeys.map(keyLine))
    if (allowed_read_values_keys.length > 0) {
      lines.push('## 可读数据', '以下key(或对应语义)被引用时，从「# 具体数据」寻找对应的值：')
      lines.push(...allowed_read_values_keys.map((k) => `  - ${k}`))
    }
    if (writableKeys.length > 0) {
      lines.push(
        '### 可写数据',
        `当用户要求"记录"、"保存"或"写入"以下任一 key(或对应语义)的值时，**必须**通过 mcp__AgentControllerMcp__CompleteTask 工具的 \`values\` 参数输出${agent.no_output ? '' : '，仅在 `content` 里描述不算写入'}。`,
        ...writableKeys.map((k) => `  - ${k}`),
        '#### 写入说明',
        '- 仅可写入上述列出的 key',
        '- 部分写入即可：未变化的 key 省略不传；省略不等于清空（要清空请显式传空字符串）',
      )
      if (!agent.no_output) {
        lines.push('- `content` 是本次任务的结果文本；`values` 用于按 key 记录用户要求保存的值')
      }
    }
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
          '一旦达成「任务描述」的结束条件，**立即**调用 mcp__AgentControllerMcp__CompleteTask 工具提交结果并选择输出分支。',
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

  if (work_mode === 'task' || work_mode === 'silent_task') {
    lines.push(
      '# **停止会话**',
      '**确定无法完成任务时**，调用 mcp__AgentControllerMcp__TerminateTask 工具中止任务。例如缺失关键信息且无工具可获取、环境异常、输出分支和任务执行情况偏差极大等极端情况。',
    )
  }
  // ── 底部：运行时可变（shareValues 快照） ────────────────────────────────
  if (allowed_read_values_keys.length > 0) {
    const visibleValues: Record<string, string | null> = {}
    if (currentValues) {
      Object.assign(visibleValues, pickInjectedShareValues(allowed_read_values_keys, currentValues))
    } else {
      for (const key of allowed_read_values_keys) {
        visibleValues[key] = '<运行时替换>'
      }
    }
    if (Object.keys(visibleValues).length > 0) {
      lines.push('# 具体数据', '```json', JSON.stringify(visibleValues, null, 2), '```')
    }
  }

  return lines.join('\n')
}

export const MODELS = new Set([
  'opus',
  'sonnet[1m]',
  'qwen3.7-max',
  'glm-5.1',
  'DeepSeek-V4-Pro',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6-v1',
  'sonnet',
  'gpt-5.5',
  'gpt-5.4',
  'haiku',
  'MiniMax-M2.7',
  'DeepSeek-V4-flash',
])
