import { useState, useEffect } from 'react'
import type { ConversationMeta } from '../../../../shared/conversation'
import { formatRelativeTime } from '../../lib/format'

type HomeTarget = 'chat' | 'knowledge' | 'lookup-guide'

interface HomeViewProps {
  onNavigate?: (view: HomeTarget) => void
  onOpenConversation?: (id: string) => void
}

const RECENT_LIMIT = 5

function ChatIcon(): React.JSX.Element {
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
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  )
}

function BookIcon(): React.JSX.Element {
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
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      <path d="M8 7h8M8 11h6" />
    </svg>
  )
}

function SearchIcon(): React.JSX.Element {
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
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  )
}

function HomeView({ onNavigate, onOpenConversation }: HomeViewProps): React.JSX.Element {
  const [hotkey, setHotkey] = useState<string | null>(null)
  const [recent, setRecent] = useState<ConversationMeta[]>([])

  useEffect(() => {
    let cancelled = false
    window.api
      .listConversations()
      .then((list) => {
        if (!cancelled) setRecent(list.slice(0, RECENT_LIMIT))
      })
      .catch(() => {
        // recents are a shortcut; Ctrl+K search still reaches every chat
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    window.api
      .loadSettings()
      .then((s) => {
        const settings = s as { hotkey?: string } | null
        if (settings?.hotkey) setHotkey(settings.hotkey)
      })
      .catch(() => {
        // hotkey hint is decorative; a failed read just hides it
      })
  }, [])

  return (
    <div className="view-shell">
      <div className="view-shell-header">
        <h1>Home</h1>
        <p className="view-shell-subtitle">
          An assistant that remembers what matters from your conversations.
        </p>
      </div>
      <div className="view-shell-content">
        <div className="home-actions">
          <button className="home-action" onClick={() => onNavigate?.('chat')}>
            <span className="home-action-icon">
              <ChatIcon />
            </span>
            <span className="home-action-body">
              <span className="home-action-title">Start a chat</span>
              <span className="home-action-desc">Ask anything — Delta AI remembers.</span>
            </span>
          </button>
          <button className="home-action" onClick={() => onNavigate?.('knowledge')}>
            <span className="home-action-icon">
              <BookIcon />
            </span>
            <span className="home-action-body">
              <span className="home-action-title">Update memories</span>
              <span className="home-action-desc">Curate your recent chats into notes.</span>
            </span>
          </button>
          <button className="home-action" onClick={() => onNavigate?.('lookup-guide')}>
            <span className="home-action-icon">
              <SearchIcon />
            </span>
            <span className="home-action-body">
              <span className="home-action-title">Look something up</span>
              <span className="home-action-desc">Screen context, one hotkey away.</span>
              {hotkey && <kbd className="kbd home-action-hotkey">{hotkey}</kbd>}
            </span>
          </button>
        </div>

        {onOpenConversation && recent.length > 0 && (
          <section className="home-recent" aria-label="Recent conversations">
            <h2 className="home-section-title">Recent conversations</h2>
            <ul className="home-recent-list">
              {recent.map((meta) => (
                <li key={meta.id}>
                  <button className="home-recent-item" onClick={() => onOpenConversation(meta.id)}>
                    <span className="home-recent-title">{meta.title}</span>
                    <span className="home-recent-meta">
                      {formatRelativeTime(meta.updatedAt)} · {meta.turnCount} turns
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

export default HomeView
