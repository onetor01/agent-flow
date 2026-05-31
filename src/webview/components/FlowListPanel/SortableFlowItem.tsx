import { useState, type FC } from 'react'
import { Typography } from 'antd'
import { HolderOutlined, DeleteOutlined, BlockOutlined, DatabaseOutlined } from '@ant-design/icons'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Flow, FlowPhase } from '@/common'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'

const PHASE_CONFIG: Record<
  Exclude<FlowPhase, 'idle'>,
  { color: string; label: string; animate: boolean }
> = {
  starting: { color: 'bg-[#f9e2af]', label: '启动中', animate: true },
  running: { color: 'bg-[#a6e3a1]', label: 'AI 生成中', animate: true },
  result: { color: 'bg-[#89b4fa]', label: '生成完毕', animate: true },
  interrupted: { color: 'bg-[#f9e2af]', label: '已中断', animate: true },
  'awaiting-question': { color: 'bg-[#cba6f7]', label: '需要回答', animate: true },
  'awaiting-tool-permission': { color: 'bg-[#f9e2af]', label: '请求授权', animate: true },
  'awaiting-complete-confirm': { color: 'bg-[#f9e2af]', label: '等待完成确认', animate: true },
  completed: { color: 'bg-[#a6e3a1]/60', label: '已完成', animate: false },
  stopped: { color: 'bg-[#9399b2]', label: '已停止', animate: false },
  error: { color: 'bg-[#f38ba8]', label: '出错', animate: false },
}

export type SortableFlowItemProps = {
  flow: Flow
  isActive: boolean
  phase?: FlowPhase
  onClick: () => void
  onDelete: () => void
  onRename: (name: string) => void
}

export const SortableFlowItem: FC<SortableFlowItemProps> = (props) => {
  const { flow, isActive, phase, onClick, onDelete, onRename } = props
  const { save, setActiveFlowId, setFlowListCollapsed, setEditingFlowId } = useFlowStore()
  const { id, name } = flow
  const [editing, setEditing] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const statusConfig = phase && phase !== 'idle' ? PHASE_CONFIG[phase] : undefined

  return (
    <div
      ref={setNodeRef}
      data-flow-id={id}
      style={style}
      className={cn(
        'group cursor-pointer rounded-md px-2 py-1.5 text-[13px] transition-colors',
        isActive ? 'bg-[#313244] text-[#cdd6f4]' : 'text-[#a6adc8] hover:bg-[#1e1e2e]',
      )}
      onClick={onClick}
    >
      <div className='flex items-center gap-1'>
        <span
          className='cursor-grab text-[#585b70] opacity-0 transition-opacity group-hover:opacity-100'
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <HolderOutlined />
        </span>

        <div
          className='flex-1'
          onClick={(e) => {
            const t = e.target as HTMLElement
            if (editing || t.closest('.ant-typography-edit')) {
              e.stopPropagation()
            }
          }}
        >
          <Typography.Text
            editable={{
              editing,
              onStart: () => setEditing(true),
              onEnd: () => setEditing(false),
              onChange: (val) => {
                setEditing(false)
                if (val && val !== name) {
                  onRename?.(val)
                }
              },
            }}
            ellipsis
            className='w-full'
          >
            {name}
          </Typography.Text>
        </div>

        <span
          className='flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'
          onClick={(e) => e.stopPropagation()}
        >
          <DatabaseOutlined
            title='编辑工作流'
            onClick={(e) => {
              setEditingFlowId(id)
            }}
            className={cn(
              'text-[#a6adc8]! opacity-0 transition-opacity group-hover:opacity-100',
              (flow.shareValuesKeys?.length ?? 0) > 0
                ? 'hover:text-[#a6e3a1]!'
                : 'hover:text-[#89b4fa]!',
            )}
          />
          <BlockOutlined
            title='克隆'
            onClick={() => {
              const newId = crypto.randomUUID()
              const cloned = structuredClone(flow)
              cloned.id = newId
              save((flows) => flows.push(cloned))
              setActiveFlowId(newId)
              setFlowListCollapsed(false)
            }}
            className='text-[#a6adc8]! opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#89b4fa]!'
          />
          <Typography.Text
            copyable={{ tooltips: false, text: () => JSON.stringify(flow, null, 2) }}
          />
          <DeleteOutlined className='text-[#a6adc8]! hover:text-[#f38ba8]!' onClick={onDelete} />
        </span>
      </div>

      {statusConfig && (
        <div className='mt-0.5 flex items-center gap-1.5 pl-6 text-[11px] text-[#a6adc8]'>
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              statusConfig.color,
              statusConfig.animate && 'animate-pulse',
            )}
          />
          <span>{statusConfig.label}</span>
        </div>
      )}
    </div>
  )
}
