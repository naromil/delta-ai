import type { LookupSession } from './state'
import { isSessionAlive, sendToSession, notifySessionState } from './state'
import { runOCRTokenedFor } from './capture'
import { callProvider, NoApiKeyError, UnsupportedProviderError } from '../provider'
import type { ProviderMessage } from '../provider'
import { loadCurrentProviderConfig } from '../config'
import { animateGrowSession, LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT } from './window'

export function handlePasteText(session: LookupSession, text: string): void {
  if (!isSessionAlive(session)) return
  session.ocrToken++
  session.context = text
  session.contextReady = true
  notifySessionState(session, 'ready', text, 'Pasted text')
}

export async function handlePasteImage(session: LookupSession, base64: string): Promise<void> {
  if (!isSessionAlive(session)) return
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) return

  session.ocrToken++
  session.contextReady = false
  notifySessionState(session, 'processing', '', 'OCR running on pasted image…')

  const text = await runOCRTokenedFor(session, buffer)
  if (text === null) return

  if (!isSessionAlive(session)) return

  session.context = text
  session.contextReady = true
  notifySessionState(session, 'ready', text, text ? '' : 'No text detected in pasted image')
}

/**
 * Handles a lookup ask request from the user.
 * Processes the user's question against the session context and returns an AI response.
 * @param session - The lookup session containing context and state
 * @param question - The user's question to answer
 */
export async function handleLookupAsk(session: LookupSession, question: string): Promise<void> {
  if (!isSessionAlive(session)) return
  if (!session.contextReady) return

  if (!session.grown) {
    sendToSession(session, 'lookup-grow', LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    animateGrowSession(session, LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    session.grown = true
  }

  const messages: ProviderMessage[] = []
  messages.push({
    role: 'system',
    content: [
      'You are DeltaAI, a helpful assistant in the software\'s "lookup" window.',
      'You will help the user approach something they are not familiar with conveniently and effectively.',
      'The context will be extracted from the screen (often via OCR), and the user will ask you to analyze it or answer questions about it.',
      "Always use web search to answer the user's questions if the answer cannot be determined from the context.",
      'If the context is extracted via OCR, it may contain errors; ask for clarification when necessary, but do not mention about OCR.',
      'Answer in simple and concise words.'
    ].join('')
  })
  if (session.context) {
    messages.push({
      role: 'user',
      content: `The following context was extracted from my screen:\n\n"${session.context}"`
    })
  }
  let completeQuestion = `Answer in simple and concise words:\n\n`
  completeQuestion += !question ? 'summarize' : question
  messages.push({ role: 'user', content: completeQuestion })

  try {
    const providerCfg = loadCurrentProviderConfig()
    const webSearchEnabled = providerCfg?.webSearchEnabled ?? false
    const response = await callProvider(messages, webSearchEnabled)
    sendToSession(session, 'ai-response', response)
  } catch (err) {
    const msg =
      err instanceof NoApiKeyError || err instanceof UnsupportedProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    sendToSession(session, 'ai-error', msg)
  }
}
