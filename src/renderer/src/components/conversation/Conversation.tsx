import { useRef, useState, useEffect, useCallback } from 'react'
import type { ConversationState, ExpandableSegment } from '../../../../shared/conversation'
import { findTextSelectionRange } from '../../../../shared/conversation'
import Turn from './Turn'
import ContextMenu from './ContextMenu'
import type { ContextMenuState } from './ContextMenu'
import ExpandPrompt from './ExpandPrompt'
import type { ExpandPromptState } from './ExpandPrompt'
import ConversationSearch from './ConversationSearch'

interface ConversationProps {
  state: ConversationState
  loading: boolean
  onSend: (content: string) => void
  onNewChat: () => void
  onLoadConversation?: (id: string) => void
  onExpand: (
    turnId: number,
    selection: string,
    startIndex: number,
    endIndex: number,
    isNested: boolean,
    parentAnswer: string,
    parentExpansionId?: number,
    prompt?: string,
    startOffset?: number,
    endOffset?: number
  ) => void
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  hideToolbar?: boolean
  transferKey?: number
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
  transferKey
}: ConversationProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [expandPrompt, setExpandPrompt] = useState<ExpandPromptState | null>(null)
  const [showSearch, setShowSearch] = useState(false)

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

      // User turns get a simple context menu without expand.
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

      // Clear stale selection if the right-click target is not within it.
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
        let selStartOffset: number | undefined
        let selEndOffset: number | undefined
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
            const found = findTextSelectionRange(parentSeg.segments, selectedText, segmentIndex)
            startIdx = found.startIdx
            endIdx = found.endIdx
            selStartOffset = found.startOffset
            selEndOffset = found.endOffset
          }
        } else {
          parentAnswer = turn.content
          const found = findTextSelectionRange(turn.segments, selectedText, segmentIndex)
          startIdx = found.startIdx
          endIdx = found.endIdx
          selStartOffset = found.startOffset
          selEndOffset = found.endOffset
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
              onExpand(
                turnId,
                cachedSelection,
                startIdx,
                endIdx,
                !!frameEl,
                parentAnswer,
                parentExpansionId,
                undefined,
                selStartOffset,
                selEndOffset
              )
            }
          },
          onExpandPrompted: () => {
            if (canExpand && startIdx >= 0) {
              setExpandPrompt({
                x: e.clientX,
                y: e.clientY,
                onSubmit: (prompt) =>
                  onExpand(
                    turnId,
                    cachedSelection,
                    startIdx,
                    endIdx,
                    !!frameEl,
                    parentAnswer,
                    parentExpansionId,
                    prompt,
                    selStartOffset,
                    selEndOffset
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
          const segEl = e.currentTarget as HTMLElement
          if (!segEl.contains(cr.startContainer)) {
            setCtxMenu(null)
            return
          }

          // Expand to word boundary
          const wordRange = cr.cloneRange()
          try {
            ;(wordRange as unknown as { expand: (unit: string) => void }).expand('word')
          } catch {
            /* expand('word') may fail, e.g. on an empty text node */
          }
          const wordText = wordRange.toString().trim()
          if (!wordText) {
            setCtxMenu(null)
            return
          }

          // Compute character offsets within the segment text
          const domRange = document.createRange()
          domRange.setStart(segEl.firstChild || segEl, 0)
          domRange.setEnd(wordRange.startContainer, wordRange.startOffset)
          const startOffset = domRange.toString().length
          const endOffset = startOffset + wordText.length

          // Visually select the word on right-click
          const wordSel = window.getSelection()
          if (wordSel) {
            wordSel.removeAllRanges()
            wordSel.addRange(wordRange)
          }

          const frameEl = (e.target as HTMLElement).closest(
            '[data-expansion-id]'
          ) as HTMLElement | null

          let isNested = false
          let parentAnswer = ''
          let parentExpansionId: number | undefined

          if (frameEl) {
            const parentId = Number(frameEl.dataset.expansionId)
            const parentSeg = findExpansionInSegments(turn.segments!, parentId)
            if (!parentSeg) {
              setCtxMenu(null)
              return
            }
            isNested = true
            parentAnswer = parentSeg.cachedText || parentSeg.originalText || ''
            parentExpansionId = parentId
          } else {
            parentAnswer = turn.content
          }

          const segIdx = segmentIndex
          const canExpand = segIdx >= 0

          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            canExpand,
            onExpand: () => {
              if (canExpand && segIdx >= 0) {
                onExpand(
                  turnId,
                  wordText,
                  segIdx,
                  segIdx + 1,
                  isNested,
                  parentAnswer,
                  parentExpansionId,
                  undefined,
                  startOffset,
                  endOffset
                )
              }
            },
            onExpandPrompted: () => {
              if (canExpand && segIdx >= 0) {
                setExpandPrompt({
                  x: e.clientX,
                  y: e.clientY,
                  onSubmit: (prompt) =>
                    onExpand(
                      turnId,
                      wordText,
                      segIdx,
                      segIdx + 1,
                      isNested,
                      parentAnswer,
                      parentExpansionId,
                      prompt,
                      startOffset,
                      endOffset
                    )
                })
              }
            },
            onCopy: () => {
              const sel_ = window.getSelection()
              sel_?.removeAllRanges()
              sel_?.addRange(wordRange.cloneRange())
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

      setCtxMenu(null)
    },
    [state.turns, onExpand]
  )

  const closeContextMenu = useCallback(() => {
    setCtxMenu(null)
  }, [])

  const closeExpandPrompt = useCallback(() => {
    setExpandPrompt(null)
  }, [])

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

export default Conversation
