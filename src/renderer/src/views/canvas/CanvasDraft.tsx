import { useEffect, useRef, useState } from 'react'
import type { CanvasLinkContext, CanvasRect, CanvasSide } from '../../../../shared/canvas'
import { estimateWords } from '../../../../shared/canvas'

export interface CanvasDraftSession {
  id: string
  label: string
}

/** Something the composer sends besides the question. */
export interface CanvasDraftContext {
  id: string
  label: string
  /** A note is always sent whole; undefined for one. */
  context: CanvasLinkContext | undefined
  /** Linked further up this branch, so it comes along and can only be changed on its link. */
  inherited: boolean
}

interface CanvasDraftProps {
  rect: CanvasRect
  /** The parent it is kept against, which decides the corner that resizes it. */
  side: CanvasSide | undefined
  resizing: boolean
  /** Cards this rectangle could continue, newest first; empty means a new session. */
  sessions: CanvasDraftSession[]
  parentId: string | undefined
  /** How many selected cards the question is about. */
  sourceCount: number
  context: CanvasDraftContext[]
  /** Roughly how much the links send, and whether some of it had to be cut. */
  contextTokens: number
  contextClipped: boolean
  /** Something held over it would link if let go. */
  linkTarget: boolean
  /** Why it cannot be sent yet (the answer it continues is still being written), or null. */
  waiting: string | null
  onParentChange: (parentId: string | undefined) => void
  /** Typing in a draft that is off screen brings it back. */
  onActivity: () => void
  onContextMode: (id: string, context: CanvasLinkContext) => void
  onContextRemove: (id: string) => void
  onResizeStart: (e: React.PointerEvent) => void
  onResizeBy: (dw: number, dh: number) => void
  onSubmit: (question: string) => void
  onCancel: () => void
}

const NEW_SESSION = ''
const LABEL_CHARS = 32
/** How far Alt+arrow resizes, in world pixels. */
const RESIZE_STEP = 40

function shortLabel(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS - 1)}…` : flat || 'Untitled'
}

function formatTokens(tokens: number): string {
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`
}

function ContextChip({
  item,
  onMode,
  onRemove
}: {
  item: CanvasDraftContext
  onMode: (id: string, context: CanvasLinkContext) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const label = shortLabel(item.label)
  if (item.inherited) {
    return (
      <span className="canvas-draft-chip is-inherited" title={`Linked earlier: ${item.label}`}>
        <span className="canvas-draft-chip-label">{label}</span>
      </span>
    )
  }
  const next = item.context === 'branch' ? 'card' : 'branch'
  return (
    <span className="canvas-draft-chip" title={item.label}>
      <span className="canvas-draft-chip-label">{label}</span>
      {item.context ? (
        <button
          type="button"
          title={
            item.context === 'branch'
              ? 'Sends the whole branch up to this card. Click to send only this card.'
              : 'Sends only this card. Click to send the whole branch up to it.'
          }
          onClick={() => onMode(item.id, next)}
        >
          {item.context === 'branch' ? 'Branch' : 'Card'}
        </button>
      ) : null}
      <button type="button" aria-label={`Remove ${label}`} onClick={() => onRemove(item.id)}>
        ×
      </button>
    </span>
  )
}

/** A drawn rectangle waiting for its question: the canvas's composer. */
function CanvasDraft({
  rect,
  side,
  resizing,
  sessions,
  parentId,
  sourceCount,
  context,
  contextTokens,
  contextClipped,
  linkTarget,
  waiting,
  onParentChange,
  onActivity,
  onContextMode,
  onContextRemove,
  onResizeStart,
  onResizeBy,
  onSubmit,
  onCancel
}: CanvasDraftProps): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const trimmed = question.trim()
  const canSend = trimmed !== '' && waiting === null

  // Not autoFocus: that scrolls the clipped plane, which only the viewport may move.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const submit = (): void => {
    if (canSend) onSubmit(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    } else if (e.altKey && e.key.startsWith('Arrow')) {
      e.preventDefault()
      e.stopPropagation()
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
        e.key
      ]
      if (step) onResizeBy(step[0] * RESIZE_STEP, step[1] * RESIZE_STEP)
    }
  }

  return (
    <article
      className={`canvas-card canvas-card--draft${resizing ? ' is-resizing' : ''}${
        linkTarget ? ' is-link-target' : ''
      }`}
      data-canvas-draft=""
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }}
    >
      <form
        className="canvas-card-surface canvas-draft"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="canvas-draft-meta">
          {sessions.length === 0 ? (
            <span>
              {sourceCount > 0
                ? `About ${sourceCount === 1 ? 'this card' : `these ${sourceCount} cards`}`
                : 'New session'}
            </span>
          ) : (
            <label className="canvas-draft-session">
              <span>Continues</span>
              <select
                value={parentId ?? NEW_SESSION}
                title="Which conversation this answer follows. Only that history is sent."
                onChange={(e) =>
                  onParentChange(e.target.value === NEW_SESSION ? undefined : e.target.value)
                }
              >
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {shortLabel(session.label)}
                  </option>
                ))}
                <option value={NEW_SESSION}>Nothing (new session)</option>
              </select>
            </label>
          )}
          <span title="How long the answer will be. Drag the corner or press Alt+arrows to change it.">
            ≈ {estimateWords(rect, trimmed.length)} words
          </span>
        </div>
        <textarea
          ref={inputRef}
          className="canvas-draft-input"
          aria-label="Question"
          placeholder="What should go here?"
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value)
            onActivity()
          }}
          onKeyDown={handleKeyDown}
        />
        {context.length > 0 ? (
          <div className="canvas-draft-context" aria-label="Context sent with this question">
            {context.map((item) => (
              <ContextChip
                key={item.id}
                item={item}
                onMode={onContextMode}
                onRemove={onContextRemove}
              />
            ))}
            {contextTokens > 0 ? (
              <span
                className="canvas-draft-context-size"
                title={
                  contextClipped
                    ? 'This was too long to send whole, so the oldest or furthest part is left out.'
                    : 'Roughly how much these links add to the request.'
                }
              >
                ≈ {formatTokens(contextTokens)} tokens{contextClipped ? ' (cut to fit)' : ''}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="canvas-draft-actions">
          <span className="canvas-draft-hint">
            {linkTarget ? 'Drop to link' : 'Drag a card or note here to link it'}
          </span>
          {waiting ? (
            <span className="canvas-draft-waiting" role="status">
              {waiting}
            </span>
          ) : null}
          <button type="button" className="btn btn--sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--sm btn--primary" disabled={!canSend}>
            Ask
          </button>
        </div>
        <div
          className="canvas-card-resize"
          data-side={side}
          title="Drag to resize; the answer's length follows"
          onPointerDown={onResizeStart}
        />
      </form>
    </article>
  )
}

export default CanvasDraft
