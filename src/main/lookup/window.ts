import { screen, BrowserWindow } from 'electron'
import { join } from 'path/posix'
import { lookUpHTML } from './html'
import { lookupState, clamp, doesLookupWindowExist } from './state'

/* ---- Constants ---- */
export const LOOKUP_WINDOW_WIDTH = 420
export const LOOKUP_WINDOW_HEIGHT = 320
const LOOKUP_WINDOW_CURSOR_OFFSET = 10
export const LOOKUP_GROWN_WIDTH = 840
export const LOOKUP_GROWN_HEIGHT = 640
const GROW_DURATION_MS = 350
const GROW_STEPS = 24

function createLookupWindow(cursorX: number, cursorY: number): BrowserWindow {
  const display = screen.getDisplayNearestPoint({ x: cursorX, y: cursorY })
  const { x: bx, y: by, width: bw, height: bh } = display.bounds

  const x = cursorX + LOOKUP_WINDOW_CURSOR_OFFSET
  const y = cursorY + LOOKUP_WINDOW_CURSOR_OFFSET

  const window = new BrowserWindow({
    width: LOOKUP_WINDOW_WIDTH,
    height: LOOKUP_WINDOW_HEIGHT,
    x: clamp(x, bx, bx + bw - LOOKUP_WINDOW_WIDTH),
    y: clamp(y, by, by + bh - LOOKUP_WINDOW_HEIGHT),
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  let hasBeenFocused = false
  window.once('focus', () => {
    hasBeenFocused = true
  })
  window.on('blur', () => {
    if (
      hasBeenFocused &&
      !lookupState.lookupGrown &&
      !lookupState.lookupHasText &&
      !window.isDestroyed()
    ) {
      window.close()
    }
  })

  window.on('closed', () => {
    if (lookupState.lookupWindow === window) {
      lookupState.lookupWindow = null
      lookupState.lookupContext = ''
      lookupState.lookupGrown = false
      lookupState.lookupContextReady = false
      lookupState.lookupHasText = false
      lookupState.lookupOcrToken++
    }
  })

  window.webContents.ipc.on('lookup-close', () => {
    if (!window.isDestroyed()) window.close()
  })

  window.webContents.ipc.on('lookup-input-changed', (_event, hasText: boolean) => {
    lookupState.lookupHasText = hasText
  })

  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(lookUpHTML))
  window.once('ready-to-show', () => {
    window.show()
  })

  return window
}

export function ensureLookupWindow(cursorX: number, cursorY: number): BrowserWindow {
  if (doesLookupWindowExist()) {
    return lookupState.lookupWindow as BrowserWindow
  }
  return createLookupWindow(cursorX, cursorY)
}

export function animateGrowWindow(targetWidth: number, targetHeight: number): void {
  const win = lookupState.lookupWindow
  if (!win || win.isDestroyed()) return

  const [startWidth, startHeight] = win.getSize()
  if (startWidth === targetWidth && startHeight === targetHeight) return

  const [startX, startY] = win.getPosition()
  const wDelta = targetWidth - startWidth
  const hDelta = targetHeight - startHeight
  const stepMs = Math.max(1, Math.floor(GROW_DURATION_MS / GROW_STEPS))
  let step = 0

  const interval = setInterval(() => {
    step += 1
    const t = step >= GROW_STEPS ? 1 : step / GROW_STEPS
    const eased = 1 - Math.pow(1 - t, 3)
    const w = Math.round(startWidth + wDelta * eased)
    const h = Math.round(startHeight + hDelta * eased)
    if (!win.isDestroyed()) {
      win.setBounds({
        x: startX - Math.round((w - startWidth) / 2),
        y: startY - Math.round((h - startHeight) / 2),
        width: w,
        height: h
      })
    }
    if (step >= GROW_STEPS) {
      clearInterval(interval)
    }
  }, stepMs)
}
