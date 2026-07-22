import type { ProviderMessage } from './conversation'

export interface BuildExpandMessagesInput {
  answer: string
  selection: string
}

export function buildExpandMessages(input: BuildExpandMessagesInput): ProviderMessage[] {
  const { answer, selection } = input
  const messages: ProviderMessage[] = []

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

  return messages
}
