import { type FC } from 'react'
import { Input, Radio } from 'antd'

type Option = {
  value: string
  label: string
  description?: string
}

type Props = {
  options: Option[]
  /** 触发显示文本输入的 value */
  inputTriggerValue: string
  value?: string
  inputValue?: string
  disabled?: boolean
  inputPlaceholder?: string
  onChange?: (value: string) => void
  onInputChange?: (text: string) => void
  onInputKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

export const RadioWithInput: FC<Props> = ({
  options,
  inputTriggerValue,
  value,
  inputValue = '',
  disabled,
  inputPlaceholder,
  onChange,
  onInputChange,
  onInputKeyDown,
}) => (
  <Radio.Group
    value={value}
    disabled={disabled}
    onChange={(e) => onChange?.(e.target.value)}
    className='flex flex-col gap-1'
  >
    {options.map((opt) => (
      <label
        key={opt.value}
        className='flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-[#313244]'
      >
        <Radio value={opt.value} />
        <span className='flex flex-col gap-0.5'>
          <span className='text-sm text-[#cdd6f4]'>{opt.label}</span>
          {opt.description && (
            <span className='text-xs leading-snug text-[#a6adc8]'>{opt.description}</span>
          )}
        </span>
      </label>
    ))}
    {value === inputTriggerValue && (
      <div className='flex flex-col gap-1 pl-6'>
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 3 }}
          value={inputValue}
          disabled={disabled}
          onChange={(e) => onInputChange?.(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={inputPlaceholder ?? '输入原因...'}
          className='text-sm'
        />
      </div>
    )}
  </Radio.Group>
)
