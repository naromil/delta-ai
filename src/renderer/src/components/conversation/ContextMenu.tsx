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

    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
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
      style={{ left: (position ?? state).x, top: (position ?? state).y }}
    >
      <div
        className={`item${state.canExpand ? '' : ' disabled'}`}
        onClick={() => state.canExpand && handleItemClick('expand')}
      >
        Expand
      </div>
      <div
        className={`item${state.canExpand ? '' : ' disabled'}`}
        onClick={() => state.canExpand && handleItemClick('expand-prompted')}
      >
        Expand on…
      </div>
      <div className="sep" />
      <div className="item" onClick={() => handleItemClick('copy')}>
        Copy
      </div>
      <div className="item" onClick={() => handleItemClick('select-all')}>
        Select All
      </div>
    </div>
  )
}

export type { ContextMenuState }
export default ContextMenu
