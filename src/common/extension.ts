import { createSdkMcpServer, SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { toJSONSchema } from 'zod/v4/core'
import {
  type Agent,
  type Code,
  type Flow,
  AgentSchema,
  CodeSchema,
  FlowSchema,
  OutputSchema,
  validateFlow,
} from '.'

// 仅extension可用

// ── MCP Server ─────────────────────────────────────────────────────────────

export type AgentMcpServerOptions = {
  agent: Agent
  onComplete: (output: {
    content: string
    outputName?: string
    values?: Record<string, string>
  }) => void
  /**
   * 模型确定无法完成任务时调用 `TerminateTask` 工具,
   * 由此回调上抛 reason,executor 据此走 error 路径终止本 run。
   */
  onTerminate?: (reason: string) => void
}

type ToolContent = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/**
 * 统一兜底：handler 内部任何抛错都转成 isError 工具结果，
 * 让 AI 收到明确的失败信号而不是把异常静默掉。
 */
function withErrorBoundary<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<ToolContent>,
): (args: TArgs) => Promise<ToolContent> {
  return async (args) => {
    try {
      return await handler(args)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        content: [{ type: 'text', text: `[${toolName}] 执行失败：${msg}` }],
        isError: true,
      }
    }
  }
}

/**
 * 构建 Agent 控制用 MCP Server
 *
 * 内置工具：
 * - `CompleteTask` — 完成任务并选择输出分支（可选写入 values）
 * - `TerminateTask` — 极端情况(确定无法完成)时中止任务
 * - `ValidateFlow` — 校验工作流定义是否合法
 * - `GetFlowJSONSchema` — 获取 Flow 的 JSON Schema 定义
 */
