import { longestLine } from '../../../../shared/canvas'

const MINIMAP_STORAGE_KEY = 'delta-canvas-minimap'

/** DOM and wording helpers for the canvas board; nothing here holds state. */

export function readMinimapPreference(): boolean {
  try {
    return localStorage.getItem(MINIMAP_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function saveMinimapPreference(open: boolean): void {
  try {
    localStorage.setItem(MINIMAP_STORAGE_KEY, open ? 'on' : 'off')
  } catch {
    /* A forgotten preference costs nothing. */
  }
}

export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/** Keys on these belong to them: Enter presses a button, arrows move a caret or scroll text. */
export function ownsKeys(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'button, a, select, [role="button"], [data-canvas-card], [data-canvas-draft]'
    ) !== null
  )
}

export function canScrollBy(element: Element, dx: number, dy: number): boolean {
  const { scrollTop, scrollHeight, clientHeight, scrollLeft, scrollWidth, clientWidth } = element
  if (dy < 0 && scrollTop > 0) return true
  if (dy > 0 && scrollTop + clientHeight < scrollHeight - 1) return true
  if (dx < 0 && scrollLeft > 0) return true
  return dx > 0 && scrollLeft + clientWidth < scrollWidth - 1
}

/** Chromium leaves Shift+wheel vertical here, and it is a plain mouse's only way sideways. */
export function wheelPanDelta(e: WheelEvent): { deltaX: number; deltaY: number } {
  if (e.shiftKey && e.deltaX === 0) return { deltaX: e.deltaY, deltaY: 0 }
  return { deltaX: e.deltaX, deltaY: e.deltaY }
}

/** A claimed press takes no focus by itself, so whatever held it would otherwise keep it. */
export function releaseFocus(pressed: Element): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && !active.contains(pressed)) active.blur()
}

/**
 * The height at which a card's body will not scroll, at its current width, in world pixels.
 * Squeezed to nothing, a body's scroll height is what the browser itself will compare against
 * its room: margins escaping the text and formulas taller than their line count, which no box
 * around the text includes. It is rounded, so the extra pixel covers the fraction it loses.
 */
export function measureCardHeight(surface: HTMLElement, id: string): number | null {
  const card = surface.querySelector<HTMLElement>(`[data-canvas-card="${id}"] .canvas-card-surface`)
  const body = card?.querySelector<HTMLElement>('.canvas-card-body')
  if (!card || !body || !body.querySelector('.message-content')) return null
  const chrome = card.offsetHeight - body.offsetHeight
  const { flex, height, overflowY } = body.style
  body.style.flex = 'none'
  body.style.height = '0'
  body.style.overflowY = 'hidden'
  const horizontalScrollbar = body.offsetHeight - body.clientHeight
  const needed = chrome + horizontalScrollbar + body.scrollHeight + 1
  body.style.flex = flex
  body.style.height = height
  body.style.overflowY = overflowY
  return needed
}

/**
 * The middle of a term on screen. A wrapped term's bounding box can be mostly empty space,
 * so this is the middle of its longest line, which always has text under it.
 */
export function termPoint(term: Element): { x: number; y: number } {
  const box = longestLine([...term.getClientRects()]) ?? term.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

/** Scrolls a card body so `el` sits in its middle, without moving anything around it. */
export function scrollIntoBody(el: Element, scale: number): void {
  const body = el.closest<HTMLElement>('.canvas-card-body')
  if (!body) return
  const offset =
    (el.getBoundingClientRect().top - body.getBoundingClientRect().top) / scale + body.scrollTop
  body.scrollTop = offset - body.clientHeight / 2
}

export function dependentsPhrase(count: number): string {
  return count === 1 ? 'the card that depends on it' : `the ${count} cards that depend on it`
}

/** Taking other cards along is asked about twice, as they may be far off screen. */
export function confirmCascade(question: string, dependents: number, undoable: boolean): boolean {
  const others = dependents === 1 ? '1 other card' : `${dependents} other cards`
  return (
    window.confirm(question) &&
    window.confirm(
      undoable
        ? `Are you sure? ${others} will be deleted too. Ctrl+Z brings them back while this canvas stays open.`
        : `Are you sure? ${others} will be permanently deleted. This cannot be undone.`
    )
  )
}

export function deletedNotice(count: number): string {
  return count === 1 ? 'Deleted.' : `Deleted ${count} items.`
}
