import { useRef, useState, useEffect, useCallback } from 'react'
import { useChatStreaming } from './hooks/useChatStreaming'
import { useExpansionContextMenu } from './hooks/useExpansionContextMenu'
import Turn from './components/conversation/Turn'
import ContextMenu from './components/conversation/ContextMenu'
import { LOOKUP_DEFAULT_QUERY } from '../../shared/prompts'
import ExpandPrompt from './components/conversation/ExpandPrompt'

function readFileAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const arr = new Uint8Array(reader.result as ArrayBuffer)
      let bin = ''
      for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
      resolve(btoa(bin))
    }
    reader.onerror = () => resolve(null)
    reader.readAsArrayBuffer(file)
  })
}

function LookupApp(): React.JSX.Element {
  const [grown, setGrown] = useState(false)
  const [contextText, setContextText] = useState('Waiting for context…')
  const [contextHint, setContextHint] = useState(true)
  const [flash, setFlash] = useState(false)
  const [ocrProcessing, setOcrProcessing] = useState(false)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const flashTimerRef = useRef<number | null>(null)
  const askRef = useRef<HTMLInputElement>(null)

  const { state, loading, contextReady, send, expand, fold, unfold, setState, conversationId } =
    useChatStreaming({
      role: 'lookup',
      initial: { turns: [] },
      onGrown: () => {
        setGrown(true)
        setTimeout(() => askRef.current?.focus(), 360)
      }
    })

  const { ctxMenu, expandPrompt, handleContextMenu, closeContextMenu, closeExpandPrompt } =
    useExpansionContextMenu({ turns: state.turns, onExpand: expand })

  /* ---- Flash hint helper ---- */
  const flashHint = useCallback((msg?: string) => {
    if (msg) {
      setContextText(msg)
      setContextHint(true)
    }
    setFlash(false)
    requestAnimationFrame(() => setFlash(true))
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlash(false), 600)
  }, [])

  /* ---- Clear pending flash timer on unmount ---- */
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    }
  }, [])

  /* ---- Listeners ---- */
  useEffect(() => {
    window.api.lookupOnContext((status) => {
      if (status.status === 'ready') {
        setState((prev) => ({ ...prev, context: status.text }))
        if (status.text) {
          setContextText(status.text)
          setContextHint(false)
          flashHint()
        } else {
          setContextText(status.hint || '(No context)')
          setContextHint(true)
        }
      } else {
        setState((prev) => (prev.context ? { ...prev, context: '' } : prev))
        setContextText(status.hint || 'Processing…')
        setContextHint(true)
      }
    })

    window.api.lookupOnError((err) => {
      setState((prev) => (prev.context ? { ...prev, context: '' } : prev))
      setContextText(err)
      setContextHint(false)
    })

    /* Signal main that the renderer's IPC listeners are registered so
     * any pending context notification can be re-sent. */
    window.api.lookupReady()
  }, [setState, flashHint])

  /* ---- Focus input on mount ---- */
  useEffect(() => {
    askRef.current?.focus()
  }, [])

  /* ---- Grow transitions ---- */
  useEffect(() => {
    if (grown) {
      document.documentElement.style.transition = 'height 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)'
      document.body.style.transition = 'height 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)'
    }
  }, [grown])

  /* ---- Auto-scroll (near-bottom only, so expand/fold doesn't jump) ---- */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    if (isNearBottom) el.scrollTop = el.scrollHeight
  }, [state.turns])

  /* ---- Keyboard ---- */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (ctxMenu) {
          closeContextMenu()
          return
        }
        if (expandPrompt) {
          closeExpandPrompt()
          return
        }
        if (input.length > 0) {
          e.preventDefault()
          setInput('')
          return
        }
        e.preventDefault()
        window.api.lookupClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [ctxMenu, expandPrompt, closeContextMenu, closeExpandPrompt, input])

  /* ---- Paste ---- */
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent): void => {
      const cd = e.clipboardData
      if (!cd) return

      let imageItem: DataTransferItem | null = null
      for (let i = 0; i < cd.items.length; i++) {
        const it = cd.items[i]
        if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
          imageItem = it
          break
        }
      }

      if (grown) {
        if (imageItem) {
          e.preventDefault()
          setOcrProcessing(true)
          const file = imageItem.getAsFile()
          if (!file) {
            setOcrProcessing(false)
            return
          }
          readFileAsBase64(file).then((b64) => {
            if (!b64) {
              setOcrProcessing(false)
              return
            }
            window.api
              .lookupOcrImage(b64)
              .then((result) => {
                setOcrProcessing(false)
                if (result.text && !result.error) {
                  setInput((prev) => {
                    const el = askRef.current
                    const start = el?.selectionStart ?? prev.length
                    const end = el?.selectionEnd ?? prev.length
                    const newVal = prev.slice(0, start) + result.text + prev.slice(end)
                    return newVal
                  })
                }
              })
              .catch(() => setOcrProcessing(false))
          })
        }
        return
      }

      e.preventDefault()
      if (imageItem) {
        const file = imageItem.getAsFile()
        if (file) {
          readFileAsBase64(file).then((b64) => {
            if (b64) window.api.lookupPasteImage(b64)
          })
        }
        return
      }

      const text = cd.getData('text/plain')
      if (text && text.trim()) {
        window.api.lookupPasteText(text)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [grown])

  /* ---- Input change tracking ---- */
  useEffect(() => {
    window.api.lookupInputChanged(input.length > 0)
  }, [input])

  /* ---- Send handler ---- */
  const handleSend = useCallback((): void => {
    const trimmed = input.trim()
    if (loading) return
    if (!contextReady) {
      flashHint('Context is still being prepared…')
      return
    }
    const text = trimmed || LOOKUP_DEFAULT_QUERY
    setInput('')
    send(text)
  }, [input, loading, contextReady, send, flashHint])

  /* ---- Transfer to chat ---- */
  const handleTransfer = useCallback((): void => {
    window.api.lookupTransferToChat(state, conversationId ?? undefined)
  }, [state, conversationId])

  const isTransferDisabled = state.turns.length === 0 || loading

  /* ---- Visible turns (skip empty turns unless loading) ---- */
  const visibleTurns = state.turns.filter(
    (t) => t.content !== '' || (t.role === 'assistant' && loading)
  )

  return (
    <div className="lookup">
      <div className="lookup-header">
        <span>Delta AI</span>
        <div className="lookup-header-actions">
          <button
            className="lookup-transfer-btn"
            disabled={isTransferDisabled}
            onClick={handleTransfer}
            title="Send to chat"
            aria-label="Send conversation to chat"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M12 4v16M4 12h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="lookup-close"
            aria-label="Close look-up"
            title="Close (Esc)"
            onClick={() => window.api.lookupClose()}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="lookup-content">
        <div className="section-label">Context</div>
        <div
          id="extracted"
          role="status"
          aria-live="polite"
          className={`extracted${contextHint ? ' hint' : ''}${flash ? ' flash' : ''}`}
        >
          {contextText}
        </div>
        <div className="paste-tip">Ctrl+V to paste text or an image as context.</div>
        <div className="ask-wrap">
          <input
            ref={askRef}
            className="ask"
            type="text"
            placeholder="Ask Delta AI..."
            aria-label="Ask Delta AI"
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.nativeEvent.isComposing) return
                e.preventDefault()
                handleSend()
              }
            }}
          />
          {ocrProcessing && (
            <div className="ocr-hint visible">Recognizing pasted image through OCR…</div>
          )}
        </div>
        <div ref={scrollRef} className={`lookup-conversation${grown ? ' visible' : ''}`}>
          {visibleTurns.map((turn) => (
            <div key={turn.id} className="message-turn" data-turn-id={turn.id}>
              <Turn
                turn={turn}
                loading={loading}
                onFold={fold}
                onUnfold={unfold}
                onContextMenu={handleContextMenu}
              />
            </div>
          ))}
        </div>
      </div>
      <ContextMenu state={ctxMenu} onClose={closeContextMenu} />
      <ExpandPrompt state={expandPrompt} onClose={closeExpandPrompt} />
    </div>
  )
}

export default LookupApp
