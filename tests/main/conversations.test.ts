import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
  markConversationKbFed,
  mutateConversation,
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

  it('preserves kbFed across renderer autosaves that change no content', async () => {
    const fed = record('chat_kb', { kbFed: true })
    await saveConversation(fed)
    await saveConversation({ ...fed, title: 'Renamed', kbFed: false }, { preserveKbFed: true })

    const loaded = await loadConversation('chat_kb')
    expect(loaded?.kbFed).toBe(true)
    expect(loaded?.title).toBe('Renamed')
  })

  it('reopens a curated conversation for the curator when its content changes', async () => {
    await saveConversation(record('chat_kb_new', { kbFed: true }))
    await saveConversation(
      record('chat_kb_new', { kbFed: true, updatedAt: '2026-12-01T00:00:00.000Z' }),
      { preserveKbFed: true }
    )

    const loaded = await loadConversation('chat_kb_new')
    expect(loaded?.kbFed).toBe(false)
    expect(loaded?.updatedAt).toBe('2026-12-01T00:00:00.000Z')
  })

  it('keeps a look-up after curating it, like any conversation', async () => {
    await saveConversation(record('lookup_kept', { source: 'lookup' }))

    await markConversationKbFed('lookup_kept')

    expect((await loadConversation('lookup_kept'))?.kbFed).toBe(true)
  })

  it('does not mark a conversation fed when it changed after the curator read it', async () => {
    const curated = record('chat_kb_race')
    await saveConversation(curated)
    await saveConversation(record('chat_kb_race', { updatedAt: '2026-12-01T00:00:00.000Z' }), {
      preserveKbFed: true
    })

    await markConversationKbFed('chat_kb_race', curated.updatedAt)
    expect((await loadConversation('chat_kb_race'))?.kbFed).toBe(false)

    await markConversationKbFed('chat_kb_race', '2026-12-01T00:00:00.000Z')
    expect((await loadConversation('chat_kb_race'))?.kbFed).toBe(true)
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

  it('writes a metadata sidecar for every save', async () => {
    await saveConversation(record('chat_meta'))

    const metaPath = join(paths.userData, 'conversations', 'chat_meta.meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    expect(meta).toEqual({
      id: 'chat_meta',
      title: 'Conversation chat_meta',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      source: 'chat',
      kbFed: false,
      turnCount: 2
    })
    expect((await listConversations()).map((entry) => entry.id)).toEqual(['chat_meta'])
  })

  it('backfills a missing sidecar when listing', async () => {
    await saveConversation(record('chat_side'))
    const metaPath = join(paths.userData, 'conversations', 'chat_side.meta.json')
    rmSync(metaPath)

    const listed = await listConversations('chat')

    expect(listed.map((entry) => entry.id)).toEqual(['chat_side'])
    expect(existsSync(metaPath)).toBe(true)
    expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toMatchObject({ turnCount: 2 })
  })

  it('falls back to the body and repairs a corrupt sidecar', async () => {
    await saveConversation(record('chat_corrupt'))
    const metaPath = join(paths.userData, 'conversations', 'chat_corrupt.meta.json')
    writeFileSync(metaPath, '{ not json')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const listed = await listConversations('chat')
      expect(listed.map((entry) => entry.id)).toEqual(['chat_corrupt'])
    } finally {
      warn.mockRestore()
    }
    expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toMatchObject({ id: 'chat_corrupt' })
  })

  it('deletes the sidecar with the record', async () => {
    await saveConversation(record('chat_both'))
    const metaPath = join(paths.userData, 'conversations', 'chat_both.meta.json')
    expect(existsSync(metaPath)).toBe(true)

    await deleteConversation('chat_both')

    expect(existsSync(metaPath)).toBe(false)
    expect(await loadConversation('chat_both')).toBeNull()
  })

  it('deletes after an autosave that was queued before it', async () => {
    await Promise.all([saveConversation(record('chat_race')), deleteConversation('chat_race')])

    expect(await loadConversation('chat_race')).toBeNull()
    expect(existsSync(join(paths.userData, 'conversations', 'chat_race.meta.json'))).toBe(false)
  })

  it('runs mutations inside the same per-id chain as saves', async () => {
    await saveConversation(record('chat_chain'))
    const newer = record('chat_chain', {
      updatedAt: '2026-03-01T00:00:00.000Z',
      state: { turns: [{ id: 3, role: 'user', content: 'latest turn', expansions: [] }] }
    })

    await Promise.all([
      saveConversation(newer),
      mutateConversation('chat_chain', (draft) => {
        draft.kbFed = true
      })
    ])

    const loaded = await loadConversation('chat_chain')
    expect(loaded?.updatedAt).toBe('2026-03-01T00:00:00.000Z')
    expect(loaded?.kbFed).toBe(true)
    expect(loaded?.state.turns.map((turn) => turn.content)).toEqual(['latest turn'])
  })

  it('cancels a mutation when it returns false and skips missing records', async () => {
    await saveConversation(record('chat_cancel'))

    expect(await mutateConversation('chat_cancel', () => false)).toBe(false)
    expect(await mutateConversation('chat_missing', () => undefined)).toBe(false)
    expect((await loadConversation('chat_cancel'))?.kbFed).toBe(false)
  })

  it('marks fed without reverting a concurrent autosave', async () => {
    await saveConversation(record('chat_mark'))
    const newer = record('chat_mark', {
      updatedAt: '2026-04-01T00:00:00.000Z',
      state: { turns: [{ id: 4, role: 'user', content: 'newer body', expansions: [] }] }
    })

    await Promise.all([saveConversation(newer), markConversationKbFed('chat_mark')])

    const loaded = await loadConversation('chat_mark')
    expect(loaded?.kbFed).toBe(true)
    expect(loaded?.updatedAt).toBe('2026-04-01T00:00:00.000Z')
    expect(loaded?.state.turns.map((turn) => turn.content)).toEqual(['newer body'])
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

  it('finds text inside an expansion, however deeply nested', async () => {
    const node = {
      id: 1,
      start: 0,
      end: 1,
      originalText: 'a',
      answer: 'outer',
      status: 'done' as const,
      folded: false,
      children: [
        {
          id: 2,
          start: 0,
          end: 1,
          originalText: 'o',
          answer: 'a buried haystack answer',
          status: 'done' as const,
          folded: false,
          children: []
        }
      ]
    }
    await saveConversation(
      record('chat_expanded', {
        title: 'Unrelated',
        state: {
          turns: [{ id: 1, role: 'assistant', content: 'plain', expansions: [node] }]
        }
      })
    )

    const results = await searchConversations('haystack')

    expect(results.map((result) => result.id)).toEqual(['chat_expanded'])
    expect(results[0].snippet).toContain('haystack')
  })
})
