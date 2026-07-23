import type { ProviderMessage } from './conversation'
import { ANSWER_FALLBACK, buildExpandUserInstruction } from './prompts'

export interface BuildExpandMessagesInput {
  answer: string
  selection: string
}

export function buildExpandMessages(input: BuildExpandMessagesInput): ProviderMessage[] {
  const { answer, selection } = input
  const messages: ProviderMessage[] = []

  messages.push({
    role: 'assistant',
    content: answer || ANSWER_FALLBACK
  })
  messages.push({
    role: 'user',
    content: buildExpandUserInstruction(selection)
  })

  return messages
}
