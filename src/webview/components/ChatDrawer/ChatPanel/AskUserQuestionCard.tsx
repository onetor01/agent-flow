import { ReactNode, useLayoutEffect, useMemo, useRef, useState, type FC } from 'react'
import { Button, Checkbox, Input, Popover, Radio, Tag } from 'antd'
import { CheckOutlined, LoadingOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { useMemoizedFn } from 'ahooks'
import type { AskUserQuestionInput, AskUserQuestionItem, AskUserQuestionOutput } from '@/common'
import { Md } from '../../text-components'

type Props = {
  input: AskUserQuestionInput
  mode: 'active' | 'historical'
  /** 历史态时展示用户之前选中的 label 列表（按 question 映射） */
  answeredValues?: Record<string, string[]>
  /** 历史态下：用户已回答但工具执行结果尚未到达时展示 loading 按钮 */
  loading?: boolean
  onSubmit?: (output: AskUserQuestionOutput) => void
  /** 测量到题目高度后通知父组件调整容器高度（传原始值，clamping 由父组件负责） */
  onChangeHeight?: (height: number) => void
  fork?: ReactNode
}

type Selections = Record<number, string[]>
type OtherState = { text: string }

const ANSWER_SEP = '\x1F'
const OTHER_LABEL = 'Other'
const OTHER_OPTION = { label: OTHER_LABEL, description: '自定义回答' }

function buildOutput(
  questions: AskUserQuestionItem[],
  selections: Selections,
  otherStates: Record<number, OtherState>,
): AskUserQuestionOutput {
  const answers: Record<string, string> = {}
  questions.forEach((q, i) => {
    const sel = selections[i] ?? []
    const o = otherStates[i]
    const effective = sel.map((s) => (s === OTHER_LABEL && o?.text ? o.text : s))
    answers[q.question] = effective.join(ANSWER_SEP)
  })
  return { questions, answers }
}

/** 发送按钮可点：多选允许零选项（用户主动放弃），单选必须有值，选了 Other 必须填字 */
function isQuestionAnswered(
  q: AskUserQuestionItem,
  idx: number,
  sels: Selections,
  others: Record<number, OtherState>,
): boolean {
  const sel = sels[idx] ?? []
  if (q.multiSelect && sel.length === 0) return true
  if (sel.length === 0) return false
  if (sel.includes(OTHER_LABEL)) {
    const o = others[idx]
    if (!o || !o.text.trim()) return false
  }
  return true
}

/** 自动导航判定：必须显式交互过——多选空数组也视为未答，避免自动跳过用户没看过的题 */
function isQuestionExplicitlyAnswered(
  idx: number,
  sels: Selections,
  others: Record<number, OtherState>,
): boolean {
  const sel = sels[idx] ?? []
  if (sel.length === 0) return false
  if (sel.includes(OTHER_LABEL)) {
    const o = others[idx]
    if (!o || !o.text.trim()) return false
  }
  return true
}

export const AskUserQuestionCard: FC<Props> = ({
  input,
  mode,
  answeredValues,
  loading,
  onSubmit,
  onChangeHeight,
  fork,
}) => {
  const questions = useMemo(() => input.questions ?? [], [input.questions])
  const isActive = mode === 'active'
  const [selections, setSelections] = useState<Selections>({})
  const [otherStates, setOtherStates] = useState<Record<number, OtherState>>({})

  const questionRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const stableOnSubmit = useMemoizedFn((output: AskUserQuestionOutput) => onSubmit?.(output))
  const stableOnChangeHeight = useMemoizedFn((height: number) => onChangeHeight?.(height))

  // 首次渲染测量第一题高度，通知父容器自适应
  // 使用 requestAnimationFrame 延迟一帧，确保 framer-motion 动画已启动、
  // 容器脱离 height:0 状态后再测量，避免 getBoundingClientRect 返回 0
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => {
      let maxHeight = 0
      questionRefs.current?.forEach((el) => {
        maxHeight = Math.max(el.getBoundingClientRect().height, maxHeight)
      })
      stableOnChangeHeight(maxHeight + 90)
    })
    return () => cancelAnimationFrame(raf)
  }, [questions, stableOnChangeHeight])

  const allAnswered = useMemo(() => {
    return questions.every((q, i) => isQuestionAnswered(q, i, selections, otherStates))
  }, [questions, selections, otherStates])

  /** 导航逻辑：找首个未显式回答的题（含当前题之前的）→ 滚过去；全部已答 → 提交。
   *  多选空数组视为未答，因此自动导航不会跳过没交互的多选题；用户须显式点"发送"。 */
  const navigate = useMemoizedFn(
    (_currentIdx: number, sels?: Selections, others?: Record<number, OtherState>) => {
      const curSels = sels ?? selections
      const curOthers = others ?? otherStates
      const firstUnanswered = questions.findIndex(
        (_q, i) => !isQuestionExplicitlyAnswered(i, curSels, curOthers),
      )
      if (firstUnanswered === -1) {
        stableOnSubmit(buildOutput(questions, curSels, curOthers))
        return
      }
      const el = questionRefs.current.get(firstUnanswered)
      if (el) {
        requestAnimationFrame(() => {
          el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        })
      }
    },
  )

  const handleRadioChange = (qIdx: number, value: string) => {
    if (!isActive) return
    const newSelections = { ...selections, [qIdx]: [value] }
    setSelections(newSelections)

    if (value === OTHER_LABEL) {
      if (!otherStates[qIdx]) {
        setOtherStates((prev) => ({ ...prev, [qIdx]: { text: '' } }))
      }
    } else {
      const newOthers = { ...otherStates }
      delete newOthers[qIdx]
      setOtherStates(newOthers)
      // Radio 选中非 Other → 自动导航
      navigate(qIdx, newSelections, newOthers)
    }
  }

  const handleCheckboxChange = (qIdx: number, values: string[]) => {
    if (!isActive) return
    setSelections((prev) => ({ ...prev, [qIdx]: values }))

    if (values.includes(OTHER_LABEL)) {
      setOtherStates((prev) => (prev[qIdx] ? prev : { ...prev, [qIdx]: { text: '' } }))
    } else {
      setOtherStates((prev) => {
        if (!(qIdx in prev)) return prev
        const next = { ...prev }
        delete next[qIdx]
        return next
      })
    }
  }

  const handleOtherTextChange = (qIdx: number, text: string) => {
    setOtherStates((prev) => ({ ...prev, [qIdx]: { text } }))
  }

  /** textarea 内：修饰键+Enter 换行，单 Enter 导航/提交 */
  const handleTextAreaKeyDown = (qIdx: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    navigate(qIdx)
  }

  const handleManualSend = () => {
    if (!allAnswered) return
    onSubmit?.(buildOutput(questions, selections, otherStates))
  }

  // 历史态：根据 answeredValues 推断预置选项与 "Other" 的自定义文本
  const getHistoricalDisplay = (q: AskUserQuestionItem) => {
    const arr = answeredValues?.[q.question] ?? []
    const predefined = new Set(q.options.map((o) => o.label))
    const predefinedSelected = arr.filter((v) => predefined.has(v))
    const customText = arr.find((v) => !predefined.has(v))
    const values = customText ? [...predefinedSelected, OTHER_LABEL] : predefinedSelected
    return { values, customText: customText ?? '' }
  }

  return (
    <div className='flex flex-col gap-2 overflow-x-hidden rounded-md border border-[#45475a] bg-[#181825] px-3 py-2'>
      <div className='flex items-center gap-2'>
        <QuestionCircleOutlined className='text-[#89b4fa]' />
        <span className='text-xs font-semibold text-[#cdd6f4]'>AI 提问</span>
        {mode === 'historical' &&
          (answeredValues ? (
            <Tag color={'success'} className='m-0 text-xs' icon={<CheckOutlined />}>
              已回答
            </Tag>
          ) : (
            <Tag color={'warning'} className='m-0 text-xs'>
              已中断
            </Tag>
          ))}
        {fork}
      </div>

      {questions.map((q, qIdx) => {
        const multi = !!q.multiSelect
        const historical = !isActive ? getHistoricalDisplay(q) : null
        const value = isActive ? (selections[qIdx] ?? []) : historical!.values
        const otherSelected = value.includes(OTHER_LABEL)
        const otherText = isActive
          ? (otherStates[qIdx]?.text ?? '')
          : (historical?.customText ?? '')

        return (
          <div
            key={qIdx}
            ref={(el) => {
              if (el) questionRefs.current.set(qIdx, el)
              else questionRefs.current.delete(qIdx)
            }}
            className='flex flex-col gap-1.5'
          >
            <div className='flex items-start justify-between gap-2'>
              <Md content={q.question} className='text-sm text-[#cdd6f4]'></Md>
              {q.header && (
                <Tag color='processing' className='m-0 shrink-0 text-xs'>
                  {q.header}
                </Tag>
              )}
            </div>
            {multi ? (
              <Checkbox.Group
                value={value}
                disabled={!isActive}
                onChange={(vs) => handleCheckboxChange(qIdx, vs as string[])}
                className='flex flex-col gap-1'
              >
                {q.options.map((opt) => (
                  <OptionRow key={opt.label} option={opt}>
                    <Checkbox value={opt.label} />
                  </OptionRow>
                ))}
                <OptionRow option={OTHER_OPTION}>
                  <Checkbox value={OTHER_LABEL} />
                </OptionRow>
              </Checkbox.Group>
            ) : (
              <Radio.Group
                value={value[0]}
                disabled={!isActive}
                onChange={(e) => handleRadioChange(qIdx, e.target.value)}
                className='flex flex-col gap-1'
              >
                {q.options.map((opt) => (
                  <OptionRow key={opt.label} option={opt}>
                    <Radio value={opt.label} />
                  </OptionRow>
                ))}
                <OptionRow option={OTHER_OPTION}>
                  <Radio value={OTHER_LABEL} />
                </OptionRow>
              </Radio.Group>
            )}
            {otherSelected && (
              <div className='flex flex-col gap-1 pl-6'>
                <Input.TextArea
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  value={otherText}
                  disabled={!isActive}
                  onChange={(e) => handleOtherTextChange(qIdx, e.target.value)}
                  onKeyDown={(e) => handleTextAreaKeyDown(qIdx, e)}
                  placeholder='输入自定义回答...'
                  className='text-sm'
                />
              </div>
            )}
          </div>
        )
      })}

      {isActive && (
        <div className='flex justify-end'>
          <Button type='primary' size='small' disabled={!allAnswered} onClick={handleManualSend}>
            发送
          </Button>
        </div>
      )}
      {/* 历史态：用户已回答但工具执行结果尚未到达 → 展示 loading 发送按钮 */}
      {mode === 'historical' && loading && (
        <div className='flex justify-end'>
          <Button type='primary' size='small' loading>
            发送
          </Button>
        </div>
      )}
    </div>
  )
}

const OptionRow: FC<{
  option: { label: string; description: string; preview?: string }
  children: React.ReactNode
}> = ({ option, children }) => {
  const content = (
    <label className='flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-[#313244]'>
      {children}
      <span className='flex flex-col gap-0.5'>
        <span className='text-sm text-[#cdd6f4]'>{option.label}</span>
        {option.description && (
          <span className='text-xs leading-snug text-[#a6adc8]'>{option.description}</span>
        )}
      </span>
    </label>
  )
  if (option.preview) {
    return (
      <Popover
        content={
          <pre className='m-0 max-w-[320px] text-xs whitespace-pre-wrap'>{option.preview}</pre>
        }
        placement='right'
        trigger={['hover', 'focus']}
      >
        {content}
      </Popover>
    )
  }
  return content
}
