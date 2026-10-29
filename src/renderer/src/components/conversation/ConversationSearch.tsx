import { useState, useEffect, useRef, useCallback } from 'react'
import type { ConversationSearchResult } from '../../../../shared/conversation'
import { formatRelativeTime } from '../../lib/recent-conversations'

interface ConversationSearchProps {
  onSelect: (id: string) => void
  onClose: () => void
  currentConversationId?: string | null
}

function ConversationSearch({
  onSelect,
  onClose,
  currentConversationId
}: ConversationSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [conversations, setConversations] = useState<ConversationSearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLDivElement>(null)
  const activeIndex =
    conversations.length === 0 ? 0 : Math.min(selectedIndex, conversations.length - 1)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(
      () => {
        setLoading(true)
        const request = query.trim()
          ? window.api.searchConversations(query.trim())
          : window.api
              .listConversations()
              .then((list) => list.map((meta) => ({ ...meta, matchedIn: 'title' as const })))
        request
          .then((list) => {
            if (!cancelled) setConversations(list)
          })
          .catch(() => {
            if (!cancelled) setConversations([])
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      },
      query.trim() ? 120 : 0
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id)
      onClose()
    },
    [onSelect, onClose]
  )

  const handleDelete = async (
    e: React.MouseEvent,
    conversation: ConversationSearchResult
  ): Promise<void> => {
    e.stopPropagation()
    if (conversation.id === currentConversationId) return
    if (!window.confirm(`Delete “${conversation.title}”? This cannot be undone.`)) return
    try {
      await window.api.deleteConversation(conversation.id)
      // Functional update so a query change during the IPC round-trip cannot be
      // overwritten by a stale snapshot. `activeIndex` clamps the selection.
      setConversations((prev) => prev.filter((entry) => entry.id !== conversation.id))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete conversation.')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (conversations.length === 0) return
      setSelectedIndex(Math.min(activeIndex + 1, conversations.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(Math.max(activeIndex - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selected = conversations[activeIndex]
      if (selected) handleSelect(selected.id)
    }
  }

  return (
    <div className="conversation-search-overlay" onClick={onClose}>
      <div
        className="conversation-search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search conversations"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="conversation-search-header">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="conversation-search-icon"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="conversation-search-input"
            placeholder="Search titles and messages..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
              setError(null)
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {error && <div className="conversation-search-error">{error}</div>}
        <div className="conversation-search-list">
          {loading ? (
            <div className="conversation-search-empty">Searching...</div>
          ) : conversations.length === 0 ? (
            <div className="conversation-search-empty">
              {query.trim() ? 'No results' : 'No conversations yet'}
            </div>
          ) : (
            conversations.map((conversation, idx) => (
              <div
                key={conversation.id}
                ref={idx === activeIndex ? selectedRef : undefined}
                role="button"
                tabIndex={0}
                className={`conversation-search-item${idx === activeIndex ? ' selected' : ''}`}
                onClick={() => handleSelect(conversation.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    handleSelect(conversation.id)
                  }
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className="conversation-search-row">
                  <span className="conversation-search-title">{conversation.title}</span>
                  <button
                    type="button"
                    className="conversation-search-delete"
                    disabled={conversation.id === currentConversationId}
                    title={
                      conversation.id === currentConversationId
                        ? 'The open conversation cannot be deleted'
                        : 'Delete conversation'
                    }
                    aria-label={`Delete ${conversation.title}`}
                    onKeyDown={(e) => e.stopPropagation()}
                    onClick={(e) => void handleDelete(e, conversation)}
                  >
                    ×
                  </button>
                </span>
                {conversation.snippet && (
                  <span className="conversation-search-snippet">{conversation.snippet}</span>
                )}
                <span className="conversation-search-meta">
                  {formatRelativeTime(conversation.updatedAt)} · {conversation.turnCount} turns
                </span>
              </div>
            ))
          )}
        </div>
        <div className="conversation-search-footer">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> open
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
          {!loading && (
            <span className="conversation-search-count">
              {conversations.length} {conversations.length === 1 ? 'result' : 'results'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default ConversationSearch