export function buildAgentMcpServer({ agent, onComplete, onTerminate }: AgentMcpServerOptions) {
  const tools: SdkMcpToolDefinition<any>[] = []
  if (agent.work_mode !== 'chat') {
    const outputs = agent.outputs ?? []
    const outputNames = outputs.map((o) => o.output_name)
    const outputDescs = outputs
      .map((o) => {
        const { output_name, output_desc } = o
        let res = `  - "${output_name}"`
        if (output_desc) {
          res += `: ${output_desc}`
        }
        return res
      })
      .join('\n')

    const hasOutputs = outputNames.length > 0
    const writeKeys = agent.allowed_write_values_keys ?? []
    const valuesSchema =
      writeKeys.length > 0
        ? z.object(
            Object.fromEntries(
              writeKeys.map((k) => [k, z.string().optional().describe(`key: ${k}`)]),
            ),
          )
        : undefined

    // 共享部分：调用语义 + values 提示。两边（systemPrompt 与本工具描述）措辞一致，
    // 让 AI 在 systemPrompt 里读过一遍后，工具描述这里再次强化要点。
    const callSemantics = [
      '## 调用约束',
      '调用此工具会**终止会话**，不可撤销；只在「任务描述」的结束条件已经达成、且与用户对齐之后调用',
    ].join('\n')

    const valuesNotes =
      writeKeys.length > 0
        ? [
            '## values',
            '当用户要求"记录"、"保存"或"写入"以下任一 key 的值时，**必须**通过 `values` 参数输出，仅在 `content` 里描述不算写入：',
            ...writeKeys.map((k) => `  - "${k}"`),
            '- 仅可写入上述列出的 key',
            '- 部分写入即可：未变化的 key 省略不传；省略不等于清空（要清空请显式传空字符串）',
            '- `content` 是本次任务的结果文本；`values` 用于按 key 记录用户要求保存的值',
          ].join('\n')
        : ''

    const baseDesc = hasOutputs
      ? `当前任务已完成时调用此工具：选择输出分支并提交任务结果。\n## 可选分支\n${outputDescs}`
      : '当前任务已完成时调用此工具，提交任务结果。无输出分支。'

    const completeDesc = [baseDesc, callSemantics, valuesNotes].filter(Boolean).join('\n\n')

    const agentCompleteTool = hasOutputs
      ? tool(
          'CompleteTask',
          completeDesc,
          {
            output_name: z.enum(outputNames as [string, ...string[]]).describe('选择的输出分支名'),
            content: z
              .string()
              .describe(
                '本次任务的结果文本。仅文字输出，不要把需要按 key 记录的值塞这里——那是 values 的职责',
              ),
            ...(valuesSchema
              ? {
                  values: valuesSchema
                    .optional()
                    .describe(
                      '按 key 记录用户要求保存的值；只能写入 allowed_write_values_keys 列出的 key。未变化的 key 省略不传',
                    ),
                }
              : {}),
          },
          withErrorBoundary('CompleteTask', async ({ output_name, content, values }) => {
            const filteredValues: Record<string, string> = {}
            if (values && writeKeys.length > 0) {
              for (const key of writeKeys) {
                if (key in values) {
                  filteredValues[key] = values[key]
                }
              }
            }
            onComplete({
              outputName: output_name,
              content,
              ...(Object.keys(filteredValues).length > 0 ? { values: filteredValues } : {}),
            })
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `任务完成，输出分支：${output_name}` +
                    (Object.keys(filteredValues).length > 0
                      ? `，写入 values：${JSON.stringify(filteredValues)}`
                      : ''),
                },
              ],
            }
          }),
        )
      : tool(
          'CompleteTask',
          completeDesc,
          {
            content: z
              .string()
              .describe(
                '本次任务的结果文本。仅文字输出，不要把需要按 key 记录的值塞这里——那是 values 的职责',
              ),
            ...(valuesSchema
              ? {
                  values: valuesSchema
                    .optional()
                    .describe(
                      '按 key 记录用户要求保存的值；只能写入 allowed_write_values_keys 列出的 key。未变化的 key 省略不传',
                    ),
                }
              : {}),
          },
          withErrorBoundary('CompleteTask', async ({ content, values }) => {
            const filteredValues: Record<string, string> = {}
            if (values && writeKeys.length > 0) {
              for (const key of writeKeys) {
                if (key in values) {
                  filteredValues[key] = values[key]
                }
              }
            }
            onComplete({
              content,
              ...(Object.keys(filteredValues).length > 0 ? { values: filteredValues } : {}),
            })
            return {
              content: [
                {
                  type: 'text',
                  text:
                    '任务完成，无后续输出。' +
                    (Object.keys(filteredValues).length > 0
                      ? `，写入 values：${JSON.stringify(filteredValues)}`
                      : ''),
                },
              ],
            }
          }),
        )
    tools.push(agentCompleteTool)
  }
  // task / silent_task:极端情况(确定无法完成)时中止任务,走 error 路径终止本 run。
  if (agent.work_mode === 'task' || agent.work_mode === 'silent_task') {
    const TerminateTaskTool = tool(
      'TerminateTask',
      [
        '当确定**无法完成**「任务描述」时调用此工具中止任务，例如缺失关键信息且无工具可获取、环境异常、输出分支和任务执行情况偏差极大等极端情况。',
        '## 调用约束',
        '- 调用此工具会**强制终止本次会话**,不可撤销;只在已经穷尽所有可行手段、确认任务不可达成时调用',
        '- 必须在 reason 中说明无法完成的具体原因(缺失关键信息 / 工具不可用 / 环境异常等)',
        '- 优先尝试 CompleteTask 提交部分结果;只有连部分结果都给不出时才用本工具',
      ].join('\n'),
      {
        reason: z.string().describe('无法完成任务的具体原因,简洁明确'),
      },
      withErrorBoundary('TerminateTask', async ({ reason }) => {
        onTerminate?.(reason)
        return {
          content: [{ type: 'text', text: `任务已中止:${reason}` }],
        }
      }),
    )
    tools.push(TerminateTaskTool)
  }
  const validateFlowTool = tool(
    'ValidateFlow',
    '校验工作流定义是否合法。在生成或修改工作流后调用此工具，确保定义符合规则。',
    {
      flow: z.string().describe('工作流定义的 JSON 字符串，需符合 Flow 类型'),
    },
    withErrorBoundary('ValidateFlow', async ({ flow }) => {
      const parsed = FlowSchema.parse(JSON.parse(flow))
      const result = validateFlow(parsed)
      const hasErrors = Object.keys(result).length > 0
      return {
        isError: hasErrors,
        content: [
          {
            type: 'text',
            text: hasErrors
              ? `校验未通过：\n${JSON.stringify(result, null, 2)}`
              : '校验通过，工作流定义合法。',
          },
        ],
      }
    }),
  )

  const getFlowJSONSchemaTool = tool(
    'GetFlowJSONSchema',
    '获取 Flow 数据结构的 JSON Schema 定义。在生成、修改或理解工作流结构时调用，以获取准确的字段定义与约束。',
    {},
    withErrorBoundary('GetFlowJSONSchema', async () => {
      // AI 设计 Flow 用的精简 schema：从完整 schema 派生
      const LiteAgent = AgentSchema.pick({
        id: true,
        agent_name: true,
        agent_prompt: true,
        allowed_read_values_keys: true,
        allowed_write_values_keys: true,
        is_entry: true,
        no_input: true,
        node_type: true,
        outputs: true,
      }).extend({
        model: z.literal('sonnet'),
        must_confirm_tools: z.tuple([z.literal('Bash(git merge)'), z.literal('Bash(git push)')]),
      }) satisfies z.ZodType<Agent>
      const LiteFlow = FlowSchema.pick({ id: true, name: true, shareValuesKeys: true }).extend({
        agents: z
          .array(z.union([LiteAgent, CodeSchema]))
          .optional()
          .describe(
            '当前 Flow 内的 agent，其 outputs 定义了连接边。Agent节点会唤起AI,Code节点会执行js代码',
          ),
      }) satisfies z.ZodType<Flow>
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              toJSONSchema(
                z
                  .registry<{ id?: string }>()
                  .add(OutputSchema, { id: 'Output' })
                  .add(LiteAgent, { id: 'Agent' })
                  .add(CodeSchema, { id: 'Code' })
                  .add(LiteFlow, { id: 'Flow' }),
              ).schemas,
              null,
              2,
            ),
          },
        ],
      }
    }),
  )

  tools.push(validateFlowTool, getFlowJSONSchemaTool)

  return createSdkMcpServer({
    name: 'AgentControllerMcp',
    version: '1.0.0',
    tools,
  })
}
