import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

/** Items reachable by arrow keys: enabled menu buttons, in DOM order. */
function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
}

function ContextMenu({ state, onClose }: ContextMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (!state) return

    // Focus the first action so the menu is usable from the keyboard.
    menuItems(menuRef.current)[0]?.focus()

    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        onClose()
        return
      }
      const items = menuItems(menuRef.current)
      if (items.length === 0) return
      const current = items.indexOf(document.activeElement as HTMLButtonElement)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        items[current < 0 ? 0 : (current + 1) % items.length].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        items[current <= 0 ? items.length - 1 : current - 1].focus()
      } else if (e.key === 'Home') {
        e.preventDefault()
        items[0].focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        items[items.length - 1].focus()
      }
    }

    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [state, onClose])

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
      className="visible"
      role="menu"
      aria-label="Text actions"
      style={{ left: (position ?? state).x, top: (position ?? state).y }}
    >
      <button
        type="button"
        role="menuitem"
        className="item"
        disabled={!state.canExpand}
        onClick={() => handleItemClick('expand')}
      >
        Expand
      </button>
      <button
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
        type="button"
        role="menuitem"
        className="item"
        onClick={() => handleItemClick('copy')}
      >
        Copy
      </button>
      <button
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
