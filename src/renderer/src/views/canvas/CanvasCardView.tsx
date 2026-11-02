import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasCard, CanvasRect, CanvasSide } from '../../../../shared/canvas'
import type { ExpansionNode } from '../../../../shared/rich-text'
import { flattenMarkdown } from '../../../../shared/rich-text'
import Markdown from '../../components/conversation/Markdown'
import { OriginalText } from '../../components/conversation/ExpansionFrame'

export type CanvasCardStatus = 'streaming' | 'done' | 'failed'

export interface CanvasCardActions {
  onDragStart: (e: React.PointerEvent, id: string) => void
  onResizeStart: (e: React.PointerEvent, id: string) => void
  onStop: (id: string) => void
  /** Retry on a failed card, Regenerate on a finished one: both use its current size. */
  onRegenerate: (id: string) => void
  /** Returns `false` when the edit was not sent (the user declined a confirm). */
  onEdit: (id: string, question: string) => boolean
  onAskAnother: (expansionId: number, at: { x: number; y: number }) => void
  onDelete: (id: string) => void
  onContinue: (id: string, side: CanvasSide) => void
  onContextMenu: (e: React.MouseEvent) => void
  onOpenExpansion: (expansionId: number) => void
}

interface CanvasCardViewProps extends CanvasCardActions {
  card: CanvasCard
  rect: CanvasRect
  caption: string
  /** The question typed about an expanded term; a message's caption is its question. */
  question?: string
  answer: string
  expansions: ExpansionNode[]
  status: CanvasCardStatus
  /** Why the card has no answer, when `status` is `failed`. */
  failure?: string
  dragging: boolean
  invalid: boolean
  pulsing: boolean
  dimmed: boolean
}

/** Expansions here are cards, so a term has nothing to fold. */
const noop = (): void => undefined

function Skeleton({ lines }: { lines: number }): React.JSX.Element {
  return (
    <div className="canvas-skeleton" aria-label="Writing an answer">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  )
}

const COPIED_MS = 1500

function ActionIcon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function CardQuestionEditor({
  question,
  onSubmit,
  onCancel
}: {
  question: string
  onSubmit: (question: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(question)
  const trimmed = draft.trim()
  return (
    <form
      className="canvas-card-edit"
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed !== '') onSubmit(trimmed)
      }}
    >
      <textarea
        className="canvas-draft-input"
        aria-label="Edit question"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          Send
        </button>
      </div>
    </form>
  )
}

