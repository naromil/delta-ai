import type { ConversationState, ProviderMessage, Turn } from './conversation'
import { serializeForChat } from './conversation'
import {
  buildExpandAncestorQuestion,
  buildExpandPromptedInstruction,
  buildExpandUserInstruction
} from './prompts'
import type { ExpansionNode, ExpansionRange } from './rich-text'
import { expansionMessageInput, expansionPath } from './rich-text'

/** Messages of earlier conversation sent with an expansion; the budget in main still applies. */
export const EXPAND_HISTORY_MESSAGES = 6

export interface BuildExpandMessagesInput {
  /** Earlier conversation, oldest first, ending just before the answer. */
  history?: ProviderMessage[]
  /** Open expansions the selection is nested in, outermost first. */
  ancestors?: ExpansionNode[]
  /** The turn the selection is in; for a nested selection, the turn its ancestors start from. */
  answer: string
  selection: string
  prompt?: string
}

export function buildExpandMessages(input: BuildExpandMessagesInput): ProviderMessage[] {
  const { history = [], ancestors = [], answer, selection, prompt } = input
  const messages: ProviderMessage[] = [
    ...history,
    { role: 'assistant', content: answer || '(empty answer)' }
  ]

  for (const ancestor of ancestors) {
    messages.push({
      role: 'user',
      content: buildExpandAncestorQuestion(ancestor.originalText, ancestor.prompt)
    })
    messages.push({ role: 'assistant', content: ancestor.answer || '(empty answer)' })
  }

  messages.push({
    role: 'user',
    content:
      prompt !== undefined
        ? buildExpandPromptedInstruction(selection, prompt)
        : buildExpandUserInstruction(selection)
  })
  return messages
}

/**
 * The system prompt and screen context, then the newest messages before `turn`.
 * Expansions are text-only, so attachments are left out and an image-only
 * message disappears.
 */
function expandHistory(
  state: ConversationState,
  turn: Turn,
  role: 'chat' | 'lookup'
): { system: ProviderMessage[]; history: ProviderMessage[] } {
  const index = state.turns.findIndex((item) => item.id === turn.id)
  const before = state.turns.slice(0, Math.max(0, index))
  const all = serializeForChat({ ...state, turns: before }, role)
  const leading = state.context ? 2 : 1
  const history = all
    .slice(leading)
    .filter((message) => message.content.trim() !== '')
    .slice(-EXPAND_HISTORY_MESSAGES)
    .map(({ role: messageRole, content }) => ({ role: messageRole, content }))
  return { system: all.slice(0, leading), history }
}

/**
 * Everything one expansion request sends: the question and recent turns that led
 * to the answer, and the chain of expansions the selection is nested in.
 */
export function buildExpandRequest(
  state: ConversationState,
  turn: Turn,
  parentId: number | undefined,
  range: ExpansionRange,
  role: 'chat' | 'lookup',
  prompt?: string
): ProviderMessage[] | null {
  const input = expansionMessageInput(turn, parentId, range)
  if (!input) return null
  const ancestors = parentId === undefined ? [] : expansionPath(turn.expansions, parentId)
  if (!ancestors) return null

  const { system, history } = expandHistory(state, turn, role)
  return [
    ...system,
    ...buildExpandMessages({
      history,
      ancestors,
      answer: turn.content,
      selection: input.selection,
      ...(prompt !== undefined ? { prompt } : {})
    })
  ]
}
