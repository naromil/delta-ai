import { useLayoutEffect, useRef, useState } from 'react'
import { EXPAND_INTENTS } from '../../../../shared/prompts'

export interface ExpandSelectionBarState {
  /** Horizontal centre and top edge of the selection. */
  x: number
  y: number
  /** Bottom edge, used when there is no room above the selection. */
  bottom: number
  onExpand: (prompt?: string) => void
  onAsk: () => void
}

const BAR_GAP = 6

/** Floats over a selection in an answer, so expanding takes one click and no right-click. */
function ExpandSelectionBar({
  state
}: {
  state: ExpandSelectionBarState | null
}): React.JSX.Element | null {
  const barRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!state || !bar) {
      setPosition(null)
      return
    }
    const rect = bar.getBoundingClientRect()
    const above = state.y - rect.height - BAR_GAP
    setPosition({
      left: Math.max(8, Math.min(state.x - rect.width / 2, window.innerWidth - rect.width - 8)),
      top: above >= 8 ? above : state.bottom + BAR_GAP
    })
  }, [state])

  if (!state) return null

  return (
    <div
      ref={barRef}
      className="expand-selection-bar"
      role="toolbar"
      aria-label="Expand selection"
      style={position ?? { left: state.x, top: state.y, visibility: 'hidden' }}
      // Clicking the bar must not clear the selection it acts on.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="expand-intent expand-intent--primary"
        onClick={() => state.onExpand()}
      >
        Expand
      </button>
      {EXPAND_INTENTS.map((intent) => (
        <button
          key={intent.label}
          type="button"
          className="expand-intent"
          title={intent.prompt}
          onClick={() => state.onExpand(intent.prompt)}
        >
          {intent.label}
        </button>
      ))}
      <button type="button" className="expand-intent" onClick={state.onAsk}>
        Ask…
      </button>
    </div>
  )
}

export default ExpandSelectionBar
