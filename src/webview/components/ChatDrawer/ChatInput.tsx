import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FC } from 'react'
import { App, Button } from 'antd'
import { ArrowUpOutlined, LoadingOutlined } from '@ant-design/icons'
import {
  createEditor,
  Editor,
  Element as SlateElement,
  Transforms,
  type BaseEditor,
  type Descendant,
} from 'slate'
import { HistoryEditor, withHistory } from 'slate-history'
import {
  Editable,
  ReactEditor,
  Slate,
  useSelected,
  useSlateStatic,
  withReact,
  type RenderElementProps,
} from 'slate-react'
import { match, P } from 'ts-pattern'
import type { AgentChatInputState, UserMessageType } from '@/common'
import type { CodeRef } from '@/webview/components/CodeRefChip'
import { CodeRefChip } from '@/webview/components/CodeRefChip'
import { FileRefChip, type FileRefData } from '@/webview/components/FileRefChip'
import { subscribeExtensionMessage } from '@/webview/utils/ExtensionMessage'

// ── Slate schema ─────────────────────────────────────────────────
//
// 节点里**只保留轻量元数据**，避免 text / File / dataUrl 等大字段进入
// Slate 树（会被 withHistory 的快照以及 immer 式变换持有）。
// 具体内容（代码片段文本、文件句柄）放在组件内的 ref store，按 id 查找。

type CodeRefMeta = Pick<CodeRef, 'id' | 'filename' | 'languageId' | 'line'>
type FileRefMeta = Pick<FileRefData, 'id' | 'name' | 'mimeType' | 'size'>

type ParagraphElement = { type: 'paragraph'; children: Descendant[] }
type CodeRefElement = { type: 'code-ref'; codeRef: CodeRefMeta; children: [{ text: '' }] }
type FileRefElement = { type: 'file-ref'; file: FileRefMeta; children: [{ text: '' }] }
type CustomElement = ParagraphElement | CodeRefElement | FileRefElement
type CustomText = { text: string }

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor
    Element: CustomElement
    Text: CustomText
  }
}

const emptyParagraph = (): ParagraphElement => ({
  type: 'paragraph',
  children: [{ text: '' }],
})

function withInlines(editor: Editor): Editor {
  const { isInline, isVoid } = editor
  editor.isInline = (el) => (el.type === 'code-ref' || el.type === 'file-ref' ? true : isInline(el))
  editor.isVoid = (el) => (el.type === 'code-ref' || el.type === 'file-ref' ? true : isVoid(el))
  return editor
}

// ── 外部存储：按 editor 实例隔离，按 id 查大字段 ───────────────────
//
// 只存**发送时真正需要的内容**：
// - 代码片段：有行范围时存片段文本；整文件不存（序列化为 <file_ref />，交给 AI 自己 Read）
// - 图片文件：base64 字符串，用于序列化 image block 和渲染缩略图
// - 文本文件：UTF-8 文本，用于序列化 <attachment>...</attachment>
// 其他非图片/非文本的粘贴文件在 paste 阶段就被拒收，不会进入 store。

type RefStore = {
  codeTexts: Map<string, string>
  imageBase64: Map<string, string>
  textContents: Map<string, string>
}

const refStoreMap = new WeakMap<Editor, RefStore>()

function getRefStore(editor: Editor): RefStore {
  let s = refStoreMap.get(editor)
  if (!s) {
    s = { codeTexts: new Map(), imageBase64: new Map(), textContents: new Map() }
    refStoreMap.set(editor, s)
  }
  return s
}

/** 清理 store 里没有对应 node 的孤儿条目（关闭 tag 时调用） */
function pruneRefStore(editor: Editor): void {
  const store = getRefStore(editor)
  const aliveCodeIds = new Set<string>()
  const aliveFileIds = new Set<string>()
  for (const [node] of Editor.nodes(editor, {
    at: [],
    match: (n) => SlateElement.isElement(n) && (n.type === 'code-ref' || n.type === 'file-ref'),
  })) {
    if (SlateElement.isElement(node)) {
      if (node.type === 'code-ref') aliveCodeIds.add(node.codeRef.id)
      else if (node.type === 'file-ref') aliveFileIds.add(node.file.id)
    }
  }
  for (const id of store.codeTexts.keys()) {
    if (!aliveCodeIds.has(id)) store.codeTexts.delete(id)
  }
  for (const id of store.imageBase64.keys()) {
    if (!aliveFileIds.has(id)) store.imageBase64.delete(id)
  }
  for (const id of store.textContents.keys()) {
    if (!aliveFileIds.has(id)) store.textContents.delete(id)
  }
}

