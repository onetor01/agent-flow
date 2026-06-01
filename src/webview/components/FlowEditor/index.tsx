import { useEffect, useState, type FC } from 'react'
import { Drawer, Form, Input, Button, Switch, Tag, Tooltip, message } from 'antd'
import {
  CloseOutlined,
  EyeOutlined,
  EditOutlined,
  QuestionCircleOutlined,
  HolderOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  FileTextOutlined,
} from '@ant-design/icons'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ShareValueKey } from '@/common'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import { Md } from '../text-components'

type FormValues = {
  name: string
  shareValuesKeys: ShareValueKey[]
  shareValues: Record<string, string>
  base_url: string
  api_key: string
}

type SortableRowProps = {
  id: string | number
  fieldName: number
  isActive: boolean
  onClickKey: () => void
  onRemove: () => void
}

const SortableShareValueKeyRow: FC<SortableRowProps> = ({
  id,
  fieldName,
  isActive,
  onClickKey,
  onRemove,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} className='mb-2 flex items-center gap-2'>
      <span
        className='cursor-grab text-[#585b70] hover:text-[#a6adc8]'
        {...attributes}
        {...listeners}
      >
        <HolderOutlined />
      </span>
      <Form.Item
        name={[fieldName, 'key']}
        noStyle
        rules={[
          { required: true, message: '请输入 key' },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value) return Promise.resolve()
              const keys = (getFieldValue('shareValuesKeys') ?? []) as ShareValueKey[]
              const dupIdxs = keys.reduce<number[]>((acc, k, i) => {
                if (k?.key === value) acc.push(i)
                return acc
              }, [])
              if (dupIdxs.length <= 1) return Promise.resolve()
              // 所有重复行都 reject 标红；只有重复组的第一个带消息文本，其余 reject 空消息，
              // 由父 Form.Item 的 CSS 把空 explain-error 隐藏，避免冒泡多条相同提示。
              return Promise.reject(new Error(dupIdxs[0] === fieldName ? 'Key 不能重复' : ''))
            },
          }),
        ]}
      >
        <Input size='small' placeholder='变量key' className='w-30' />
      </Form.Item>
      <Form.Item name={[fieldName, 'desc']} noStyle>
        <Input size='small' placeholder='变量描述' className='flex-1' />
      </Form.Item>
      <FileTextOutlined
        onClick={onClickKey}
        className={isActive ? 'border-[#89b4fa] text-[#89b4fa]' : ''}
        title='编辑值'
      />
      <MinusCircleOutlined className='cursor-pointer text-[#f38ba8]' onClick={onRemove} />
    </div>
  )
}

