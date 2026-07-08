import { useState, useRef, useEffect } from 'react'
import Settings from './components/Settings'

type Message = {
  id: number
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

type View = 'chat' | 'settings'

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('chat')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  /* Auto-scroll to bottom on new messages */
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const handleSend = async (): Promise<void> => {
    const trimmed = input.trim()
    if (trimmed === '' || loading) return
    setInput('')

    const userMsg: Message = { id: Date.now(), role: 'user', content: trimmed }
    const assistantId = Date.now() + 1
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '' }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setLoading(true)

    // Build message history for the API (exclude the empty assistant placeholder)
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
        <main className="chat">
          <div className="chat-scroll" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="empty-state">
                <h1 className="empty-title">How can I help you today?</h1>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((m) => (
                  <div key={m.id} className={`message message-${m.role}`}>
                    <div className="message-avatar">{m.role === 'user' ? 'You' : 'AI'}</div>
                    {m.content === '' && loading && m.role === 'assistant' ? (
                      <div className="message-content">
                        <div className="loading-dots">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      </div>
                    ) : (
                      <div className={`message-content${m.error ? ' error' : ''}`}>{m.content}</div>
                    )}
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
                disabled={input.trim() === '' || loading}
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
