import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRecord } from '../../src/shared/conversation'

const { callProvider, loadConversation, markConversationKbFed, memoryAgentFor } = vi.hoisted(
  () => ({
    memoryAgentFor: vi.fn(),
    callProvider: vi.fn(),
    loadConversation: vi.fn(),
    markConversationKbFed: vi.fn()
  })
)

vi.mock('../../src/main/provider', () => ({ callProvider }))
vi.mock('../../src/main/memory/tools', () => ({ memoryAgentFor }))
vi.mock('../../src/main/conversations', () => ({ loadConversation, markConversationKbFed }))

import { CURATOR_UNAVAILABLE_ERROR, runKbAnalysis } from '../../src/main/kb/run'

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
  const agent = { tools: {}, instructions: 'memory rules', maxSteps: 25 }

  beforeEach(() => {
    callProvider.mockReset().mockResolvedValue('wrote profile.md')
    memoryAgentFor.mockReset().mockReturnValue(agent)
    loadConversation.mockReset()
    markConversationKbFed.mockReset()
  })

  it('curates each conversation with the memory tools and marks it fed', async () => {
    loadConversation.mockImplementation(async (id: string) => record(id))

    const result = await runKbAnalysis([{ id: 'chat_a' }, { id: 'chat_b' }], { markFed: true })

    expect(result).toEqual({ conversationsAnalyzed: 2 })
    expect(memoryAgentFor).toHaveBeenCalledWith('kb-maintenance')
    expect(callProvider).toHaveBeenCalledTimes(2)
    const [messages, role, , usedAgent] = callProvider.mock.calls[0]
    expect(role).toBe('kb-maintenance')
    expect(usedAgent).toBe(agent)
    expect(messages[0].content).toMatch(/primary writer/)
    expect(JSON.stringify(messages)).toContain('What is a finite state machine?')
    expect(markConversationKbFed.mock.calls).toEqual([['chat_a'], ['chat_b']])
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

    const result = await runKbAnalysis([{ id: 'chat_fed' }], { markFed: false })

    expect(result.conversationsAnalyzed).toBe(1)
    expect(callProvider).toHaveBeenCalledTimes(1)
    expect(markConversationKbFed).not.toHaveBeenCalled()
  })

  it('leaves the conversation unfed when curating fails', async () => {
    loadConversation.mockImplementation(async (id: string) => record(id))
    callProvider.mockRejectedValueOnce(new Error('API error 500'))

    await expect(runKbAnalysis([{ id: 'chat_a' }], { markFed: true })).rejects.toThrow('500')

    expect(markConversationKbFed).not.toHaveBeenCalled()
  })

  it('fails instead of marking a conversation fed when the model cannot use tools', async () => {
    memoryAgentFor.mockReturnValue(undefined)
    loadConversation.mockImplementation(async (id: string) => record(id))

    await expect(runKbAnalysis([{ id: 'chat_a' }], { markFed: true })).rejects.toThrow(
      CURATOR_UNAVAILABLE_ERROR
    )

    expect(callProvider).not.toHaveBeenCalled()
    expect(markConversationKbFed).not.toHaveBeenCalled()
  })

  it('stops between conversations when the pass is aborted, keeping earlier progress', async () => {
    const controller = new AbortController()
    loadConversation.mockImplementation(async (id: string) => record(id))
    callProvider.mockImplementation(async () => {
      controller.abort()
      return 'wrote profile.md'
    })

    const result = await runKbAnalysis([{ id: 'chat_a' }, { id: 'chat_b' }], {
      markFed: true,
      signal: controller.signal
    })

    expect(callProvider).toHaveBeenCalledTimes(1)
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
