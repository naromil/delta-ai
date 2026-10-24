import { describe, expect, it } from 'vitest'
import { emptyKbState, normalizeKbState } from '../../src/shared/kb'

describe('normalizeKbState', () => {
  it('returns empty state for anything that is not an object', () => {
    expect(normalizeKbState(null)).toEqual(emptyKbState())
    expect(normalizeKbState('nope')).toEqual(emptyKbState())
    expect(normalizeKbState([])).toEqual(emptyKbState())
  })

  it('keeps valid timestamps and counts', () => {
    expect(
      normalizeKbState({
        lastRunAt: '2026-10-24T10:00:00.000Z',
        lastLearnedAt: '2026-10-24T09:00:00.000Z',
        lastAnalyzed: 3,
        lastError: 'API error 500',
        failedAttempts: 2
      })
    ).toEqual({
      lastRunAt: '2026-10-24T10:00:00.000Z',
      lastLearnedAt: '2026-10-24T09:00:00.000Z',
      lastAnalyzed: 3,
      lastError: 'API error 500',
      failedAttempts: 2
    })
  })

  it('replaces bad fields instead of trusting a hand-edited file', () => {
    expect(
      normalizeKbState({
        lastRunAt: '   ',
        lastLearnedAt: 42,
        lastAnalyzed: -1,
        lastError: '',
        failedAttempts: 1.9
      })
    ).toEqual({
      lastRunAt: null,
      lastLearnedAt: null,
      lastAnalyzed: 0,
      lastError: null,
      failedAttempts: 1
    })
  })
})
