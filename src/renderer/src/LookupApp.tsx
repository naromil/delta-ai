import { useRef, useState, useEffect, useCallback } from 'react'
import { useChatStreaming } from './hooks/useChatStreaming'
import Turn from './components/conversation/Turn'
import ContextMenu from './components/conversation/ContextMenu'
import type { ContextMenuState } from './components/conversation/ContextMenu'
import type { ExpandableSegment } from '../../shared/conversation'
import { findTextSelectionRange } from '../../shared/conversation'
import { LOOKUP_DEFAULT_QUERY } from '../../shared/prompts'
import ExpandPrompt from './components/conversation/ExpandPrompt'
import type { ExpandPromptState } from './components/conversation/ExpandPrompt'

function findExpansionInSegments(
  segments: ExpandableSegment[],
  id: number
): (ExpandableSegment & { kind: 'expansion' }) | null {
  for (const seg of segments) {
    if (seg.kind === 'expansion') {
      if (seg.expansionId === id) return seg
      const found = findExpansionInSegments(seg.segments, id)
      if (found) return found
    }
  }
  return null
}

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

function isInsideExpansionFrame(el: HTMLElement): boolean {
  return !!el.closest('[data-expansion-id]')
}

function LookupApp(): React.JSX.Element {
  const [grown, setGrown] = useState(false)
  const [contextText, setContextText] = useState('Waiting for OCR\u2026')
  const [contextHint, setContextHint] = useState(true)
  const [ocrProcessing, setOcrProcessing] = useState(false)
  const [input, setInput] = useState('')
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [expandPrompt, setExpandPrompt] = useState<ExpandPromptState | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  /* ---- Flash hint helper ---- */
  const flashHint = useCallback((msg?: string) => {
    const extractedEl = document.getElementById('extracted')
    if (!extractedEl) return
    if (msg) {
      extractedEl.textContent = msg
      extractedEl.classList.add('hint')
    }
    extractedEl.classList.add('flash')
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => {
      extractedEl.classList.remove('flash')
    }, 600)
  }, [])

  /* ---- Listeners ---- */
  useEffect(() => {
    window.api.lookupOnContext((status) => {
      if (status.status === 'ready') {
        if (status.text) {
          setContextText(status.text)
          setContextHint(false)
          setState((prev) => ({ ...prev, context: status.text }))
          flashHint()
        } else {
          setContextText(status.hint || '(No context)')
          setContextHint(true)
        }
      } else {
        setContextText(status.hint || 'Processing\u2026')
        setContextHint(true)
      }
    })

    window.api.lookupOnError((err) => {
      setContextText(err)
      setContextHint(false)
    })
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
          setCtxMenu(null)
          return
        }
        if (expandPrompt) {
          setExpandPrompt(null)
          return
        }
        e.preventDefault()
        window.api.lookupClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [ctxMenu, expandPrompt])

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
      flashHint('Context is still being prepared\u2026')
      return
    }
    const text = trimmed || LOOKUP_DEFAULT_QUERY
    setInput('')
    send(text)
  }, [input, loading, contextReady, send, flashHint])

  /* ---- Context menu handlers ---- */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, segmentIndex: number) => {
      e.preventDefault()

      const sel = window.getSelection()
      let selectedText = sel?.toString().trim()

      const turnEl = (e.currentTarget as HTMLElement).closest('.message-turn') as HTMLElement | null
      if (!turnEl) return
      const turnId = Number(turnEl.dataset.turnId)
      if (!turnId) return

      const turn = state.turns.find((t) => t.id === turnId)
      if (!turn || !turn.segments) return

      if (turn.role === 'user') {
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          canExpand: false,
          onExpand: () => {},
          onExpandPrompted: () => {},
          onCopy: () => {
            const sel_ = window.getSelection()
            if (sel_ && sel_.rangeCount > 0) {
              document.execCommand('copy')
            }
          },
          onSelectAll: () => {
            const turnContent = turnEl.querySelector('.message-content')
            if (turnContent) {
              const range = document.createRange()
              range.selectNodeContents(turnContent)
              const sel_ = window.getSelection()
              sel_?.removeAllRanges()
              sel_?.addRange(range)
            }
          }
        })
        return
      }

      // If there's a stale selection that doesn't include the right-click
      // target (e.g. from a previous triple-click or drag), clear it so
      // the single-word path handles the interaction correctly.
      if (selectedText && sel && sel.rangeCount > 0) {
        const clickedEl = e.currentTarget as HTMLElement
        let insideSelection = false
        for (let i = 0; i < sel.rangeCount; i++) {
          if (sel.getRangeAt(i).intersectsNode(clickedEl)) {
            insideSelection = true
            break
          }
        }
        if (!insideSelection) {
          sel.removeAllRanges()
          selectedText = ''
        }
      }

      if (selectedText && sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)

        let canExpand = true
        let startIdx = -1
        let endIdx = -1
        let parentExpansionId: number | undefined
        let parentAnswer = ''

        const frameEl = (e.target as HTMLElement).closest(
          '[data-expansion-id]'
        ) as HTMLElement | null

        if (frameEl) {
          parentExpansionId = Number(frameEl.dataset.expansionId)
          const parentSeg = findExpansionInSegments(turn.segments!, parentExpansionId)
          if (parentSeg) {
            parentAnswer = parentSeg.cachedText || parentSeg.originalText || ''
            // Match selected text against the parent frame's child segments,
            // anchored on the right-click position to avoid picking the wrong
            // occurrence when the same word appears more than once.
            const found = findTextSelectionRange(parentSeg.segments, selectedText, segmentIndex)
            startIdx = found.startIdx
            endIdx = found.endIdx
          }
        } else {
          parentAnswer = turn.content
          // Match selected text against the top-level turn segments,
          // anchored on the right-click position.
          const found = findTextSelectionRange(turn.segments, selectedText, segmentIndex)
          startIdx = found.startIdx
          endIdx = found.endIdx
        }

        if (startIdx < 0 || endIdx <= startIdx) {
          canExpand = false
        }

        const cachedRange = range.cloneRange()
        const cachedSelection = selectedText

        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          canExpand,
          onExpand: () => {
            if (canExpand && startIdx >= 0) {
              expand(
                turnId,
                cachedSelection,
                startIdx,
                endIdx,
                !!frameEl,
                parentAnswer,
                parentExpansionId
              )
            }
          },
          onExpandPrompted: () => {
            if (canExpand && startIdx >= 0) {
              setExpandPrompt({
                x: e.clientX,
                y: e.clientY,
                onSubmit: (prompt) =>
                  expand(
                    turnId,
                    cachedSelection,
                    startIdx,
                    endIdx,
                    !!frameEl,
                    parentAnswer,
                    parentExpansionId,
                    prompt
                  )
              })
            }
          },
          onCopy: () => {
            const sel_ = window.getSelection()
            if (cachedRange) {
              sel_?.removeAllRanges()
              sel_?.addRange(cachedRange)
            }
            document.execCommand('copy')
          },
          onSelectAll: () => {
            const turnContent = turnEl.querySelector('.message-content')
            if (turnContent) {
              const range = document.createRange()
              range.selectNodeContents(turnContent)
              const sel_ = window.getSelection()
              sel_?.removeAllRanges()
              sel_?.addRange(range)
            }
          }
        })
        return
      }

      // Single-word right-click
      if (document.caretRangeFromPoint) {
        const cr = document.caretRangeFromPoint(e.clientX, e.clientY)
        if (cr && cr.startContainer) {
          const wordEl =
            cr.startContainer.nodeType === 3
              ? (cr.startContainer.parentElement as HTMLElement)
              : (cr.startContainer as HTMLElement)
          if (wordEl && wordEl.classList.contains('word')) {
            // Visually select the word so the user sees what is being targeted
            const wordRange = document.createRange()
            wordRange.selectNodeContents(wordEl)
            const wordSel = window.getSelection()
            if (wordSel) {
              wordSel.removeAllRanges()
              wordSel.addRange(wordRange)
            }

            const wordText = wordEl.textContent?.trim() || ''
            const inFrame = isInsideExpansionFrame(wordEl)

            if (inFrame) {
              // When inside an expansion frame, segmentIndex is the correct
              // child index passed by the frame's InlineSegments (since the
              // word handler now stops propagation).
              const frameEl = wordEl.closest('[data-expansion-id]') as HTMLElement | null
              const parentId = frameEl ? Number(frameEl.dataset.expansionId) : undefined
              const parentSeg = parentId ? findExpansionInSegments(turn.segments!, parentId) : null

              if (!parentSeg) {
                setCtxMenu(null)
                return
              }

              const childIdx = segmentIndex
              const parentAnswer = parentSeg.cachedText || parentSeg.originalText || ''

              setCtxMenu({
                x: e.clientX,
                y: e.clientY,
                canExpand: childIdx >= 0,
                onExpand: () => {
                  if (childIdx >= 0) {
                    expand(turnId, wordText, childIdx, childIdx + 1, true, parentAnswer, parentId)
                  }
                },
                onExpandPrompted: () => {
                  if (childIdx >= 0) {
                    setExpandPrompt({
                      x: e.clientX,
                      y: e.clientY,
                      onSubmit: (prompt) =>
                        expand(
                          turnId,
                          wordText,
                          childIdx,
                          childIdx + 1,
                          true,
                          parentAnswer,
                          parentId,
                          prompt
                        )
                    })
                  }
                },
                onCopy: () => {
                  const sel_ = window.getSelection()
                  sel_?.removeAllRanges()
                  const r = document.createRange()
                  r.selectNodeContents(wordEl)
                  sel_?.addRange(r)
                  document.execCommand('copy')
                },
                onSelectAll: () => {
                  const turnContent = turnEl.querySelector('.message-content')
                  if (turnContent) {
                    const range = document.createRange()
                    range.selectNodeContents(turnContent)
                    const sel_ = window.getSelection()
                    sel_?.removeAllRanges()
                    sel_?.addRange(range)
                  }
                }
              })
              return
            }

            // segmentIndex is the correct segments-array index passed by
            // InlineSegments (the `.word` handler now stops propagation).
            const segIdx = turn.segments[segmentIndex]?.kind === 'text' ? segmentIndex : -1
            const canExpand = segIdx >= 0

            let isNested = false
            let parentAnswer = ''
            let parentExpansionId: number | undefined

            const frameEl = (e.target as HTMLElement).closest(
              '[data-expansion-id]'
            ) as HTMLElement | null
            if (frameEl) {
              const parentId = Number(frameEl.dataset.expansionId)
              const parentSeg = findExpansionInSegments(turn.segments!, parentId)
              if (parentSeg) {
                isNested = true
                parentAnswer = parentSeg.cachedText || parentSeg.originalText || ''
                parentExpansionId = parentId
              }
            } else {
              parentAnswer = turn.content
            }

            setCtxMenu({
              x: e.clientX,
              y: e.clientY,
              canExpand,
              onExpand: () => {
                if (canExpand && segIdx >= 0) {
                  expand(
                    turnId,
                    wordText,
                    segIdx,
                    segIdx + 1,
                    isNested,
                    parentAnswer,
                    parentExpansionId
                  )
                }
              },
              onExpandPrompted: () => {
                if (canExpand && segIdx >= 0) {
                  setExpandPrompt({
                    x: e.clientX,
                    y: e.clientY,
                    onSubmit: (prompt) =>
                      expand(
                        turnId,
                        wordText,
                        segIdx,
                        segIdx + 1,
                        isNested,
                        parentAnswer,
                        parentExpansionId,
                        prompt
                      )
                  })
                }
              },
              onCopy: () => {
                const sel_ = window.getSelection()
                sel_?.removeAllRanges()
                const r = document.createRange()
                r.selectNodeContents(wordEl)
                sel_?.addRange(r)
                document.execCommand('copy')
              },
              onSelectAll: () => {
                const turnContent = turnEl.querySelector('.message-content')
                if (turnContent) {
                  const range = document.createRange()
                  range.selectNodeContents(turnContent)
                  const sel_ = window.getSelection()
                  sel_?.removeAllRanges()
                  sel_?.addRange(range)
                }
              }
            })
            return
          }
        }
      }

      setCtxMenu(null)
    },
    [state.turns, expand]
  )

  /* ---- Transfer to chat ---- */
  const handleTransfer = useCallback((): void => {
    window.api.lookupTransferToChat(state, conversationId ?? undefined)
  }, [state, conversationId])

  const isTransferDisabled = state.turns.length === 0 || loading

  const closeExpandPrompt = useCallback(() => {
    setExpandPrompt(null)
  }, [])

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
          <span className="lookup-close" onClick={() => window.api.lookupClose()}>
            ✕
          </span>
        </div>
      </div>
      <div className="lookup-content">
        <div className="section-label">Context</div>
        <div id="extracted" className={`extracted${contextHint ? ' hint' : ''}`}>
          {contextText}
        </div>
        <div className="paste-tip">Ctrl+V to paste text or an image as context.</div>
        <div className="ask-wrap">
          <input
            ref={askRef}
            className="ask"
            type="text"
            placeholder="Ask Delta AI..."
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          {ocrProcessing && (
            <div className="ocr-hint visible">Recognizing pasted image through OCR\u2026</div>
          )}
        </div>
        <div ref={scrollRef} className={`lookup-conversation${grown ? ' visible' : ''}`}>
          {visibleTurns.length === 0 && !grown && null}
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
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
      <ExpandPrompt state={expandPrompt} onClose={closeExpandPrompt} />
    </div>
  )
}

export default LookupApp