export const FlowEditor: FC = () => {
  const editingFlowId = useFlowStore((s) => s.editingFlowId)
  const flows = useFlowStore((s) => s.flows)
  const save = useFlowStore((s) => s.save)
  const setEditingFlowId = useFlowStore((s) => s.setEditingFlowId)
  const setShareValues = useFlowStore((s) => s.setShareValues)
  const runShareValues = useFlowStore((s) =>
    editingFlowId ? s.flowRunStates[editingFlowId]?.shareValues : undefined,
  )

  const open = !!editingFlowId
  const flow = flows.find((f) => f.id === editingFlowId)

  const [form] = Form.useForm<FormValues>()
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState<'edit' | 'preview'>('edit')
  const [newKeyInput, setNewKeyInput] = useState('')

  const watchedShareValues = (Form.useWatch('shareValues', form) ?? {}) as Record<string, string>
  const watchedKeys = (Form.useWatch('shareValuesKeys', form) ?? []) as ShareValueKey[]

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  useEffect(() => {
    if (open && flow) {
      // shareValues 是 nested 字段，setFieldsValue 对未在新值中出现的子 key 不会清除，
      // 跨 flow 切换时会读到上一次 form 内部 store 的残留值，所以先 reset 再赋值。
      form.resetFields()
      form.setFieldsValue({
        name: flow.name,
        shareValuesKeys: flow.shareValuesKeys ?? [],
        shareValues: runShareValues ?? {},
        base_url: flow.base_url ?? '',
        api_key: flow.api_key ?? '',
      })
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditingKey(null)
      setNewKeyInput('')
    }
  }, [open, flow, runShareValues, form])

  if (!flow) return null

  const handleClose = () => setEditingFlowId(undefined)

  const handleFinish = (values: FormValues) => {
    const newKeys = (values.shareValuesKeys ?? []).map((k) => ({
      key: k.key,
      ...(k.desc ? { desc: k.desc } : {}),
    }))
    const newKeyStrs = newKeys.map((k) => k.key)
    const sourceValues = form.getFieldsValue(true)?.shareValues ?? {}
    const cleanedValues = Object.fromEntries(
      newKeyStrs
        .map((k) => (typeof sourceValues[k] === 'string' ? [k, sourceValues[k]] : null))
        .filter(Boolean) as [string, string][],
    )
    const oldKeyStrs = (flow.shareValuesKeys ?? []).map((k) => k.key)
    const removedKeys = oldKeyStrs.filter((k) => !newKeyStrs.includes(k))
    save((draft) => {
      const target = draft.find((f) => f.id === flow.id)
      if (!target) return
      target.name = values.name.trim() || target.name
      target.shareValuesKeys = newKeys
      target.base_url = values.base_url
      target.api_key = values.api_key
      for (const agent of target.agents ?? []) {
        // allowed_*_values_keys 仅 node_type='agent' 节点有,code 节点跳过
        if (agent.node_type === 'code') continue
        if (agent.allowed_read_values_keys) {
          agent.allowed_read_values_keys = agent.allowed_read_values_keys.filter(
            (k) => !removedKeys.includes(k),
          )
        }
        if (agent.allowed_write_values_keys) {
          agent.allowed_write_values_keys = agent.allowed_write_values_keys.filter(
            (k) => !removedKeys.includes(k),
          )
        }
      }
    })
    // shareValues 是运行时数据，不进入持久化的 Flow 定义；
    // 通过单独的 setShareValues 命令同步到运行中的 RunState（无 active run 时为 no-op）。
    setShareValues(flow.id, cleanedValues)
    handleClose()
  }

  const editingValue = editingKey ? (watchedShareValues[editingKey] ?? '') : ''

  return (
    <Drawer
      key={flow.id}
      title={null}
      placement='left'
      open={open}
      onClose={handleClose}
      size='auto'
      styles={{
        header: { display: 'none' },
        body: { padding: 0 },
        wrapper: { transition: 'none' },
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
        onFinish={handleFinish}
      >
        <div className='flex w-150 flex-col'>
          <div className='border-b border-[#313244] px-3 py-2 text-xs font-bold'>
            <CloseOutlined onClick={handleClose} className='mr-2' />
            <span>编辑工作流</span>
          </div>
          <div className='flex-1 overflow-auto'>
            <div className='p-4'>
              <Form.Item
                name='name'
                label='名称'
                rules={[{ required: true, message: '请输入名称' }]}
              >
                <Input placeholder='工作流名称' />
              </Form.Item>
              <Form.Item
                className='[&_.ant-form-item-explain-error:empty]:hidden'
                label={
                  <span>
                    共享数据
                    <Tooltip title='点击 key 标签打开右侧面板编辑值；编辑描述；点叉号删除该 key；拖拽手柄调整顺序'>
                      <QuestionCircleOutlined style={{ marginInlineStart: 4 }} />
                    </Tooltip>
                    <Button
                      type='link'
                      size='small'
                      onClick={() => {
                        form.setFieldValue('shareValues', {})
                        setShareValues(flow.id, {})
                        setEditingKey(null)
                      }}
                    >
                      清空
                    </Button>
                  </span>
                }
              >
                <Form.List name='shareValuesKeys'>
                  {(fields, { add, remove, move }) => {
                    const onDragEnd = (event: DragEndEvent) => {
                      const { active, over } = event
                      if (!over || active.id === over.id) return
                      const oldIdx = fields.findIndex((f) => String(f.key) === active.id)
                      const newIdx = fields.findIndex((f) => String(f.key) === over.id)
                      if (oldIdx !== -1 && newIdx !== -1) {
                        move(oldIdx, newIdx)
                      }
                    }

                    const tryAdd = () => {
                      const v = newKeyInput.trim()
                      if (!v) return
                      const current = (form.getFieldValue('shareValuesKeys') ??
                        []) as ShareValueKey[]
                      if (current.some((k) => k.key === v)) {
                        message.error('Key 不能重复')
                        return
                      }
                      add({ key: v })
                      setNewKeyInput('')
                    }

                    return (
                      <>
                        <DndContext
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={onDragEnd}
                        >
                          <SortableContext
                            items={fields.map((f) => String(f.key))}
                            strategy={verticalListSortingStrategy}
                          >
                            {fields.map((field, idx) => {
                              const k = watchedKeys[idx]?.key ?? ''
                              return (
                                <SortableShareValueKeyRow
                                  key={field.key}
                                  id={String(field.key)}
                                  fieldName={field.name}
                                  isActive={!!k && k === editingKey}
                                  onClickKey={() => {
                                    if (!k) return
                                    setEditingKey((curK) => (k === curK ? null : k))
                                    setPreviewMode('preview')
                                  }}
                                  onRemove={() => {
                                    if (editingKey === k) setEditingKey(null)
                                    remove(field.name)
                                  }}
                                />
                              )
                            })}
                          </SortableContext>
                        </DndContext>
                        <div className='mt-2 flex items-center gap-2'>
                          <Input
                            size='small'
                            placeholder='输入新 key 后回车添加'
                            value={newKeyInput}
                            onChange={(e) => setNewKeyInput(e.target.value)}
                            onPressEnter={(e) => {
                              e.preventDefault()
                              tryAdd()
                            }}
                          />
                          <Button
                            type='dashed'
                            size='small'
                            icon={<PlusOutlined />}
                            onClick={tryAdd}
                          >
                            添加
                          </Button>
                        </div>
                      </>
                    )
                  }}
                </Form.List>
              </Form.Item>
              <Form.Item
                name='base_url'
                label='Base URL'
                tooltip='Flow 默认 base url;Agent 同名字段非空时覆盖,注入 SDK 子进程的 ANTHROPIC_BASE_URL'
              >
                <Input placeholder='例如 https://api.anthropic.com' />
              </Form.Item>
              <Form.Item
                name='api_key'
                label='API Key'
                tooltip='Flow 默认 api key;Agent 同名字段非空时覆盖,注入 SDK 子进程的 ANTHROPIC_AUTH_TOKEN'
              >
                <Input placeholder='sk-ant-...' />
              </Form.Item>
            </div>
          </div>
          <div className='border-t border-[#313244] px-4 py-3'>
            <Button type='primary' htmlType='submit' block>
              保存
            </Button>
          </div>
        </div>

        {editingKey && (
          <div className='flex h-full w-150 flex-col overflow-hidden border-l border-[#313244]'>
            <div className='flex items-center gap-2 px-3 py-2'>
              <span className='text-[12px] text-[#a6adc8]'>{editingKey}</span>
              <Switch
                size='small'
                checked={previewMode === 'preview'}
                onChange={(v) => setPreviewMode(v ? 'preview' : 'edit')}
                checkedChildren={<EyeOutlined />}
                unCheckedChildren={<EditOutlined />}
              />
            </div>
            <div className={cn('flex-1 overflow-hidden', { 'px-2': previewMode === 'edit' })}>
              <Form.Item key={editingKey} name={['shareValues', editingKey]} noStyle>
                <Input.TextArea
                  className={cn('hidden h-full w-full resize-none overflow-auto', {
                    block: previewMode === 'edit',
                  })}
                  placeholder='输入共享数据内容'
                />
              </Form.Item>
              {previewMode === 'preview' && (
                <Md
                  content={editingValue}
                  className='h-full overflow-auto p-3 break-all whitespace-pre-wrap'
                ></Md>
              )}
            </div>
          </div>
        )}
      </Form>
    </Drawer>
  )
}
