import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderMessage } from '../../src/shared/models'

const h = vi.hoisted(() => ({
  resolveRole: vi.fn(),
  getCachedModel: vi.fn()
}))

vi.mock('../../src/main/config', () => ({ resolveRole: h.resolveRole }))
vi.mock('../../src/main/services/model-catalog', () => ({ getCachedModel: h.getCachedModel }))

import { applyContextBudget } from '../../src/main/context-budget'

const connection = { id: 'c1', providerType: 'openai', name: 'OpenAI' }

function conversation(): ProviderMessage[] {
  return [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'a'.repeat(4000) },
    { role: 'assistant', content: 'b'.repeat(4000) },
    { role: 'user', content: 'latest question' }
  ]
}

describe('applyContextBudget', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('returns the messages untouched when the role is unassigned', () => {
    h.resolveRole.mockReturnValue(null)
    const messages = conversation()
    expect(applyContextBudget(messages, 'chat')).toBe(messages)
    expect(h.getCachedModel).not.toHaveBeenCalled()
  })

  it('returns the messages untouched when the model is not in the catalog', () => {
    h.resolveRole.mockReturnValue({ connection, model: 'unknown' })
    h.getCachedModel.mockReturnValue(null)
    const messages = conversation()
    expect(applyContextBudget(messages, 'chat')).toBe(messages)
  })

  it('returns the messages untouched when the model has no context window', () => {
    h.resolveRole.mockReturnValue({ connection, model: 'gpt' })
    h.getCachedModel.mockReturnValue({ id: 'gpt' })
    const messages = conversation()
    expect(applyContextBudget(messages, 'chat')).toBe(messages)
  })

  it('fails open when resolving the role throws', () => {
    h.resolveRole.mockImplementation(() => {
      throw new Error('corrupt config')
    })
    const messages = conversation()
    expect(applyContextBudget(messages, 'chat')).toBe(messages)
  })

  it('keeps every message that fits the budget', () => {
    h.resolveRole.mockReturnValue({ connection, model: 'gpt' })
    h.getCachedModel.mockReturnValue({ id: 'gpt', contextWindow: 128_000, maxOutput: 4096 })
    const messages = conversation()
    expect(applyContextBudget(messages, 'chat')).toEqual(messages)
  })

  it('drops the oldest non-system messages when the window is too small', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.resolveRole.mockReturnValue({ connection, model: 'tiny' })
    // budgetFor(2048, 512) = max(1024, 1740 - 512) = 1228 tokens: one 1000-token
    // message plus the system prompt and latest question fit, two do not.
    h.getCachedModel.mockReturnValue({ id: 'tiny', contextWindow: 2048, maxOutput: 512 })
    const messages = conversation()
    const trimmed = applyContextBudget(messages, 'chat')
    expect(trimmed.map((m) => m.role)).toEqual(['system', 'assistant', 'user'])
    expect(trimmed[trimmed.length - 1].content).toBe('latest question')
    expect(messages).toHaveLength(4)
    expect(console.warn).toHaveBeenCalledOnce()
  })
})
