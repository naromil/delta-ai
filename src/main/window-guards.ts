import { shell } from 'electron'
import type { BrowserWindow } from 'electron'

export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Keeps a window on the app bundle: links open in the system browser, and no
 * page (an AI-written link included) may load inside an Electron window that
 * carries the preload bridge.
 */
export function guardWindowNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
}
