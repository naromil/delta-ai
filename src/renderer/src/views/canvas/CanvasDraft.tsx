import { useState } from 'react'
import type { CanvasRect } from '../../../../shared/canvas'
import { estimateWords } from '../../../../shared/canvas'

interface CanvasDraftProps {
  rect: CanvasRect
  continues: boolean
  onSubmit: (question: string) => void
  onCancel: () => void
}

/** A drawn rectangle waiting for its question. */
function CanvasDraft({ rect, continues, onSubmit, onCancel }: CanvasDraftProps): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const trimmed = question.trim()

  return (
    <article
      className="canvas-card canvas-card--draft"
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }}
    >
      <form
        className="canvas-card-surface canvas-draft"
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed !== '') onSubmit(trimmed)
        }}
      >
        <div className="canvas-draft-meta">
          <span>{continues ? 'Continues this session' : 'New session'}</span>
          <span>≈ {estimateWords(rect, trimmed.length)} words</span>
        </div>
        <textarea
          className="canvas-draft-input"
          aria-label="Question"
          placeholder="What should go here?"
          value={question}
          autoFocus
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (trimmed !== '') onSubmit(trimmed)
            }
          }}
        />
        <div className="canvas-draft-actions">
          <button type="button" className="btn btn--sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--sm btn--primary" disabled={trimmed === ''}>
            Ask
          </button>
        </div>
      </form>
    </article>
  )
}

export default CanvasDraft
