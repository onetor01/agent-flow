import { useState, useEffect, useCallback } from 'react'
import type { FC } from 'react'
import {
  Drawer,
  Form,
  Input,
  Switch,
  Select,
  AutoComplete,
  Button,
  Flex,
  Checkbox,
  Tooltip,
} from 'antd'
import {
  PlusOutlined,
  MinusCircleOutlined,
  EditOutlined,
  EyeOutlined,
  CloseOutlined,
  CodeOutlined,
} from '@ant-design/icons'
import type { Agent, Code } from '@/common'
import { BUILTIN_TOOL_NAMES, MCP_WILDCARD, MODELS, buildAgentSystemPrompt } from '@/common'
import { useSilentTaskModeNotification } from '@/webview/hooks/useSilentTaskModeNotification'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import { postMessageToExtension, subscribeExtensionMessage } from '@/webview/utils/ExtensionMessage'
import { CodeEditor } from '../CodeEditor'
import '../CodeEditor/code-editor.css'
import { Md } from '../text-components'

type CodeNodeFormValue = Omit<Code, 'id'>
type AgentNodeFormValue = Omit<Agent, 'id'>

/**
 * 编辑器表单值 —— agent / code 两类节点共用一张表单(node_type / code 为隐藏字段)。
 * 判别联合:按 node_type 分流,Agent 节点携带 model / work_mode 等字段,Code 节点携带 code。
 */
type AgentFormValue = CodeNodeFormValue | AgentNodeFormValue

const FormItem = Form.Item<AgentFormValue>

const TOOL_OPTIONS = [
  { label: `${MCP_WILDCARD} — 匹配所有 mcp__* 工具`, value: MCP_WILDCARD },
  ...BUILTIN_TOOL_NAMES.map((n) => ({ label: n, value: n })),
]

