import type { CanvasIconName } from './CanvasIcons'
import CanvasIcon from './CanvasIcons'

export type CanvasTool = 'select' | 'hand' | 'answer' | 'note' | 'connect' | 'frame'

const TOOLS: ReadonlyArray<{ tool: CanvasTool; icon: CanvasIconName; label: string; key: string }> =
  [
    { tool: 'select', icon: 'select', label: 'Select', key: 'V' },
    { tool: 'hand', icon: 'hand', label: 'Hand: drag anywhere to pan', key: 'H' },
    { tool: 'answer', icon: 'answer', label: 'Answer: draw a rectangle to ask in', key: 'R' },
    { tool: 'note', icon: 'note', label: 'Note: your own text', key: 'T' },
    { tool: 'connect', icon: 'connect', label: 'Connect: drag from card to card', key: 'C' },
    { tool: 'frame', icon: 'frame', label: 'Frame: group a region', key: 'F' }
  ]

interface CanvasToolRailProps {
  tool: CanvasTool
  onTool: (tool: CanvasTool) => void
  undoLabel: string | null
  redoLabel: string | null
  onUndo: () => void
  onRedo: () => void
  outlineOpen: boolean
  onToggleOutline: () => void
}

/** The tools, then the two actions and the panel that belong to no tool. */
function CanvasToolRail({
  tool,
  onTool,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  outlineOpen,
  onToggleOutline
}: CanvasToolRailProps): React.JSX.Element {
  return (
    <div className="canvas-rail" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.map(({ tool: item, icon, label, key }) => (
        <button
          key={item}
          type="button"
          className={`canvas-rail-btn${tool === item ? ' is-active' : ''}`}
          aria-label={label}
          aria-pressed={tool === item}
          data-tip={`${label}  (${key})`}
          onClick={() => onTool(item)}
        >
          <CanvasIcon name={icon} />
        </button>
      ))}
      <span className="canvas-rail-sep" role="separator" />
      <button
        type="button"
        className="canvas-rail-btn"
        aria-label="Undo"
        data-tip={undoLabel ? `Undo ${undoLabel.toLowerCase()}  (Ctrl+Z)` : 'Nothing to undo'}
        disabled={undoLabel === null}
        onClick={onUndo}
      >
        <CanvasIcon name="undo" />
      </button>
      <button
        type="button"
        className="canvas-rail-btn"
        aria-label="Redo"
        data-tip={redoLabel ? `Redo ${redoLabel.toLowerCase()}  (Ctrl+Shift+Z)` : 'Nothing to redo'}
        disabled={redoLabel === null}
        onClick={onRedo}
      >
        <CanvasIcon name="redo" />
      </button>
      <span className="canvas-rail-sep" role="separator" />
      <button
        type="button"
        className={`canvas-rail-btn${outlineOpen ? ' is-active' : ''}`}
        aria-label="Outline and search"
        aria-expanded={outlineOpen}
        data-tip="Outline and search  (O, Ctrl+F)"
        onClick={onToggleOutline}
      >
        <CanvasIcon name="outline" />
      </button>
    </div>
  )
}

export default CanvasToolRail
