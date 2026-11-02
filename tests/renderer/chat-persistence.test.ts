import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRecord, ConversationState, Turn } from '../../src/shared/conversation'
import {
  SAVE_FAILED_MESSAGE,
  saveConversationState
} from '../../src/renderer/src/hooks/chat/persistence'
import type { ConversationMeta } from '../../src/renderer/src/hooks/chat/persistence'

const meta: ConversationMeta = {
  id: 'conv-1',
  title: 'A chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  kbFed: false
}

function turn(id: number, role: Turn['role'], content: string): Turn {
  return { id, role, content, expansions: [] }
}

function chat(...turns: Turn[]): ConversationState {
  return { context: '', turns }
}

let saveConversation: ReturnType<typeof vi.fn<(record: ConversationRecord) => Promise<void>>>

beforeEach(() => {
  saveConversation = vi.fn<(record: ConversationRecord) => Promise<void>>(() => Promise.resolve())
  vi.stubGlobal('window', { api: { saveConversation } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saveConversationState outcome', () => {
  it('resolves ok when the main process saves the record', async () => {
    const outcome = await saveConversationState(chat(turn(1, 'user', 'hi')), 'chat', meta)

    expect(outcome).toEqual({ ok: true })
  })

  it('resolves with a readable error instead of rejecting when the save fails', async () => {
    saveConversation.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))

    const outcome = await saveConversationState(chat(turn(1, 'user', 'hi')), 'chat', meta)

    expect(outcome).toEqual({
      ok: false,
      error: `${SAVE_FAILED_MESSAGE}: ENOSPC: no space left on device`
    })
  })

  it('falls back to a generic message for a rejection without detail', async () => {
    saveConversation.mockRejectedValueOnce(undefined)

    const outcome = await saveConversationState(chat(turn(1, 'user', 'hi')), 'chat', meta)

    expect(outcome).toEqual({ ok: false, error: `${SAVE_FAILED_MESSAGE}.` })
  })
})
