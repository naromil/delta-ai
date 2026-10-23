import { screen, clipboard } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createLookupSession } from './window'
import { isSessionAlive, notifyProcessing, applyOcrResult, type LookupSession } from './state'
import { captureScreen, runOCR } from './capture'
import { installLocalShortcut } from '../services/local-shortcut'
import { currentLookupContextMode, isWaylandSession } from '../config'

const execFileAsync = promisify(execFile)

/**
 * Create a lookup window that also carries the in-app shortcut, so the key keeps
 * working while the popup itself holds focus.
 */
function createSession(cursorX: number, cursorY: number): LookupSession {
  const session = createLookupSession(cursorX, cursorY)
  installLocalShortcut(session.window, handleHotkeyPressed)
  return session
}

/**
 * Read clipboard text. On Wayland, Electron's `clipboard.readText()` reads
 * from the X11 clipboard (via XWayland) which is frequently out of sync with
 * the native Wayland clipboard. Fall back to `wl-paste` when available so we
 * see content copied from native Wayland apps.
 */
async function readClipboardText(): Promise<string> {
  if (isWaylandSession()) {
    try {
      const { stdout } = await execFileAsync('wl-paste', ['--no-newline'])
      return stdout
    } catch {
      // wl-paste not available or clipboard empty — fall through to Electron
    }
  }
  return clipboard.readText()
}

/**
 * Read clipboard image as a PNG buffer. Same Wayland caveat as readClipboardText.
 */
async function readClipboardImage(): Promise<Buffer | null> {
  if (isWaylandSession()) {
    try {
      const { stdout } = await execFileAsync('wl-paste', ['-t', 'image/png'], {
        encoding: 'buffer',
        maxBuffer: 50 * 1024 * 1024
      })
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
      if (buf.length > 0) return buf
    } catch {
      // fall through to Electron
    }
  }
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  return img.toPNG()
}

async function doFullscreenOCR(cursorX: number, cursorY: number): Promise<void> {
  const imageBuffer = await captureScreen()
  if (!imageBuffer) {
    const session = createSession(cursorX, cursorY)
    session.window.webContents.send('ai-error', 'Failed to capture the screen.')
    return
  }

  const session = createSession(cursorX, cursorY)
  if (!isSessionAlive(session)) return

  const token = ++session.ocrToken
  session.contextReady = false
  notifyProcessing(session, 'Waiting for context…')

  try {
    const ocrText = await runOCR(imageBuffer)
    applyOcrResult(session, token, ocrText, 'No text detected on screen')
  } catch (err) {
    applyOcrResult(
      session,
      token,
      err instanceof Error ? err : new Error(String(err)),
      'No text detected on screen'
    )
  }
}

async function tryClipboardContext(cursorX: number, cursorY: number): Promise<boolean> {
  const text = await readClipboardText()
  if (text && text.trim()) {
    const session = createSession(cursorX, cursorY)
    applyOcrResult(session, session.ocrToken, text.trim(), '')
    return true
  }

  const pngBuffer = await readClipboardImage()
  if (pngBuffer && pngBuffer.length > 0) {
    const session = createSession(cursorX, cursorY)
    if (!isSessionAlive(session)) return true

    const token = ++session.ocrToken
    session.contextReady = false
    notifyProcessing(session, 'Running OCR on clipboard image…')

    try {
      const ocrText = await runOCR(pngBuffer)
      applyOcrResult(session, token, ocrText, 'No text detected in clipboard image')
    } catch (err) {
      applyOcrResult(
        session,
        token,
        err instanceof Error ? err : new Error(String(err)),
        'No text detected in clipboard image'
      )
    }
    return true
  }

  return false
}

/* ---- Entry-point ---- */
export async function handleHotkeyPressed(): Promise<void> {
  const cursorPos = screen.getCursorScreenPoint()

  if (currentLookupContextMode === 'clipboard') {
    const handled = await tryClipboardContext(cursorPos.x, cursorPos.y)
    if (handled) return
    await doFullscreenOCR(cursorPos.x, cursorPos.y)
    return
  }

  await doFullscreenOCR(cursorPos.x, cursorPos.y)
}
