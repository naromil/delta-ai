export interface RightPressPoint {
  pointerId: number
  clientX: number
  clientY: number
}

interface RightPress extends RightPressPoint {
  dragging: boolean
  /** Where the menu event landed, when it came before the release. */
  menuTarget: Element | null
}

export interface RightDragHandlers {
  onPress: (e: React.PointerEvent) => void
  /** The press that has just become a drag, once; otherwise null. */
  onMove: (e: React.PointerEvent) => RightPressPoint | null
  onRelease: (e: React.PointerEvent) => void
  onCancel: () => void
  onContextMenuCapture: (e: React.MouseEvent) => void
}

/** Right-button travel on screen before a press stops being a click. */
const DRAG_START_PX = 5
const RIGHT_BUTTON = 2
/** The bit for the right button in `PointerEvent.buttons`. */
const RIGHT_BUTTONS_BIT = 2

/**
 * Tells a right click from a right drag. Linux and macOS fire `contextmenu` on press and
 * Windows on release, so a press holds its menu back, and the release either replays it on
 * whatever was pressed or, after a drag, drops it. The replay is a real event on the original
 * target, so every menu keeps working as it does for a click.
 */
export function createRightDrag(): RightDragHandlers {
  let press: RightPress | null = null
  let swallowNext = false
  let replaying = false

  return {
    onPress: (e) => {
      swallowNext = false
      press = null
      // A field keeps its own right click, and a captured pointer would retarget the menu.
      if (e.button !== RIGHT_BUTTON || (e.target as Element).closest('input, textarea, select')) {
        return
      }
      press = {
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        dragging: false,
        menuTarget: null
      }
    },
    onMove: (e) => {
      if (!press || press.dragging) return null
      if (!(e.buttons & RIGHT_BUTTONS_BIT)) {
        // Let go somewhere this surface could not hear it.
        press = null
        return null
      }
      const travel = Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY)
      if (travel < DRAG_START_PX) return null
      press.dragging = true
      return press
    },
    onRelease: (e) => {
      if (e.button !== RIGHT_BUTTON || !press) return
      const released = press
      press = null
      if (released.dragging) {
        // Where the menu comes after the release, it has yet to be dropped.
        swallowNext = released.menuTarget === null
        return
      }
      if (!released.menuTarget) return
      replaying = true
      released.menuTarget.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: RIGHT_BUTTON,
          clientX: released.clientX,
          clientY: released.clientY
        })
      )
      replaying = false
    },
    onCancel: () => {
      press = null
    },
    onContextMenuCapture: (e) => {
      if (replaying || (!press && !swallowNext)) return
      e.preventDefault()
      e.stopPropagation()
      if (press) press.menuTarget = e.target as Element
      else swallowNext = false
    }
  }
}
