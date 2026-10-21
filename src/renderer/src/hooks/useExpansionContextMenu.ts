import { useCallback, useState } from 'react'
import type { Turn } from '../../../shared/conversation'
import { findExpansionInSegments, findTextSelectionRange } from '../../../shared/conversation'
import type { ContextMenuState } from '../components/conversation/ContextMenu'
import type { ExpandPromptState } from '../components/conversation/ExpandPrompt'

export type ExpandRequest = (
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

interface UseExpansionContextMenuOptions {
  turns: Turn[]
  onExpand: ExpandRequest
}

export function useExpansionContextMenu(options: UseExpansionContextMenuOptions): {
  ctxMenu: ContextMenuState | null
  expandPrompt: ExpandPromptState | null
  handleContextMenu: (e: React.MouseEvent, segmentIndex: number) => void
  closeContextMenu: () => void
  closeExpandPrompt: () => void
} {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [expandPrompt, setExpandPrompt] = useState<ExpandPromptState | null>(null)
  const { turns, onExpand } = options

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, segmentIndex: number) => {
      e.preventDefault()

      const sel = window.getSelection()
      let selectedText = sel?.toString().trim()

      const turnEl = (e.currentTarget as HTMLElement).closest('.message-turn') as HTMLElement | null
      if (!turnEl) return
      const turnId = Number(turnEl.dataset.turnId)
      if (!turnId) return

      const turn = turns.find((t) => t.id === turnId)
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
          // Range.expand() is Chromium-only and absent from lib.dom.d.ts.
          const expandableRange = wordRange as unknown as { expand: (unit: string) => void }
          try {
            expandableRange.expand('word')
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
    [turns, onExpand]
  )

  const closeContextMenu = useCallback(() => {
    setCtxMenu(null)
  }, [])

  const closeExpandPrompt = useCallback(() => {
    setExpandPrompt(null)
  }, [])

  return { ctxMenu, expandPrompt, handleContextMenu, closeContextMenu, closeExpandPrompt }
}
