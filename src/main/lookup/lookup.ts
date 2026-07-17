import { screen, type BrowserWindow } from 'electron'
import { lookupState, doesLookupWindowExist, sendToWindow, notifyContextState } from './state'
import { captureScreen, runOCR } from './capture'
import { ensureLookupWindow } from './window'
import { handleLookupAsk, handlePasteText, handlePasteImage } from './handlers'

function setupLookupIPC(window: BrowserWindow): void {
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
}

/* ---- Entry-point ---- */
export async function handleHotkeyPressed(): Promise<void> {
  const cursorPos = screen.getCursorScreenPoint()

  const imageBuffer = await captureScreen()
  if (!imageBuffer) {
    lookupState.lookupWindow = ensureLookupWindow(cursorPos.x, cursorPos.y)
    sendToWindow('ai-error', 'Failed to capture the screen.')
    return
  }

  // Create the popup before OCR for responsiveness
  const isNewWindow = !doesLookupWindowExist()
  lookupState.lookupWindow = ensureLookupWindow(cursorPos.x, cursorPos.y)
  if (!doesLookupWindowExist()) return

  if (isNewWindow) {
    setupLookupIPC(lookupState.lookupWindow)
  }

  // OCR: signal processing, then settle the context with the result.
  const token = ++lookupState.lookupOcrToken
  lookupState.lookupContextReady = false
  notifyContextState('processing', '', 'Waiting for OCR…')

  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    if (!doesLookupWindowExist()) return
    if (token !== lookupState.lookupOcrToken) return
    const msg = err instanceof Error ? err.message : String(err)
    lookupState.lookupContextReady = true
    notifyContextState('ready', '', `OCR error: ${msg}`)
    return
  }

  if (!doesLookupWindowExist()) return
  if (token !== lookupState.lookupOcrToken) return

  lookupState.lookupContext = ocrText
  lookupState.lookupContextReady = true
  notifyContextState('ready', ocrText, ocrText ? '' : 'No text detected on screen')
}
