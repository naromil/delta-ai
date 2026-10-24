import { useCallback, useEffect, useRef, useState } from 'react'
import type { Turn } from '../../../shared/conversation'
import type { ExpansionRange, ExpansionTarget } from '../../../shared/rich-text'
import { findExpansionInNodes, validateExpansionTarget } from '../../../shared/rich-text'
import { isAnchoredRange } from '../lib/markdown'
import type { ContextMenuState } from '../components/conversation/ContextMenu'
import type { ExpandPromptState } from '../components/conversation/ExpandPrompt'
import type { ExpandOutcome } from './useChatStreaming'

export type { ExpansionTarget }

export type ExpandRequest = (
  turnId: number,
  target: ExpansionTarget,
  prompt?: string
) => ExpandOutcome

interface SourceAnchor {
  offset: number
  frameId: number | null
}

interface SourceSelection {
  start: number
  end: number
  frameId: number | null
}

interface PendingSelection {
  turnId: number
  /** Cloned at menu-open so submit can re-resolve if the DOM is still alive. */
  range: Range | null
  selection: string
  /** Fallback computed at menu-open (used when the Range was detached). */
  target: ExpansionTarget | null
}

interface UseExpansionContextMenuOptions {
  turns: Turn[]
  onExpand: ExpandRequest
}

const FRAME_SELECTOR = '[data-expansion-id]'
const NOTICE_TIMEOUT_MS = 4000

function frameIdOf(element: Element | null): number | null {
  const frame = element?.closest(FRAME_SELECTOR) as HTMLElement | null
  if (!frame) return null
  const id = Number(frame.dataset.expansionId)
  return Number.isFinite(id) ? id : null
}

/**
 * Maps a DOM text point to an absolute offset in its enclosing markdown source.
 * Every rendered markdown text node is a leaf `[data-src]` element, so the
 * mapping is exact arithmetic — no string search.
 */
function anchorOfText(text: Text, offset: number): SourceAnchor | null {
  const host = text.parentElement
  if (!host || !host.hasAttribute('data-src')) return null
  const base = Number(host.getAttribute('data-src'))
  if (!Number.isFinite(base)) return null
  return { offset: base + offset, frameId: frameIdOf(host) }
}

function firstTextInside(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text
  return document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode() as Text | null
}

function lastTextInside(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  let current = walker.nextNode()
  while (current) {
    last = current as Text
    current = walker.nextNode()
  }
  return last
}

function resolveAnchor(node: Node, offset: number, prefer: 'start' | 'end'): SourceAnchor | null {
  if (node.nodeType === Node.TEXT_NODE) return anchorOfText(node as Text, offset)

  const children = Array.from((node as Element).childNodes)
  if (prefer === 'start') {
    for (const child of children.slice(offset)) {
      const text = firstTextInside(child)
      const anchor = text ? anchorOfText(text, 0) : null
      if (anchor) return anchor
    }
    return null
  }
  for (const child of children.slice(0, offset).reverse()) {
    const text = lastTextInside(child)
    const anchor = text ? anchorOfText(text, text.length) : null
    if (anchor) return anchor
  }
  return null
}

function anchorsFromRange(range: Range): SourceSelection | null {
  const start = resolveAnchor(range.startContainer, range.startOffset, 'start')
  const end = resolveAnchor(range.endContainer, range.endOffset, 'end')
  if (!start || !end) return null
  if (start.frameId !== end.frameId) return null
  if (end.offset <= start.offset) return null
  return { start: start.offset, end: end.offset, frameId: start.frameId }
}

function sourceFor(
  turn: Turn,
  frameId: number | null
): { source: string; siblings: Turn['expansions']; parentExpansionId?: number } | null {
  if (frameId === null) return { source: turn.content, siblings: turn.expansions }
  const parent = findExpansionInNodes(turn.expansions, frameId)
  if (!parent) return null
  return {
    source: parent.node.answer,
    siblings: parent.node.children,
    parentExpansionId: parent.node.id
  }
}

type TargetResult = { ok: true; target: ExpansionTarget } | { ok: false; reason: string }

/**
 * Resolves a DOM selection against the *current* turn state and validates it
 * with the same rules `expand()` enforces, so the menu and the commit cannot
 * disagree. The markdown text-node check comes first: a range that spans
 * several nodes (e.g. across `**bold**`) is reported as unanchored rather than
 * as a text mismatch.
 */
