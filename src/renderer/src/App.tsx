import { useState } from 'react'
import Settings from './views/settings/Settings'
import Conversation from './components/conversation/Conversation'
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
  const { state, loading, send, expand, fold, unfold, newChat } = useChatStreaming()

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
          Delta AI
        </div>
        <nav className="sidebar-nav">
          {mainNavEntries.map((entry) => (
            <button
              key={entry.view}
              className={`sidebar-nav-item${view === entry.view ? ' active' : ''}`}
              onClick={() => setView(entry.view)}
            >
              {ICONS[entry.icon]}
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider sidebar-divider--bottom" />
        <nav className="sidebar-nav">
          <button
            className={`sidebar-nav-item${view === settingsNavEntry.view ? ' active' : ''}`}
            onClick={() => setView(settingsNavEntry.view)}
          >
            {ICONS[settingsNavEntry.icon]}
            {settingsNavEntry.label}
          </button>
        </nav>
      </aside>
      <div className="app-main">
        {view === 'home' && <HomeView />}
        {view === 'chat' && (
          <Conversation
            state={state}
            loading={loading}
            onSend={send}
            onNewChat={newChat}
            onExpand={expand}
            onFold={fold}
            onUnfold={unfold}
          />
        )}
        {view === 'knowledge' && <KnowledgeView />}
        {view === 'lookup-guide' && <LookupGuideView />}
        {view === 'settings' && <Settings />}
      </div>
    </div>
  )
}

export default App