// ── 内容序列化 ─────────────────────────────────────────────────

type SendContent = UserMessageType['message']['content']
type ContentBlock = Exclude<SendContent, string>[number]

/** XML 属性值最小转义（避免 path/name 里的 `"` / `&` / `<` 破坏结构） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** 选区代码片段：内联快照，带 path / lines / language */
function codeRefToXml(meta: CodeRefMeta, text: string): string {
  const [start, end] = meta.line!
  const lines = start === end ? `${start}` : `${start}-${end}`
  const body = text.replace(/\n+$/, '')
  return `<code_snippet path="${escapeAttr(meta.filename)}" lines="${lines}" language="${escapeAttr(meta.languageId)}">\n${body}\n</code_snippet>`
}

/** 整个文件：只发路径，交给 AI 按需 Read */
function fileRefToXml(meta: CodeRefMeta): string {
  return `<file_ref path="${escapeAttr(meta.filename)}" />`
}

/** 外部粘入的文本文件：内容内联 */
function attachmentToXml(meta: FileRefMeta, content: string): string {
  const body = content.replace(/\n+$/, '')
  return `<attachment name="${escapeAttr(meta.name)}" mime="${escapeAttr(meta.mimeType)}">\n${body}\n</attachment>`
}

/**
 * 粘贴文件是否接受为"文本类"：
 * - MIME 命中 `text/*` 或 application 白名单 → 接受
 * - MIME 缺失或未命中时按扩展名兜底（Windows 上 `.md` 等常见没有 MIME）
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // 文档 / 配置
  'md',
  'markdown',
  'mdx',
  'txt',
  'rst',
  'adoc',
  'asciidoc',
  'tex',
  'bib',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'env',
  'csv',
  'tsv',
  'log',
  // Web
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'astro',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'mts',
  'cts',
  // 通用语言
  'py',
  'pyi',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'groovy',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'hxx',
  'm',
  'mm',
  'cs',
  'fs',
  'fsx',
  'vb',
  'swift',
  'dart',
  'lua',
  'perl',
  'pl',
  'pm',
  'php',
  'phtml',
  'r',
  'jl',
  'ex',
  'exs',
  'erl',
  'hrl',
  'clj',
  'cljs',
  'edn',
  // Shell / 构建
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'bat',
  'cmd',
  'sql',
  'graphql',
  'gql',
  'proto',
  'thrift',
  // 无扩展名（extOf 返回整个文件名小写）
  'makefile',
  'dockerfile',
  'cmake',
  'gradle',
  // dotfile（extOf 去掉前导点后的 basename）
  'gitignore',
  'gitattributes',
  'dockerignore',
  'editorconfig',
  'prettierrc',
  'eslintrc',
  'npmrc',
])

function extOf(name: string): string {
  const lower = name.toLowerCase()
  const i = lower.lastIndexOf('.')
  if (i < 0) return lower // 无扩展名文件（Makefile / Dockerfile）
  if (i === 0) return lower.slice(1) // dotfile：`.gitignore` → `gitignore`
  return lower.slice(i + 1)
}

function isTextLike(file: File): boolean {
  const mime = file.type
  if (mime.startsWith('text/')) return true
  if (
    mime &&
    [
      'application/json',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
      'application/javascript',
      'application/typescript',
      'application/toml',
      'application/x-sh',
      'application/x-python',
      'application/sql',
    ].includes(mime)
  ) {
    return true
  }
  return TEXT_EXTENSIONS.has(extOf(file.name))
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

/**
 * 把编辑器内容序列化为 SDK message content：
 * - 行内文本累积为 text block（末尾换行被裁掉）
 * - code-ref 有行范围 → <code_snippet> 内联快照；无行范围 → <file_ref /> 让 AI 按需 Read
 * - 图片 file-ref → image block（base64）
 * - 文本 file-ref → <attachment> 内联内容
 */
