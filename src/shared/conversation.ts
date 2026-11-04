import type { ImageAttachment } from './attachments'
import { attachmentImages } from './attachments'
import type { CanvasLayout } from './canvas'
import { normalizeCanvasLayout } from './canvas'
import type { ProviderMessage } from './models'
import { getSystemPrompt, buildScreenContextMessage } from './prompts'
import type { ExpansionNode, LegacyTurn, RichTextTurn } from './rich-text'
import { finalizeTurns, flattenMarkdown, migrateLegacyTurns } from './rich-text'

export type { ProviderMessage, ExpansionNode }

export interface Turn extends RichTextTurn {
  role: 'user' | 'assistant'
  error?: boolean
  /** Images sent with a user turn. */
  attachments?: ImageAttachment[]
}

/** A conversation's type. Every type is stored and listed the same way. */
export type ConversationSource = 'chat' | 'lookup' | 'canvas'

export const CONVERSATION_SOURCE_LABELS: Record<ConversationSource, string> = {
  chat: 'Chat',
  lookup: 'Look-up',
  canvas: 'Canvas'
}

/** What any window needs to open a conversation in the view that owns its type. */
export interface ConversationTarget {
  id: string
  source: ConversationSource
}

/** What every type has in common. */
export interface ConversationContent {
  turns: Turn[]
}

/** The chat hook's live state: a line of turns, with a look-up's screen text when it has one. */
export interface ConversationState extends ConversationContent {
  context?: string
}

interface ConversationBase {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  state: ConversationContent
  kbFed: boolean
}

export interface ChatRecord extends ConversationBase {
  source: 'chat'
}

export interface LookupRecord extends ConversationBase {
  source: 'lookup'
  lookup: {
    /** The screen text the look-up was asked about; empty when it had none. */
    context: string
  }
}

export interface CanvasRecord extends ConversationBase {
  source: 'canvas'
  /** Where each turn and expansion sits. */
  canvas: CanvasLayout
}

/** One entity: shared fields, plus properties only its own type may hold. */
export type ConversationRecord = ChatRecord | LookupRecord | CanvasRecord

/** The types the chat hook and the chat view can show. */
export type LinearRecord = ChatRecord | LookupRecord
export type LinearSource = LinearRecord['source']

/** Records written before per-type properties kept them all in `state`. */
type StoredRecord = Omit<ConversationBase, 'state'> & {
  source?: ConversationSource
  state: ConversationContent & { context?: string; canvas?: CanvasLayout }
  lookup?: { context?: string }
  canvas?: CanvasLayout
}

export interface ConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  source: ConversationSource
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

/** A chat cannot hold screen text, so an old one that does keeps it as its first message. */
function withContextTurn(turns: Turn[], context: string | undefined): Turn[] {
  if (!context) return turns
  const id = Math.min(0, ...turns.map((turn) => turn.id)) - 1
  return [
    { id, role: 'user', content: buildScreenContextMessage(context), expansions: [] },
    ...turns
  ]
}

/**
 * Load-time boundary for persisted records: gives each type its own properties,
 * rebuilds turns written before offset-anchored expansions and converts any
 * transient `loading` frame into a recoverable error, so a reload never shows a
 * frame that waits forever. Anything belonging to another type is dropped here.
 */
export function migrateConversationRecord(record: ConversationRecord): ConversationRecord {
  const stored = record as StoredRecord
  const { id, title, createdAt, updatedAt, kbFed } = stored
  const legacyTurns = stored.state.turns as unknown as LegacyTurn[]
  const turns = finalizeTurns(migrateLegacyTurns(legacyTurns) as Turn[])
  const base = { id, title, createdAt, updatedAt, kbFed }
  if (stored.source === 'canvas') {
    const canvas = stored.canvas ?? stored.state.canvas ?? normalizeCanvasLayout(undefined, turns)
    return { ...base, source: 'canvas', state: { turns }, canvas }
  }
  if (stored.source === 'lookup') {
    const context = stored.lookup?.context ?? stored.state.context ?? ''
    return { ...base, source: 'lookup', state: { turns }, lookup: { context } }
  }
  return {
    ...base,
    source: 'chat',
    state: { turns: withContextTurn(turns, stored.state.context) }
  }
}

/** The chat hook's state for a record it can show. */
export function linearStateOf(record: LinearRecord): ConversationState {
  return {
    context: record.source === 'lookup' ? record.lookup.context : '',
    turns: record.state.turns
  }
}

/** The record for a chat hook's state; screen text is kept only by the type that has it. */
export function linearRecordOf(
  meta: Omit<ConversationBase, 'state'> & { source: LinearSource },
  state: ConversationState
): LinearRecord {
  const { id, title, createdAt, updatedAt, kbFed } = meta
  const base = { id, title, createdAt, updatedAt, kbFed, state: { turns: state.turns } }
  return meta.source === 'lookup'
    ? { ...base, source: 'lookup', lookup: { context: state.context ?? '' } }
    : { ...base, source: 'chat' }
}

/**
 * Serialize a conversation into provider messages.
 *
 * The system prompt is always sent; the screen-context preamble is prepended
 * only when a context exists (the lookup's context source can be off, and
 * capture/OCR can come up empty). Expansions are UI annotations and are never
 * added to the model context.
 */
export function serializeForChat(
  state: ConversationState,
  role?: 'chat' | 'lookup'
): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'system', content: getSystemPrompt(role) }]

  if (state.context) {
    messages.push({
      role: 'user',
      content: buildScreenContextMessage(state.context)
    })
  }

  for (const turn of state.turns) {
    // Failed turns store the error text for the UI, and empty assistant turns are
    // in-flight/legacy placeholders; neither may be replayed to the model.
    if (turn.role === 'assistant' && (turn.error || turn.content.trim() === '')) continue
    const images = attachmentImages(turn.attachments)
    messages.push({
      role: turn.role,
      content: turn.content,
      ...(images.length > 0 ? { images } : {})
    })
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
