import { useRef, useState, useEffect } from 'react'
import type { ConversationState } from '../../../../shared/conversation'
import { useExpansionContextMenu } from '../../hooks/useExpansionContextMenu'
import type { ExpandRequest } from '../../hooks/useExpansionContextMenu'
import Turn from './Turn'
import ContextMenu from './ContextMenu'
import ExpandPrompt from './ExpandPrompt'
import ConversationSearch from './ConversationSearch'

interface ConversationProps {
  state: ConversationState
  loading: boolean
  onSend: (content: string) => void
  onNewChat: () => void
  onLoadConversation?: (id: string) => void
  onExpand: ExpandRequest
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  hideToolbar?: boolean
  transferKey?: number
  conversationId?: string | null
}

function Conversation({
  state,
  loading,
  onSend,
  onNewChat,
  onExpand,
  onFold,
  onUnfold,
  onLoadConversation,
  hideToolbar = false,
  transferKey,
  conversationId
}: ConversationProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showSearch, setShowSearch] = useState(false)
  const { ctxMenu, expandPrompt, handleContextMenu, closeContextMenu, closeExpandPrompt } =
    useExpansionContextMenu({ turns: state.turns, onExpand })

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    if (isNearBottom) el.scrollTop = el.scrollHeight
  }, [state.turns])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [transferKey])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [conversationId])

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

  const visibleTurns = state.turns.filter(
    (t) => t.content !== '' || (t.role === 'assistant' && loading)
  )

  return (
    <main className="chat">
      {!hideToolbar && (
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
          <button
            className="new-chat-button"
            onClick={() => setShowSearch(true)}
            aria-label="Search conversations"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" fill="none" />
              <path
                d="M21 21l-4.35-4.35"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            Search
          </button>
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef}>
        {visibleTurns.length === 0 ? (
          <div className="empty-state">
            <h1 className="empty-title">Grow with me</h1>
          </div>
        ) : (
          <div className="message-list">
            {visibleTurns.map((turn) => (
              <div key={turn.id} className="message-turn" data-turn-id={turn.id}>
                <Turn
                  turn={turn}
                  loading={loading}
                  onFold={onFold}
                  onUnfold={onUnfold}
                  onContextMenu={handleContextMenu}
                />
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
      <ContextMenu state={ctxMenu} onClose={closeContextMenu} />
      <ExpandPrompt state={expandPrompt} onClose={closeExpandPrompt} />
      {showSearch && onLoadConversation && (
        <ConversationSearch onSelect={onLoadConversation} onClose={() => setShowSearch(false)} />
      )}
    </main>
  )
}

export default Conversation