async function serialize(editor: Editor): Promise<SendContent> {
  const store = getRefStore(editor)
  const blocks: ContentBlock[] = []
  let textBuf = ''

  const flush = () => {
    const trimmed = textBuf.replace(/\n+$/, '')
    if (trimmed.length > 0) blocks.push({ type: 'text', text: trimmed })
    textBuf = ''
  }

  const walk = async (node: Descendant): Promise<void> => {
    if (!SlateElement.isElement(node)) {
      textBuf += node.text
      return
    }
    if (node.type === 'paragraph') {
      for (const child of node.children) await walk(child)
      textBuf += '\n'
      return
    }
    if (node.type === 'code-ref') {
      flush()
      if (node.codeRef.line) {
        const text = store.codeTexts.get(node.codeRef.id) ?? ''
        blocks.push({ type: 'text', text: codeRefToXml(node.codeRef, text) })
      } else {
        blocks.push({ type: 'text', text: fileRefToXml(node.codeRef) })
      }
      return
    }
    // file-ref
    const meta = node.file
    if (meta.mimeType.startsWith('image/')) {
      const base64 = store.imageBase64.get(meta.id)
      if (!base64) return
      flush()
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: meta.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: base64,
        },
      })
    } else {
      // 文本类：paste 阶段已筛选过 MIME，这里回查 store 的字符串
      const content = store.textContents.get(meta.id)
      if (content === undefined) return
      flush()
      blocks.push({ type: 'text', text: attachmentToXml(meta, content) })
    }
  }

  for (const node of editor.children) await walk(node)
  flush()

  if (blocks.length === 0) return ''
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text
  return blocks
}

function isEmptyEditor(nodes: Descendant[]): boolean {
  for (const n of nodes) {
    if (!SlateElement.isElement(n)) {
      if (n.text.length > 0) return false
      continue
    }
    if (n.type === 'code-ref' || n.type === 'file-ref') return false
    for (const c of n.children) {
      if (SlateElement.isElement(c)) return false
      if (c.text.length > 0) return false
    }
  }
  return true
}

// ── 编辑器操作 ─────────────────────────────────────────────────

function selectEnd(editor: Editor): void {
  Transforms.select(editor, Editor.end(editor, []))
}

function insertCodeRef(editor: Editor, ref: CodeRef): void {
  const store = getRefStore(editor)
  // 整文件引用（line 省略）不存 text：序列化为 <file_ref />，内容由 AI 按需 Read。
  if (ref.line) store.codeTexts.set(ref.id, ref.text)
  const meta: CodeRefMeta = {
    id: ref.id,
    filename: ref.filename,
    languageId: ref.languageId,
    line: ref.line,
  }
  if (!editor.selection) selectEnd(editor)
  Transforms.insertNodes(editor, {
    type: 'code-ref',
    codeRef: meta,
    children: [{ text: '' }],
  })
  // 光标移到刚插入的 void 之后
  Transforms.move(editor, { unit: 'offset' })
}

function insertFileRef(
  editor: Editor,
  file: File,
  payload: { base64?: string; text?: string },
): void {
  const store = getRefStore(editor)
  const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const isImage = file.type.startsWith('image/')
  if (isImage && payload.base64) {
    store.imageBase64.set(id, payload.base64)
  } else if (!isImage && payload.text !== undefined) {
    store.textContents.set(id, payload.text)
  }
  const meta: FileRefMeta = {
    id,
    name: file.name || `pasted.${file.type.split('/')[1] || 'bin'}`,
    mimeType: file.type,
    size: file.size,
  }
  if (!editor.selection) selectEnd(editor)
  Transforms.insertNodes(editor, {
    type: 'file-ref',
    file: meta,
    children: [{ text: '' }],
  })
  Transforms.move(editor, { unit: 'offset' })
}

