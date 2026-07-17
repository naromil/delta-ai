import { useState } from 'react'
import Settings from './views/settings/Settings'
import ChatView, { type Message } from './views/chat/ChatView'

type View = 'chat' | 'settings'

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('chat')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)

  const handleSend = async (content: string): Promise<void> => {
    const trimmed = content.trim()
    if (trimmed === '' || loading) return

    const userMsg: Message = { id: Date.now(), role: 'user', content: trimmed }
    const assistantId = Date.now() + 1
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '' }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setLoading(true)

    const history = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content
    }))

    const res = await window.api.sendMessage(history)

    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? res.success
            ? { ...m, content: res.response ?? '(No response received)' }
            : { ...m, content: res.error ?? 'An unknown error occurred.', error: true }
          : m
      )
    )
    setLoading(false)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="new-chat-button" onClick={() => setMessages([])}>
            <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
              <path
                d="M12 4v16M4 12h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            New chat
          </button>
        </div>
        <div className="sidebar-footer">
          <button
            className={`sidebar-settings-button ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
          >
            <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
              <path
                d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            Settings
          </button>
        </div>
      </aside>
      {view === 'settings' ? (
        <Settings onBack={() => setView('chat')} />
      ) : (
        <ChatView messages={messages} loading={loading} onSend={handleSend} />
      )}
    </div>
  )
}

export default App
