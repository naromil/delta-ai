import { app, screen, desktopCapturer, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path/posix'
import { lookUpHTML } from './lookupHTML'
import { callGoogleAI } from './index'
import { loadProviderConfig } from './config'
import { captureScreenViaPortal, isScreenCapturePortalPreferred } from './screenCapturePortal'

/* ---- OCR ---- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tesseractWorker: any = null

export async function runOCR(imageBuffer: Buffer): Promise<string> {
  // Dynamically import tesseract.js (WASM-based, works in main process with sandbox:false)
  const Tesseract = await import('tesseract.js')

  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      // Cache language data in userData so it persists
      cachePath: join(app.getPath('userData'), 'tesseract-cache'),
      logger: () => {} // suppress progress logs
    })
  }

  const result = await tesseractWorker.recognize(imageBuffer)
  return result.data.text.trim()
}

/**
 * Get the current screen contents as a `NativeImage` matching `display`, in a
 * way that avoids the persistent KDE Wayland screen-sharing prompt that every
 * `desktopCapturer` call shows (and whose "remember choice" checkbox is broken
 * at the portal-impl level).
 *
 * Strategy:
 *   1. On KDE Plasma Wayland, first try `org.freedesktop.portal.Screenshot`
 *      (interactive=false) via dbus-next — silent after one-time consent.
 *   2. Everywhere else (or as fallback) use Electron's `desktopCapturer`
 *      which the user expects on X11 / Windows / macOS, and on non-KDE
 *      Wayland compositors where the remember-choice checkbox actually works.
 *
 * Returns `null` if no source was available.
 */
async function captureScreenImage(display: Electron.Display): Promise<Electron.NativeImage | null> {
  if (isScreenCapturePortalPreferred()) {
    const portalPng = await captureScreenViaPortal()
    if (portalPng && portalPng.length > 0) {
      const img = nativeImage.createFromBuffer(portalPng)
      if (!img.isEmpty()) return img
    }
    // Fall through to desktopCapturer if the portal path failed or returned empty.
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

/* ---- Screen capture around cursor ---- */
export async function captureRegionAroundCursor(width = 400, height = 150): Promise<Buffer | null> {
  const cursorPos = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPos)

  const screenImage = await captureScreenImage(display)
  if (!screenImage || screenImage.isEmpty()) return null

  // Calculate crop region centered on cursor (relative to this display).
  // The portal screenshot returns pixels in the display's natural coordinate
  // space, so we apply the scale factor the same way we do for desktopCapturer.
  const scaleFactor = display.scaleFactor || 1
  const relX = cursorPos.x - display.bounds.x
  const relY = cursorPos.y - display.bounds.y

  // If the source image is at a different scale than the logical display size,
  // we crop in physical pixels relative to image dims. Handle the common case:
  // portal returns an exact physical-pixel screenshot of one monitor, so use
  // the image's own dimensions to compute the cursor's fractional position.
  const imgW = screenImage.getSize().width
  const imgH = screenImage.getSize().height
  // Fraction of cursor across the logical display bounds, mapped to image:
  const fracX = display.size.width > 0 ? clamp(relX / display.size.width, 0, 1) : 0.5
  const fracY = display.size.height > 0 ? clamp(relY / display.size.height, 0, 1) : 0.5
  const cursorImgX = Math.round(fracX * imgW)
  const cursorImgY = Math.round(fracY * imgH)

  // Desired region size in image-pixel units. If the screenshot is at scale
  // factor > 1 (HiDPI), the image is bigger than the logical width/height, so
  // we scale up the logical region requested.
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/* ---- Lookup window ---- */
export let lookupWindow: BrowserWindow | null = null

export function createLookupWindow(x: number, y: number): BrowserWindow {
  const window = new BrowserWindow({
    width: 420,
    height: 320,
    x: Math.min(x, screen.getPrimaryDisplay().size.width - 430),
    y: Math.min(y, screen.getPrimaryDisplay().size.height - 340),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true
    }
  })

  // Auto-close on focus loss
  window.on('blur', () => {
    window.close()
  })

  window.on('closed', () => {
    lookupWindow = null
  })

  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(lookUpHTML))
  window.once('ready-to-show', () => {
    window.show()
  })

  return window
}

/* ---- Hotkey handler: capture -> OCR -> AI -> lookup ---- */
export async function handleHotkeyPressed(): Promise<void> {
  const cursorPos = screen.getCursorScreenPoint()

  // Create lookup immediately for responsive feel
  if (!lookupWindow || lookupWindow.isDestroyed()) {
    lookupWindow = createLookupWindow(cursorPos.x + 10, cursorPos.y + 10)
  }

  // 1. Capture region around cursor
  const imageBuffer = await captureRegionAroundCursor()
  if (!imageBuffer) {
    lookupWindow?.webContents.send('ai-error', 'Failed to capture screen region.')
    return
  }

  // 2. OCR
  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lookupWindow?.webContents.send('ai-error', `OCR error: ${msg}`)
    return
  }

  lookupWindow?.webContents.send('ocr-result', ocrText)

  if (!ocrText) {
    lookupWindow?.webContents.send('ai-error', 'No text detected near cursor.')
    return
  }

  // 3. AI query with extracted text
  const config = loadProviderConfig()
  if (!config || !config.apiKey) {
    lookupWindow?.webContents.send(
      'ai-error',
      'No API key configured. Open Settings to add your provider API key.'
    )
    return
  }

  try {
    if (config.provider === 'google-ai-studio') {
      const prompt = `The following text was extracted via OCR from the screen near the user's cursor. Please analyze and respond to it:\n\n"${ocrText}"`
      const response = await callGoogleAI(config.apiKey, config.model, [
        { role: 'user', content: prompt }
      ])
      lookupWindow?.webContents.send('ai-response', response)
    } else {
      lookupWindow?.webContents.send(
        'ai-error',
        `Provider "${config.provider}" is not supported yet.`
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lookupWindow?.webContents.send('ai-error', msg)
  }
}
