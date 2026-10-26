import type { ProviderMessage } from './provider'
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
    messages.push({ role: entry.role, content: entry.content })
  }
  return messages
}

export function isConversationState(value: unknown): value is ConversationState {
  if (!isRecord(value) || !Array.isArray(value.turns)) return false
  if (value.context !== undefined && typeof value.context !== 'string') return false
  return value.turns.every(
    (turn) =>
      isRecord(turn) &&
      typeof turn.id === 'number' &&
      (turn.role === 'user' || turn.role === 'assistant') &&
      typeof turn.content === 'string' &&
      (turn.expansions === undefined || Array.isArray(turn.expansions))
  )
}

export function isConversationRecord(value: unknown): value is ConversationRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.source === 'chat' || value.source === 'lookup') &&
    isConversationState(value.state)
  )
}

/* ---- Prompt assembly ---- */

/** Appends the learned profile to the system prompt (or adds one). */
export function withKbPrompt(messages: ProviderMessage[], kbPrompt: string): ProviderMessage[] {
  if (!kbPrompt) return messages
  const systemIndex = messages.findIndex((msg) => msg.role === 'system')
  if (systemIndex === -1) return [{ role: 'system', content: kbPrompt }, ...messages]
  return messages.map((msg, index) =>
    index === systemIndex ? { ...msg, content: msg.content + '\n\n' + kbPrompt } : msg
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
