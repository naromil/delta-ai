import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRecord } from '../../src/shared/conversation'

const paths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => paths.userData }
}))

import {
  deleteConversation,
  listConversations,
  loadConversation,
  resetKbFedFlags,
  saveConversation,
  searchConversations
} from '../../src/main/conversations'

function record(id: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'chat',
    state: {
      turns: [
        { id: 1, role: 'user', content: 'first question', expansions: [] },
        {
          id: 2,
          role: 'assistant',
          content: 'The answer mentions **needle** deep inside.',
          expansions: []
        }
      ]
    },
    kbFed: false,
    ...overrides
  }
}

describe('conversation store', () => {
  beforeEach(() => {
    paths.userData = mkdtempSync(join(tmpdir(), 'delta-ai-conv-'))
  })

  afterEach(() => {
    rmSync(paths.userData, { recursive: true, force: true })
  })

  it('round-trips a conversation and lists it by source', async () => {
    await saveConversation(record('chat_a'))
    await saveConversation(
      record('lookup_a', {
        source: 'lookup',
        title: 'Lookup',
        updatedAt: '2026-01-03T00:00:00.000Z'
      })
    )

    expect((await loadConversation('chat_a'))?.title).toBe('Conversation chat_a')
    const chats = await listConversations('chat')
    expect(chats.map((meta) => meta.id)).toEqual(['chat_a'])
  })

  it('refuses ids that could escape the conversations directory', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await saveConversation(record('../escape'))
      expect(await loadConversation('../escape')).toBeNull()
    } finally {
      warn.mockRestore()
    }
    expect(await listConversations()).toEqual([])
  })

  it('preserves kbFed across renderer autosaves', async () => {
    await saveConversation(record('chat_kb', { kbFed: true }))
    await saveConversation(
      record('chat_kb', { kbFed: false, updatedAt: '2026-02-01T00:00:00.000Z' }),
      { preserveKbFed: true }
    )

    const loaded = await loadConversation('chat_kb')
    expect(loaded?.kbFed).toBe(true)
    expect(loaded?.updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('sanitises interrupted expansions when loading', async () => {
    await saveConversation(
      record('chat_load', {
        state: {
          turns: [
            {
              id: 1,
              role: 'assistant',
              content: 'x',
              expansions: [
                {
                  id: 1,
                  start: 0,
                  end: 1,
                  originalText: 'x',
                  answer: '',
                  status: 'loading',
                  folded: false,
                  children: []
                }
              ]
            }
          ]
        }
      })
    )

    const loaded = await loadConversation('chat_load')
    expect(loaded?.state.turns[0].expansions[0].status).toBe('error')
    expect(loaded?.state.turns[0].expansions[0].error).toBeDefined()
  })

  it('deletes a conversation file', async () => {
    await saveConversation(record('chat_del'))
    await deleteConversation('chat_del')
    expect(await loadConversation('chat_del')).toBeNull()
  })

  it('ranks title matches first and returns a snippet for content matches', async () => {
    await saveConversation(
      record('chat_old', { title: 'Unrelated', updatedAt: '2026-01-01T00:00:00.000Z' })
    )
    await saveConversation(
      record('chat_new', { title: 'Needle in the title', updatedAt: '2026-01-05T00:00:00.000Z' })
    )

    const results = await searchConversations('needle')

    expect(results.map((result) => result.id)).toEqual(['chat_new', 'chat_old'])
    expect(results[0]).toMatchObject({ matchedIn: 'title' })
    expect(results[0].snippet).toBeUndefined()
    expect(results[1]).toMatchObject({ matchedIn: 'content' })
    expect(results[1].snippet).toContain('needle')
  })

  it('clears kbFed on chat conversations during a KB reset, leaving lookups alone', async () => {
    await saveConversation(record('chat_fed', { kbFed: true }))
    await saveConversation(record('chat_unfed', { kbFed: false }))
    await saveConversation(record('lookup_fed', { source: 'lookup', kbFed: true }))

    await resetKbFedFlags()

    const chats = await listConversations('chat')
    expect(chats.every((meta) => meta.kbFed === false)).toBe(true)
    expect((await loadConversation('lookup_fed'))?.kbFed).toBe(true)
  })
})
