import { useEffect, useRef, useState } from 'react'
import type { CanvasColor } from '../../../../shared/canvas'
import { CANVAS_COLORS } from '../../../../shared/canvas'
import type { CanvasAlignEdge, CanvasAxis } from '../../../../shared/canvas-arrange'
import type { CanvasIconName } from './CanvasIcons'
import CanvasIcon from './CanvasIcons'

export interface CanvasSelectionBarProps {
  count: number
  /** Selected things that can hold a colour: cards and frames. */
  colorable: boolean
  color: CanvasColor | undefined
  /** Selected cards that have text a question could be about. */
  askable: boolean
  connectable: boolean
  collapsible: boolean
  /** Whether Collapse would expand instead, since every collapsible card is collapsed. */
  collapsed: boolean
  /** Separately movable blocks in the selection: arranging needs at least two. */
  blocks: number
  /** Exactly one connection is selected, and nothing else. */
  linkOnly: boolean
  onAsk: () => void
  onColor: (color: CanvasColor | undefined) => void
  onAlign: (edge: CanvasAlignEdge) => void
  onDistribute: (axis: CanvasAxis) => void
  onTidy: () => void
  onConnect: () => void
  onCollapse: () => void
  onFrame: () => void
  onDuplicate: () => void
  onCopy: () => void
  onZoom: () => void
  onDelete: () => void
  onLabelLink: () => void
  onReverseLink: () => void
}

const ALIGNMENTS: ReadonlyArray<{ edge: CanvasAlignEdge; label: string; d: string }> = [
  { edge: 'left', label: 'Left', d: 'M4 3v18M8 7h12M8 12h7M8 17h10' },
  { edge: 'center', label: 'Centre', d: 'M12 3v18M6 7h12M8.5 12h7M7 17h10' },
  { edge: 'right', label: 'Right', d: 'M20 3v18M4 7h12M9 12h7M6 17h10' },
  { edge: 'top', label: 'Top', d: 'M3 4h18M7 8v12M12 8v7M17 8v10' },
  { edge: 'middle', label: 'Middle', d: 'M3 12h18M7 6v12M12 8.5v7M17 7v10' },
  { edge: 'bottom', label: 'Bottom', d: 'M3 20h18M7 4v12M12 9v7M17 6v10' }
]

function BarButton({
  icon,
  label,
  onClick,
  disabled = false
}: {
  icon: CanvasIconName
  label: string
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="canvas-bar-btn"
      aria-label={label}
      data-tip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <CanvasIcon name={icon} />
    </button>
  )
}

/** Lines things up. Closes on an outside press, or after a choice. */
function ArrangeMenu(props: CanvasSelectionBarProps & { onClose: () => void }): React.JSX.Element {
  const { blocks, onAlign, onDistribute, onTidy, onClose } = props
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePress = (e: PointerEvent): void => {
      if (!menuRef.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', handlePress, true)
    return () => document.removeEventListener('pointerdown', handlePress, true)
  }, [onClose])

  const choose = (action: () => void): void => {
    action()
    onClose()
  }

  return (
    <div ref={menuRef} className="canvas-arrange" role="menu" aria-label="Arrange">
      <div className="canvas-arrange-grid">
        {ALIGNMENTS.map(({ edge, label, d }) => (
          <button
            key={edge}
            type="button"
            role="menuitem"
            className="canvas-bar-btn"
            aria-label={`Align ${label.toLowerCase()}`}
            title={`Align ${label.toLowerCase()}`}
            onClick={() => choose(() => onAlign(edge))}
          >
            <svg
              className="canvas-glyph"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d={d} />
            </svg>
          </button>
        ))}
      </div>
      <button
        type="button"
        role="menuitem"
        className="canvas-arrange-item"
        disabled={blocks < 3}
        onClick={() => choose(() => onDistribute('x'))}
      >
        Space evenly across
      </button>
      <button
        type="button"
        role="menuitem"
        className="canvas-arrange-item"
        disabled={blocks < 3}
        onClick={() => choose(() => onDistribute('y'))}
      >
        Space evenly down
      </button>
      <button
        type="button"
        role="menuitem"
        className="canvas-arrange-item"
        onClick={() => choose(onTidy)}
      >
        Tidy up
      </button>
    </div>
  )
}

/** What can be done to the selection. It stays put on screen, so it never covers what it acts on. */
function CanvasSelectionBar(props: CanvasSelectionBarProps): React.JSX.Element {
  const { count, colorable, color, askable, connectable, collapsible, collapsed, blocks } = props
  const { linkOnly, onAsk, onColor, onConnect, onCollapse, onFrame, onDuplicate } = props
  const { onCopy, onZoom, onDelete, onLabelLink, onReverseLink } = props
  const [arranging, setArranging] = useState(false)
  const canArrange = blocks >= 2

  if (linkOnly) {
    return (
      <div className="canvas-bar" role="toolbar" aria-label="Connection">
        <span className="canvas-bar-count">Connection</span>
        <BarButton icon="label" label="Label  (Enter)" onClick={onLabelLink} />
        <BarButton icon="reverse" label="Reverse direction" onClick={onReverseLink} />
        <BarButton icon="trash" label="Delete  (Del)" onClick={onDelete} />
      </div>
    )
  }

  return (
    <div className="canvas-bar" role="toolbar" aria-label="Selection">
      <span className="canvas-bar-count">{count} selected</span>
      {askable ? (
        <button
          type="button"
          className="canvas-bar-ask"
          data-tip="Ask about this  (A)"
          onClick={onAsk}
        >
          <CanvasIcon name="ask" />
          Ask
        </button>
      ) : null}
      {colorable ? (
        <>
          <span className="canvas-bar-sep" />
          <div className="canvas-swatches" role="group" aria-label="Colour">
            <button
              type="button"
              className={`canvas-swatch canvas-swatch--none${color === undefined ? ' is-active' : ''}`}
              aria-label="No colour"
              data-tip="No colour"
              onClick={() => onColor(undefined)}
            />
            {CANVAS_COLORS.map((item) => (
              <button
                key={item}
                type="button"
                className={`canvas-swatch${color === item ? ' is-active' : ''}`}
                data-color={item}
                aria-label={item}
                aria-pressed={color === item}
                onClick={() => onColor(item)}
              />
            ))}
          </div>
        </>
      ) : null}
      <span className="canvas-bar-sep" />
      {canArrange ? (
        <span className="canvas-bar-anchor">
          <BarButton icon="align" label="Arrange" onClick={() => setArranging((open) => !open)} />
          {arranging ? <ArrangeMenu {...props} onClose={() => setArranging(false)} /> : null}
        </span>
      ) : null}
      {connectable ? (
        <BarButton icon="connect" label="Connect these two" onClick={onConnect} />
      ) : null}
      {collapsible ? (
        <BarButton
          icon={collapsed ? 'expand' : 'collapse'}
          label={collapsed ? 'Expand  (.)' : 'Collapse to title  (.)'}
          onClick={onCollapse}
        />
      ) : null}
      <BarButton icon="frame" label="Put in a frame  (Ctrl+G)" onClick={onFrame} />
      <BarButton icon="duplicate" label="Duplicate  (Ctrl+D)" onClick={onDuplicate} />
      <BarButton icon="copy" label="Copy as markdown  (Ctrl+C)" onClick={onCopy} />
      <BarButton icon="zoomTo" label="Zoom to selection  (Z)" onClick={onZoom} />
      <BarButton icon="trash" label="Delete  (Del)" onClick={onDelete} />
    </div>
  )
}

export default CanvasSelectionBar
