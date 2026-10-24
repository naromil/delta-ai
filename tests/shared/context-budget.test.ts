import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OUTPUT_RESERVE,
  budgetFor,
  estimateTokens,
  trimMessages
} from '../../src/shared/context-budget'
import type { ProviderMessage } from '../../src/shared/models'

function message(role: ProviderMessage['role'], content: string): ProviderMessage {
  return { role, content }
}

describe('estimateTokens', () => {
  it('returns zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates four characters per token, rounding up', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })
})

describe('budgetFor', () => {
  it('returns null without a usable context window', () => {
    expect(budgetFor()).toBeNull()
    expect(budgetFor(0)).toBeNull()
    expect(budgetFor(-4096)).toBeNull()
    expect(budgetFor(Number.NaN)).toBeNull()
    expect(budgetFor(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('reserves the default output allowance', () => {
    expect(budgetFor(100_000)).toBe(Math.floor(100_000 * 0.85) - DEFAULT_OUTPUT_RESERVE)
  })

  it('uses a valid explicit output reserve', () => {
    expect(budgetFor(8192, 2048)).toBe(Math.floor(8192 * 0.85) - 2048)
  })

  it('ignores an invalid explicit reserve', () => {
    expect(budgetFor(100_000, 0)).toBe(Math.floor(100_000 * 0.85) - DEFAULT_OUTPUT_RESERVE)
    expect(budgetFor(100_000, -1)).toBe(Math.floor(100_000 * 0.85) - DEFAULT_OUTPUT_RESERVE)
    expect(budgetFor(100_000, Number.NaN)).toBe(Math.floor(100_000 * 0.85) - DEFAULT_OUTPUT_RESERVE)
  })

  it('never reserves more than half the context window', () => {
    // Half of 2000 is below the default reserve, so only 1000 is held back.
    expect(budgetFor(2000)).toBe(Math.max(1024, Math.floor(2000 * 0.85) - 1000))
  })

  it('never drops below 1024 tokens', () => {
    expect(budgetFor(1000)).toBe(1024)
  })
})

describe('trimMessages', () => {
  it('returns the messages untouched when they fit the budget', () => {
    const messages = [message('system', 'system'), message('user', 'question')]
    const result = trimMessages(messages, 100)

    expect(result.dropped).toBe(0)
    expect(result.messages).toEqual(messages)
  })

  it('drops the oldest non-system messages first', () => {
    const first = message('user', 'a'.repeat(40))
    const second = message('assistant', 'b'.repeat(40))
    const last = message('user', 'c'.repeat(40))
    const result = trimMessages([first, second, last], 15)

    expect(result.dropped).toBe(2)
    expect(result.messages).toEqual([last])
  })

  it('keeps the system prompt and the final message even when over budget', () => {
    const system = message('system', 's'.repeat(40))
    const middle = message('user', 'u'.repeat(40))
    const last = message('assistant', 'a'.repeat(40))
    const result = trimMessages([system, middle, last], 0)

    expect(result.dropped).toBe(1)
    expect(result.messages).toEqual([system, last])
  })

  it('drops nothing when every message is a system or the final message', () => {
    const system = message('system', 's'.repeat(40))
    const last = message('user', 'u'.repeat(40))
    const result = trimMessages([system, last], 0)

    expect(result.dropped).toBe(0)
    expect(result.messages).toEqual([system, last])
  })

  it('handles an empty conversation', () => {
    expect(trimMessages([], 0)).toEqual({ messages: [], dropped: 0 })
  })

  it('never mutates the input array or its messages', () => {
    const first = message('user', 'a'.repeat(40))
    const last = message('assistant', 'b'.repeat(40))
    const input = [first, last]
    const snapshot = input.slice()

    const result = trimMessages(input, 0)

    expect(input).toEqual(snapshot)
    expect(input[0]).toBe(first)
    expect(result.messages).not.toBe(input)
  })
})
