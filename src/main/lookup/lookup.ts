import { screen } from 'electron'
import { createLookupSession } from './window'
import { isSessionAlive, notifySessionState } from './state'
import { captureScreen, runOCR } from './capture'

/* ---- Entry-point ---- */
export async function handleHotkeyPressed(): Promise<void> {
  const cursorPos = screen.getCursorScreenPoint()

  const imageBuffer = await captureScreen()
  if (!imageBuffer) {
    const session = createLookupSession(cursorPos.x, cursorPos.y)
    session.window.webContents.send('ai-error', 'Failed to capture the screen.')
    return
  }

  const session = createLookupSession(cursorPos.x, cursorPos.y)
  if (!isSessionAlive(session)) return

  // OCR: signal processing, then settle the context with the result.
  const token = ++session.ocrToken
  session.contextReady = false
  notifySessionState(session, 'processing', '', 'Waiting for OCR…')

  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    if (!isSessionAlive(session)) return
    if (token !== session.ocrToken) return
    const msg = err instanceof Error ? err.message : String(err)
    session.contextReady = true
    notifySessionState(session, 'ready', '', `OCR error: ${msg}`)
    return
  }

  if (!isSessionAlive(session)) return
  if (token !== session.ocrToken) return

  session.context = ocrText
  session.contextReady = true
  notifySessionState(session, 'ready', ocrText, ocrText ? '' : 'No text detected on screen')
}
