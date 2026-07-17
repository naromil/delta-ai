import { BrowserWindow } from 'electron'

export interface LookupSession {
  window: BrowserWindow
  context: string
  grown: boolean
  contextReady: boolean
  ocrToken: number
  hasText: boolean
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
  sendToSession(session, 'lookup-context', { status, text, hint })
}

export function isSessionAlive(session: LookupSession | null): boolean {
  return !!session && !session.window.isDestroyed()
}
