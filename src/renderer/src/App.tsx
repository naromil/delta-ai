import { useCallback, useEffect, useState } from 'react'
import Settings from './views/settings/Settings'
import Conversation from './components/conversation/Conversation'
import ConversationSearch from './components/conversation/ConversationSearch'
import HomeView from './views/home/HomeView'
import KnowledgeView from './views/knowledge/KnowledgeView'
import LookupGuideView from './views/lookup-guide/LookupGuideView'
import { useChatStreaming } from './hooks/useChatStreaming'

type View = 'home' | 'chat' | 'knowledge' | 'lookup-guide' | 'settings'

const mainNavEntries: Array<{ view: View; label: string; icon: string }> = [
  { view: 'home', label: 'Home', icon: 'home' },
  { view: 'chat', label: 'Chat', icon: 'chat' },
  { view: 'knowledge', label: 'Knowledge Base', icon: 'knowledge' },
  { view: 'lookup-guide', label: 'Look-Up Guide', icon: 'lookup' }
]

const settingsNavEntry: { view: View; label: string; icon: string } = {
  view: 'settings',
  label: 'Settings',
  icon: 'settings'
}

const ICONS: Record<string, React.JSX.Element> = {
  home: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12l9-9 9 9" />
      <path d="M5 10v10a1 1 0 001 1h3a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1h3a1 1 0 001-1V10" />
    </svg>
  ),
  chat: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  knowledge: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      <path d="M8 7h8M8 11h6" />
    </svg>
  ),
  lookup: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  ),
  settings: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  )
}

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [transferKey, setTransferKey] = useState(0)
  const [showSearch, setShowSearch] = useState(false)
  // Lives here, not in Conversation, so a view switch cannot drop the draft.
  const [draft, setDraft] = useState('')
  const {
    state,
    loading,
    send,
    stop,
    retry,
    regenerate,
    editMessage,
    expand,
    retryExpansion,
    dismissExpansion,
    fold,
    unfold,
    renameConversation,
    newChat,
    deleteConversation,
    loadConversation,
    conversationId,
    conversationTitle
  } = useChatStreaming({
    onReplaceConversation: () => {
      setView('chat')
      setTransferKey((k) => k + 1)
    }
  })

  const startNewChat = useCallback(() => {
    newChat()
    setView('chat')
  }, [newChat])

  const openConversation = useCallback(
    (id: string) => {
      setView('chat')
      void loadConversation(id)
    },
    [loadConversation]
  )

  const openSearch = useCallback(() => setShowSearch(true), [])
  const closeSearch = useCallback(() => setShowSearch(false), [])

  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setShowSearch(true)
      } else if (key === 'n') {
        e.preventDefault()
        startNewChat()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [startNewChat])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span className="sidebar-brand-name">Delta AI</span>
        </div>
        <nav className="sidebar-nav">
          {mainNavEntries.map((entry) => (
            <button
              key={entry.view}
              className={`sidebar-nav-item${view === entry.view ? ' active' : ''}`}
              title={entry.label}
              aria-current={view === entry.view ? 'page' : undefined}
              onClick={() => setView(entry.view)}
            >
              {ICONS[entry.icon]}
              <span className="sidebar-nav-label">{entry.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-divider sidebar-divider--bottom" />
        <nav className="sidebar-nav">
          <button
            className={`sidebar-nav-item${view === settingsNavEntry.view ? ' active' : ''}`}
            title={settingsNavEntry.label}
            aria-current={view === settingsNavEntry.view ? 'page' : undefined}
            onClick={() => setView(settingsNavEntry.view)}
          >
            {ICONS[settingsNavEntry.icon]}
            <span className="sidebar-nav-label">{settingsNavEntry.label}</span>
          </button>
        </nav>
      </aside>
      <div className="app-main">
        {view === 'home' && <HomeView onNavigate={setView} onOpenConversation={openConversation} />}
        {view === 'chat' && (
          <Conversation
            state={state}
            loading={loading}
            onSend={send}
            onStop={stop}
            onRetry={retry}
            onRegenerate={regenerate}
            onEditMessage={editMessage}
            onRename={renameConversation}
            onDelete={deleteConversation}
            onNewChat={newChat}
            onOpenSearch={openSearch}
            searchOpen={showSearch}
            input={draft}
            onInputChange={setDraft}
            conversationId={conversationId}
            conversationTitle={conversationTitle}
            onExpand={expand}
            onFold={fold}
            onUnfold={unfold}
            onRetryExpansion={retryExpansion}
            onDismissExpansion={dismissExpansion}
            transferKey={transferKey}
          />
        )}
        {view === 'knowledge' && <KnowledgeView />}
        {view === 'lookup-guide' && <LookupGuideView />}
        {view === 'settings' && <Settings />}
      </div>
      {showSearch && (
        <ConversationSearch
          onSelect={openConversation}
          onClose={closeSearch}
          currentConversationId={conversationId}
        />
      )}
    </div>
  )
}

export default App