function resetEditor(editor: Editor): void {
  // 清空外部存储（否则 store 会随提交逐渐增长）
  const store = getRefStore(editor)
  store.codeTexts.clear()
  store.imageBase64.clear()
  store.textContents.clear()

  // 删除全部节点（保留一个空段落）
  Editor.withoutNormalizing(editor, () => {
    const count = editor.children.length
    for (let i = 0; i < count; i++) {
      Transforms.removeNodes(editor, { at: [0] })
    }
    Transforms.insertNodes(editor, emptyParagraph(), { at: [0] })
  })
  Transforms.select(editor, Editor.start(editor, []))

  // 清空 undo/redo 栈：释放旧节点持有的 meta / 文本引用，也避免发送后 Ctrl+Z 恢复出已发送的内容
  if (HistoryEditor.isHistoryEditor(editor)) {
    editor.history.undos = []
    editor.history.redos = []
  }
}

// ── Slate 节点渲染 ────────────────────────────────────────────

const RenderCodeRef: FC<RenderElementProps> = ({ attributes, children, element }) => {
  const editor = useSlateStatic()
  const selected = useSelected()
  if (element.type !== 'code-ref') return null
  const path = ReactEditor.findPath(editor, element)
  return (
    <span
      {...attributes}
      className='mx-0.5 inline-flex align-middle'
      style={selected ? { outline: '1px solid #74c7ec', borderRadius: 4 } : undefined}
    >
      {children}
      <span contentEditable={false}>
        <CodeRefChip
          codeRef={element.codeRef}
          closable
          onClose={() => {
            Transforms.removeNodes(editor, { at: path })
            pruneRefStore(editor)
          }}
        />
      </span>
    </span>
  )
}

const RenderFileRef: FC<RenderElementProps> = ({ attributes, children, element }) => {
  const editor = useSlateStatic()
  const selected = useSelected()
  if (element.type !== 'file-ref') return null
  const path = ReactEditor.findPath(editor, element)
  const isImage = element.file.mimeType.startsWith('image/')
  const store = getRefStore(editor)
  const base64 = isImage ? store.imageBase64.get(element.file.id) : undefined
  const text = !isImage ? store.textContents.get(element.file.id) : undefined
  const data: FileRefData = {
    id: element.file.id,
    name: element.file.name,
    mimeType: element.file.mimeType,
    size: element.file.size,
    base64,
    text,
  }
  return (
    <span
      {...attributes}
      className='mx-0.5 inline-flex align-middle'
      style={selected ? { outline: '1px solid #74c7ec', borderRadius: 4 } : undefined}
    >
      {children}
      <span contentEditable={false}>
        <FileRefChip
          data={data}
          closable
          onClose={() => {
            Transforms.removeNodes(editor, { at: path })
            pruneRefStore(editor)
          }}
        />
      </span>
    </span>
  )
}

const renderElement = (props: RenderElementProps) => {
  switch (props.element.type) {
    case 'code-ref':
      return <RenderCodeRef {...props} />
    case 'file-ref':
      return <RenderFileRef {...props} />
    default:
      return (
        <p {...props.attributes} className='m-0 min-h-[1.25em]'>
          {props.children}
        </p>
      )
  }
}

// ── Component ────────────────────────────────────────────────────

type Props = {
  onSend: (content: UserMessageType['message']['content']) => boolean | Promise<boolean>
  placeholder?: string
  status: AgentChatInputState
  onCancel?: () => void
}

