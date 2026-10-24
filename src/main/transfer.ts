import type { ConversationState } from '../shared/conversation'
import { finalizeTurns } from '../shared/rich-text'
import { buildScreenContextMessage } from '../shared/prompts'

/**
 * Prepares the lookup window's live state before it is persisted and forwarded
 * to the chat window.
 *
 * The lookup renderer may transfer while an expansion is still streaming;
 * transient `loading` frames are finalised into recoverable errors exactly once
 * here, so neither the file nor the `chat-replace-conversation` payload ever
 * carries in-flight transport state. A screen-context preamble is folded into
 * a leading user turn.
 */
export function prepareTransferredState(state: ConversationState): ConversationState {
  const turns = finalizeTurns([...state.turns])
  if (!state.context) return { ...state, turns }

  return {
    ...state,
    turns: [
      {
        id: Date.now(),
        role: 'user',
        content: buildScreenContextMessage(state.context),
        expansions: []
      },
      ...turns
    ],
    context: ''
  }
}
