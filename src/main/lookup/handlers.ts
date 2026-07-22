import type { LookupSession } from './state'
import { isSessionAlive, notifySessionState } from './state'
import { runOCRTokenedFor, cancelOCR } from './capture'

export async function handlePasteText(session: LookupSession, text: string): Promise<void> {
  if (!isSessionAlive(session)) return

  await cancelOCR()

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

  session.ocrToken++
  session.contextReady = false
  notifySessionState(session, 'processing', '', 'OCR running on pasted image\u2026')

  const text = await runOCRTokenedFor(session, buffer)
  if (text === null) return

  if (!isSessionAlive(session)) return

  session.context = text
  session.contextReady = true
  notifySessionState(session, 'ready', text, text ? '' : 'No text detected in pasted image')
}
