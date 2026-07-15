import { app, screen, desktopCapturer, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path/posix'
import { lookUpHTML } from './lookupHTML'
import { callProvider, NoApiKeyError, UnsupportedProviderError } from './index'
import type { ProviderMessage } from './index'
import { captureScreenViaPortal, isScreenCapturePortalPreferred } from './screenCapturePortal'

const LOOKUP_WINDOW_WIDTH = 420
const LOOKUP_WINDOW_HEIGHT = 320
const LOOKUP_WINDOW_CURSOR_OFFSET = 10
const LOOKUP_GROWN_WIDTH = 840
const LOOKUP_GROWN_HEIGHT = 640
const GROW_DURATION_MS = 350
const GROW_STEPS = 24

/* ---- Module state ---- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tesseractWorker: any = null
let lookupWindow: BrowserWindow | null = null
let lookupOcrContext = ''
let lookupGrown = false

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function createLookupWindow(cursorX: number, cursorY: number): BrowserWindow {
  const display = screen.getDisplayNearestPoint({ x: cursorX, y: cursorY })
  const { x: bx, y: by, width: bw, height: bh } = display.bounds

  // Best-effort position near the cursor; the compositor may ignore this
  // (e.g. on Wayland) and center the window, which is acceptable.
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

  // Per spec: blur only closes the window before the first ask. Once the window
  // has grown (post-ask), blur does not kill it; the window closes only via ✕.

  let hasBeenFocused = false
  window.once('focus', () => {
    hasBeenFocused = true
  })
  window.on('blur', () => {
    if (hasBeenFocused && !lookupGrown && !window.isDestroyed()) {
      window.close()
    }
  })

  window.on('closed', () => {
    if (lookupWindow === window) {
      lookupWindow = null
      lookupOcrContext = ''
      lookupGrown = false
    }
  })

  window.webContents.ipc.on('lookup-close', () => {
    if (!window.isDestroyed()) window.close()
  })

  window.webContents.ipc.on('lookup-ask', (_event, question: string) => {
    handleLookupAsk(question).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      sendToWindow('ai-error', msg)
    })
  })

  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(lookUpHTML))
  window.once('ready-to-show', () => {
    window.show()
  })

  return window
}

function doesLookupWindowExist(): boolean {
  return !!lookupWindow && !lookupWindow.isDestroyed()
}

// Create one lookup window if not exist
function ensureLookupWindow(cursorX: number, cursorY: number): BrowserWindow {
  if (doesLookupWindowExist()) {
    return lookupWindow as BrowserWindow
  }
  return createLookupWindow(cursorX, cursorY)
}

async function captureScreenImage(display: Electron.Display): Promise<Electron.NativeImage | null> {
  if (isScreenCapturePortalPreferred()) {
    const portalPng = await captureScreenViaPortal()
    if (portalPng && portalPng.length > 0) {
      const img = nativeImage.createFromBuffer(portalPng)
      if (!img.isEmpty()) return img
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height }
  })

  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) return null

  const thumb = source.thumbnail
  if (thumb.isEmpty()) return null
  return thumb
}

/* ---- Screen capture ---- */
async function captureScreen(): Promise<Buffer | null> {
  const cursorPos = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPos)

  const image = await captureScreenImage(display)
  if (!image || image.isEmpty()) return null
  return image.toPNG()
}

/* ---- OCR ---- */
async function runOCR(imageBuffer: Buffer): Promise<string> {
  const Tesseract = await import('tesseract.js')

  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      cachePath: join(app.getPath('userData'), 'tesseract-cache'),
      logger: () => {}
    })
  }

  const result = await tesseractWorker.recognize(imageBuffer)
  return result.data.text.trim()
}

/* ---- Lookup window ---- */
function sendToWindow(channel: string, ...args: unknown[]): void {
  const win = lookupWindow
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

/* ---- Window grow animation ---- */
function animateGrowWindow(targetWidth: number, targetHeight: number): void {
  const win = lookupWindow
  if (!win || win.isDestroyed()) return

  const [startWidth, startHeight] = win.getSize()
  if (startWidth === targetWidth && startHeight === targetHeight) return

  // Keep the top-left corner fixed so the window grows downward/rightward.
  const [x, y] = win.getPosition()
  const wDelta = targetWidth - startWidth
  const hDelta = targetHeight - startHeight
  const stepMs = Math.max(1, Math.floor(GROW_DURATION_MS / GROW_STEPS))
  let step = 0

  const interval = setInterval(() => {
    step += 1
    const t = step >= GROW_STEPS ? 1 : step / GROW_STEPS
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3)
    const w = Math.round(startWidth + wDelta * eased)
    const h = Math.round(startHeight + hDelta * eased)
    if (!win.isDestroyed()) {
      win.setBounds({ x, y, width: w, height: h })
    }
    if (step >= GROW_STEPS) {
      clearInterval(interval)
    }
  }, stepMs)
}

/* ---- Ask handler: OCR text as context + user question -> provider ---- */
async function handleLookupAsk(question: string): Promise<void> {
  const win = lookupWindow
  if (!win || win.isDestroyed()) return

  if (!lookupGrown) {
    // Tell the page to grow its layout, and animate the native window to match.
    sendToWindow('lookup-grow', LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    animateGrowWindow(LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    lookupGrown = true
  }

  const messages: ProviderMessage[] = []
  if (lookupOcrContext) {
    messages.push({
      role: 'system',
      content: `The following text was extracted via OCR from the screen near the user's cursor and is the context for their question:\n\n"${lookupOcrContext}"`
    })
  }
  messages.push({ role: 'user', content: question })

  try {
    const response = await callProvider(messages)
    sendToWindow('ai-response', response)
  } catch (err) {
    if (err instanceof NoApiKeyError || err instanceof UnsupportedProviderError) {
      sendToWindow('ai-error', err.message)
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      sendToWindow('ai-error', msg)
    }
  }
}

/* ---- Entry-point ---- */
/** Hotkey handler: capture -> OCR -> show popup; user then asks via the input. */
export async function handleHotkeyPressed(): Promise<void> {
  const cursorPos = screen.getCursorScreenPoint()

  // 1. Capture the screen (full, no crop)
  const imageBuffer = await captureScreen()
  if (!imageBuffer) {
    lookupWindow = ensureLookupWindow(cursorPos.x, cursorPos.y)
    sendToWindow('ai-error', 'Failed to capture the screen.')
    return
  }

  // 2. Create the popup before OCR for responsiveness
  lookupWindow = ensureLookupWindow(cursorPos.x, cursorPos.y)
  if (!doesLookupWindowExist()) return

  // 3. OCR
  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    if (!doesLookupWindowExist()) return
    const msg = err instanceof Error ? err.message : String(err)
    sendToWindow('ai-error', `OCR error: ${msg}`)
    return
  }

  if (!doesLookupWindowExist()) return

  lookupOcrContext = ocrText
  sendToWindow('ocr-result', ocrText)

  if (!ocrText) {
    // No context to send, but the window stays open so the user can still ask a
    // free-form question. The page shows the "(No text extracted)" placeholder.
    return
  }

  // 4. Wait for the user's question (handled by handleLookupAsk via the
  // 'lookup-ask' IPC). The OCR text is kept as the default context.
}
