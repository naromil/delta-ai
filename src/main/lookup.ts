import { app, screen, desktopCapturer, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path/posix'
import { buildLookupHTML } from './lookupHTML'
import { callProvider, NoApiKeyError, UnsupportedProviderError } from './index'
import type { ProviderMessage } from './index'
import { captureScreenViaPortal, isScreenCapturePortalPreferred } from './screenCapturePortal'

const LOOKUP_WINDOW_CURSOR_OFFSET = 10

/* ---- Module state ---- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tesseractWorker: any = null
let lookupWindow: BrowserWindow | null = null
let warnedAboutWaylandCursor = false

/* ---- Entry-point ---- */
/** Hotkey handler: capture -> OCR -> AI -> lookup. */
export async function handleHotkeyPressed(): Promise<void> {
  const cursorPos = getCursorPos()

  // 1. Capture region around cursor (before the overlay is visible)
  const imageBuffer = await captureRegionAroundCursor()

  // Create the overlay after the capture so it does not appear in the screenshot.
  if (!lookupWindow || lookupWindow.isDestroyed()) {
    lookupWindow = createLookupWindow(cursorPos.x, cursorPos.y)
  }

  if (!imageBuffer) {
    sendToWindow('ai-error', 'Failed to capture screen region.')
    return
  }

  // 2. OCR
  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendToWindow('ai-error', `OCR error: ${msg}`)
    return
  }

  sendToWindow('ocr-result', ocrText)

  if (!ocrText) {
    sendToWindow('ai-error', 'No text detected near cursor.')
    return
  }

  // 3. Ask the AI about the text. index.ts picks the provider.
  const prompt: ProviderMessage = {
    role: 'explainer',
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

/* ---- Cursor position ---- */
function getCursorPos(): { x: number; y: number } {
  const p = screen.getCursorScreenPoint()
  if (
    p.x === 0 &&
    p.y === 0 &&
    process.env['DELTA_AI_WAYLAND'] === '1' &&
    !warnedAboutWaylandCursor
  ) {
    warnedAboutWaylandCursor = true
    console.warn(
      '[lookup] screen.getCursorScreenPoint() returned (0,0) under the native Wayland ' +
        'backend — Wayland does not expose the global cursor to clients. Run without ' +
        'DELTA_AI_WAYLAND=1 (XWayland backend) so the lookup feature can locate the pointer.'
    )
  }
  return p
}

/* ---- Screen capture around cursor ---- */
export async function captureRegionAroundCursor(width = 400, height = 150): Promise<Buffer | null> {
  const cursorPos = getCursorPos()
  const display = screen.getDisplayNearestPoint(cursorPos)

  const screenImage = await captureScreenImage(display)
  if (!screenImage || screenImage.isEmpty()) return null

  const scaleFactor = display.scaleFactor || 1
  const relX = cursorPos.x - display.bounds.x
  const relY = cursorPos.y - display.bounds.y

  // The screenshot may be at a different scale than the logical display.
  // Find the cursor's position in the image by using its own dimensions,
  // since the portal returns an exact pixel copy of one monitor.
  const imgW = screenImage.getSize().width
  const imgH = screenImage.getSize().height
  // Where the cursor sits as a fraction of the display, mapped to the image.
  const fracX = display.size.width > 0 ? clamp(relX / display.size.width, 0, 1) : 0.5
  const fracY = display.size.height > 0 ? clamp(relY / display.size.height, 0, 1) : 0.5
  const cursorImgX = Math.round(fracX * imgW)
  const cursorImgY = Math.round(fracY * imgH)

  // On HiDPI screens the image is larger than the logical size, so grow the
  // crop region by the scale factor to keep the requested area.
  const physW = Math.round(width * scaleFactor)
  const physH = Math.round(height * scaleFactor)

  const cropX = Math.max(0, cursorImgX - Math.floor(physW / 2))
  const cropY = Math.max(0, cursorImgY - Math.floor(physH / 2))
  const cropW = Math.min(physW, imgW - cropX)
  const cropH = Math.min(physH, imgH - cropY)

  const cropped = screenImage.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
  if (cropped.isEmpty()) return null
  return cropped.toPNG()
}

/* ---- Screenshot ---- */
async function captureScreenImage(display: Electron.Display): Promise<Electron.NativeImage | null> {
  if (isScreenCapturePortalPreferred()) {
    const portalPng = await captureScreenViaPortal()
    if (portalPng && portalPng.length > 0) {
      const img = nativeImage.createFromBuffer(portalPng)
      if (!img.isEmpty()) return img
    }
    // Use desktopCapturer if the portal gave nothing.
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Create the lookup popup as a transparent, fullscreen, always-on-top overlay
 * on the monitor the cursor is on.
 */
function createLookupWindow(cursorX: number, cursorY: number): BrowserWindow {
  const display = screen.getDisplayNearestPoint({ x: cursorX, y: cursorY })
  const panelX = cursorX - display.bounds.x + LOOKUP_WINDOW_CURSOR_OFFSET
  const panelY = cursorY - display.bounds.y + LOOKUP_WINDOW_CURSOR_OFFSET

  console.log('[lookup] cursorPos:', cursorX, cursorY)
  console.log('[lookup] display:', {
    id: display.id,
    bounds: display.bounds,
    size: display.size,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation
  })

  const window = new BrowserWindow({
    fullscreen: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    closable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Autoclose: the overlay is a transient surface, so dismiss it once the
  // user moves away from it.  Gate on first focus so startup jitter does not
  // close the overlay before the OCR/AI result can land.
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

  // Listen for the close button click from inside the overlay page.
  window.webContents.ipc.on('lookup-close', () => {
    if (!window.isDestroyed()) window.close()
  })

  window.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(buildLookupHTML(panelX, panelY))
  )

  window.once('ready-to-show', () => {
    window.show()
  })

  return window
}

/* ---- OCR ---- */
export async function runOCR(imageBuffer: Buffer): Promise<string> {
  // Load tesseract.js only when needed (WASM, runs in the main process)
  const Tesseract = await import('tesseract.js')

  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      // Keep the language files in userData so they are not downloaded again
      cachePath: join(app.getPath('userData'), 'tesseract-cache'),
      logger: () => {} // hide progress logging
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
