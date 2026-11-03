import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { RightDragHandlers } from '../../src/renderer/src/views/canvas/right-drag'
import { createRightDrag } from '../../src/renderer/src/views/canvas/right-drag'

const RIGHT = 2

interface Harness {
  drag: RightDragHandlers
  started: ReturnType<typeof vi.fn>
  target: { closest: () => null; dispatchEvent: ReturnType<typeof vi.fn> }
  press: () => void
  moveBy: (dx: number) => void
  release: () => void
  /** Returns whether the menu was held back from everything below the surface. */
  menuEvent: () => boolean
}

function harness(): Harness {
  const started = vi.fn()
  const drag = createRightDrag()
  const target = { closest: (): null => null, dispatchEvent: vi.fn() }
  const pointer = (extra: object): React.PointerEvent =>
    ({
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      target,
      ...extra
    }) as unknown as React.PointerEvent
  return {
    drag,
    started,
    target,
    press: () => drag.onPress(pointer({ button: RIGHT })),
    moveBy: (dx) => {
      const begun = drag.onMove(pointer({ buttons: RIGHT, clientX: 100 + dx }))
      if (begun) started(begun)
    },
    release: () => drag.onRelease(pointer({ button: RIGHT })),
    menuEvent: () => {
      const stopPropagation = vi.fn()
      drag.onContextMenuCapture({
        target,
        preventDefault: vi.fn(),
        stopPropagation
      } as unknown as React.MouseEvent)
      return stopPropagation.mock.calls.length > 0
    }
  }
}

describe('right drag and right click', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'MouseEvent',
      class {
        constructor(
          public type: string,
          public init: MouseEventInit
        ) {}
      }
    )
  })

  describe('where the menu event comes on press (Linux, macOS)', () => {
    it('opens the menu on release of a click, on what was pressed, where it was pressed', () => {
      const h = harness()
      h.press()
      expect(h.menuEvent()).toBe(true)
      expect(h.target.dispatchEvent).not.toHaveBeenCalled()
      h.release()
      expect(h.target.dispatchEvent).toHaveBeenCalledOnce()
      const replay = h.target.dispatchEvent.mock.calls[0][0]
      expect(replay.type).toBe('contextmenu')
      expect(replay.init).toMatchObject({ clientX: 100, clientY: 100, bubbles: true })
      expect(h.started).not.toHaveBeenCalled()
    })

    it('starts one drag once the pointer has travelled, and drops the menu', () => {
      const h = harness()
      h.press()
      h.menuEvent()
      h.moveBy(2)
      expect(h.started).not.toHaveBeenCalled()
      h.moveBy(12)
      h.moveBy(30)
      expect(h.started).toHaveBeenCalledOnce()
      expect(h.started.mock.calls[0][0]).toMatchObject({ clientX: 100, clientY: 100 })
      h.release()
      expect(h.target.dispatchEvent).not.toHaveBeenCalled()
    })

    it('does not swallow a later menu after a drag', () => {
      const h = harness()
      h.press()
      h.menuEvent()
      h.moveBy(30)
      h.release()
      // The menu key on a keyboard comes with no press at all.
      expect(h.menuEvent()).toBe(false)
    })
  })

  describe('where the menu event comes on release (Windows)', () => {
    it('lets the menu of a click through', () => {
      const h = harness()
      h.press()
      h.release()
      expect(h.menuEvent()).toBe(false)
    })

    it('drops only the menu that follows a drag', () => {
      const h = harness()
      h.press()
      h.moveBy(30)
      h.release()
      expect(h.menuEvent()).toBe(true)
      expect(h.menuEvent()).toBe(false)
    })
  })

  it('leaves a text field to its own right click', () => {
    const h = harness()
    h.drag.onPress({
      button: RIGHT,
      target: { closest: () => ({}) }
    } as unknown as React.PointerEvent)
    expect(h.menuEvent()).toBe(false)
  })

  it('ignores the other buttons', () => {
    const h = harness()
    h.drag.onPress({ button: 0, target: h.target } as unknown as React.PointerEvent)
    h.moveBy(30)
    expect(h.started).not.toHaveBeenCalled()
    expect(h.menuEvent()).toBe(false)
  })

  it('forgets a press released where the surface could not hear it', () => {
    const h = harness()
    h.press()
    h.drag.onMove({ buttons: 0, clientX: 200, clientY: 100 } as unknown as React.PointerEvent)
    h.moveBy(40)
    expect(h.started).not.toHaveBeenCalled()
  })
})