function CanvasCardView(props: CanvasCardViewProps): React.JSX.Element {
  const { card, rect, caption, question, answer, expansions, status, failure } = props
  const { dragging, invalid, pulsing, dimmed } = props
  const { onDragStart, onResizeStart, onStop, onRegenerate, onEdit, onDelete, onContinue } = props
  const { onAskAnother, onContextMenu, onOpenExpansion } = props
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(answer)
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null
        setCopied(false)
      }, COPIED_MS)
    } catch {
      /* clipboard unavailable — leave the button unchanged */
    }
  }

  const renderExpansion = useCallback(
    (node: ExpansionNode, group: ExpansionNode[]) => {
      const flat = flattenMarkdown(node.originalText).slice(0, 80)
      return (
        <span
          className="queried canvas-term"
          data-expansion-id={node.id}
          data-canvas-terms={group.map((item) => item.id).join(' ')}
          role="button"
          tabIndex={0}
          aria-label={`Go to the expansion of ${flat}`}
          title={node.prompt?.trim() || 'Go to this expansion'}
          onClick={() => onOpenExpansion(node.id)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            onOpenExpansion(node.id)
          }}
        >
          <OriginalText text={node.originalText} />
        </span>
      )
    },
    [onOpenExpansion]
  )

  const classes = [
    'canvas-card',
    `canvas-card--${card.kind}`,
    card.kind === 'expansion' && card.inset ? 'is-inset' : '',
    status === 'streaming' ? 'is-streaming' : '',
    status === 'failed' ? 'is-failed' : '',
    dragging ? 'is-dragging' : '',
    invalid ? 'is-invalid' : '',
    pulsing ? 'is-pulsing' : '',
    dimmed ? 'is-dimmed' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const canContinue = (card.kind === 'message' || !card.inset) && status === 'done'
  const waiting = status === 'streaming' && answer === ''
  const expansionId = card.kind === 'expansion' ? card.expansionId : undefined

  return (
    <article
      className={classes}
      data-canvas-card={card.id}
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }}
    >
      <div className="canvas-card-surface">
        <header
          className="canvas-card-header"
          title="Drag to move"
          onPointerDown={(e) => onDragStart(e, card.id)}
        >
          <div className="canvas-card-caption">
            {card.kind === 'expansion' ? <span className="canvas-card-kind">Expansion</span> : null}
            <span title={question ?? caption}>
              {question ? `${caption}: ${question}` : caption}
            </span>
          </div>
          <div className="canvas-card-actions">
            {status === 'streaming' ? (
              <button type="button" className="canvas-icon-btn" onClick={() => onStop(card.id)}>
                Stop
              </button>
            ) : null}
            {status === 'failed' && !editing ? (
              <button
                type="button"
                className="canvas-icon-btn"
                onClick={() => onRegenerate(card.id)}
              >
                Retry
              </button>
            ) : null}
            {answer !== '' ? (
              <button
                type="button"
                className="canvas-icon-btn"
                aria-label={copied ? 'Copied' : 'Copy answer'}
                title={copied ? 'Copied' : 'Copy answer'}
                onClick={() => void handleCopy()}
              >
                <ActionIcon>
                  {copied ? (
                    <path d="M20 6L9 17l-5-5" />
                  ) : (
                    <>
                      <rect x="9" y="9" width="12" height="12" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </>
                  )}
                </ActionIcon>
              </button>
            ) : null}
            {card.kind === 'message' && status !== 'streaming' && !editing ? (
              <button
                type="button"
                className="canvas-icon-btn"
                aria-label="Edit and resend"
                title="Edit and resend"
                onClick={() => setEditing(true)}
              >
                <ActionIcon>
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                </ActionIcon>
              </button>
            ) : null}
            {expansionId !== undefined && status === 'done' ? (
              <button
                type="button"
                className="canvas-icon-btn"
                title="Ask something else about this; this answer stays"
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  onAskAnother(expansionId, { x: box.left, y: box.bottom + 4 })
                }}
              >
                Ask…
              </button>
            ) : null}
            {status === 'done' && !editing ? (
              <button
                type="button"
                className="canvas-icon-btn"
                aria-label="Regenerate at this size"
                title="Regenerate at this size"
                onClick={() => onRegenerate(card.id)}
              >
                <ActionIcon>
                  <path d="M20 11a8 8 0 1 0-2.34 5.66" />
                  <path d="M20 4v7h-7" />
                </ActionIcon>
              </button>
            ) : null}
            <button
              type="button"
              className="canvas-icon-btn canvas-icon-btn--close"
              aria-label="Delete"
              title="Delete"
              onClick={() => onDelete(card.id)}
            >
              ×
            </button>
          </div>
        </header>
        <div className="canvas-card-progress" aria-hidden="true" />
        <div
          className="canvas-card-body"
          data-turn-id={card.turnId}
          data-expansion-id={expansionId}
          onContextMenu={onContextMenu}
        >
          {editing ? (
            <CardQuestionEditor
              question={caption}
              onCancel={() => setEditing(false)}
              onSubmit={(question) => {
                if (onEdit(card.id, question)) setEditing(false)
              }}
            />
          ) : (
            <div className="message-content">
              {waiting ? <Skeleton lines={4} /> : null}
              {status === 'failed' ? <p className="canvas-card-failure">{failure}</p> : null}
              {!waiting && status !== 'failed' ? (
                <Markdown
                  source={answer}
                  expansions={expansions}
                  onFold={noop}
                  onUnfold={noop}
                  renderExpansion={renderExpansion}
                />
              ) : null}
            </div>
          )}
        </div>
        <span
          className="canvas-card-resize"
          title="Drag to resize"
          onPointerDown={(e) => onResizeStart(e, card.id)}
        />
      </div>
      {canContinue ? (
        <>
          <button
            type="button"
            className="canvas-continue canvas-continue--right"
            aria-label="Continue on the right"
            title="Continue this session here"
            onClick={() => onContinue(card.id, 'right')}
          >
            +
          </button>
          <button
            type="button"
            className="canvas-continue canvas-continue--bottom"
            aria-label="Continue below"
            title="Continue this session here"
            onClick={() => onContinue(card.id, 'bottom')}
          >
            +
          </button>
        </>
      ) : null}
    </article>
  )
}

export default memo(CanvasCardView)