function resolveTarget(turn: Turn, selection: SourceSelection, selectedText: string): TargetResult {
  const scope = sourceFor(turn, selection.frameId)
  if (!scope) return { ok: false, reason: 'parent-not-found' }

  const range: ExpansionRange = { start: selection.start, end: selection.end }
  if (!isAnchoredRange(scope.source, range)) return { ok: false, reason: 'not-anchored' }

  const target: ExpansionTarget = {
    ...range,
    selection: selectedText,
    ...(scope.parentExpansionId !== undefined ? { parentExpansionId: scope.parentExpansionId } : {})
  }

  const refusal = validateExpansionTarget(scope.source, scope.siblings, target)
  if (refusal !== null) return { ok: false, reason: refusal }
  return { ok: true, target }
}

function refusalMessage(reason: string): string {
  switch (reason) {
    case 'selection-mismatch':
      return 'The text changed while the menu was open. Select it again.'
    case 'overlaps-expansion':
    case 'inside-expansion':
      return 'That range overlaps an existing expansion.'
    case 'cross-block':
      return 'Select text inside one paragraph, list item or heading.'
    case 'blank-selection':
    case 'empty-range':
      return 'Select some text to expand.'
    case 'out-of-bounds':
      return 'The selection is no longer available.'
    case 'parent-not-found':
    case 'turn-not-found':
      return 'That message is no longer on screen.'
    case 'not-anchored':
      return 'Select text inside a single block.'
    default:
      return 'The selection cannot be expanded.'
  }
}

async function copyText(text: string): Promise<void> {
  if (text === '') return
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    /* fall through to the selection-based fallback */
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  document.body.removeChild(area)
}

