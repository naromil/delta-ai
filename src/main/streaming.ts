import type { ProviderMessage } from './provider'
import { MAX_ATTACHMENTS_PER_MESSAGE, isImageAttachment, isImageInput } from '../shared/attachments'
import type { ConversationRecord, ConversationState } from '../shared/conversation'

/* ---- IPC payload validation ----
 * The renderer is our own bundle, but main still owns what reaches a provider
 * or the disk: a payload of the wrong shape is refused rather than trusted.
 */

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Streaming IPC may only target the chat and lookup roles; anything else is chat. */
export function parseStreamRole(raw: unknown): 'chat' | 'lookup' {
  return raw === 'lookup' ? 'lookup' : 'chat'
}

export function parseProviderMessages(raw: unknown): ProviderMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const messages: ProviderMessage[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.content !== 'string') return null
    if (typeof entry.role !== 'string' || !MESSAGE_ROLES.has(entry.role)) return null
    if (entry.images === undefined) {
      messages.push({ role: entry.role, content: entry.content })
      continue
    }
    if (
      entry.role !== 'user' ||
      !Array.isArray(entry.images) ||
      entry.images.length > MAX_ATTACHMENTS_PER_MESSAGE ||
      !entry.images.every(isImageInput)
    ) {
      return null
    }
    const images = entry.images.map(({ mediaType, data }) => ({ mediaType, data }))
    messages.push({ role: entry.role, content: entry.content, images })
  }
  return messages
}

function hasValidTurns(value: unknown): value is { turns: unknown[] } {
  if (!isRecord(value) || !Array.isArray(value.turns)) return false
  return value.turns.every(
    (turn) =>
      isRecord(turn) &&
      typeof turn.id === 'number' &&
      (turn.role === 'user' || turn.role === 'assistant') &&
      typeof turn.content === 'string' &&
      (turn.expansions === undefined || Array.isArray(turn.expansions)) &&
      (turn.attachments === undefined ||
        (Array.isArray(turn.attachments) && turn.attachments.every(isImageAttachment)))
  )
}

export function isConversationState(value: unknown): value is ConversationState {
  if (!hasValidTurns(value)) return false
  const { context } = value as { context?: unknown }
  return context === undefined || typeof context === 'string'
}

/** Each type holds its own properties and nobody else's. */
function hasOwnTypeProperties(value: Record<string, unknown>): boolean {
  const { source, lookup, canvas } = value
  if (source === 'chat') return lookup === undefined && canvas === undefined
  if (source === 'lookup') {
    return canvas === undefined && isRecord(lookup) && typeof lookup.context === 'string'
  }
  return source === 'canvas' && lookup === undefined && isRecord(canvas)
}

export function isConversationRecord(value: unknown): value is ConversationRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    hasOwnTypeProperties(value) &&
    hasValidTurns(value.state) &&
    (value.state as Record<string, unknown>).context === undefined &&
    (value.state as Record<string, unknown>).canvas === undefined
  )
}

/* ---- Prompt assembly ---- */

/** Appends instructions to the system prompt (or adds one). */
export function withInstructions(
  messages: ProviderMessage[],
  instructions: string
): ProviderMessage[] {
  if (!instructions) return messages
  const systemIndex = messages.findIndex((msg) => msg.role === 'system')
  if (systemIndex === -1) return [{ role: 'system', content: instructions }, ...messages]
  return messages.map((msg, index) =>
    index === systemIndex ? { ...msg, content: msg.content + '\n\n' + instructions } : msg
  )
}

/* ---- Chunk batching ---- */

export const CHUNK_FLUSH_INTERVAL_MS = 32

export interface ChunkBatcher {
  push: (delta: string) => void
  /** Sends whatever is buffered now. */
  flush: () => void
  /** Drops the buffer and the timer; the final message carries the full text. */
  stop: () => void
}

/**
 * Coalesces provider tokens into at most one IPC message per interval, each
 * carrying only the text since the last one. Sending the whole answer per
 * token made long answers quadratic in both IPC bytes and renderer work.
 */
export function createChunkBatcher(
  send: (delta: string) => void,
  intervalMs = CHUNK_FLUSH_INTERVAL_MS
): ChunkBatcher {
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (buffer === '') return
    const delta = buffer
    buffer = ''
    send(delta)
  }

  return {
    push: (delta) => {
      if (delta === '') return
      buffer += delta
      if (timer === null) timer = setTimeout(flush, intervalMs)
    },
    flush,
    stop: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      buffer = ''
    }
  }
}
