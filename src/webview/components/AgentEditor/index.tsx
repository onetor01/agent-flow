import { useState, useEffect, useRef } from 'react'
import type { FC } from 'react'
import { Drawer, Form, Input, Switch, Select, AutoComplete, Button, Flex, Modal, App } from 'antd'
import {
  PlusOutlined,
  MinusCircleOutlined,
  EditOutlined,
  EyeOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import type { Agent } from '@/common'
import { BUILTIN_TOOL_NAMES, MCP_WILDCARD, buildAgentSystemPrompt } from '@/common'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import { Md } from '../text-components'

const FormItem = Form.Item<Agent>

const TOOL_OPTIONS = [
  { label: `${MCP_WILDCARD} — 匹配所有 mcp__* 工具`, value: MCP_WILDCARD },
  ...BUILTIN_TOOL_NAMES.map((n) => ({ label: n, value: n })),
]

type AutoAllowedValue = true | string[] | undefined

/** 受控：Switch 开 → true；关 → string[]（默认 []）。兼容 undefined 初值 */
const AutoAllowedToolsField: FC<{
  value?: AutoAllowedValue
  onChange?: (v: AutoAllowedValue) => void
}> = ({ value, onChange }) => {
  const allowAll = value === true
  const list = Array.isArray(value) ? value : []
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-2'>
        <Switch
          size='small'
          checked={allowAll}
          onChange={(checked) => onChange?.(checked ? true : [])}
        />
        <span className='text-[12px] text-[#cdd6f4]'>允许全部工具</span>
      </div>
      {!allowAll && (
        <Select
          mode='tags'
          placeholder='选择或输入工具名（回车添加自定义）'
          value={list}
          onChange={(v) => onChange?.(v as string[])}
          options={TOOL_OPTIONS}
        />
      )}
    </div>
  )
}

