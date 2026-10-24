import { describe, expect, it } from 'vitest'
import {
  AUTO_BACKLOG_INTERVAL_MS,
  AUTO_BATCH_SIZE,
  AUTO_MIN_INTERVAL_MS,
  AUTO_RETRY_BASE_MS,
  AUTO_RETRY_MAX_MS,
  AUTO_STARTUP_DELAY_MS,
  autoFollowUpDelayMs,
  autoRetryDelayMs,
  selectAutoBatch,
  startupDelayMs
} from '../../src/main/kb/schedule'

describe('autoRetryDelayMs', () => {
  it('backs off exponentially and caps the wait', () => {
    expect(autoRetryDelayMs(1)).toBe(AUTO_RETRY_BASE_MS)
    expect(autoRetryDelayMs(2)).toBe(AUTO_RETRY_BASE_MS * 2)
    expect(autoRetryDelayMs(3)).toBe(AUTO_RETRY_BASE_MS * 4)
    expect(autoRetryDelayMs(20)).toBe(AUTO_RETRY_MAX_MS)
  })

  it('never returns a zero or negative delay for nonsense input', () => {
    expect(autoRetryDelayMs(0)).toBe(AUTO_RETRY_BASE_MS)
    expect(autoRetryDelayMs(-4)).toBe(AUTO_RETRY_BASE_MS)
    expect(autoRetryDelayMs(1.7)).toBe(AUTO_RETRY_BASE_MS)
  })
})

describe('autoFollowUpDelayMs', () => {
  it('keeps draining a backlog shortly after a successful pass', () => {
    expect(autoFollowUpDelayMs({ pending: true, failed: false, failedAttempts: 0 })).toBe(
      AUTO_BACKLOG_INTERVAL_MS
    )
  })

  it('stays idle once the queue is empty, and backs off after a failure', () => {
    expect(autoFollowUpDelayMs({ pending: false, failed: false, failedAttempts: 0 })).toBe(0)
    expect(autoFollowUpDelayMs({ pending: true, failed: true, failedAttempts: 2 })).toBe(
      autoRetryDelayMs(2)
    )
  })
})

describe('selectAutoBatch', () => {
  const meta = (
    id: string,
    source: 'chat' | 'lookup' = 'chat',
    kbFed = false
  ): { id: string; source: 'chat' | 'lookup'; kbFed: boolean } => ({ id, source, kbFed })

  it('takes only unfed chat conversations, newest first, up to the batch size', () => {
    const metas = [
      meta('chat_new'),
      meta('lookup_x', 'lookup'),
      meta('chat_fed', 'chat', true),
      meta('chat_older'),
      meta('chat_3'),
      meta('chat_4'),
      meta('chat_5')
    ]
    expect(selectAutoBatch(metas).map((item) => item.id)).toEqual([
      'chat_new',
      'chat_older',
      'chat_3',
      'chat_4'
    ])
    expect(selectAutoBatch(metas)).toHaveLength(AUTO_BATCH_SIZE)
  })

  it('honours an explicit limit and refuses a negative one', () => {
    const metas = [meta('a'), meta('b'), meta('c')]
    expect(selectAutoBatch(metas, 2).map((item) => item.id)).toEqual(['a', 'b'])
    expect(selectAutoBatch(metas, -1)).toEqual([])
  })
})

describe('startupDelayMs', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z')

  it('waits the floor when nothing has ever run', () => {
    expect(startupDelayMs(null, now)).toBe(AUTO_STARTUP_DELAY_MS)
    expect(startupDelayMs('not-a-date', now)).toBe(AUTO_STARTUP_DELAY_MS)
  })

  it('respects the interval since the last run', () => {
    const fiveMinutesAgo = new Date(now - 5 * 60_000).toISOString()
    expect(startupDelayMs(fiveMinutesAgo, now)).toBe(AUTO_MIN_INTERVAL_MS - 5 * 60_000)
  })

  it('does not wait longer than the interval, even with a clock skew', () => {
    const future = new Date(now + 60 * 60_000).toISOString()
    expect(startupDelayMs(future, now)).toBe(AUTO_MIN_INTERVAL_MS)
    const longAgo = new Date(now - 24 * 60 * 60_000).toISOString()
    expect(startupDelayMs(longAgo, now)).toBe(AUTO_STARTUP_DELAY_MS)
  })
})
