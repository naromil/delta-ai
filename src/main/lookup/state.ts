import { BrowserWindow } from 'electron'

export const lookupState = {
  lookupWindow: null as BrowserWindow | null,
  lookupContext: '',
  lookupGrown: false,
  lookupContextReady: false,
  lookupOcrToken: 0,
  lookupHasText: false
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function doesLookupWindowExist(): boolean {
  return !!lookupState.lookupWindow && !lookupState.lookupWindow.isDestroyed()
}

export function sendToWindow(channel: string, ...args: unknown[]): void {
  const win = lookupState.lookupWindow
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

export function notifyContextState(
  status: 'processing' | 'ready',
  text: string,
  hint: string
): void {
  sendToWindow('lookup-context', { status, text, hint })
}
