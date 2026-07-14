import { app, screen, desktopCapturer, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path/posix'
import { lookUpHTML } from './lookupHTML'
import { callProvider, NoApiKeyError, UnsupportedProviderError } from './index'
import type { ProviderMessage } from './index'
import { captureScreenViaPortal, isScreenCapturePortalPreferred } from './screenCapturePortal'

const LOOKUP_WINDOW_WIDTH = 420
const LOOKUP_WINDOW_HEIGHT = 320
const LOOKUP_WINDOW_CURSOR_OFFSET = 10

/* ---- Module state ---- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tesseractWorker: any = null
let lookupWindow: BrowserWindow | null = null

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
    resizable: false,
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
    if (hasBeenFocused && !window.isDestroyed()) window.close()
  })

  window.on('closed', () => {
    if (lookupWindow === window) lookupWindow = null
  })

  window.webContents.ipc.on('lookup-close', () => {
    if (!window.isDestroyed()) window.close()
  })

  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(lookUpHTML))
  window.once('ready-to-show', () => {
    window.show()
  })

  return window
}

function ensureLookupWindow(cursorX: number, cursorY: number): BrowserWindow {
  if (lookupWindow && !lookupWindow.isDestroyed()) {
    return lookupWindow
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
export async function runOCR(imageBuffer: Buffer): Promise<string> {
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

/* ---- Entry-point ---- */
/** Hotkey handler: capture -> OCR -> AI -> lookup. */
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

  // 3. OCR
  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    lookupWindow = ensureLookupWindow(cursorPos.x, cursorPos.y)
    const msg = err instanceof Error ? err.message : String(err)
    sendToWindow('ai-error', `OCR error: ${msg}`)
    return
  }

  sendToWindow('ocr-result', ocrText)

  if (!ocrText) {
    sendToWindow('ai-error', 'No text detected on screen.')
    return
  }

  // 4. Ask the AI about the text. index.ts picks the provider.
  const prompt: ProviderMessage = {
    role: 'assistant',
    content: `The following text was extracted via OCR from the screen near the user's cursor. Please analyze and explain it:\n\n"${ocrText}"`
  }

  try {
    const response = await callProvider([prompt])
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
