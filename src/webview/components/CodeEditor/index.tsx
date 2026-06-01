import { autocompletion, type CompletionContext, type CompletionSource } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { indentRange } from '@codemirror/language'
import { Compartment, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { FC } from 'react'

export type CodeEditorProps = {
  value?: string
  onChange?: (value: string) => void
  /** 当前 Flow 的 shareValues key 列表 —— 注入到补全项 */
  shareValueKeys?: string[]
  /** 当前节点的输出分支名称列表 —— 注入到 CodeResult 返回值类型 */
  outputs?: string[]
}

// ── 主题：oneDark + 填满父容器（覆盖 CodeMirror 默认 height:auto / maxHeight:500px）──
const theme = [
  oneDark,
  EditorView.theme({
    '&': { height: '100%' },
    '.cm-scroller': { overflow: 'auto' },
  }),
]

// ── 补全源工厂：根据 shareValueKeys / outputs 动态生成 input / values / runCommand 补全 ──
function createCompletionSource(
  shareValueKeys: string[],
  outputs: string[],
): CompletionSource {
  const outputType =
    outputs.length > 0 ? outputs.map((n) => `'${n}'`).join(' | ') : 'undefined'

  return (ctx: CompletionContext) => {
    // values.xxx → 补全 shareValueKeys
    const valuesDot = ctx.matchBefore(/values\.\w*/)
    if (valuesDot) {
      return {
        from: valuesDot.from + 'values.'.length,
        options: shareValueKeys.map((k) => ({
          label: k,
          type: 'property',
          detail: 'string',
        })),
      }
    }

    // 普通标识符 → 补全 input / values / runCommand / CodeResult
    const word = ctx.matchBefore(/\w*/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null

    return {
      from: word.from,
      options: [
        {
          label: 'input',
          type: 'variable',
          detail: 'string',
          info: '上游节点 AgentComplete.content 传入的文本；no_input 模式时为 "开始"',
        },
        {
          label: 'values',
          type: 'variable',
          detail: 'Record<string, string>',
          info: 'Flow 级共享存储（按 key 授权读写）。Code 节点可全量读写所有 shareValues。',
        },
        {
          label: 'runCommand',
          type: 'function',
          detail: '(command: string, timeout?: number) => Promise<string>',
          info: '在 VSCode workspaceFolder 下执行 shell 命令，返回 stdout + stderr 拼接的字符串',
        },
        {
          label: 'CodeResult',
          type: 'type',
          detail: `{ output_name?: ${outputType}; content?: string; values?: Record<string, string> }`,
          info: 'Code 节点返回值类型 — 返回对象 / 字符串 / void',
        },
        ...shareValueKeys.map((k) => ({
          label: k,
          type: 'property',
          detail: 'values key',
        })),
      ],
    }
  }
}

/**
 * Code 节点的 CodeMirror 编辑器，提供：
 * - JavaScript 语法高亮（oneDark 主题）
 * - Shift+Alt+F 全量缩进格式化
 * - 基于 shareValueKeys / outputs 的补全（input / values.* / runCommand / CodeResult）
 *
 * 生命周期：mount 时创建 → unmount 时 destroy，中间通过 ref 同步 value。
 */
export const CodeEditor: FC<CodeEditorProps> = ({
  value = '',
  onChange,
  shareValueKeys = [],
  outputs = [],
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 防止 editor → onChange → form → value prop → editor.setValue 形成回环
  const suppressNextChangeRef = useRef(false)
  // 补全源随 props 变化重建，通过 Compartment 热替换
  const completionRef = useRef<Extension>([])
  const compRef = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // ── 初始化编辑器 ──
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 用 mount 时刻的 props 构建初始补全扩展
    completionRef.current = autocompletion({
      override: [createCompletionSource(shareValueKeys, outputs)],
    })

    const view = new EditorView({
      doc: value,
      extensions: [
        theme,
        javascript(),
        compRef.current.of(completionRef.current),
        // Shift+Alt+F = 全量缩进
        keymap.of([
          {
            key: 'Shift-Alt-f',
            run: (view) => {
              view.dispatch({
                changes: indentRange(view.state, 0, view.state.doc.length),
              })
              return true
            },
          },
        ]),
        // editor → onChange：用户编辑时通知外部（Form）
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            if (suppressNextChangeRef.current) {
              suppressNextChangeRef.current = false
              return
            }
            onChangeRef.current?.(update.state.doc.toString())
          }
        }),
      ],
      parent: container,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 仅 mount 时执行一次；value / shareValueKeys / outputs 变化由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 外部 value → editor（form.setFieldsValue / 切换 agent 时）──
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      // 标记：接下来 replace 触发的 updateListener 不回调 onChange
      suppressNextChangeRef.current = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value ?? '' },
      })
    }
  }, [value])

  // ── shareValueKeys / outputs 变化 → 重建补全源并热替换 ──
  useEffect(() => {
    completionRef.current = autocompletion({
      override: [createCompletionSource(shareValueKeys, outputs)],
    })
    viewRef.current?.dispatch({
      effects: compRef.current.reconfigure(completionRef.current),
    })
  }, [shareValueKeys, outputs])

  return (
    <div
      ref={containerRef}
      className='h-full w-full'
      // 阻止 Form 的全局 onKeyDown 拦截 Tab（CodeMirror 需要 Tab 做缩进）
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}
