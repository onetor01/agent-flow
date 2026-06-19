import { useState, useEffect, useRef, type FC } from 'react'
import { Button, Input } from 'antd'
import {
  PlusOutlined,
  UnorderedListOutlined,
  SearchOutlined,
  FolderOutlined,
  GlobalOutlined,
  RightOutlined,
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
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { AnimatePresence, motion } from 'motion/react'
import { getFlowPhase } from '@/common'
import { useFlowStore } from '@/webview/store/flow'
import { SortableFlowItem } from './SortableFlowItem'

const PANEL_WIDTH = 280

export const FlowListPanel: FC = () => {
  const {
    flows,
    activeFlowId,
    flowRunStates,
    save,
    setActiveFlowId,
    flowListCollapsed,
    setFlowListCollapsed,
  } = useFlowStore()
  const [searchText, setSearchText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const [globalCollapsed, setGlobalCollapsed] = useState(() => {
    const hasProjectFlows = flows.filter((f) => f.project).length > 0
    const globalFlowsHaveMessages = flows
      .filter((f) => !f.project)
      .some((f) => flowRunStates[f.id]?.runs.some((r) => r.messages.length > 0))
    return hasProjectFlows && !globalFlowsHaveMessages
  })
  const [projectCollapsed, setProjectCollapsed] = useState(false)

  const filteredFlows = searchText
    ? flows.filter((f) => f.name.toLowerCase().includes(searchText.toLowerCase()))
    : flows

  const projectFlows = filteredFlows.filter((f) => f.project)
  const globalFlows = filteredFlows.filter((f) => !f.project)
  const displayFlows = [...globalFlows, ...projectFlows]
  const hasWorkspace = projectFlows.length > 0 || !searchText

  useEffect(() => {
    if (!flowListCollapsed && activeFlowId && listRef.current) {
      const el = listRef.current?.querySelector(`[data-flow-id="${activeFlowId}"]`)
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [flowListCollapsed, activeFlowId])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = flows.findIndex((f) => f.id === active.id)
    const newIndex = flows.findIndex((f) => f.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    save((flows) => {
      const reordered = arrayMove(flows, oldIndex, newIndex)
      flows.length = 0
      flows.push(...reordered)
    })
  }

  const onAdd = (project?: boolean) => {
    const id = crypto.randomUUID()
    save((flows) => {
      flows.push({ id, name: '新建工作流', agents: [], ...(project ? { project: true } : {}) })
    })
    setActiveFlowId(id)
    if (flowListCollapsed) setFlowListCollapsed(false)
  }

  const onDelete = (id: string) => {
    save((flows) => {
      const idx = flows.findIndex((f) => f.id === id)
      if (idx >= 0) flows.splice(idx, 1)
    })
    if (activeFlowId === id) {
      // 从全量 flows（不受搜索过滤）中选取下一个 activeFlow
      const allGlobal = flows.filter((f) => !f.project)
      const allProject = flows.filter((f) => f.project)
      const remainingGlobal = allGlobal.filter((f) => f.id !== id)
      const remainingProject = allProject.filter((f) => f.id !== id)
      const next =
        remainingProject.length === 0 || (!globalCollapsed && projectCollapsed)
          ? remainingGlobal[0]
          : remainingProject[0]
      setActiveFlowId(next?.id)
    }
  }

  const onRename = (id: string, name: string) => {
    save((flows) => {
      const f = flows.find((f) => f.id === id)
      if (f) f.name = name
    })
  }

  const renderFlowItem = (flow: (typeof flows)[number]) => (
    <SortableFlowItem
      key={flow.id}
      flow={flow}
      isActive={flow.id === activeFlowId}
      phase={getFlowPhase(flowRunStates[flow.id])}
      onClick={() => setActiveFlowId(flow.id)}
      onDelete={() => onDelete(flow.id)}
      onRename={(name) => onRename(flow.id, name)}
    />
  )

  const renderGroupHeader = (opts: {
    icon: React.ReactNode
    label: string
    collapsed: boolean
    onToggle: () => void
    hasBorderTop?: boolean
  }) => (
    <div
      className={`flex cursor-pointer items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs text-[#4096ff] select-none hover:text-[#69b1ff] ${opts.hasBorderTop ? 'mt-1 border-t border-[#313244]' : ''}`}
      onClick={opts.onToggle}
    >
      {opts.icon}
      <span>{opts.label}</span>
      <RightOutlined
        className='ml-auto text-[10px] text-[#585b70] transition-transform duration-200'
        style={{ transform: opts.collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
      />
    </div>
  )

  return (
    <div
      className='absolute bottom-2 left-2 z-50'
      onKeyDown={(e) => {
        if (e.key !== 'Escape') e.stopPropagation()
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <AnimatePresence mode='wait'>
        {flowListCollapsed ? (
          <motion.div
            key='icon'
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
          >
            <Button
              type='text'
              size='large'
              icon={<UnorderedListOutlined style={{ fontSize: 18 }} />}
              onClick={() => setFlowListCollapsed(false)}
              className='rounded-lg bg-[#1e1e2e]/90! text-[#cdd6f4]! shadow-[0_2px_12px_rgba(0,0,0,0.4)] backdrop-blur-sm hover:bg-[#313244]! hover:text-[#6366f1]!'
            />
          </motion.div>
        ) : (
          <motion.div
            key='panel'
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            style={{ width: PANEL_WIDTH }}
            className='flex max-h-[70vh] flex-col rounded-xl border border-[#313244] bg-[#181825]/95 shadow-[0_4px_24px_rgba(0,0,0,0.5)] backdrop-blur-sm'
          >
            <div className='flex items-center justify-between border-b border-[#313244] px-3 py-2'>
              <span className='text-sm font-semibold text-[#cdd6f4]'>工作流列表</span>
              <span className='flex items-center gap-0.5'>
                {hasWorkspace && (
                  <Button
                    type='text'
                    size='small'
                    icon={<FolderOutlined />}
                    onClick={() => onAdd(true)}
                    title='新建项目工作流'
                    className='text-[#89b4fa]! hover:bg-[#313244]!'
                  />
                )}
                <Button
                  type='text'
                  size='small'
                  icon={<PlusOutlined />}
                  onClick={() => onAdd()}
                  title='新建全局工作流'
                  className='text-[#6366f1]! hover:bg-[#313244]!'
                />
                <Button
                  type='text'
                  size='small'
                  onClick={() => setFlowListCollapsed(true)}
                  className='text-[#a6adc8]! hover:bg-[#313244]! hover:text-[#cdd6f4]!'
                >
                  <svg width='14' height='14' viewBox='0 0 16 16' fill='currentColor'>
                    <path d='M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z' />
                  </svg>
                </Button>
              </span>
            </div>

            <div className='px-2 pt-2'>
              <Input
                size='small'
                placeholder='搜索工作流...'
                prefix={<SearchOutlined className='text-[#585b70]!' />}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onPaste={(e) => e.stopPropagation()}
                allowClear
                className='border-[#313244]! bg-[#1e1e2e]! text-[#cdd6f4]! [&_input]:bg-transparent! [&_input]:text-[#cdd6f4]! [&_input]:placeholder-[#585b70]!'
              />
            </div>

            <div
              ref={listRef}
              className='flex-1 overflow-y-auto p-1.5'
              style={{ scrollbarGutter: 'stable' }}
            >
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={displayFlows.map((f) => f.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {globalFlows.length > 0 &&
                    renderGroupHeader({
                      icon: <GlobalOutlined />,
                      label: '全局工作流',
                      collapsed: globalCollapsed,
                      onToggle: () => setGlobalCollapsed((v) => !v),
                    })}
                  <AnimatePresence initial={false}>
                    {!globalCollapsed && (
                      <motion.div
                        key='global-flows'
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeInOut' }}
                        style={{ overflow: 'hidden' }}
                      >
                        {globalFlows.map(renderFlowItem)}
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {projectFlows.length > 0 &&
                    renderGroupHeader({
                      icon: <FolderOutlined />,
                      label: '项目工作流',
                      collapsed: projectCollapsed,
                      onToggle: () => setProjectCollapsed((v) => !v),
                      hasBorderTop: true,
                    })}
                  <AnimatePresence initial={false}>
                    {!projectCollapsed && projectFlows.length > 0 && (
                      <motion.div
                        key='project-flows'
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeInOut' }}
                        style={{ overflow: 'hidden' }}
                      >
                        {projectFlows.map(renderFlowItem)}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </SortableContext>
              </DndContext>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
