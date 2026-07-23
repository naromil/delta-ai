import { useState, useEffect, useRef, useCallback } from 'react'
import type { ConversationMeta } from '../../../../shared/conversation'

interface ConversationSearchProps {
  onSelect: (id: string) => void
  onClose: () => void
}

function ConversationSearch({ onSelect, onClose }: ConversationSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.listConversations().then((list) => {
      setConversations(list)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0)

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const filtered = query.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : conversations

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value)
    setSelectedIndex(0)
  }

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id)
      onClose()
    },
    [onSelect, onClose]
  )

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) {
        handleSelect(filtered[selectedIndex].id)
      }
    }
  }

  const formatDate = (iso: string): string => {
    const date = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  return (
    <div className="conversation-search-overlay" onClick={onClose}>
      <div
        className="conversation-search-panel"
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
            placeholder="Search conversations..."
            value={query}
            onChange={handleQueryChange}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="conversation-search-list" ref={listRef}>
          {loading ? (
            <div className="conversation-search-empty">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="conversation-search-empty">
              {query.trim() ? 'No results' : 'No conversations yet'}
            </div>
          ) : (
            filtered.map((conv, idx) => (
              <button
                key={conv.id}
                className={`conversation-search-item${idx === selectedIndex ? ' selected' : ''}`}
                onClick={() => handleSelect(conv.id)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className="conversation-search-title">{conv.title}</span>
                <span className="conversation-search-meta">
                  {formatDate(conv.updatedAt)} · {conv.turnCount} messages
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default ConversationSearch
