import { BrowserWindow } from 'electron'

export interface LookupSession {
  window: BrowserWindow
  context: string
  grown: boolean
  contextReady: boolean
  ocrToken: number
  hasText: boolean
  pendingState: { status: 'processing' | 'ready'; text: string; hint: string } | null
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function sendToSession(session: LookupSession, channel: string, ...args: unknown[]): void {
  const win = session.window
  if (!win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function notifySessionState(
  session: LookupSession,
  status: 'processing' | 'ready',
  text: string,
  hint: string
): void {
  session.pendingState = { status, text, hint }
  sendToSession(session, 'lookup-context', { status, text, hint })
}

export function notifyProcessing(session: LookupSession, hint: string): void {
  notifySessionState(session, 'processing', '', hint)
}

export function isSessionAlive(session: LookupSession | null): boolean {
  return !!session && !session.window.isDestroyed()
}

/**
 * Apply an async OCR outcome to a session. Stale results (dead window or a token
 * bumped by a newer job) are dropped. An `Error` means the OCR job failed.
 */
export function applyOcrResult(
  session: LookupSession,
  token: number,
  text: string | Error,
  emptyHint: string
): void {
  if (!isSessionAlive(session) || token !== session.ocrToken) return

  if (text instanceof Error) {
    session.contextReady = true
    notifySessionState(session, 'ready', '', `OCR error: ${text.message}`)
    return
  }

  session.context = text
  session.contextReady = true
  notifySessionState(session, 'ready', text, text ? '' : emptyHint)
}
