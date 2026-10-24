import { useCallback, useRef, useState, useEffect } from 'react'
import type { ConversationState } from '../../../../shared/conversation'
import { CONVERSATION_TITLE_MAX_LENGTH } from '../../../../shared/conversation'
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
  onStop: () => void
  onRetry: (turnId: number) => void
  onRegenerate?: (turnId: number) => void
  onRename?: (title: string) => void
  onNewChat: () => void
  onLoadConversation?: (id: string) => void
  onExpand: ExpandRequest
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  onRetryExpansion?: (expansionId: number) => void
  onDismissExpansion?: (expansionId: number) => void
  hideToolbar?: boolean
  transferKey?: number
  conversationId?: string | null
  conversationTitle?: string | null
}

const SUGGESTIONS = [
  'What have I been learning recently?',
  'Quiz me on something from my history',
  'Explain a concept step by step'
]

function Conversation({
  state,
  loading,
  onSend,
  onStop,
  onRetry,
  onRegenerate,
  onRename,
  onNewChat,
  onExpand,
  onFold,
  onUnfold,
  onRetryExpansion,
  onDismissExpansion,
  onLoadConversation,
  hideToolbar = false,
  transferKey,
  conversationId,
  conversationTitle
}: ConversationProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportSavedTimerRef = useRef<number | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleSettledRef = useRef(false)
  const turnsRef = useRef(state.turns)

  useEffect(() => {
    turnsRef.current = state.turns
  }, [state.turns])
  const {
    ctxMenu,
    expandPrompt,
    notice,
    handleContextMenu,
    closeContextMenu,
    closeExpandPrompt,
    dismissNotice
  } = useExpansionContextMenu({ turns: state.turns, onExpand })

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    if (isNearBottom) el.scrollTop = el.scrollHeight
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }, [state.turns])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => {
      if (exportSavedTimerRef.current !== null) window.clearTimeout(exportSavedTimerRef.current)
    }
  }, [])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }

  const fillComposer = (text: string): void => {
    setInput(text)
    textareaRef.current?.focus()
  }

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

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [input])

  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'k' && onLoadConversation) {
        e.preventDefault()
        setShowSearch(true)
      } else if (key === 'n') {
        e.preventDefault()
        onNewChat()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [onLoadConversation, onNewChat])

  useEffect(() => {
    if (showSearch) closeContextMenu()
  }, [showSearch, closeContextMenu])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing) return
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

  const handleExport = async (): Promise<void> => {
    if (!conversationId || exporting) return
    if (exportSavedTimerRef.current !== null) {
      window.clearTimeout(exportSavedTimerRef.current)
      exportSavedTimerRef.current = null
    }
    setExported(false)
    setExportError(null)
    setExporting(true)
    try {
      const result = await window.api.exportConversation(conversationId)
      if (result.ok) {
        setExported(true)
        exportSavedTimerRef.current = window.setTimeout(() => {
          exportSavedTimerRef.current = null
          setExported(false)
        }, 2000)
      } else if (result.error !== 'Canceled.') {
        setExportError(result.error)
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  const beginTitleEdit = (): void => {
    if (!onRename || !conversationTitle) return
    titleSettledRef.current = false
    setTitleDraft(conversationTitle)
    setEditingTitle(true)
  }

  const commitTitle = (): void => {
    if (titleSettledRef.current) return
    titleSettledRef.current = true
    setEditingTitle(false)
    onRename?.(titleDraft)
  }

  const cancelTitleEdit = (): void => {
    titleSettledRef.current = true
    setEditingTitle(false)
  }

  const handleRegenerate = useCallback(
    (turnId: number) => {
      if (!onRegenerate) return
      const turns = turnsRef.current
      const index = turns.findIndex((turn) => turn.id === turnId)
      if (index < 0) return
      if (index !== turns.length - 1) {
        const removed = turns.length - index
        const confirmed = window.confirm(
          `Regenerate this answer? ${removed} later message${removed === 1 ? '' : 's'} will be removed.`
        )
        if (!confirmed) return
      }
      onRegenerate(turnId)
    },
    [onRegenerate]
  )

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
          {conversationId && (
            <button
              className="new-chat-button"
              onClick={handleExport}
              disabled={exporting}
              aria-label="Export conversation"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              {exporting ? 'Exporting…' : exported ? 'Saved' : 'Export'}
            </button>
          )}
          {exportError && (
            <span className="chat-export-error" role="alert">
              {exportError}
            </span>
          )}
          {conversationTitle &&
            (editingTitle ? (
              <input
                className="chat-title chat-title-input"
                value={titleDraft}
                maxLength={CONVERSATION_TITLE_MAX_LENGTH}
                autoFocus
                aria-label="Conversation title"
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTitle()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelTitleEdit()
                  }
                }}
              />
            ) : onRename ? (
              <button
                type="button"
                className="chat-title chat-title-button"
                title={conversationTitle}
                aria-label="Rename conversation"
                onClick={beginTitleEdit}
              >
                {conversationTitle}
              </button>
            ) : (
              <span className="chat-title" title={conversationTitle}>
                {conversationTitle}
              </span>
            ))}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {loading ? 'Delta AI is responding' : ''}
      </div>
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {visibleTurns.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-inner">
              <h1 className="empty-title">Grow with me</h1>
              <p className="empty-subtitle">
                Ask anything, or start from one of these. Your learning profile grows with every
                conversation.
              </p>
              <div className="empty-suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="empty-suggestion"
                    onClick={() => fillComposer(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="message-list">
            {visibleTurns.map((turn) => (
              <div
                key={turn.id}
                className="message-turn"
                data-turn-id={turn.id}
                onContextMenu={handleContextMenu}
              >
                <Turn
                  turn={turn}
                  loading={loading}
                  onFold={onFold}
                  onUnfold={onUnfold}
                  onRetry={onRetry}
                  onRegenerate={onRegenerate ? handleRegenerate : undefined}
                  onRetryExpansion={onRetryExpansion}
                  onDismissExpansion={onDismissExpansion}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="composer">
        {!atBottom && visibleTurns.length > 0 && (
          <button className="jump-latest" onClick={jumpToLatest}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Latest
          </button>
        )}
        <div className="composer-box">
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Delta AI..."
            aria-label="Message Delta AI"
            rows={1}
          />
          {loading ? (
            <button
              className="composer-send composer-stop"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
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
          )}
        </div>
        <div className="composer-meta">
          <p className="composer-hint">Delta AI can make mistakes. Check important info.</p>
          <span className="composer-keys">
            <kbd className="kbd">Enter</kbd> send
            <span className="keys-sep" aria-hidden="true">
              ·
            </span>
            <kbd className="kbd">Shift</kbd>
            <kbd className="kbd">Enter</kbd> newline
          </span>
        </div>
      </div>
      <ContextMenu state={ctxMenu} onClose={closeContextMenu} />
      <ExpandPrompt state={expandPrompt} onClose={closeExpandPrompt} />
      {notice ? (
        <div className="expand-notice" role="status" onClick={dismissNotice}>
          {notice}
        </div>
      ) : null}
      {showSearch && onLoadConversation && (
        <ConversationSearch
          onSelect={onLoadConversation}
          onClose={() => setShowSearch(false)}
          currentConversationId={conversationId}
        />
      )}
    </main>
  )
}

export default Conversation
