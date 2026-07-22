import type { Turn as TurnType } from '../../../../shared/conversation'
import { InlineSegments } from './ExpansionFrame'

interface TurnProps {
  turn: TurnType
  loading: boolean
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  onContextMenu: (e: React.MouseEvent, segmentIndex: number) => void
}

function Turn({ turn, loading, onFold, onUnfold, onContextMenu }: TurnProps): React.JSX.Element {
  const isUser = turn.role === 'user'

  return (
    <div className={`message message-${isUser ? 'user' : 'assistant'}`}>
      <div className="message-avatar">
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
      {turn.content === '' && loading && !isUser ? (
        <div className="message-content">
          <div className="loading-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      ) : (
        <div className={`message-content${turn.error ? ' error' : ''}`}>
          {isUser || !turn.segments ? (
            turn.content
          ) : (
            <InlineSegments
              segments={turn.segments}
              onFold={onFold}
              onUnfold={onUnfold}
              onContextMenu={onContextMenu}
            />
          )}
        </div>
      )}
    </div>
  )
}

export default Turn
