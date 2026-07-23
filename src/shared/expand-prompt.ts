import type { ProviderMessage } from './conversation'
import {
  ANSWER_FALLBACK,
  buildExpandUserInstruction,
  buildExpandPromptedInstruction
} from './prompts'

export interface BuildExpandMessagesInput {
  answer: string
  selection: string
  prompt?: string
}

export function buildExpandMessages(input: BuildExpandMessagesInput): ProviderMessage[] {
  const { answer, selection, prompt } = input
  const messages: ProviderMessage[] = []

  messages.push({
    role: 'assistant',
    content: answer || ANSWER_FALLBACK
  })
  messages.push({
    role: 'user',
    content:
      prompt !== undefined
        ? buildExpandPromptedInstruction(selection, prompt)
        : buildExpandUserInstruction(selection)
  })

  return messages
}
