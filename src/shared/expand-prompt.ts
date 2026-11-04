import type { ImageAttachment } from './attachments'
import { attachmentImages } from './attachments'
import type { ConversationState, ProviderMessage, Turn } from './conversation'
import { serializeForChat } from './conversation'
import {
  buildExpandAncestorQuestion,
  buildExpandPromptedInstruction,
  buildExpandUserInstruction
} from './prompts'
import type { ExpansionNode, ExpansionRange } from './rich-text'
import { expansionMessageInput, expansionPath } from './rich-text'

export interface BuildExpandMessagesInput {
  /** Open expansions the selection is nested in, outermost first. */
  ancestors?: ExpansionNode[]
  /** The turn the selection is in; for a nested selection, the turn its ancestors start from. */
  answer: string
  selection: string
  prompt?: string
  attachments?: ImageAttachment[]
}

function questionMessage(content: string, attachments?: ImageAttachment[]): ProviderMessage {
  const images = attachmentImages(attachments)
  return { role: 'user', content, ...(images.length > 0 ? { images } : {}) }
}

export function buildExpandMessages(input: BuildExpandMessagesInput): ProviderMessage[] {
  const { ancestors = [], answer, selection, prompt, attachments } = input
  const messages: ProviderMessage[] = [{ role: 'assistant', content: answer || '(empty answer)' }]

  for (const ancestor of ancestors) {
    messages.push(
      questionMessage(
        buildExpandAncestorQuestion(ancestor.originalText, ancestor.prompt),
        ancestor.attachments
      )
    )
    messages.push({ role: 'assistant', content: ancestor.answer || '(empty answer)' })
  }

  messages.push(
    questionMessage(
      prompt !== undefined
        ? buildExpandPromptedInstruction(selection, prompt)
        : buildExpandUserInstruction(selection),
      attachments
    )
  )
  return messages
}

/**
 * An expansion is a follow-up branching from `turn`: exactly what a follow-up sent at
 * that point would hold, then the chain of expansions the selection is nested in. Keeping
 * that prefix identical is what lets a provider serve it from its prompt cache.
 */
export function buildExpandRequest(
  state: ConversationState,
  turn: Turn,
  parentId: number | undefined,
  range: ExpansionRange,
  role: 'chat' | 'lookup',
  prompt?: string,
  attachments?: ImageAttachment[]
): ProviderMessage[] | null {
  const input = expansionMessageInput(turn, parentId, range)
  if (!input) return null
  const ancestors = parentId === undefined ? [] : expansionPath(turn.expansions, parentId)
  if (!ancestors) return null

  const index = state.turns.findIndex((item) => item.id === turn.id)
  const before = state.turns.slice(0, Math.max(0, index))
  return [
    ...serializeForChat({ ...state, turns: before }, role),
    ...buildExpandMessages({
      ancestors,
      answer: turn.content,
      selection: input.selection,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(attachments?.length ? { attachments } : {})
    })
  ]
}
