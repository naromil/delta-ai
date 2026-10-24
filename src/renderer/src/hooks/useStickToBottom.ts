import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** Distance (px) within which the view counts as bottom and follows new content. */
const RE_PIN_DISTANCE = 12

/** Distance (px) beyond which the "Latest" affordance shows. */
const SHOW_LATEST_DISTANCE = 40

export interface StickToBottom {
  scrollRef: RefObject<HTMLDivElement | null>
  atBottom: boolean
  /** Jump to the bottom now and follow new content again (no animation). */
  pin: () => void
  /** Re-pin and animate to the bottom. */
  jumpToLatest: () => void
}

/**
 * Follow decision for one scroll event. `distance` is the gap to the bottom.
 *
 * Scrolling up past the re-pin threshold drops the pin immediately, so a
 * streamed chunk can never drag the reader back down. Returning to the bottom
 * restores it. Content shrinking above the viewport clamps `scrollTop` upwards
 * (a negative jump on screen) while `distance` stays at zero, so that keeps the
 * pin too.
 */
export function nextPinned(
  pinned: boolean,
  previousTop: number,
  top: number,
  distance: number
): boolean {
  if (top < previousTop && distance > RE_PIN_DISTANCE) return false
  if (distance <= RE_PIN_DISTANCE) return true
  return pinned
}

function distanceFromBottom(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

/**
 * Glues a scroll container to its growing bottom while the user stays there.
 *
 * `signal` is the changing content (the turns array): every change follows the
 * tail if pinned. Unlike a plain proximity check, once the user scrolls up the
 * view stays where they left it — streaming keeps appending without moving it —
 * until they scroll back to the bottom, click "Latest", or send a message.
 */
export function useStickToBottom(signal: unknown): StickToBottom {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const lastTopRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    lastTopRef.current = el.scrollTop

    const handleScroll = (): void => {
      const top = el.scrollTop
      const distance = distanceFromBottom(el)
      pinnedRef.current = nextPinned(pinnedRef.current, lastTopRef.current, top, distance)
      lastTopRef.current = top
      setAtBottom(distance <= SHOW_LATEST_DISTANCE)
    }

    /* Container growth (window resize, composer growth, lookup popup expanding)
     * must not leave a pinned view short of the bottom. */
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return
      el.scrollTop = el.scrollHeight
      setAtBottom(true)
    })

    el.addEventListener('scroll', handleScroll, { passive: true })
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (pinnedRef.current) el.scrollTop = el.scrollHeight
    setAtBottom(distanceFromBottom(el) <= SHOW_LATEST_DISTANCE)

    /* Fonts, images or nested frames can grow the content after the commit;
     * glue once more before the next paint while the view is still pinned. */
    const frame = requestAnimationFrame(() => {
      if (!pinnedRef.current) return
      if (distanceFromBottom(el) > 0) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [signal])

  const pin = useCallback((): void => {
    pinnedRef.current = true
    setAtBottom(true)
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastTopRef.current = el.scrollTop
  }, [])

  const jumpToLatest = useCallback((): void => {
    pinnedRef.current = true
    setAtBottom(true)
    const el = scrollRef.current
    if (!el) return
    lastTopRef.current = el.scrollTop
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  return { scrollRef, atBottom, pin, jumpToLatest }
}
