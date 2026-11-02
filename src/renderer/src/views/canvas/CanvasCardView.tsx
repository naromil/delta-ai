import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasCard, CanvasRect, CanvasSide } from '../../../../shared/canvas'
import type { ExpansionNode } from '../../../../shared/rich-text'
import { flattenMarkdown } from '../../../../shared/rich-text'
import Markdown from '../../components/conversation/Markdown'
import { OriginalText } from '../../components/conversation/ExpansionFrame'
import { nextPinned } from '../../hooks/useStickToBottom'

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
  /** Back along the session: an expansion's term, or the card a message continues. */
  onGoToSource: (id: string) => void
  /** Keys pressed while the card itself has focus (not a button or field inside it). */
  onCardKeyDown: (e: React.KeyboardEvent, id: string) => void
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
  /** Whether a same-sized continuation fits against each side with a handle. */
  roomRight: boolean
  roomBottom: boolean
  invalid: boolean
  pulsing: boolean
  dimmed: boolean
  /** The card a rectangle being drawn, or a waiting draft, would continue. */
  continued: boolean
  /** An expanded term in this card to flash, after navigating back to it. */
  pulseTermId: number | null
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const trimmed = draft.trim()

  // Not autoFocus: that scrolls the clipped plane, which only the viewport may move.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])
  return (
    <form
      className="canvas-card-edit"
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed !== '') onSubmit(trimmed)
      }}
    >
      <textarea
        ref={inputRef}
        className="canvas-draft-input"
        aria-label="Edit question"
        value={draft}
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
  const { dragging, roomRight, roomBottom, invalid, pulsing, dimmed, continued, pulseTermId } =
    props
  const { onDragStart, onResizeStart, onStop, onRegenerate, onEdit, onDelete, onContinue } = props
  const { onAskAnother, onContextMenu, onOpenExpansion, onGoToSource, onCardKeyDown } = props
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const lastTopRef = useRef(0)
  const lastStatusRef = useRef(status)

  // An answer that outgrows its card while streaming follows its newest line, as a
  // chat does; scrolling up lets go until the reader returns to the end.
  useLayoutEffect(() => {
    const body = bodyRef.current
    const started = status === 'streaming' && lastStatusRef.current !== 'streaming'
    lastStatusRef.current = status
    if (started) pinnedRef.current = true
    if (!body || status !== 'streaming' || !pinnedRef.current) return
    body.scrollTop = body.scrollHeight
    lastTopRef.current = body.scrollTop
  }, [answer, status])

  const handleBodyScroll = (): void => {
    const body = bodyRef.current
    if (!body) return
    const top = body.scrollTop
    const distance = Math.max(0, body.scrollHeight - top - body.clientHeight)
    pinnedRef.current = nextPinned(pinnedRef.current, lastTopRef.current, top, distance)
    lastTopRef.current = top
  }

  const finishEditing = (): void => {
    setEditing(false)
    articleRef.current?.focus({ preventScroll: true })
  }

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
          className={`queried canvas-term${group.some((item) => item.id === pulseTermId) ? ' is-pulsing' : ''}`}
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
    [onOpenExpansion, pulseTermId]
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
    dimmed ? 'is-dimmed' : '',
    continued ? 'is-continued' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const canContinue = (card.kind === 'message' || !card.inset) && status === 'done'
  const waiting = status === 'streaming' && answer === ''
  const expansionId = card.kind === 'expansion' ? card.expansionId : undefined
  const hasSource = card.kind === 'expansion' || card.parentId !== undefined
  const label = question ? `${caption}: ${question}` : caption

  return (
    <article
      ref={articleRef}
      className={classes}
      data-canvas-card={card.id}
      tabIndex={0}
      aria-label={`${card.kind === 'expansion' ? 'Expansion' : 'Question'}: ${label.slice(0, 120)}`}
      aria-busy={status === 'streaming'}
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return
        if ((e.key === 'e' || e.key === 'E') && card.kind === 'message' && status !== 'streaming') {
          e.preventDefault()
          setEditing(true)
          return
        }
        // Arrows move between cards, so paging is how a long answer is read.
        if ((e.key === 'PageDown' || e.key === 'PageUp') && bodyRef.current) {
          e.preventDefault()
          const page = bodyRef.current.clientHeight * 0.85
          bodyRef.current.scrollBy({ top: e.key === 'PageDown' ? page : -page, behavior: 'smooth' })
          return
        }
        onCardKeyDown(e, card.id)
      }}
    >
      <div className="canvas-card-surface">
        <header
          className="canvas-card-header"
          title="Drag to move"
          onPointerDown={(e) => onDragStart(e, card.id)}
        >
          <div className="canvas-card-caption">
            {card.kind === 'expansion' ? <span className="canvas-card-kind">Expansion</span> : null}
            <span title={question ?? caption}>{label}</span>
          </div>
          <div className="canvas-card-actions">
            {hasSource ? (
              <button
                type="button"
                className="canvas-icon-btn"
                aria-label={
                  card.kind === 'expansion' ? 'Back to the term (B)' : 'Previous card (B)'
                }
                title={card.kind === 'expansion' ? 'Back to the term (B)' : 'Previous card (B)'}
                onClick={() => onGoToSource(card.id)}
              >
                <ActionIcon>
                  <path d="M9 14L4 9l5-5" />
                  <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
                </ActionIcon>
              </button>
            ) : null}
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
                aria-label="Edit and resend (E)"
                title="Edit and resend (E)"
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
              aria-label="Delete (Delete)"
              title="Delete (Delete)"
              onClick={() => onDelete(card.id)}
            >
              ×
            </button>
          </div>
        </header>
        <div className="canvas-card-progress" aria-hidden="true" />
        <div
          ref={bodyRef}
          className="canvas-card-body"
          data-turn-id={card.turnId}
          data-expansion-id={expansionId}
          onContextMenu={onContextMenu}
          onScroll={handleBodyScroll}
        >
          {editing ? (
            <CardQuestionEditor
              question={caption}
              onCancel={finishEditing}
              onSubmit={(question) => {
                if (onEdit(card.id, question)) finishEditing()
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
      {canContinue && roomRight ? (
        <button
          type="button"
          className="canvas-continue canvas-continue--right"
          aria-label="Continue on the right (Shift+Enter)"
          title="Continue this session here (Shift+Enter)"
          onClick={() => onContinue(card.id, 'right')}
        >
          +
        </button>
      ) : null}
      {canContinue && roomBottom ? (
        <button
          type="button"
          className="canvas-continue canvas-continue--bottom"
          aria-label="Reply below (Enter)"
          title="Continue this session here (Enter)"
          onClick={() => onContinue(card.id, 'bottom')}
        >
          +
        </button>
      ) : null}
    </article>
  )
}

export default memo(CanvasCardView)
