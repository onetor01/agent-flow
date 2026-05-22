import type { ExtensionToWebviewMessage, ExtensionFromWebviewMessage } from '@/common'

// ── vscode api ────────────────────────────────────────────────────────

type VsCodeApi = ReturnType<typeof acquireVsCodeApi>

let api: VsCodeApi | undefined

function getApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi()
  }
  return api
}

/** 类型安全地向 extension 发送消息 */
export function postMessageToExtension(msg: ExtensionFromWebviewMessage): void {
  getApi().postMessage(msg)
}

// ── subscribeExtensionMessage ────────────────────────────────────────────

/**
 * 注册一个回调，每当收到新的 extension 消息时调用
 *
 * @returns 取消订阅的函数
 */
export function subscribeExtensionMessage(
  handler: (msg: ExtensionToWebviewMessage) => void,
): () => void {
  const listener = (e: MessageEvent) => {
    handler(e.data as ExtensionToWebviewMessage)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
