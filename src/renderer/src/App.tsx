import { useState } from 'react'
import Settings from './components/Settings'

type Message = {
  id: number
  role: 'user' | 'assistant'
  content: string
}

type View = 'chat' | 'settings'

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('chat')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')

  const handleSend = (): void => {
    const trimmed = input.trim()
    if (trimmed === '') return
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: 'user', content: trimmed },
      { id: Date.now() + 1, role: 'assistant', content: '' }
    ])
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="new-chat-button" onClick={() => setMessages([])}>
            <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
              <path d="M12 4v16M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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
        <main className="chat">
        <div className="chat-scroll">
          {messages.length === 0 ? (
            <div className="empty-state">
              <h1 className="empty-title">How can I help you today?</h1>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((m) => (
                <div key={m.id} className={`message message-${m.role}`}>
                  <div className="message-avatar">{m.role === 'user' ? 'You' : 'AI'}</div>
                  <div className="message-content">{m.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="composer">
          <div className="composer-box">
            <textarea
              className="composer-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Send a message..."
              rows={1}
            />
            <button
              className="composer-send"
              onClick={handleSend}
              disabled={input.trim() === ''}
              aria-label="Send message"
            >
              <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
                <path d="M4 12l16-8-6 16-2-7-8-1z" fill="currentColor" />
              </svg>
            </button>
          </div>
          <p className="composer-hint">Delta AI can make mistakes. Check important info.</p>
        </div>
      </main>
      )}
    </div>
  )
}

export default App
