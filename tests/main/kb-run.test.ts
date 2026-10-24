import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRecord } from '../../src/shared/conversation'
import type { CategorizedKeyword } from '../../src/shared/models'

const { callProvider, loadConversation, markConversationKbFed, saveKbPrompt, store } = vi.hoisted(
  () => ({
    callProvider: vi.fn(),
    loadConversation: vi.fn(),
    markConversationKbFed: vi.fn(),
    saveKbPrompt: vi.fn(),
    store: { prompt: '', keywords: [] as CategorizedKeyword[] }
  })
)

vi.mock('../../src/main/provider', () => ({ callProvider }))
vi.mock('../../src/main/conversations', () => ({ loadConversation, markConversationKbFed }))
vi.mock('../../src/main/kb/store', () => ({
  loadKbPrompt: (): string => store.prompt,
  saveKbPrompt,
  loadKbKeywords: (): CategorizedKeyword[] => store.keywords,
  saveKbKeywords: (next: CategorizedKeyword[]): void => {
    store.keywords = next
  },
  loadKbState: vi.fn(),
  saveKbState: vi.fn()
}))

import { runKbAnalysis } from '../../src/main/kb/run'

function record(id: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'chat',
    state: {
      turns: [
        { id: 1, role: 'user', content: 'What is a finite state machine?', expansions: [] },
        {
          id: 2,
          role: 'assistant',
          content: 'A model of computation with states and transitions.',
          expansions: []
        }
      ]
    },
    kbFed: false,
    ...overrides
  }
}

describe('runKbAnalysis', () => {
  beforeEach(() => {
    callProvider.mockReset()
    loadConversation.mockReset()
    markConversationKbFed.mockReset()
    saveKbPrompt.mockReset()
    saveKbPrompt.mockImplementation((next: string) => {
      store.prompt = next
    })
    store.prompt = ''
    store.keywords = []
  })

  it('folds conversations into the prompt one at a time and merges keywords', async () => {
    loadConversation.mockImplementation(async (id: string) => record(id))
    callProvider
      .mockResolvedValueOnce('PROMPT after first conversation')
      .mockResolvedValueOnce('PROMPT after second conversation')
      .mockResolvedValueOnce('machine learning [topic]\nworked examples [learning_preference]')

    const result = await runKbAnalysis([{ id: 'chat_a' }, { id: 'chat_b' }], { markFed: true })

    expect(result.conversationsAnalyzed).toBe(2)
    expect(result.newPrompt).toBe('PROMPT after second conversation')
    expect(saveKbPrompt).toHaveBeenCalledTimes(2)
    expect(markConversationKbFed.mock.calls).toEqual([['chat_a'], ['chat_b']])
    expect(result.keywords.map((kw) => [kw.keyword, kw.category])).toEqual([
      ['machine learning', 'topic'],
      ['worked examples', 'learning_preference']
    ])

    // The second analysis request must carry the prompt produced by the first.
    const secondRequest = callProvider.mock.calls[1][0] as Array<{ role: string; content: string }>
    expect(secondRequest[1].content).toContain('PROMPT after first conversation')
    expect(secondRequest[1].content).toContain('What is a finite state machine?')
  })

  it('marks empty conversations fed without spending a model call', async () => {
    loadConversation.mockResolvedValueOnce(
      record('chat_empty', {
        state: {
          turns: [
            { id: 1, role: 'user', content: '   ', expansions: [] },
            { id: 2, role: 'assistant', content: '', expansions: [] }
          ]
        }
      })
    )

    const result = await runKbAnalysis([{ id: 'chat_empty' }], { markFed: true })

    expect(result.conversationsAnalyzed).toBe(0)
    expect(callProvider).not.toHaveBeenCalled()
    expect(markConversationKbFed).toHaveBeenCalledWith('chat_empty')
  })

  it('does not learn from standalone look-up records', async () => {
    loadConversation.mockResolvedValueOnce(record('lookup_a', { source: 'lookup' }))

    const result = await runKbAnalysis([{ id: 'lookup_a' }], { markFed: true })

    expect(result.conversationsAnalyzed).toBe(0)
    expect(callProvider).not.toHaveBeenCalled()
    // markConversationKbFed also deletes look-up records, so the queue drains.
    expect(markConversationKbFed).toHaveBeenCalledWith('lookup_a')
  })

  it('does not relearn a conversation that was fed while it was queued', async () => {
    loadConversation.mockResolvedValueOnce(record('chat_fed', { kbFed: true }))

    const result = await runKbAnalysis([{ id: 'chat_fed' }], { markFed: true })

    expect(result.conversationsAnalyzed).toBe(0)
    expect(callProvider).not.toHaveBeenCalled()
    expect(markConversationKbFed).not.toHaveBeenCalled()
  })

  it('still re-analyzes fed conversations when markFed is false', async () => {
    loadConversation.mockResolvedValueOnce(record('chat_fed', { kbFed: true }))
    callProvider
      .mockResolvedValueOnce('REFRESHED PROMPT')
      .mockResolvedValueOnce('machine learning [topic]')

    const result = await runKbAnalysis([{ id: 'chat_fed' }], { markFed: false })

    expect(result.conversationsAnalyzed).toBe(1)
    expect(saveKbPrompt).toHaveBeenCalledWith('REFRESHED PROMPT')
    expect(markConversationKbFed).not.toHaveBeenCalled()
  })

  it('stops between conversations when the pass is aborted, keeping earlier progress', async () => {
    const controller = new AbortController()
    loadConversation.mockImplementation(async (id: string) => record(id))
    callProvider.mockImplementation(async () => {
      controller.abort()
      return 'PARTIAL PROMPT'
    })

    const result = await runKbAnalysis([{ id: 'chat_a' }, { id: 'chat_b' }], {
      markFed: true,
      signal: controller.signal
    })

    expect(callProvider).toHaveBeenCalledTimes(1)
    expect(saveKbPrompt).toHaveBeenCalledWith('PARTIAL PROMPT')
    expect(markConversationKbFed).toHaveBeenCalledTimes(1)
    // An aborted pass must never be reported as a completed learning event.
    expect(result.conversationsAnalyzed).toBe(0)
  })

  it('does nothing at all when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runKbAnalysis([{ id: 'chat_a' }], {
      markFed: true,
      signal: controller.signal
    })

    expect(result.conversationsAnalyzed).toBe(0)
    expect(loadConversation).not.toHaveBeenCalled()
    expect(callProvider).not.toHaveBeenCalled()
  })
})
