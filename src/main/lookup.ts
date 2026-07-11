import { app, screen, desktopCapturer, BrowserWindow } from 'electron'
import { join } from 'path/posix'
import { lookUpHTML } from './lookupHTML'
import { callGoogleAI } from '.'
import { loadProviderConfig } from './config'

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

/* ---- Screen capture around cursor ---- */
export async function captureRegionAroundCursor(width = 400, height = 150): Promise<Buffer | null> {
  const cursorPos = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPos)

  // Get all sources (screens)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height }
  })

  // Find the source matching this display
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) return null

  const thumb = source.thumbnail
  if (thumb.isEmpty()) return null

  // Calculate crop region centered on cursor (relative to this display)
  const scaleFactor = display.scaleFactor || 1
  const relX = cursorPos.x - display.bounds.x
  const relY = cursorPos.y - display.bounds.y

  const cropX = Math.max(0, Math.round(relX * scaleFactor - width / 2))
  const cropY = Math.max(0, Math.round(relY * scaleFactor - height / 2))
  const cropW = Math.min(width, display.size.width * scaleFactor - cropX)
  const cropH = Math.min(height, display.size.height * scaleFactor - cropY)

  // Crop the thumbnail
  const cropped = thumb.crop({
    x: cropX,
    y: cropY,
    width: cropW,
    height: cropH
  })

  if (cropped.isEmpty()) return null
  return cropped.toPNG()
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
