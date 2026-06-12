import { useRef, useState } from 'react'
import type { FC, MouseEvent } from 'react'
import { AutoComplete, Tag } from 'antd'
import { MODELS } from '@/common'
import { useFlowStore } from '@/webview/store/flow'

interface ModelEditorProps {
  model: string
  flowId: string
  agentId: string
}

export const ModelEditor: FC<ModelEditorProps> = ({ model, flowId, agentId }) => {
  const [editing, setEditing] = useState(false)
  const [width, setWidth] = useState(80)
  const tagRef = useRef<HTMLSpanElement>(null)

  const save = (val: string) => {
    if (!val) return
    useFlowStore.getState().save((flows) => {
      const f = flows.find((f) => f.id === flowId)
      const a = f?.agents?.find((a) => a.id === agentId)
      if (a && a.node_type !== 'code') a.model = val
    })
  }

  const enterEdit = (e: MouseEvent) => {
    e.stopPropagation()
    setWidth(tagRef.current?.offsetWidth ?? 80)
    setEditing(true)
  }

  if (editing) {
    return (
      <AutoComplete
        autoFocus
        defaultOpen
        allowClear
        defaultValue={model}
        size='small'
        style={{ fontSize: 10, width, minWidth: 80 }}
        className='nodrag nopan !h-[22px] [&_.ant-select-selection-search-input]:!h-[22px] [&_.ant-select-selector]:!h-[22px] [&_.ant-select-selector]:!min-h-[22px]'
        options={Array.from(MODELS).map((m) => ({ value: m, label: m }))}
        filterOption={(input, option) =>
          (option?.label as string)?.toLowerCase().includes(input.toLowerCase()) ?? false
        }
        onSelect={(val) => {
          save(val)
          setEditing(false)
        }}
        onBlur={(e) => {
          save((e.target as HTMLInputElement).value)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <Tag ref={tagRef} color='blue' className='cursor-pointer' onClick={enterEdit}>
      {model}
    </Tag>
  )
}
