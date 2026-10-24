import { useState } from 'react'
import type { Turn as TurnType } from '../../../../shared/conversation'
import { InlineSegments } from './ExpansionFrame'

interface TurnProps {
  turn: TurnType
  loading: boolean
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  onContextMenu: (e: React.MouseEvent, segmentIndex: number) => void
  onRetry?: (turnId: number) => void
}

function Turn({
  turn,
  loading,
  onFold,
  onUnfold,
  onContextMenu,
  onRetry
}: TurnProps): React.JSX.Element {
  const isUser = turn.role === 'user'
  const [copied, setCopied] = useState(false)

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
        ) : (
          <div className={`message-content${turn.error ? ' error' : ''}`}>
            {turn.segments ? (
              <InlineSegments
                segments={turn.segments}
                onFold={onFold}
                onUnfold={onUnfold}
                onContextMenu={onContextMenu}
              />
            ) : (
              turn.content
            )}
            {turn.error && onRetry && (
              <button className="message-retry" onClick={() => onRetry(turn.id)}>
                Retry
              </button>
            )}
          </div>
        )}
        {turn.content !== '' && (
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
          </div>
        )}
      </div>
    </div>
  )
}

export default Turn
