import { match, P } from 'ts-pattern'
import * as vscode from 'vscode'

let channel: vscode.OutputChannel | undefined

export function initLogger(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Agent Flow')
    context.subscriptions.push(channel)
  }
  return channel
}

export function log(...args: unknown[]): void {
  console.log(...args)
  channel?.appendLine(args.map(formatArg).join(' '))
}

export function logError(...args: unknown[]): void {
  channel?.appendLine('[ERROR] ' + args.map(formatArg).join(' '))
}

function formatArg(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack ?? v.message
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/**
 * 把事件载荷压成体积可控的摘要,供日志使用。只对会膨胀到几万条 / 含图片 base64 的载荷做减法:
 * - aiMessage.message (SDKMessage):
 *   - stream_event(partial): 仅 type / session_id / uuid / event.type / 文本片段
 *   - result: 仅 type / subtype / session_id / is_error / num_turns / duration_ms
 *   - user: 文本保留,image / document 块替换为占位
 *   - assistant: 完整保留(用户最关心)
 *   - 其他: 原样
 * - agentComplete.result: 同上 SDKMessage 规则
 * - userMessage.message / flowStart.initMessage: 同 user 规则,丢图片资源
 *
 * 其它 type 直接返回原 data。仅做浅替换,不深拷贝大字段。
 */
export function summarizeLogPayload(type: string, data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const d = data as Record<string, unknown>
  return match(type)
    .with('flow.signal.aiMessage', () => ({ ...d, message: summarizeSDKMessage(d.message) }))
    .with('flow.signal.agentComplete', () =>
      d.result === undefined ? d : { ...d, result: summarizeSDKMessage(d.result) },
    )
    .with('flow.command.userMessage', () => ({ ...d, message: redactUserMessage(d.message) }))
    .with('flow.command.flowStart', () => ({
      ...d,
      initMessage: redactUserMessage(d.initMessage),
    }))
    .otherwise(() => d)
}

function summarizeSDKMessage(msg: unknown): unknown {
  if (!msg || typeof msg !== 'object') return msg
  const m = msg as Record<string, unknown>
  return match(m.type)
    .with('stream_event', () => {
      const event = m.event as { type?: string; delta?: { text?: string } } | undefined
      return {
        type: m.type,
        session_id: m.session_id,
        uuid: m.uuid,
        eventType: event?.type,
        text: event?.delta?.text,
      }
    })
    .with('result', () => ({
      type: m.type,
      subtype: m.subtype,
      session_id: m.session_id,
      is_error: m.is_error,
      num_turns: m.num_turns,
      duration_ms: m.duration_ms,
    }))
    .with('user', () => ({ ...m, message: redactUserMessage(m.message) }))
    .with('assistant', () => m)
    .otherwise(() => m)
}

function redactUserMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message
  const m = message as Record<string, unknown>
  const content = m.content
  if (typeof content === 'string') return m
  if (!Array.isArray(content)) return m
  return {
    ...m,
    content: content.map((b) =>
      match(b as { type?: string } | null | undefined)
        .with({ type: 'image' }, () => ({ type: 'image', _redacted: true }))
        .with({ type: 'document' }, () => ({ type: 'document', _redacted: true }))
        .with(P.any, (x) => x)
        .exhaustive(),
    ),
  }
}
