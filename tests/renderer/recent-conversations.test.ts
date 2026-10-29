import { describe, expect, it } from 'vitest'
import type { ConversationMeta } from '../../src/shared/conversation'
import {
  HOME_RECENT_LIMIT,
  formatRelativeTime,
  pickRecentConversations
} from '../../src/renderer/src/lib/recent-conversations'

function meta(id: string, updatedAt: string, source: 'chat' | 'lookup' = 'chat'): ConversationMeta {
  return { id, title: id, createdAt: updatedAt, updatedAt, source, kbFed: false, turnCount: 2 }
}

describe('pickRecentConversations', () => {
  it('returns the newest chat conversations first, capped at the limit', () => {
    const list = Array.from({ length: 8 }, (_, i) =>
      meta(`c${i}`, `2026-10-0${i + 1}T12:00:00.000Z`)
    )

    const recent = pickRecentConversations(list)

    expect(recent).toHaveLength(HOME_RECENT_LIMIT)
    expect(recent.map((m) => m.id)).toEqual(['c7', 'c6', 'c5', 'c4', 'c3'])
  })

  it('drops lookup records and does not mutate the input', () => {
    const list = [
      meta('old', '2026-10-01T00:00:00.000Z'),
      meta('lookup', '2026-10-03T00:00:00.000Z', 'lookup'),
      meta('new', '2026-10-02T00:00:00.000Z')
    ]

    expect(pickRecentConversations(list).map((m) => m.id)).toEqual(['new', 'old'])
    expect(list.map((m) => m.id)).toEqual(['old', 'lookup', 'new'])
  })

  it('handles an empty list and a non-positive limit', () => {
    expect(pickRecentConversations([])).toEqual([])
    expect(pickRecentConversations([meta('a', '2026-10-01T00:00:00.000Z')], 0)).toEqual([])
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-10-29T12:00:00.000Z')

  it('labels recent times relative to now', () => {
    expect(formatRelativeTime('2026-10-29T11:59:30.000Z', now)).toBe('Just now')
    expect(formatRelativeTime('2026-10-29T11:15:00.000Z', now)).toBe('45m ago')
    expect(formatRelativeTime('2026-10-29T07:00:00.000Z', now)).toBe('5h ago')
    expect(formatRelativeTime('2026-10-26T12:00:00.000Z', now)).toBe('3d ago')
  })

  it('falls back to the locale date after a week', () => {
    const iso = '2026-10-01T12:00:00.000Z'
    expect(formatRelativeTime(iso, now)).toBe(new Date(iso).toLocaleDateString())
  })
})
