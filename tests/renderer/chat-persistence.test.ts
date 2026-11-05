import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRecord, ConversationState, Turn } from '../../src/shared/conversation'
import type { ExpansionNode } from '../../src/shared/rich-text'
import { EXPANSION_EMPTY_ERROR, EXPANSION_INTERRUPTED_ERROR } from '../../src/shared/rich-text'
import {
  SAVE_FAILED_MESSAGE,
  saveConversationState
} from '../../src/renderer/src/hooks/chat/persistence'
import type { ConversationMeta } from '../../src/renderer/src/hooks/chat/persistence'

const meta: ConversationMeta = {
  id: 'conv-1',
  source: 'chat',
  title: 'A chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  kbFed: false
}

function turn(id: number, role: Turn['role'], content: string): Turn {
  return { id, role, content, expansions: [] }
}

function expansion(id: number, overrides: Partial<ExpansionNode> = {}): ExpansionNode {
  return {
    id,
    start: 0,
    end: 2,
    originalText: 'hi',
    answer: '',
    status: 'done',
    folded: false,
    children: [],
    ...overrides
  }
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

describe('saveConversationState type', () => {
  it('keeps a look-up a look-up, screen text included, when the chat view saves it', async () => {
    const state = { context: 'Text on screen', turns: [turn(1, 'user', 'hi')] }
    await saveConversationState(state, { ...meta, source: 'lookup' })

    const [saved] = saveConversation.mock.calls[0]
    expect(saved.source).toBe('lookup')
    expect(saved).toMatchObject({ lookup: { context: 'Text on screen' } })
    expect(saved.state).toEqual({ turns: state.turns })
  })

  it('gives a chat no look-up properties', async () => {
    await saveConversationState(chat(turn(1, 'user', 'hi')), meta)

    const [saved] = saveConversation.mock.calls[0]
    expect(saved.source).toBe('chat')
    expect(saved).not.toHaveProperty('lookup')
  })
})

describe('saveConversationState outcome', () => {
  it('resolves ok when the main process saves the record', async () => {
    const outcome = await saveConversationState(chat(turn(1, 'user', 'hi')), meta)

    expect(outcome).toEqual({ ok: true })
  })

  it('resolves with a readable error instead of rejecting when the save fails', async () => {
    saveConversation.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))

    const outcome = await saveConversationState(chat(turn(1, 'user', 'hi')), meta)

    expect(outcome).toEqual({
      ok: false,
      error: `${SAVE_FAILED_MESSAGE}: ENOSPC: no space left on device`
    })
  })

  it('falls back to a generic message for a rejection without detail', async () => {
    saveConversation.mockRejectedValueOnce(undefined)

    const outcome = await saveConversationState(chat(turn(1, 'user', 'hi')), meta)

    expect(outcome).toEqual({ ok: false, error: `${SAVE_FAILED_MESSAGE}.` })
  })
})

describe('saveConversationState skip rules', () => {
  it('saves nothing for a conversation without turns', () => {
    expect(saveConversationState(chat(), meta)).toBeUndefined()
    expect(saveConversation).not.toHaveBeenCalled()
  })

  it('saves nothing when every turn is blank', () => {
    const state = chat(turn(1, 'user', '   '), turn(2, 'assistant', ''))

    expect(saveConversationState(state, meta)).toBeUndefined()
    expect(saveConversation).not.toHaveBeenCalled()
  })

  it('saves nothing for a look-up holding only screen context', () => {
    const state = { context: 'Text on screen', turns: [] }

    expect(saveConversationState(state, { ...meta, source: 'lookup' })).toBeUndefined()
    expect(saveConversation).not.toHaveBeenCalled()
  })

  it('drops a blank assistant placeholder but keeps the question before it', async () => {
    const question = turn(1, 'user', 'hi')
    await saveConversationState(chat(question, turn(2, 'assistant', '  ')), meta)

    const [saved] = saveConversation.mock.calls[0]
    expect(saved.state.turns).toEqual([question])
  })

  it('keeps an assistant error turn so Retry survives a reload', async () => {
    const failed: Turn = { ...turn(2, 'assistant', 'Request failed'), error: true }
    await saveConversationState(chat(turn(1, 'user', 'hi'), failed), meta)

    const [saved] = saveConversation.mock.calls[0]
    expect(saved.state.turns).toEqual([turn(1, 'user', 'hi'), failed])
  })

  it('carries the meta onto the record', async () => {
    await saveConversationState(chat(turn(1, 'user', 'hi')), meta)

    const [saved] = saveConversation.mock.calls[0]
    expect(saved).toMatchObject({
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      kbFed: meta.kbFed
    })
  })
})

describe('saveConversationState loading expansions', () => {
  it('saves a streaming expansion as an error, nested ones included', async () => {
    const nested = expansion(3, { status: 'loading', answer: '' })
    const outer = expansion(2, { status: 'loading', answer: 'Partial text', children: [nested] })
    const answer: Turn = { ...turn(2, 'assistant', 'hi there'), expansions: [outer] }
    await saveConversationState(chat(turn(1, 'user', 'hi'), answer), meta)

    const [saved] = saveConversation.mock.calls[0]
    const [savedOuter] = saved.state.turns[1].expansions
    expect(savedOuter).toMatchObject({ status: 'error', error: EXPANSION_INTERRUPTED_ERROR })
    expect(savedOuter.children[0]).toMatchObject({ status: 'error', error: EXPANSION_EMPTY_ERROR })
  })

  it('leaves the in-memory state streaming', async () => {
    const live = expansion(2, { status: 'loading', answer: 'Partial text' })
    const answer: Turn = { ...turn(2, 'assistant', 'hi there'), expansions: [live] }
    await saveConversationState(chat(turn(1, 'user', 'hi'), answer), meta)

    expect(answer.expansions[0]).toBe(live)
    expect(live.status).toBe('loading')
  })

  it('keeps finished expansions as they are', async () => {
    const done = expansion(2, { answer: 'A greeting' })
    const answer: Turn = { ...turn(2, 'assistant', 'hi there'), expansions: [done] }
    await saveConversationState(chat(turn(1, 'user', 'hi'), answer), meta)

    const [saved] = saveConversation.mock.calls[0]
    expect(saved.state.turns[1].expansions).toEqual([done])
  })
})
