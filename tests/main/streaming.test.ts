import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createChunkBatcher,
  isConversationRecord,
  isConversationState,
  parseProviderMessages,
  parseStreamRole,
  withKbPrompt
} from '../../src/main/streaming'

describe('parseStreamRole', () => {
  it('only lets streaming IPC target chat or lookup', () => {
    expect(parseStreamRole('lookup')).toBe('lookup')
    expect(parseStreamRole('chat')).toBe('chat')
    expect(parseStreamRole('kb-maintenance')).toBe('chat')
    expect(parseStreamRole(undefined)).toBe('chat')
  })
})

describe('parseProviderMessages', () => {
  it('keeps well-formed messages and drops extra fields', () => {
    expect(parseProviderMessages([{ role: 'user', content: 'hi', extra: 1 }])).toEqual([
      { role: 'user', content: 'hi' }
    ])
  })

  it('refuses empty, unknown-role or non-string messages', () => {
    expect(parseProviderMessages([])).toBeNull()
    expect(parseProviderMessages('hi')).toBeNull()
    expect(parseProviderMessages([{ role: 'tool', content: 'x' }])).toBeNull()
    expect(parseProviderMessages([{ role: 'user', content: 42 }])).toBeNull()
  })
})

describe('conversation shape checks', () => {
  const state = {
    turns: [
      { id: 1, role: 'user', content: 'q', expansions: [] },
      { id: 2, role: 'assistant', content: 'a', expansions: [] }
    ]
  }
  const record = {
    id: 'abc',
    title: 'q',
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    source: 'chat',
    state,
    kbFed: false
  }

  it('accepts a record the renderer autosaves', () => {
    expect(isConversationState(state)).toBe(true)
    expect(isConversationRecord(record)).toBe(true)
  })

  it('refuses records with a malformed state or source', () => {
    expect(isConversationRecord({ ...record, source: 'other' })).toBe(false)
    expect(isConversationRecord({ ...record, id: 7 })).toBe(false)
    expect(isConversationRecord({ ...record, state: { turns: 'nope' } })).toBe(false)
    expect(isConversationState({ turns: [{ id: 1, role: 'system', content: 'x' }] })).toBe(false)
    expect(isConversationState({ turns: [], context: 5 })).toBe(false)
  })
})

describe('withKbPrompt', () => {
  it('appends the profile to the existing system prompt', () => {
    const messages = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'q' }
    ]
    expect(withKbPrompt(messages, 'profile')).toEqual([
      { role: 'system', content: 'base\n\nprofile' },
      { role: 'user', content: 'q' }
    ])
  })

  it('adds a system message when there is none, and is a no-op without a profile', () => {
    const messages = [{ role: 'user', content: 'q' }]
    expect(withKbPrompt(messages, 'profile')[0]).toEqual({ role: 'system', content: 'profile' })
    expect(withKbPrompt(messages, '')).toBe(messages)
  })
})

describe('createChunkBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces tokens into one delta per interval', () => {
    const send = vi.fn()
    const batcher = createChunkBatcher(send, 30)
    batcher.push('Hel')
    batcher.push('lo')
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30)
    expect(send).toHaveBeenCalledWith('Hello')
    batcher.push(' world')
    vi.advanceTimersByTime(30)
    expect(send.mock.calls.map(([delta]) => delta)).toEqual(['Hello', ' world'])
  })

  it('flushes on demand and sends nothing when empty', () => {
    const send = vi.fn()
    const batcher = createChunkBatcher(send, 30)
    batcher.flush()
    expect(send).not.toHaveBeenCalled()
    batcher.push('x')
    batcher.flush()
    vi.advanceTimersByTime(30)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('discards the buffer on stop so nothing lands after the final message', () => {
    const send = vi.fn()
    const batcher = createChunkBatcher(send, 30)
    batcher.push('late')
    batcher.stop()
    vi.advanceTimersByTime(100)
    expect(send).not.toHaveBeenCalled()
  })
})
