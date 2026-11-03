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

/** The height a card needs for its answer at its current width, in world pixels. */
export function measureCardHeight(surface: HTMLElement, id: string): number | null {
  const card = surface.querySelector<HTMLElement>(`[data-canvas-card="${id}"] .canvas-card-surface`)
  const body = card?.querySelector<HTMLElement>('.canvas-card-body')
  const content = body?.querySelector<HTMLElement>('.message-content')
  if (!card || !body || !content) return null
  // Without this, the scrollbar of an overflowing answer narrows the text being measured.
  const overflowY = body.style.overflowY
  body.style.overflowY = 'hidden'
  const { paddingTop, paddingBottom } = getComputedStyle(body)
  const height =
    card.offsetHeight -
    body.clientHeight +
    parseFloat(paddingTop) +
    parseFloat(paddingBottom) +
    content.offsetHeight
  body.style.overflowY = overflowY
  return height
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
