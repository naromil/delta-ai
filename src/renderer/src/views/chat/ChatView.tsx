import { useState, useRef, useEffect } from 'react'

export type Message = {
  id: number
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

interface ChatViewProps {
  messages: Message[]
  loading: boolean
  onSend: (content: string) => void
  onNewChat: () => void
}

function ChatView({ messages, loading, onSend, onNewChat }: ChatViewProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = (): void => {
    const trimmed = input.trim()
    if (trimmed === '' || loading) return
    setInput('')
    onSend(trimmed)
  }

  return (
    <main className="chat">
      <div className="chat-toolbar">
        <button className="new-chat-button" onClick={onNewChat}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
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
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <h1 className="empty-title">Sync with me</h1>
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
            placeholder="Message Delta AI..."
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
  )
}

export default ChatView