export const AgentEditor: FC = () => {
  const { modal } = App.useApp()
  const editingAgent = useFlowStore((s) => s.editingAgent)
  const flows = useFlowStore((s) => s.flows)
  const save = useFlowStore((s) => s.save)
  const setEditingAgent = useFlowStore((s) => s.setEditingAgent)
  const setEditingFlowId = useFlowStore((s) => s.setEditingFlowId)

  const open = !!editingAgent
  const agent = (() => {
    if (!editingAgent) return null
    const flow = flows.find((f) => f.id === editingAgent.flowId)
    return flow?.agents?.find((a) => a.id === editingAgent.agentId) ?? null
  })()
  const allAgents = (() => {
    const flow = editingAgent ? flows.find((f) => f.id === editingAgent.flowId) : undefined
    return (flow?.agents ?? []).map((a) => ({ id: a.id, agent_name: a.agent_name }))
  })()

  const [form] = Form.useForm()
  const [previewMode, setPreviewMode] = useState<'edit' | 'preview'>('preview')

  // 首次切到 silent_task 时弹一次警告;Agent 本身已是静默模式则不再提示
  const silentWarnedRef = useRef(false)

  const watchedValues = Form.useWatch([], form)

  useEffect(() => {
    if (open && agent) {
      const newFormValue: Omit<Agent, 'id'> = {
        agent_name: agent.agent_name,
        agent_desc: agent.agent_desc,
        model: agent.model,
        effort: agent.effort,
        agent_prompt: agent.agent_prompt,
        auto_allowed_tools: agent.auto_allowed_tools,
        must_confirm_tools: agent.must_confirm_tools,
        work_mode: agent.work_mode ?? 'task',
        no_input: agent.no_input ?? false,
        allowed_read_values_keys: agent.allowed_read_values_keys ?? [],
        allowed_write_values_keys: agent.allowed_write_values_keys ?? [],
        outputs: (agent.outputs ?? []).map((o) => ({
          output_name: o.output_name,
          output_desc: o.output_desc,
          next_agent: o.next_agent,
        })),
      }
      form.setFieldsValue(newFormValue)
      silentWarnedRef.current = (agent.work_mode ?? 'task') === 'silent_task'
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewMode('preview')
    }
  }, [open, agent, form])

  const isValidAgent = (v: any): v is Agent => v && typeof v.agent_name === 'string'

  // 从 Flow 定义中提取全部可用 key 选项
  const currentFlow = editingAgent ? flows.find((f) => f.id === editingAgent.flowId) : undefined
  const shareValueKeys = currentFlow?.shareValuesKeys ?? []
  const shareValueKeyOptions = shareValueKeys.map((k) => ({
    label: k.desc ? `${k.key}(${k.desc})` : k.key,
    value: k.key,
  }))

  const fullPrompt = isValidAgent(watchedValues)
    ? buildAgentSystemPrompt(watchedValues, shareValueKeys)
    : ''

  return (
    <Drawer
      key={agent?.id}
      title={null}
      placement='left'
      open={open}
      onClose={() => setEditingAgent(undefined)}
      defaultSize={1200}
      resizable
      styles={{
        header: { display: 'none' },
        body: { padding: 0 },
        wrapper: { transition: 'none', minWidth: 1200 },
      }}
      footer={null}
    >
      <Form
        form={form}
        layout='vertical'
        autoComplete='off'
        className='flex h-full'
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') return
          e.stopPropagation()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
        onValuesChange={(changed: Partial<Agent>) => {
          if (changed.work_mode === 'silent_task' && !silentWarnedRef.current) {
            silentWarnedRef.current = true
            modal.warning({
              title: '谨慎使用静默模式',
              content:
                '静默模式下，AskUserQuestion 与每轮 result 续轮会被自动应答，直到 Agent 自行完成任务。请谨慎选择模型、effort，并确保输入和提示词的完整。',
            })
          }
        }}
        onFinish={(val: Omit<Agent, 'id'>) => {
          save((draftFlows) => {
            const f = draftFlows.find((f) => f.id === editingAgent!.flowId)
            if (!f) return
            f.agents = (f.agents ?? []).map((a) =>
              a.id === editingAgent!.agentId ? { ...val, id: a.id } : a,
            )
          })
          setEditingAgent(undefined)
        }}
      >
        {/* 左侧表单 — 独立滚动 */}
        <div className='flex w-120 grow-0 flex-col'>
          <div className='border-b border-[#313244] px-3 py-2 text-xs font-bold'>
            <CloseOutlined onClick={() => setEditingAgent(undefined)} className='mr-2' />
            <span>编辑 Agent</span>
          </div>
          <div className='flex-1 overflow-auto'>
            <div className='p-4'>
              <FormItem
                name='agent_name'
                label='Agent 名称'
                rules={[{ required: true, message: '请输入名称' }]}
              >
                <Input />
              </FormItem>

              <FormItem name='agent_desc' label='Agent 简介'>
                <Input placeholder='例如：负责代码评审，检查潜在 bug 与性能问题' />
              </FormItem>

              <Flex gap={16}>
                <FormItem
                  name='model'
                  label='模型'
                  rules={[{ required: true, message: '请选择或输入模型' }]}
                  className='mb-0 flex-1'
                >
                  <AutoComplete
                    placeholder='选择或输入模型名称'
                    allowClear
                    options={[
                      { value: 'opus', label: 'opus' },
                      { value: 'sonnet[1m]', label: 'sonnet[1m]' },
                      { value: 'qwen3.7-max', label: 'qwen3.7-max' },
                      { value: 'glm-5.1', label: 'glm-5.1' },
                      { value: 'DeepSeek-V4-Pro', label: 'DeepSeek-V4-Pro' },
                      { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
                      { value: 'claude-opus-4-7', label: 'claude-opus-4-7' },
                      { value: 'claude-opus-4-6-v1', label: 'claude-opus-4-6-v1' },
                      { value: 'sonnet', label: 'sonnet' },
                      { value: 'gpt-5.5', label: 'gpt-5.5' },
                      { value: 'gpt-5.4', label: 'gpt-5.4' },
                      { value: 'haiku', label: 'haiku' },
                      { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
                      { value: 'DeepSeek-V4-flash', label: 'DeepSeek-V4-flash' },
                    ]}
                    filterOption={(inputValue, option) =>
                      (option?.label as string)?.toLowerCase().includes(inputValue.toLowerCase()) ??
                      option?.value?.toLowerCase().includes(inputValue.toLowerCase()) ??
                      false
                    }
                  />
                </FormItem>

                <FormItem name='effort' label='努力程度' className='mb-0 w-56'>
                  <Select
                    placeholder='默认（不指定）'
                    allowClear
                    options={[
                      { label: 'low — 简单任务', value: 'low' },
                      { label: 'medium — 日常任务', value: 'medium' },
                      { label: 'high — 复杂任务', value: 'high' },
                      { label: 'xhigh — 长程任务(opus4.7+)', value: 'xhigh' },
                      { label: 'max — 最大性能(opus4.6+)', value: 'max' },
                    ]}
                  />
                </FormItem>
              </Flex>

              <FormItem
                name='auto_allowed_tools'
                label='自动允许的工具'
                tooltip={{
                  classNames: {
                    container: 'w-max whitespace-pre',
                  },
                  title: [
                    `不需要用户确认、自动执行的工具，开启「允许全部」表示全部放行`,
                    `特殊值 "${MCP_WILDCARD}" 匹配所有 mcp__* 工具`,
                    `Bash匹配所有命令，"Bash(cmd)" 匹配命令前缀。`,
                    `组合命令需所有子命令都命中才自动放行`,
                  ].join('\n'),
                }}
              >
                <AutoAllowedToolsField />
              </FormItem>

              <FormItem
                name='must_confirm_tools'
                label='必须确认的工具'
                tooltip={{
                  classNames: {
                    container: 'w-max whitespace-pre',
                  },
                  title: [
                    `每次调用都必须用户确认的工具，优先级高于「自动允许」`,
                    `特殊值 "${MCP_WILDCARD}" 匹配所有 mcp__* 工具`,
                    `Bash匹配所有命令，"Bash(cmd)" 匹配命令前缀。`,
                    `组合命令中任一子命令命中即要求确认`,
                  ].join('\n'),
                }}
              >
                <Select
                  mode='tags'
                  placeholder='选择或输入工具名（回车添加自定义）'
                  options={TOOL_OPTIONS}
                />
              </FormItem>

              <Flex gap={16}>
                <FormItem
                  name='work_mode'
                  label='工作模式'
                  tooltip='静默模式下，用户无法与AI进行多轮对话，无法中断会话'
                >
                  <Select
                    className='w-70'
                    options={[
                      {
                        value: 'task',
                        label: '任务模式 · AI会执行任务并提交结果',
                      },
                      {
                        value: 'chat',
                        label: '对话模式 · 永不终止的多轮对话',
                      },
                      {
                        value: 'silent_task',
                        label: '静默模式 · 无交互执行任务',
                      },
                    ]}
                  />
                </FormItem>

                <FormItem
                  name='no_input'
                  label='无输入'
                  tooltip='开启后节点操作区显示启动按钮，点击时始终以"开始"为初始消息自动运行（忽略用户实际输入）'
                  valuePropName='checked'
                >
                  <Switch />
                </FormItem>
              </Flex>

              <FormItem
                name='allowed_read_values_keys'
                label={
                  <div className='flex items-center gap-2'>
                    <span>可读共享数据</span>
                    <Button
                      size='small'
                      type='link'
                      onClick={() => editingAgent && setEditingFlowId(editingAgent.flowId)}
                    >
                      编辑共享存储
                    </Button>
                  </div>
                }
                tooltip='Agent 在系统提示词中可看到的 shareValues key 子集'
              >
                <Select
                  mode='multiple'
                  placeholder='从 Flow 共享数据中选择 key'
                  options={shareValueKeyOptions}
                />
              </FormItem>
              <FormItem
                name='allowed_write_values_keys'
                label='可写共享数据'
                tooltip='Agent 完成时通过 AgentComplete 可写入的 shareValues key 子集'
              >
                <Select
                  mode='multiple'
                  placeholder='从 Flow 共享数据中选择 key'
                  options={shareValueKeyOptions}
                />
              </FormItem>

              <FormItem label='输出分支'>
                <Form.List name='outputs'>
                  {(fields, { add, remove }) => (
                    <>
                      {fields.map(({ key, name, ...restField }) => (
                        <div key={key} className='mb-2 flex items-start gap-2'>
                          <Form.Item
                            {...restField}
                            name={[name, 'output_name']}
                            rules={[
                              { required: true, message: '名称不能为空' },
                              ({ getFieldValue }) => ({
                                validator(_, value) {
                                  const outputs = getFieldValue('outputs') || []
                                  const names = outputs
                                    .map((o: any) => o?.output_name)
                                    .filter(Boolean)
                                  if (names.filter((n: string) => n === value).length > 1) {
                                    return Promise.reject(new Error('名称重复'))
                                  }
                                  return Promise.resolve()
                                },
                              }),
                            ]}
                            className='mb-0 flex-1'
                          >
                            <Input placeholder='分支名称' size='small' />
                          </Form.Item>
                          <Form.Item
                            {...restField}
                            name={[name, 'output_desc']}
                            className='mb-0 flex-1'
                          >
                            <Input placeholder='分支描述' size='small' />
                          </Form.Item>
                          <Form.Item
                            {...restField}
                            name={[name, 'next_agent']}
                            className='mb-0 w-36'
                          >
                            <Select
                              placeholder='下一个 Agent'
                              size='small'
                              allowClear
                              options={allAgents.map((a) => ({
                                label: a.agent_name,
                                value: a.id,
                              }))}
                            />
                          </Form.Item>
                          <MinusCircleOutlined
                            className='mt-1.5 cursor-pointer text-[#f38ba8]'
                            onClick={() => remove(name)}
                          />
                        </div>
                      ))}
                      <Button
                        type='dashed'
                        onClick={() =>
                          add({
                            output_name: 'output',
                          })
                        }
                        block
                        icon={<PlusOutlined />}
                      >
                        添加输出分支
                      </Button>
                    </>
                  )}
                </Form.List>
              </FormItem>
            </div>
          </div>
          {/* 底部保存按钮 — 固定不滚动 */}
          <div className='border-t border-[#313244] px-4 py-3'>
            <Button type='primary' htmlType='submit' block>
              保存
            </Button>
          </div>
        </div>

        {/* 右侧提示词面板— 独立滚动 */}
        <div
          className={cn('flex h-full flex-1 flex-col overflow-hidden border-l border-[#313244]')}
        >
          <div className='flex items-center gap-2 px-3 py-2'>
            <span className='text-base font-medium'>提示词</span>
            <Switch
              checked={previewMode === 'preview'}
              onChange={(v) => setPreviewMode(v ? 'preview' : 'edit')}
              checkedChildren={<EyeOutlined />}
              unCheckedChildren={<EditOutlined />}
            />
          </div>

          <div className={cn('flex-1 overflow-hidden', { 'px-2': previewMode === 'edit' })}>
            <FormItem name='agent_prompt' noStyle>
              <Input.TextArea
                className={cn('hidden h-full w-full resize-none overflow-auto', {
                  block: previewMode === 'edit',
                })}
                placeholder='请输入提示词'
              />
            </FormItem>

            {previewMode === 'preview' && (
              <Md
                className='h-full overflow-auto p-3 break-all whitespace-pre-wrap'
                content={fullPrompt}
              ></Md>
            )}
          </div>
        </div>
      </Form>
    </Drawer>
  )
}
