import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface ContextMenuState {
  x: number
  y: number
  canExpand: boolean
  onExpand: () => void
  onExpandPrompted: () => void
  onCopy: () => void
  onSelectAll: () => void
}

interface ContextMenuProps {
  state: ContextMenuState | null
  onClose: () => void
}

function ContextMenu({ state, onClose }: ContextMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!state || !menu) {
      setPosition(null)
      return
    }
    const rect = menu.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8))
    })
  }, [state])

  /* Focus the first enabled item, and give focus back when the menu closes. */
  useEffect(() => {
    if (!state) {
      const previous = previousFocusRef.current
      previousFocusRef.current = null
      previous?.focus?.()
      return
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null
    itemRefs.current.find((item) => item && !item.disabled)?.focus()
  }, [state])

  const moveFocus = useCallback((direction: 1 | -1) => {
    const items = itemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled
    )
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? 0 : (current + direction + items.length) % items.length
    items[next].focus()
  }, [])

  useEffect(() => {
    if (!state) return

    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveFocus(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveFocus(-1)
      }
    }

    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [state, onClose, moveFocus])

  if (!state) return null

  const handleItemClick = (action: 'expand' | 'expand-prompted' | 'copy' | 'select-all'): void => {
    if (action === 'expand') state.onExpand()
    else if (action === 'expand-prompted') state.onExpandPrompted()
    else if (action === 'copy') state.onCopy()
    else if (action === 'select-all') state.onSelectAll()
    onClose()
  }

  return (
    <div
      ref={menuRef}
      id="ctxMenu"
      role="menu"
      aria-label="Text actions"
      className="visible"
      style={{ left: (position ?? state).x, top: (position ?? state).y }}
    >
      <button
        ref={(el) => {
          itemRefs.current[0] = el
        }}
        type="button"
        role="menuitem"
        className="item"
        disabled={!state.canExpand}
        onClick={() => handleItemClick('expand')}
      >
        Expand
      </button>
      <button
        ref={(el) => {
          itemRefs.current[1] = el
        }}
        type="button"
        role="menuitem"
        className="item"
        disabled={!state.canExpand}
        onClick={() => handleItemClick('expand-prompted')}
      >
        Expand on…
      </button>
      <div className="sep" role="separator" />
      <button
        ref={(el) => {
          itemRefs.current[2] = el
        }}
        type="button"
        role="menuitem"
        className="item"
        onClick={() => handleItemClick('copy')}
      >
        Copy
      </button>
      <button
        ref={(el) => {
          itemRefs.current[3] = el
        }}
        type="button"
        role="menuitem"
        className="item"
        onClick={() => handleItemClick('select-all')}
      >
        Select All
      </button>
    </div>
  )
}

export type { ContextMenuState }
export default ContextMenu
