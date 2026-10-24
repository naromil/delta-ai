import type { ProviderMessage } from './models'
import { getSystemPrompt, buildScreenContextMessage } from './prompts'
import type { ExpansionNode, LegacyTurn, RichTextTurn } from './rich-text'
import { finalizeTurns, flattenMarkdown, migrateLegacyTurns } from './rich-text'

export type { ProviderMessage, ExpansionNode }

export interface Turn extends RichTextTurn {
  role: 'user' | 'assistant'
  error?: boolean
}

export interface ConversationState {
  context?: string
  systemNote?: string
  turns: Turn[]
}

export interface ConversationRecord {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  source: 'chat' | 'lookup'
  state: ConversationState
  kbFed: boolean
}

export interface ConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  source: 'chat' | 'lookup'
  kbFed: boolean
  turnCount: number
}

export interface ConversationSearchResult extends ConversationMeta {
  /** Where the query matched; title matches rank first. */
  matchedIn: 'title' | 'content'
  /** Nearby flattened text around a content match. */
  snippet?: string
}

/**
 * Turns that are safe to persist. An assistant turn with no content is an
 * in-flight placeholder; saving it would leave a phantom trailing turn that
 * later gets replayed to the model.
 */
export function persistableTurns(turns: Turn[]): Turn[] {
  return turns.filter((turn) => turn.role !== 'assistant' || turn.content.trim() !== '')
}

export function toConversationMeta(record: ConversationRecord): ConversationMeta {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    source: record.source,
    kbFed: record.kbFed,
    turnCount: record.state.turns.length
  }
}

/**
 * Load-time boundary for persisted records: rebuilds turns written before
 * offset-anchored expansions and converts any transient `loading` frame into a
 * recoverable error, so a reload never shows a frame that waits forever.
 */
export function migrateConversationRecord(record: ConversationRecord): ConversationRecord {
  const migrated = migrateLegacyTurns(record.state.turns as unknown as LegacyTurn[]) as Turn[]
  return { ...record, state: { ...record.state, turns: finalizeTurns(migrated) } }
}

/**
 * Serialize a conversation into provider messages.
 *
 * The system prompt is always sent; the screen-context preamble is prepended
 * only when a context exists (or the caller is the lookup window, which always
 * introduces itself as screen-aware). Expansions are UI annotations and are
 * never added to the model context.
 */
export function serializeForChat(
  state: ConversationState,
  role?: 'chat' | 'lookup'
): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'system', content: getSystemPrompt(role) }]

  if (role === 'lookup' || state.context) {
    messages.push({
      role: 'user',
      content: buildScreenContextMessage(state.context ?? '')
    })
  }

  for (const turn of state.turns) {
    // Failed turns store the error text for the UI, and empty assistant turns are
    // in-flight/legacy placeholders; neither may be replayed to the model.
    if (turn.role === 'assistant' && (turn.error || turn.content.trim() === '')) continue
    messages.push({ role: turn.role, content: turn.content })
  }
  return messages
}

export const CONVERSATION_TITLE_MAX_LENGTH = 60

/** Derive a conversation title from its first user message. */
export function buildConversationTitle(text: string): string {
  const flat = flattenMarkdown(text).replace(/\s+/g, ' ').trim()
  if (flat === '') return 'New conversation'
  if (flat.length <= CONVERSATION_TITLE_MAX_LENGTH) return flat
  return flat.slice(0, CONVERSATION_TITLE_MAX_LENGTH).trimEnd()
}
