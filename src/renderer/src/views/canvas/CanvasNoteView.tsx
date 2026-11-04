import { memo, useEffect, useRef, useState } from 'react'
import type { CanvasNoteCard, CanvasRect } from '../../../../shared/canvas'
import Markdown from '../../components/conversation/Markdown'

const noop = (): void => undefined
const noExpansion = (): null => null

interface NoteEditorProps {
  text: string
  onCommit: (text: string) => void
  onCancel: () => void
}

/** Enter makes a new line, so Ctrl+Enter or clicking away is what finishes. */
function NoteEditor({ text, onCommit, onCancel }: NoteEditorProps): React.JSX.Element {
  const [value, setValue] = useState(text)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const finishedRef = useRef(false)

  // Not autoFocus: that scrolls the clipped plane, which only the viewport may move.
  useEffect(() => {
    const input = inputRef.current
    input?.focus({ preventScroll: true })
    input?.setSelectionRange(input.value.length, input.value.length)
  }, [])

  const finish = (action: () => void): void => {
    if (finishedRef.current) return
    finishedRef.current = true
    action()
  }

  return (
    <textarea
      ref={inputRef}
      className="canvas-note-input"
      aria-label="Note text"
      placeholder="Write a note…"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(() => onCommit(value))}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(onCancel)
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          finish(() => onCommit(value))
        }
      }}
    />
  )
}

interface CanvasNoteDraftProps {
  rect: CanvasRect
  onCommit: (text: string) => void
  onCancel: () => void
}

/** A note before it has any text: blank, it never reaches the canvas or its history. */
export function CanvasNoteDraft({
  rect,
  onCommit,
  onCancel
}: CanvasNoteDraftProps): React.JSX.Element {
  return (
    <article
      className="canvas-card canvas-card--note is-editing"
      data-canvas-draft=""
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }}
    >
      <div className="canvas-card-surface">
        <NoteEditor text="" onCommit={onCommit} onCancel={onCancel} />
      </div>
    </article>
  )
}

interface CanvasNoteViewProps {
  card: CanvasNoteCard
  editing: boolean
  selected: boolean
  dragging: boolean
  /** Its height in the pile where cards overlap; a held card rises above all of them. */
  stackLevel: number
  pulsing: boolean
  dimmed: boolean
  /** A connection being drawn starts or would end here. */
  continued: boolean
  onDragStart: (e: React.PointerEvent, id: string) => void
  onResizeStart: (e: React.PointerEvent, id: string) => void
  onClick: (e: React.MouseEvent, id: string) => void
  onKeyDown: (e: React.KeyboardEvent, id: string) => void
  onMenu: (e: React.MouseEvent, id: string) => void
  onEdit: (id: string | null) => void
  onCommit: (id: string, text: string) => void
}

function CanvasNoteView(props: CanvasNoteViewProps): React.JSX.Element {
  const { card, editing, selected, dragging, stackLevel, pulsing, dimmed, continued } = props
  const { onDragStart, onResizeStart, onClick, onKeyDown, onMenu, onEdit, onCommit } = props
  const { rect } = card
  const articleRef = useRef<HTMLElement>(null)
  const classes = [
    'canvas-card',
    'canvas-card--note',
    editing ? 'is-editing' : '',
    selected ? 'is-selected' : '',
    dragging ? 'is-dragging' : '',
    pulsing ? 'is-pulsing' : '',
    dimmed ? 'is-dimmed' : '',
    continued ? 'is-continued' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const stopEditing = (): void => {
    onEdit(null)
    articleRef.current?.focus({ preventScroll: true })
  }

  return (
    <article
      ref={articleRef}
      className={classes}
      data-canvas-card={card.id}
      data-color={card.color}
      tabIndex={0}
      aria-label={`Note: ${card.text.slice(0, 120)}`}
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: rect.w,
        height: rect.h,
        zIndex: dragging ? undefined : stackLevel
      }}
      onClick={(e) => onClick(e, card.id)}
      onContextMenu={(e) => onMenu(e, card.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return
        if (e.key === 'e' || e.key === 'E' || e.key === 'F2') {
          e.preventDefault()
          onEdit(card.id)
          return
        }
        onKeyDown(e, card.id)
      }}
    >
      <div className="canvas-card-surface">
        {editing ? (
          <NoteEditor
            text={card.text}
            onCancel={stopEditing}
            onCommit={(text) => {
              onCommit(card.id, text)
              stopEditing()
            }}
          />
        ) : (
          <div
            className="canvas-note-body"
            title="Drag to move, double-click to edit"
            onPointerDown={(e) => onDragStart(e, card.id)}
          >
            {card.text.trim() === '' ? (
              <p className="canvas-note-empty">Double-click to write</p>
            ) : (
              <div className="message-content">
                <Markdown
                  source={card.text}
                  expansions={[]}
                  anchored={false}
                  onFold={noop}
                  onUnfold={noop}
                  renderExpansion={noExpansion}
                />
              </div>
            )}
          </div>
        )}
        <div className="canvas-card-lod" onPointerDown={(e) => onDragStart(e, card.id)}>
          {card.text}
        </div>
        {editing ? null : (
          <span
            className="canvas-card-resize"
            title="Drag to resize"
            onPointerDown={(e) => onResizeStart(e, card.id)}
          />
        )}
      </div>
    </article>
  )
}

export default memo(CanvasNoteView)
