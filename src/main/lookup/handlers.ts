import { lookupState, doesLookupWindowExist, sendToWindow, notifyContextState } from './state'
import { runOCRTokened } from './capture'
import { callProvider, NoApiKeyError, UnsupportedProviderError } from '../provider'
import type { ProviderMessage } from '../provider'
import { animateGrowWindow, LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT } from './window'

export function handlePasteText(text: string): void {
  if (!doesLookupWindowExist()) return
  lookupState.lookupOcrToken++
  lookupState.lookupContext = text
  lookupState.lookupContextReady = true
  notifyContextState('ready', text, 'Pasted text')
}

export async function handlePasteImage(base64: string): Promise<void> {
  if (!doesLookupWindowExist()) return
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) return

  lookupState.lookupOcrToken++
  lookupState.lookupContextReady = false
  notifyContextState('processing', '', 'OCR running on pasted image…')

  const text = await runOCRTokened(buffer)
  if (text === null) return

  if (!doesLookupWindowExist()) return

  lookupState.lookupContext = text
  lookupState.lookupContextReady = true
  notifyContextState('ready', text, text ? '' : 'No text detected in pasted image')
}

export async function handleLookupAsk(question: string): Promise<void> {
  const win = lookupState.lookupWindow
  if (!win || win.isDestroyed()) return
  if (!lookupState.lookupContextReady) return

  if (!lookupState.lookupGrown) {
    sendToWindow('lookup-grow', LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    animateGrowWindow(LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
    lookupState.lookupGrown = true
  }

  const messages: ProviderMessage[] = []
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
  if (lookupState.lookupContext) {
    messages.push({
      role: 'user',
      content: `The following context was extracted from my screen:\n\n"${lookupState.lookupContext}"`
    })
  }
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
