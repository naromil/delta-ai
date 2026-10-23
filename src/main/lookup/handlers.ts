import type { LookupSession } from './state'
import { isSessionAlive, notifySessionState, notifyProcessing, applyOcrResult } from './state'
import { runOCRTokenedFor, cancelOCR } from './capture'

export async function handlePasteText(session: LookupSession, text: string): Promise<void> {
  if (!isSessionAlive(session)) return

  await cancelOCR()

  // Invalidate any OCR job still in flight so its result cannot overwrite this.
  session.ocrToken++
  session.context = text
  session.contextReady = true
  notifySessionState(session, 'ready', text, 'Pasted text')
}

export async function handlePasteImage(session: LookupSession, base64: string): Promise<void> {
  if (!isSessionAlive(session)) return
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) return

  await cancelOCR()

  const token = ++session.ocrToken
  session.contextReady = false
  notifyProcessing(session, 'OCR running on pasted image\u2026')

  try {
    const text = await runOCRTokenedFor(session, buffer, token)
    if (text === null) return
    applyOcrResult(session, token, text, 'No text detected in pasted image')
  } catch (err) {
    // Mark the context resolved even on failure, otherwise Ask stays disabled
    // forever behind the "context is still being prepared" guard.
    applyOcrResult(
      session,
      token,
      err instanceof Error ? err : new Error(String(err)),
      'No text detected in pasted image'
    )
  }
}