function selectAllInTurn(turnEl: HTMLElement): void {
  const content = turnEl.querySelector('.message-content')
  if (!content) return
  const range = document.createRange()
  range.selectNodeContents(content)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function useExpansionContextMenu(options: UseExpansionContextMenuOptions): {
  ctxMenu: ContextMenuState | null
  expandPrompt: ExpandPromptState | null
  notice: string | null
  handleContextMenu: (e: React.MouseEvent) => void
  closeContextMenu: () => void
  closeExpandPrompt: () => void
  dismissNotice: () => void
} {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [expandPrompt, setExpandPrompt] = useState<ExpandPromptState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { turns, onExpand } = options

  // Submits happen after the menu opened; read the newest turns, not the
  // closure captured when the menu rendered.
  const turnsRef = useRef(turns)
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  const pendingRef = useRef<PendingSelection | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS)
  }, [])

  const dismissNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    setNotice(null)
  }, [])

  const submit = useCallback(
    (prompt?: string) => {
      const pending = pendingRef.current
      if (!pending) return

      const turn = turnsRef.current.find((item) => item.id === pending.turnId)
      if (!turn) {
        showNotice(refusalMessage('turn-not-found'))
        return
      }

      let target: ExpansionTarget | null = null
      const range = pending.range
      if (range && range.startContainer.isConnected) {
        const anchors = anchorsFromRange(range)
        // Re-validate against the live source; a detached Range falls back to
        // the snapshot, which is re-validated below.
        if (anchors) {
          const resolved = resolveTarget(turn, anchors, pending.selection)
          if (!resolved.ok) {
            showNotice(refusalMessage(resolved.reason))
            return
          }
          target = resolved.target
        }
      }

      if (!target) target = pending.target
      if (!target) {
        showNotice(refusalMessage('selection-mismatch'))
        return
      }

      const scope = sourceFor(turn, target.parentExpansionId ?? null)
      if (!scope || !isAnchoredRange(scope.source, target)) {
        showNotice(refusalMessage('not-anchored'))
        return
      }
      const refusal = validateExpansionTarget(scope.source, scope.siblings, target)
      if (refusal !== null) {
        showNotice(refusalMessage(refusal))
        return
      }

      const outcome = onExpand(pending.turnId, target, prompt)
      if (!outcome.ok) showNotice(refusalMessage(outcome.reason))
    },
    [onExpand, showNotice]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()

      const turnEl = e.currentTarget as HTMLElement
      const turnId = Number(turnEl.dataset.turnId)
      const turn = Number.isFinite(turnId) ? turns.find((item) => item.id === turnId) : undefined
      if (!turn) return

      const selection = window.getSelection()
      let selectedText = selection?.toString() ?? ''

      if (selectedText.trim() !== '' && selection && selection.rangeCount > 0) {
        // Drop a stale selection left over from a previous interaction.
        if (!selection.getRangeAt(0).intersectsNode(e.target as Node)) {
          selection.removeAllRanges()
          selectedText = ''
        }
      }

      // User turns get Copy / Select All only: they are not model answers.
      if (turn.role === 'user') {
        pendingRef.current = null
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          canExpand: false,
          onExpand: () => {},
          onExpandPrompted: () => {},
          onCopy: () => void copyText(selectedText),
          onSelectAll: () => selectAllInTurn(turnEl)
        })
        return
      }

      if (selectedText.trim() !== '' && selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const anchors = anchorsFromRange(range)
        const resolved = anchors ? resolveTarget(turn, anchors, selectedText) : null
        const target = resolved?.ok ? resolved.target : null
        const hint = target
          ? undefined
          : refusalMessage(resolved && !resolved.ok ? resolved.reason : 'not-anchored')
        pendingRef.current = {
          turnId,
          range: range.cloneRange(),
          selection: selectedText,
          target
        }

        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          canExpand: target !== null,
          hint,
          onExpand: () => submit(),
          onExpandPrompted: () => {
            if (!target) return
            setExpandPrompt({
              x: e.clientX,
              y: e.clientY,
              onSubmit: (prompt) => submit(prompt)
            })
          },
          onCopy: () => void copyText(selectedText),
          onSelectAll: () => selectAllInTurn(turnEl)
        })
        return
      }

      // Single-word right-click: the caret lands in a text node, then
      // Range.expand('word') widens it to the word under the cursor.
      const caret =
        typeof document.caretRangeFromPoint === 'function'
          ? document.caretRangeFromPoint(e.clientX, e.clientY)
          : null

      if (caret && caret.startContainer && turnEl.contains(caret.startContainer)) {
        const wordRange = caret.cloneRange()
        // Range.expand() is Chromium-only and absent from lib.dom.d.ts.
        const expandableRange = wordRange as unknown as { expand: (unit: string) => void }
        try {
          expandableRange.expand('word')
        } catch {
          /* expand('word') can throw on an empty text node */
        }

        const wordText = wordRange.toString()
        if (wordText.trim() !== '') {
          const anchors = anchorsFromRange(wordRange)
          const resolved = anchors ? resolveTarget(turn, anchors, wordText) : null
          const target = resolved?.ok ? resolved.target : null
          const hint = target
            ? undefined
            : refusalMessage(resolved && !resolved.ok ? resolved.reason : 'not-anchored')
          pendingRef.current = {
            turnId,
            range: wordRange.cloneRange(),
            selection: wordText,
            target
          }

          // Select the word so the menu's Copy/Expand act on what was clicked.
          selection?.removeAllRanges()
          selection?.addRange(wordRange.cloneRange())

          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            canExpand: target !== null,
            hint,
            onExpand: () => submit(),
            onExpandPrompted: () => {
              if (!target) return
              setExpandPrompt({
                x: e.clientX,
                y: e.clientY,
                onSubmit: (prompt) => submit(prompt)
              })
            },
            onCopy: () => void copyText(wordText),
            onSelectAll: () => selectAllInTurn(turnEl)
          })
          return
        }
      }

      // Nothing targeted, but Copy / Select All must still be reachable.
      pendingRef.current = null
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        canExpand: false,
        onExpand: () => {},
        onExpandPrompted: () => {},
        onCopy: () => void copyText(selectedText),
        onSelectAll: () => selectAllInTurn(turnEl)
      })
    },
    [turns, submit]
  )

  const closeContextMenu = useCallback(() => {
    setCtxMenu(null)
  }, [])

  const closeExpandPrompt = useCallback(() => {
    setExpandPrompt(null)
  }, [])

  return {
    ctxMenu,
    expandPrompt,
    notice,
    handleContextMenu,
    closeContextMenu,
    closeExpandPrompt,
    dismissNotice
  }
}
