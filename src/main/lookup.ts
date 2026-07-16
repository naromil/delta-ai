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
let lookupContext = ''
let lookupGrown = false
// Context-gating state machine. A question may be sent once the context is
// "ready": OCR finished (from hotkey capture or image paste), or a text paste
// was accepted. While OCR is in flight (and no paste has settled), this is
// false and the renderer blocks Enter.
let lookupContextReady = false
// Generation token for OCR races. Incremented whenever a new OCR run starts or
// a paste supersedes the current run. A late OCR result whose captured token
// no longer matches is discarded (tesseract.js has no native cancel).
let lookupOcrToken = 0
let lookupHasText = false

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
  // If the Ask field has text, blur also keeps the window open so the user
  // doesn't lose a typed question.

  let hasBeenFocused = false
  window.once('focus', () => {
    hasBeenFocused = true
  })
  window.on('blur', () => {
    if (hasBeenFocused && !lookupGrown && !lookupHasText && !window.isDestroyed()) {
      window.close()
    }
  })

  window.on('closed', () => {
    if (lookupWindow === window) {
      lookupWindow = null
      lookupContext = ''
      lookupGrown = false
      lookupContextReady = false
      lookupHasText = false
      lookupOcrToken++
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

  window.webContents.ipc.on('lookup-paste-text', (_event, text: string) => {
    handlePasteText(text)
  })

  window.webContents.ipc.on('lookup-paste-image', (_event, base64: string) => {
    handlePasteImage(base64).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      sendToWindow('ai-error', `OCR error: ${msg}`)
    })
  })

  window.webContents.ipc.on('lookup-input-changed', (_event, hasText: boolean) => {
    lookupHasText = hasText
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

/* Tokened OCR: starts a new generation. Returns null if a newer OCR run or a
   paste superseded this one while it was in flight, so the caller can drop the
   stale result instead of clobbering a newer context. */
async function runOCRTokened(imageBuffer: Buffer): Promise<string | null> {
  const token = ++lookupOcrToken
  const text = await runOCR(imageBuffer)
  if (token !== lookupOcrToken) return null
  return text
}

/* ---- Lookup window ---- */
function sendToWindow(channel: string, ...args: unknown[]): void {
  const win = lookupWindow
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

/* ---- Context state machine ----
   The single source of truth for what the "Extracted Text" box shows and whether
   Enter may send a question. Pushes a { status, text, hint } payload to the
   renderer via the 'lookup-context' channel.
     status 'processing' -> OCR in flight; Enter blocked; box shows `hint`.
     status 'ready'      -> context settled; Enter allowed; box shows `text`
                            (or the hint as a placeholder when text is empty). */
function notifyContextState(status: 'processing' | 'ready', text: string, hint: string): void {
  sendToWindow('lookup-context', { status, text, hint })
}

/* ---- Paste handlers ----
   Text paste: stop any in-flight OCR (token bump), accept the pasted text as
   the context verbatim, and mark the context ready immediately. */
function handlePasteText(text: string): void {
  if (!doesLookupWindowExist()) return
  // Cancel any running OCR by superseding its generation token.
  lookupOcrToken++
  lookupContext = text
  lookupContextReady = true
  notifyContextState('ready', text, 'Pasted text')
}

/* Image paste: stop any in-flight OCR, then restart the OCR workflow on the
   new image. The box shows a processing hint until that OCR resolves. */
async function handlePasteImage(base64: string): Promise<void> {
  if (!doesLookupWindowExist()) return
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) return

  // Cancel the previous run and enter processing. runOCRTokened bumps the
  // token again on its own start, but we bump first so a hotkey-capture result
  // that lands in between cannot win.
  lookupOcrToken++
  lookupContextReady = false
  notifyContextState('processing', '', 'OCR running on pasted image…')

  const text = await runOCRTokened(buffer)
  if (text === null) return // superseded by a newer paste / capture

  if (!doesLookupWindowExist()) return

  lookupContext = text
  lookupContextReady = true
  notifyContextState('ready', text, text ? '' : 'No text detected in pasted image')
}

/* ---- Window grow animation ---- */
function animateGrowWindow(targetWidth: number, targetHeight: number): void {
  const win = lookupWindow
  if (!win || win.isDestroyed()) return

  const [startWidth, startHeight] = win.getSize()
  if (startWidth === targetWidth && startHeight === targetHeight) return

  // Keep the top-left corner fixed so the window grows downward/rightward.
  const [startX, startY] = win.getPosition()
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

/* ---- Ask handler: OCR text as context + user question -> provider ---- */
async function handleLookupAsk(question: string): Promise<void> {
  const win = lookupWindow
  if (!win || win.isDestroyed()) return
  // Defense-in-depth: the renderer gates Enter on context readiness, but never
  // send a question while OCR is still in flight and no context is settled.
  if (!lookupContextReady) return

  if (!lookupGrown) {
    // Tell the page to grow its layout, and animate the native window to match.
    sendToWindow('lookup-grow', LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    animateGrowWindow(LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    lookupGrown = true
  }

  const messages: ProviderMessage[] = []
  // System instructions and rules
  messages.push({
    role: 'system',
    content: [
      'You are DeltaAI, a helpful assistant in the software\'s "lookup" window.',
      'You will help the user approach something they are not familiar with conveniently and effectively.',
      'The context will be extracted from the screen (often via OCR), and the user will ask you to analyze it or answer questions about it.',
      'If the context is extracted via OCR, it may contain errors; ask for clarification when necessary, but do not mention about OCR.',
      'Answer in simple and concise words.'
    ].join('')
  })
  // The OCR text as the context
  if (lookupContext) {
    messages.push({
      role: 'user',
      content: `The following context was extracted from my screen:\n\n"${lookupContext}"`
    })
  }
  // The user's question
  let completeQuestion = `Answer in simple and concise words:\n\n`
  completeQuestion += !question ? 'summarize' : question
  messages.push({ role: 'user', content: completeQuestion })

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

  // 3. OCR (tokened: a paste that lands while OCR is in flight supersedes this
  //    run and discards its result). Signal "processing" so the renderer blocks
  //    Enter until the context settles.
  const token = ++lookupOcrToken
  lookupContextReady = false
  notifyContextState('processing', '', 'Waiting for OCR…')

  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    if (!doesLookupWindowExist()) return
    if (token !== lookupOcrToken) return // superseded by a paste
    const msg = err instanceof Error ? err.message : String(err)
    // Settle the context (empty) so the user can still ask a free-form question;
    // surface the failure in the context box rather than the conversation area.
    lookupContextReady = true
    notifyContextState('ready', '', `OCR error: ${msg}`)
    return
  }

  if (!doesLookupWindowExist()) return
  if (token !== lookupOcrToken) return // superseded by a paste; let the paste drive state

  lookupContext = ocrText
  lookupContextReady = true
  notifyContextState('ready', ocrText, ocrText ? '' : 'No text detected on screen')
}
