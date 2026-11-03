import { useEffect, useRef, useState } from 'react'
import type { CanvasRect } from '../../../../shared/canvas'
import { estimateWords } from '../../../../shared/canvas'

export interface CanvasDraftSession {
  id: string
  label: string
}

interface CanvasDraftProps {
  rect: CanvasRect
  /** Cards this rectangle could continue, newest first; empty means a new session. */
  sessions: CanvasDraftSession[]
  parentId: string | undefined
  /** How many selected cards the question is about. */
  sourceCount: number
  /** Why it cannot be sent yet (the answer it continues is still being written), or null. */
  waiting: string | null
  onParentChange: (parentId: string | undefined) => void
  /** Typing in a draft that is off screen brings it back. */
  onActivity: () => void
  onSubmit: (question: string) => void
  onCancel: () => void
}

const NEW_SESSION = ''
const LABEL_CHARS = 32

function shortLabel(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS - 1)}…` : flat || 'Untitled'
}

/** A drawn rectangle waiting for its question: the canvas's composer. */
function CanvasDraft({
  rect,
  sessions,
  parentId,
  sourceCount,
  waiting,
  onParentChange,
  onActivity,
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

  return (
    <article
      className="canvas-card canvas-card--draft"
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
          <span>≈ {estimateWords(rect, trimmed.length)} words</span>
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
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="canvas-draft-actions">
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
      </form>
    </article>
  )
}

export default CanvasDraft
