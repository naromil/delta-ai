import { describe, expect, it } from 'vitest'
import { nextPinned } from '../../src/renderer/src/hooks/useStickToBottom'

describe('stick-to-bottom pinning', () => {
  it('keeps following while content grows without a scroll', () => {
    // A streamed chunk grew the page; scrollTop did not move.
    expect(nextPinned(true, 500, 500, 300)).toBe(true)
  })

  it('drops the pin as soon as the reader scrolls up past the threshold', () => {
    expect(nextPinned(true, 500, 480, 120)).toBe(false)
  })

  it('keeps the pin for an upward nudge within the threshold', () => {
    expect(nextPinned(true, 500, 495, 5)).toBe(true)
  })

  it('restores the pin when the reader scrolls back to the bottom', () => {
    expect(nextPinned(false, 500, 560, 0)).toBe(true)
    expect(nextPinned(false, 500, 560, 12)).toBe(true)
  })

  it('stays unpinned when scrolled down but short of the bottom', () => {
    expect(nextPinned(false, 500, 530, 60)).toBe(false)
  })

  it('treats a content-shrink clamp as staying pinned', () => {
    // Folding a frame above the viewport pulls scrollTop down to the new
    // maximum; distance stays zero even though scrollTop decreased.
    expect(nextPinned(true, 500, 480, 0)).toBe(true)
  })
})