export const ChatInput: FC<Props> = ({ onSend, placeholder = '输入消息...', status, onCancel }) => {
  const { message } = App.useApp()
  const editor = useMemo(() => withHistory(withReact(withInlines(createEditor()))), [])
  const initialValue = useMemo<Descendant[]>(() => [emptyParagraph()], [])
  const [empty, setEmpty] = useState(true)

  // 监听来自 extension 的代码片段插入指令（Ctrl+Shift+L 快捷键）。
  // 编辑器始终挂载,即使 Drawer 关闭时也接受片段;只有在可见(未 disabled)时才尝试 DOM 聚焦。
  useEffect(() => {
    return subscribeExtensionMessage((msg) => {
      if (msg.type !== 'insertSelection') return
      const { text, languageId, filename, line } = msg.data
      insertCodeRef(editor, {
        id: crypto.randomUUID(),
        text,
        languageId: languageId ?? '',
        filename: filename ?? '',
        line,
      })
      setEmpty(isEmptyEditor(editor.children))
      ReactEditor.focus(editor)
    })
  }, [editor])

  const handleSubmit = useCallback(async () => {
    if (isEmptyEditor(editor.children)) return
    const content = await serialize(editor)
    if (content === '' || (Array.isArray(content) && content.length === 0)) return
    // onSend 可能同步 return false（当前状态不允许发送），或走 modal 确认返回 Promise<boolean>。
    // 只有真正发送出去才清空输入框，避免用户输入在"取消"分支下无故丢失。
    const sent = await onSend(content)
    if (sent) {
      resetEditor(editor)
      setEmpty(true)
    }
  }, [editor, onSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    if ((e.nativeEvent as KeyboardEvent).isComposing) return

    // Ctrl / Shift / Alt / Cmd + Enter：插入换行
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
      e.preventDefault()
      editor.insertBreak()
      return
    }
    // 纯 Enter：提交
    e.preventDefault()
    handleSubmit()
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      e.preventDefault()
      // 在粘贴事件返回前读取所有文件内容，确保 insertFileRef 发生时就已经拿到 base64 / 文本，
      // 节点一次性以最终形态进入 Slate（图片直接渲染缩略图，不会先经历 .jpg 外链阶段）。
      const accepted: File[] = []
      let rejected = 0
      for (const f of Array.from(files)) {
        if (f.type.startsWith('image/') || isTextLike(f)) {
          accepted.push(f)
        } else {
          rejected++
        }
      }
      if (rejected > 0) {
        message.info('仅支持图片和文本文件')
      }
      if (accepted.length === 0) return
      void Promise.all(
        accepted.map(async (f) => {
          if (f.type.startsWith('image/')) {
            return { file: f, payload: { base64: await fileToBase64(f) } }
          }
          return { file: f, payload: { text: await f.text() } }
        }),
      ).then((results) => {
        for (const { file, payload } of results) insertFileRef(editor, file, payload)
      })
      return
    }

    // 无文件粘贴：始终 preventDefault 以避免浏览器原生粘贴绕过 Slate 状态树。
    // Slate fragment：手动解码并 insertFragment，确保经过 Slate 操作系统触发 onChange。
    // 其他：按纯文本插入，避免网页 / 富文本编辑器的 HTML 带样式进入。
    e.preventDefault()
    const fragment = e.clipboardData.getData('application/x-slate-fragment')
    if (fragment) {
      try {
        const decoded = JSON.parse(decodeURIComponent(window.atob(fragment))) as Descendant[]
        editor.insertFragment(decoded)
      } catch {
        const text = e.clipboardData.getData('text/plain')
        if (text) editor.insertText(text)
      }
      return
    }
    const text = e.clipboardData.getData('text/plain')
    if (text) editor.insertText(text)
  }

  return (
    <div className='shrink-0 border-t border-[#45475a] px-2 py-2'>
      <div className='flex items-end gap-2'>
        <div className='min-w-0 flex-1'>
          <Slate
            editor={editor}
            initialValue={initialValue}
            onChange={() => setEmpty(isEmptyEditor(editor.children))}
          >
            <Editable
              className='max-h-[16em] overflow-x-hidden overflow-y-auto rounded border border-[#313244] bg-[#181825] px-4 py-2.5 text-[15px] leading-relaxed text-[#cdd6f4] outline-none focus:border-[#585b70]'
              placeholder={placeholder}
              renderElement={renderElement}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
            />
          </Slate>
        </div>
        {match(status)
          .with(P.union('ready', 'confirm-required'), () => (
            <Button
              type='primary'
              shape='circle'
              icon={<ArrowUpOutlined />}
              disabled={empty}
              onClick={handleSubmit}
            />
          ))
          .with('disabled', () => (
            <Button type='primary' shape='circle' icon={<ArrowUpOutlined />} disabled />
          ))
          .with('loading', () => (
            <Button type='primary' shape='circle' icon={<LoadingOutlined />} onClick={onCancel} />
          ))
          .exhaustive()}
      </div>
    </div>
  )
}