export const AgentEditor: FC = () => {
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

  const notifySilentMode = useSilentTaskModeNotification()

  const watchedValues = Form.useWatch([], form)

  useEffect(() => {
    if (open && agent) {
      form.resetFields()
      form.setFieldsValue(agent)
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewMode('preview')
    }
  }, [open, agent, form])

  // 监听 VSCode 编辑器中 Code 节点代码变更
  useEffect(() => {
    return subscribeExtensionMessage((msg) => {
      if (msg.type !== 'codeEditorUpdate') return
      if (!editingAgent) return
      if (msg.data.flowId !== editingAgent.flowId) return
      if (msg.data.agentId !== editingAgent.agentId) return
      form.setFieldValue('code', msg.data.code)
      save((draftFlows) => {
        const f = draftFlows.find((f) => f.id === editingAgent!.flowId)
        if (!f) return
        const a = f.agents?.find((a) => a.id === editingAgent!.agentId)
        if (a && a.node_type === 'code') a.code = msg.data.code
      })
    })
  }, [editingAgent, form, save])

  const isValidAgent = (v: any): v is Agent => v && typeof v.agent_name === 'string'

  // 从 Flow 定义中提取全部可用 key 选项
  const currentFlow = editingAgent ? flows.find((f) => f.id === editingAgent.flowId) : undefined
  const shareValueKeys = currentFlow?.shareValuesKeys ?? []
  const shareValueKeyOptions = shareValueKeys.map((k) => ({
    label: k.desc ? `${k.key}(${k.desc})` : k.key,
    value: k.key,
  }))

  const isCodeNode = (watchedValues?.node_type ?? agent?.node_type) === 'code'

  const handleClose = useCallback(() => {
    if (agent?.node_type === 'code' && editingAgent) {
      postMessageToExtension({
        type: 'closeCodeEditor',
        data: { flowId: editingAgent.flowId, agentId: editingAgent.agentId },
      })
    }
    setEditingAgent(undefined)
  }, [agent, editingAgent, setEditingAgent])

  const fullPrompt =
    !isCodeNode && isValidAgent(watchedValues)
      ? buildAgentSystemPrompt(watchedValues, shareValueKeys)
      : ''

  return (
    <Drawer
      key={agent?.id}
      title={null}
      placement='left'
      open={open}
      onClose={handleClose}
      defaultSize={1300}
      resizable
      styles={{
        header: { display: 'none' },
        body: { padding: 0 },
        wrapper: { transition: 'none', minWidth: 1300 },
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
        onValuesChange={(changed: Partial<AgentFormValue>) => {
          if ('work_mode' in changed && changed.work_mode === 'silent_task') {
            notifySilentMode()
          }
        }}
        onFinish={(val: AgentFormValue) => {
          save((draftFlows) => {
            const f = draftFlows.find((f) => f.id === editingAgent!.flowId)
            if (!f) return
            f.agents = f.agents?.map((a) =>
              a.id === editingAgent!.agentId ? ({ ...val, id: a.id } as typeof a) : a,
            )
          })
          handleClose()
        }}
      >
        {/* 左侧表单 — 独立滚动 */}
        <div className='flex w-140 grow-0 flex-col'>
          <div className='border-b border-[#313244] px-3 py-2 text-xs font-bold'>
            <CloseOutlined onClick={handleClose} className='mr-2' />
            <span>编辑节点</span>
          </div>
          <div className='flex-1 overflow-auto'>
            <div className='p-4'>
              {/* node_type / code 是隐藏字段:由"添加 Code 节点"入口写入,编辑器不显式切换 —— 切换会让 model / work_mode / agent_prompt 等已有配置语义错位 */}
              <FormItem name='node_type' hidden>
                <Input />
              </FormItem>
              <FormItem
                name='agent_name'
                label={'名称'}
                rules={[{ required: true, message: '请输入名称' }]}
              >
                <Input />
              </FormItem>
              <FormItem name='agent_desc' label={'简介'}>
                <Input
                  placeholder={
                    isCodeNode ? '简要描述代码功能' : '例如：负责代码评审，检查潜在 bug 与性能问题'
                  }
                />
              </FormItem>
              {!isCodeNode && (
                <Flex gap={16}>
                  <FormItem
                    name='model'
                    label='模型'
                    rules={[{ required: true, message: '请选择或输入模型' }]}
                    className='flex-1'
                  >
                    <AutoComplete
                      placeholder='选择或输入模型名称'
                      allowClear
                      options={Array.from(MODELS).map((m) => ({ value: m, label: m }))}
                      filterOption={(inputValue, option) => {
                        if (
                          Array.from(MODELS).some(
                            (m) =>
                              m.replace('[1m]', '').toLowerCase() ===
                              inputValue.toLowerCase(),
                          )
                        ) {
                          return true
                        }
                        return (
                          (option?.label as string)?.toLowerCase()?.includes(inputValue.toLowerCase()) ??
                          option?.value?.toLowerCase().includes(inputValue.toLowerCase()) ??
                          false
                        )
                      }}
                    />
                  </FormItem>

                  <FormItem name='effort' label='努力程度' className='w-56'>
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
              )}
              {!isCodeNode && (
                <FormItem
                  name='deny_tools'
                  label='禁止使用的工具'
                  tooltip={{
                    classNames: {
                      container: 'w-max whitespace-pre',
                    },
                    title: [
                      `优先级高于Claude Code原生权限体系`,
                      `禁止 Agent 调用的工具，优先级最高，命中即直接拒绝`,
                      `特殊值 "${MCP_WILDCARD}" 匹配所有 mcp__* 工具`,
                      `Bash匹配所有命令，"Bash(cmd)" 匹配命令前缀。`,
                      `组合命令中任一子命令命中即禁止`,
                    ].join('\n'),
                  }}
                >
                  <Select
                    mode='tags'
                    placeholder='选择或输入工具名（回车添加自定义）'
                    options={TOOL_OPTIONS}
                  />
                </FormItem>
              )}
              {!isCodeNode && (
                <FormItem
                  name='must_confirm_tools'
                  label='必须确认的工具'
                  tooltip={{
                    classNames: {
                      container: 'w-max whitespace-pre',
                    },
                    title: [
                      `优先级低于Claude Code原生权限体系`,
                      `其余规则与禁止使用的工具相同`,
                    ].join('\n'),
                  }}
                >
                  <Select
                    mode='tags'
                    placeholder='选择或输入工具名（回车添加自定义）'
                    options={TOOL_OPTIONS}
                  />
                </FormItem>
              )}
              {!isCodeNode && (
                <FormItem name='work_mode' label='工作模式'>
                  <Select
                    options={[
                      {
                        value: 'chat',
                        label: '对话模式  永不终止的多轮对话',
                      },
                      {
                        value: 'task',
                        label: '任务模式  AI会执行任务并提交结果',
                      },
                      {
                        value: 'silent_task',
                        label: '静默模式 无交互执行任务，后台代替用户自动应答',
                      },
                    ]}
                  />
                </FormItem>
              )}
              <Flex gap={16}>
                <FormItem
                  name='no_input'
                  label='无输入'
                  tooltip='忽略用户实际输入'
                  valuePropName='checked'
                >
                  <Switch />
                </FormItem>
                {!isCodeNode && (
                  <>
                    <FormItem
                      name='no_output'
                      label='无输出'
                      tooltip='此节点不能输出文本，但仍然可以正常修改共享数据'
                      valuePropName='checked'
                    >
                      <Switch />
                    </FormItem>
                    <FormItem
                      name='plan_mode'
                      label='Plan模式'
                      tooltip='对话开始时进入Plan模式。系统提示词倾向会改变，AI会写计划并尝试执行，而不是完成任务。对Claude系列模型效果非常明显。'
                      valuePropName='checked'
                    >
                      <Switch />
                    </FormItem>
                    <FormItem
                      name='isolation_mode'
                      label='隔离模式'
                      tooltip='不再注入全局/项目/local的settings和CLAUDE.md'
                      valuePropName='checked'
                    >
                      <Switch />
                    </FormItem>
                  </>
                )}
                <FormItem
                  name='is_entry'
                  label='入口节点'
                  tooltip='将一个节点明确指定为入口，样式和位置做特殊处理'
                  valuePropName='checked'
                >
                  <Switch />
                </FormItem>
              </Flex>
              {!isCodeNode && (
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
              )}
              {!isCodeNode && (
                <FormItem
                  name='allowed_write_values_keys'
                  label='可写共享数据'
                  tooltip='Agent 完成时通过 CompleteTask 可写入的 shareValues key 子集'
                >
                  <Select
                    mode='multiple'
                    placeholder='从 Flow 共享数据中选择 key'
                    options={shareValueKeyOptions}
                  />
                </FormItem>
              )}
              <FormItem label='输出分支' tooltip={isCodeNode ? null : '对话模式下不生效'}>
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
                            noStyle
                          >
                            <Input placeholder='分支名称' size='small' className='w-25 grow-0' />
                          </Form.Item>
                          <Form.Item {...restField} name={[name, 'output_desc']} noStyle>
                            <Input placeholder='分支描述' size='small' className='flex-1' />
                          </Form.Item>
                          <Form.Item {...restField} name={[name, 'next_agent']} noStyle>
                            <Select
                              placeholder='下一个 Agent'
                              size='small'
                              allowClear
                              options={allAgents.map((a) => ({
                                label: a.agent_name,
                                value: a.id,
                              }))}
                              className='w-30'
                            />
                          </Form.Item>
                          <Form.Item
                            {...restField}
                            name={[name, 'require_confirm']}
                            valuePropName='checked'
                            hidden={agent?.node_type === 'code'}
                            noStyle
                          >
                            <Checkbox>
                              <Tooltip title='选择此分支输出时，会以代码方式要求用户验证'>
                                需要确认
                              </Tooltip>
                            </Checkbox>
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
              {!isCodeNode && (
                <FormItem
                  name='base_url'
                  label='Base URL'
                  tooltip='留空使用 Flow 配置;非空则覆盖 Flow,注入 SDK 子进程的 ANTHROPIC_BASE_URL'
                >
                  <Input placeholder='例如 https://api.anthropic.com' />
                </FormItem>
              )}
              {!isCodeNode && (
                <FormItem
                  name='api_key'
                  label='API Key'
                  tooltip='留空使用 Flow 配置;非空则覆盖 Flow,注入 SDK 子进程的 ANTHROPIC_AUTH_TOKEN'
                >
                  <Input placeholder='sk-ant-...' />
                </FormItem>
              )}
            </div>
          </div>
          {/* 底部保存按钮 — 固定不滚动 */}
          <div className='border-t border-[#313244] px-4 py-3'>
            <Button type='primary' htmlType='submit' block>
              保存
            </Button>
          </div>
        </div>

        {/* 右侧面板:agent → 提示词预览/编辑;code → 完整 async function 只读展示（实际编辑在 VSCode 中完成） */}
        <div
          className={cn('flex h-full flex-1 flex-col overflow-hidden border-l border-[#313244]')}
        >
          {isCodeNode ? (
            <>
              <div className='flex items-center gap-2 px-3 py-2'>
                <span className='text-base font-medium'>代码</span>
                <Button
                  type='text'
                  size='small'
                  icon={<CodeOutlined />}
                  onClick={() => {
                    if (!editingAgent) return
                    postMessageToExtension({
                      type: 'openCodeEditor',
                      data: {
                        flowId: editingAgent.flowId,
                        agentId: editingAgent.agentId,
                        code: form.getFieldValue('code') ?? '',
                        shareValueKeys: shareValueKeys.map((k) => k.key),
                        outputs: (watchedValues?.outputs ?? [])
                          .map((o: any) => o?.output_name)
                          .filter(Boolean),
                      },
                    })
                  }}
                >
                  编辑
                </Button>
              </div>
              {/* code 字段为完整 async function 表达式，直接只读展示。实际编辑在 VSCode 中完成。 */}
              <div className='flex flex-1 flex-col overflow-hidden font-mono text-[12px]'>
                <FormItem name='code' noStyle>
                  <CodeEditor
                    readOnly
                    shareValueKeys={shareValueKeys.map((k) => k.key)}
                    outputs={(watchedValues?.outputs ?? [])
                      .map((o: any) => o?.output_name)
                      .filter(Boolean)}
                  />
                </FormItem>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </Form>
    </Drawer>
  )
}
