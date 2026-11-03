import { memo, useEffect, useRef } from 'react'
import type { CanvasFrame } from '../../../../shared/canvas'

interface FrameTitleEditorProps {
  title: string
  onDone: (title: string | null) => void
}

function FrameTitleEditor({ title, onDone }: FrameTitleEditorProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
  }, [])

  const finish = (value: string | null): void => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(value)
  }

  return (
    <input
      ref={inputRef}
      className="canvas-frame-input"
      aria-label="Frame title"
      defaultValue={title}
      onBlur={(e) => finish(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value)
        else if (e.key === 'Escape') finish(null)
      }}
    />
  )
}

interface CanvasFrameViewProps {
  frame: CanvasFrame
  editing: boolean
  selected: boolean
  dragging: boolean
  pulsing: boolean
  dimmed: boolean
  onDragStart: (e: React.PointerEvent, id: string) => void
  onResizeStart: (e: React.PointerEvent, id: string) => void
  onMenu: (e: React.MouseEvent, id: string) => void
  onEdit: (id: string | null) => void
  onRename: (id: string, title: string) => void
  onZoomTo: (id: string) => void
}

/**
 * A titled region under the cards. Only its title and corner take the pointer, so the
 * space inside it behaves like the plane: a marquee can start there.
 */
function CanvasFrameView(props: CanvasFrameViewProps): React.JSX.Element {
  const { frame, editing, selected, dragging, pulsing, dimmed } = props
  const { onDragStart, onResizeStart, onMenu, onEdit, onRename, onZoomTo } = props
  const { rect } = frame
  const classes = [
    'canvas-frame',
    selected ? 'is-selected' : '',
    dragging ? 'is-dragging' : '',
    pulsing ? 'is-pulsing' : '',
    dimmed ? 'is-dimmed' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section
      className={classes}
      data-canvas-frame={frame.id}
      data-color={frame.color}
      aria-label={`Frame: ${frame.title || 'Untitled'}`}
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }}
    >
      <div className="canvas-frame-title">
        {editing ? (
          <FrameTitleEditor
            title={frame.title}
            onDone={(title) => {
              if (title !== null) onRename(frame.id, title.trim())
              onEdit(null)
            }}
          />
        ) : (
          <button
            type="button"
            className="canvas-frame-handle"
            title="Drag to move with what is inside. Double-click to rename."
            onPointerDown={(e) => onDragStart(e, frame.id)}
            onContextMenu={(e) => onMenu(e, frame.id)}
            onKeyDown={(e) => {
              if (e.key === 'F2') {
                e.preventDefault()
                onEdit(frame.id)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                onZoomTo(frame.id)
              }
            }}
          >
            {frame.title || 'Untitled frame'}
          </button>
        )}
      </div>
      <span
        className="canvas-frame-resize"
        title="Drag to resize"
        onPointerDown={(e) => onResizeStart(e, frame.id)}
      />
    </section>
  )
}

export default memo(CanvasFrameView)
