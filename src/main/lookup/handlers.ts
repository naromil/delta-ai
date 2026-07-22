import type { LookupSession } from './state'
import { isSessionAlive, sendToSession, notifySessionState } from './state'
import { runOCRTokenedFor, cancelOCR } from './capture'
import {
  callProviderStream,
  NoApiKeyError,
  UnsupportedProviderError,
  RoleUnassignedError
} from '../provider'
import type { ProviderMessage } from '../provider'
import { animateGrowSession, LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT } from './window'

export interface ExpandPayload {
  context: string
  question: string
  answer: string
  selection: string
  expansionId: number
}

export async function handlePasteText(session: LookupSession, text: string): Promise<void> {
  if (!isSessionAlive(session)) return

  // Cancel in-flight fullscreen OCR so paste OCR doesn't wait for it
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
  notifySessionState(session, 'processing', '', 'OCR running on pasted image…')

  const text = await runOCRTokenedFor(session, buffer)
  if (text === null) return

  if (!isSessionAlive(session)) return

  session.context = text
  session.contextReady = true
  notifySessionState(session, 'ready', text, text ? '' : 'No text detected in pasted image')
}

function initializeMessagesWithContext(context: string): ProviderMessage[] {
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
  if (context) {
    messages.push({
      role: 'user',
      content: `The following context was extracted from my screen:\n\n"${context}"`
    })
  }
  return messages
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

  const messages = initializeMessagesWithContext(session.context)
  const completeQuestion = `Answer in simple and concise words:\n\n` + (question || 'summarize')
  messages.push({ role: 'user', content: completeQuestion })

  try {
    let fullResponse = ''
    for await (const chunk of callProviderStream(messages, 'lookup')) {
      fullResponse += chunk
      sendToSession(session, 'lookup-ai-chunk', fullResponse)
    }
    sendToSession(session, 'ai-response', fullResponse)
  } catch (err) {
    let msg: string
    if (
      err instanceof NoApiKeyError ||
      err instanceof UnsupportedProviderError ||
      err instanceof RoleUnassignedError
    ) {
      msg = err.message
    } else if (err instanceof Error) {
      msg = err.message
    } else {
      msg = String(err)
    }
    sendToSession(session, 'ai-error', msg)
  }
}

/**
 * Handles an "expand" request from the lookup window: the user has selected
 * a word/excerpt inside an AI answer and asked for an inline expansion.
 *
 * On the first expansion we grow the window to its centered work-area max
 * (per spec point 2). The expansion request itself is a tame prompt built
 * from the original context + question + surrounding answer + the selected
 * excerpt, and the streaming chunk is delivered back tagged with the
 * caller's expansionId.
 */
export async function handleLookupExpand(
  session: LookupSession,
  payload: ExpandPayload
): Promise<void> {
  const { context, question, answer, selection, expansionId } = payload
  if (!isSessionAlive(session)) return
  if (!selection.trim()) return

  const messages = initializeMessagesWithContext(context)
  if (question) {
    messages.push({
      role: 'user',
      content: `My initial question was: ${question}`
    })
  }
  messages.push({
    role: 'assistant',
    content: answer || '(empty answer)'
  })
  messages.push({
    role: 'user',
    content: [
      `Define "${selection}" from the text above.`,
      'Do NOT repeat the word itself or re-state the sentence it appears in.',
      'Do NOT use phrases like "refers to" or "is" that introduce the word.',
      'Output just the definition — a bare phrase or noun phrase.',
      'Example good output for "HKUMed": Li Ka Shing Faculty of Medicine at the University of Hong Kong',
      'Example bad output: "HKUMed" refers to the Li Ka Shing Faculty of Medicine...',
      'Keep it to at most two short phrases. Respond in inline text only.'
    ].join(' ')
  })

  try {
    let fullResponse = ''
    for await (const chunk of callProviderStream(messages, 'lookup')) {
      fullResponse += chunk
      sendToSession(session, 'lookup-expand-chunk', { expansionId, text: fullResponse })
    }
  } catch (err) {
    let msg: string
    if (
      err instanceof NoApiKeyError ||
      err instanceof UnsupportedProviderError ||
      err instanceof RoleUnassignedError
    ) {
      msg = err.message
    } else if (err instanceof Error) {
      msg = err.message
    } else {
      msg = String(err)
    }
    sendToSession(session, 'lookup-expand-chunk', { expansionId, error: msg })
  }
}
