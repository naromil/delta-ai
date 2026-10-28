import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { Turn as TurnType } from '../../../../shared/conversation'
import type { ExpansionNode } from '../../../../shared/rich-text'
import Markdown from './Markdown'
import ExpansionFrame from './ExpansionFrame'

interface TurnProps {
  turn: TurnType
  loading: boolean
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  onRetry?: (turnId: number) => void
  onRegenerate?: (turnId: number) => void
  /** Returns `false` when the edit was not sent (e.g. the user cancelled a confirm). */
  onEdit?: (turnId: number, content: string) => boolean
  onRetryExpansion?: (expansionId: number) => void
  onDismissExpansion?: (expansionId: number) => void
}

function Turn({
  turn,
  loading,
  onFold,
  onUnfold,
  onRetry,
  onRegenerate,
  onEdit,
  onRetryExpansion,
  onDismissExpansion
}: TurnProps): React.JSX.Element {
  const isUser = turn.role === 'user'
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = editRef.current
    if (!editing || !el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [editing, editDraft])

  const beginEdit = (): void => {
    setEditDraft(turn.content)
    setEditing(true)
  }

  const submitEdit = (): void => {
    const trimmed = editDraft.trim()
    if (trimmed === '' || loading || !onEdit) return
    if (onEdit(turn.id, trimmed)) setEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(false)
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submitEdit()
    }
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(turn.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — leave the label unchanged */
    }
  }

  const isStreamingPlaceholder = turn.content === '' && loading && !isUser

  // Stable across streamed chunks, so memoized nested frames are not invalidated.
  const renderExpansion = useCallback(
    (node: ExpansionNode) => (
      <ExpansionFrame
        node={node}
        onFold={onFold}
        onUnfold={onUnfold}
        onRetry={onRetryExpansion}
        onDismiss={onDismissExpansion}
      />
    ),
    [onFold, onUnfold, onRetryExpansion, onDismissExpansion]
  )

  return (
    <div
      className={`message message-${isUser ? 'user' : 'assistant'}`}
      aria-busy={isStreamingPlaceholder || undefined}
    >
      <div className="message-avatar" aria-hidden="true">
        {isUser ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2L2 22h20L12 2z" />
          </svg>
        )}
      </div>
      <div className="message-body">
        {isStreamingPlaceholder ? (
          <div className="message-content">
            <div className="loading-dots" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <span className="sr-only">Delta AI is responding</span>
          </div>
        ) : editing ? (
          <div className="message-content message-edit">
            <textarea
              ref={editRef}
              className="message-edit-input"
              value={editDraft}
              autoFocus
              aria-label="Edit message"
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={handleEditKeyDown}
            />
            <div className="message-edit-actions">
              <button type="button" className="btn btn--sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={submitEdit}
                disabled={loading || editDraft.trim() === ''}
              >
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className={`message-content${turn.error ? ' error' : ''}`}>
            <Markdown
              source={turn.content}
              expansions={turn.expansions}
              onFold={onFold}
              onUnfold={onUnfold}
              renderExpansion={renderExpansion}
            />
            {turn.error && onRetry && (
              <button className="message-retry" onClick={() => onRetry(turn.id)}>
                Retry
              </button>
            )}
          </div>
        )}
        {turn.content !== '' && !editing && (
          <div className="message-actions">
            <button
              type="button"
              className="message-copy"
              onClick={() => void handleCopy()}
              title="Copy message"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="12" height="12" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {isUser && onEdit && !loading && (
              <button
                type="button"
                className="message-edit-button"
                onClick={beginEdit}
                title="Edit and resend"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                </svg>
                Edit
              </button>
            )}
            {!isUser && onRegenerate && !isStreamingPlaceholder && (
              <button
                type="button"
                className="message-regenerate"
                onClick={() => onRegenerate(turn.id)}
                title="Regenerate answer"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 11a8 8 0 1 0-2.34 5.66" />
                  <path d="M20 4v7h-7" />
                </svg>
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(Turn)
