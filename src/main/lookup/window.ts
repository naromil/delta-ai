import { screen, BrowserWindow } from 'electron'
import { join } from 'path/posix'
import { lookUpHTML } from './html'
import { clamp, type LookupSession } from './state'
import { handleLookupAsk, handleLookupExpand, handlePasteText, handlePasteImage } from './handlers'

/* ---- Constants ---- */
export const LOOKUP_WINDOW_WIDTH = 420
export const LOOKUP_WINDOW_HEIGHT = 320
const LOOKUP_WINDOW_CURSOR_OFFSET = 10
export const LOOKUP_GROWN_WIDTH = 840
export const LOOKUP_GROWN_HEIGHT = 640
const GROW_DURATION_MS = 350
const GROW_STEPS = 24

/* ---- Window creation ---- */
export function createLookupSession(cursorX: number, cursorY: number): LookupSession {
  const display = screen.getDisplayNearestPoint({ x: cursorX, y: cursorY })
  const { x: bx, y: by, width: bw, height: bh } = display.bounds

  const x = cursorX + LOOKUP_WINDOW_CURSOR_OFFSET
  const y = cursorY + LOOKUP_WINDOW_CURSOR_OFFSET

  const session: LookupSession = {
    window: null as unknown as BrowserWindow,
    context: '',
    grown: false,
    contextReady: false,
    ocrToken: 0,
    hasText: false
  }

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
  session.window = window

  let hasBeenFocused = false
  window.once('focus', () => {
    hasBeenFocused = true
  })
  window.on('blur', () => {
    // A window that has grown (a message has been sent) stays open on blur
    // so the user can keep consulting it while triggering new lookups.
    if (hasBeenFocused && !session.grown && !session.hasText && !window.isDestroyed()) {
      window.close()
    }
  })

  window.on('closed', () => {
    const idx = lookupSessions.indexOf(session)
    if (idx >= 0) lookupSessions.splice(idx, 1)
  })

  window.webContents.ipc.on('lookup-ask', (_event, question: string) => {
    handleLookupAsk(session, question).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      session.window.webContents.send('ai-error', msg)
    })
  })

  window.webContents.ipc.on(
    'lookup-expand',
    (
      _event,
      payload: {
        context: string
        question: string
        answer: string
        selection: string
        expansionId: number
      }
    ) => {
      handleLookupExpand(session, payload).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (!session.window.isDestroyed()) {
          session.window.webContents.send('lookup-expand-chunk', {
            expansionId: payload.expansionId,
            error: msg
          })
        }
      })
    }
  )

  window.webContents.ipc.on('lookup-paste-text', (_event, text: string) => {
    handlePasteText(session, text)
  })

  window.webContents.ipc.on('lookup-paste-image', (_event, base64: string) => {
    handlePasteImage(session, base64).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (!session.window.isDestroyed()) {
        session.window.webContents.send('ai-error', `OCR error: ${msg}`)
      }
    })
  })

  window.webContents.ipc.on('lookup-close', () => {
    if (!window.isDestroyed()) window.close()
  })

  window.webContents.ipc.on('lookup-input-changed', (_event, hasText: boolean) => {
    session.hasText = hasText
  })

  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(lookUpHTML))
  window.once('ready-to-show', () => {
    window.show()
  })

  lookupSessions.push(session)
  return session
}

export const lookupSessions: LookupSession[] = []

export function animateGrowSession(
  session: LookupSession,
  targetWidth: number,
  targetHeight: number,
  targetX?: number,
  targetY?: number
): void {
  const win = session.window
  if (win.isDestroyed()) return

  const [startWidth, startHeight] = win.getSize()
  if (startWidth === targetWidth && startHeight === targetHeight) return

  const [startX, startY] = win.getPosition()
  // If a target position is not provided, re-center around the original
  // window center (the Ask-flow grow behaviour). If it is provided,
  // animate position toward that target.
  const endX = targetX !== undefined ? targetX : startX - (targetWidth - startWidth) / 2
  const endY = targetY !== undefined ? targetY : startY - (targetHeight - startHeight) / 2
  const xDelta = endX - startX
  const yDelta = endY - startY
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
    const x =
      targetX !== undefined
        ? Math.round(startX + xDelta * eased)
        : startX - Math.round((w - startWidth) / 2)
    const y =
      targetY !== undefined
        ? Math.round(startY + yDelta * eased)
        : startY - Math.round((h - startHeight) / 2)
    if (!win.isDestroyed()) {
      win.setBounds({ x, y, width: w, height: h })
    }
    if (step >= GROW_STEPS) {
      clearInterval(interval)
    }
  }, stepMs)
}
