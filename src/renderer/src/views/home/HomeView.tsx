import { useState, useEffect } from 'react'
import type { ConversationMeta } from '../../../../shared/conversation'
import type { CategorizedKeyword, KeywordCategory } from '../../../../shared/models'
import { formatRelativeTime, pickRecentConversations } from '../../lib/recent-conversations'

type HomeTarget = 'chat' | 'knowledge' | 'lookup-guide'

interface HomeViewProps {
  onNavigate?: (view: HomeTarget) => void
  onOpenConversation?: (id: string) => void
}

const CATEGORY_LABELS: Record<KeywordCategory, string> = {
  topic: 'Topics',
  knowledge_area: 'Knowledge',
  learning_preference: 'Preferences'
}

const CATEGORIES: KeywordCategory[] = ['topic', 'knowledge_area', 'learning_preference']

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
  const [keywords, setKeywords] = useState<CategorizedKeyword[]>([])
  const [hotkey, setHotkey] = useState<string | null>(null)
  const [recent, setRecent] = useState<ConversationMeta[]>([])

  useEffect(() => {
    let cancelled = false
    window.api
      .listConversations()
      .then((list) => {
        if (!cancelled) setRecent(pickRecentConversations(list))
      })
      .catch(() => {
        // the list is a shortcut; Ctrl+K search still reaches every chat
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const { keywords: kw } = await window.api.kbLoadPrompt()
        if (!cancelled) setKeywords(kw)
      } catch {
        // ignore
      }
    }
    load()
    // The profile learns itself; refresh the tags whenever a pass finishes.
    const unsubscribe = window.api.kbOnStatus((status) => {
      if (status.state === 'running') return
      void load()
    })
    return () => {
      cancelled = true
      unsubscribe()
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
          Your learning profile, built from the conversations you have with Delta AI.
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
              <span className="home-action-desc">
                Ask anything — every chat feeds your profile.
              </span>
            </span>
          </button>
          <button className="home-action" onClick={() => onNavigate?.('knowledge')}>
            <span className="home-action-icon">
              <BookIcon />
            </span>
            <span className="home-action-body">
              <span className="home-action-title">Build your profile</span>
              <span className="home-action-desc">Analyze unfed conversations into a prompt.</span>
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

        {recent.length > 0 && onOpenConversation && (
          <section className="home-recent">
            <h2 className="home-section-title">Recent conversations</h2>
            <ul className="home-recent-list">
              {recent.map((meta) => (
                <li key={meta.id}>
                  <button className="home-recent-item" onClick={() => onOpenConversation(meta.id)}>
                    <span className="home-recent-title">{meta.title || 'Untitled'}</span>
                    <span className="home-recent-meta">
                      {formatRelativeTime(meta.updatedAt)} · {meta.turnCount} turns
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {keywords.length === 0 ? (
          <div className="home-empty">
            <h2 className="home-empty-title">No learning profile yet</h2>
            <p className="home-empty-text">
              Your learning profile builds itself as you chat with Delta AI. New topics and
              preferences will appear here; automatic learning can be turned off in{' '}
              <strong>Settings → General</strong>.
            </p>
          </div>
        ) : (
          <>
            <h2 className="home-section-title">What Delta AI has learned</h2>
            <div className="kb-home-columns">
              {CATEGORIES.map((cat) => {
                const group = keywords
                  .filter((kw) => kw.category === cat)
                  .sort((a, b) => b.count - a.count)

                return (
                  <div key={cat} className={`kb-home-column kb-home-column--${cat}`}>
                    <span className="kb-home-column-label">{CATEGORY_LABELS[cat]}</span>
                    <div className="kb-home-column-tags">
                      {group.length === 0 ? (
                        <span className="kb-home-column-empty">Nothing yet</span>
                      ) : (
                        group.map((kw) => (
                          <div key={kw.keyword} className={`kb-home-tag kb-home-tag--${cat}`}>
                            <span className="kb-home-tag-keyword">{kw.keyword}</span>
                            <span className="kb-home-tag-count">{kw.count}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default HomeView
